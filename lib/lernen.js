'use strict';
/**
 * Lernschleife.
 *
 * Drei Dinge, die zusammengehoeren:
 *
 *  1. pruefe()        stellt Rueckfragen zu einer Begehung. Die Fragen kommen
 *                     aus der Tabelle pruefregeln, nicht aus dem Code.
 *  2. lerneAusAngebot() zaehlt nach einer Beauftragung mit, welche Positionen
 *                     bei diesem Objekttyp tatsaechlich verkauft wurden.
 *  3. vorschlaege()   vergleicht die aktuelle Begehung mit dieser Statistik
 *                     und nennt, was bei vergleichbaren Objekten dabei war.
 *
 * Bewusst keine Blackbox: jeder Vorschlag traegt seine Herkunft mit sich
 * ("bei 7 von 8 vergleichbaren Objekten"). Wer das nicht nachvollziehen
 * kann, soll es auch nicht anwenden.
 */

const db = require('./db');
const h = require('./helfer');

// ---------------------------------------------------------------------
// Merkmale — der Objekttyp einer Begehung
// ---------------------------------------------------------------------

/** Freitext auf einen vergleichbaren Schluessel bringen. */
function normal(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

/**
 * Ein Objekt bekommt mehrere Merkmale — vom groben zum feinen.
 * Das grobe traegt frueh, das feine wird mit der Zeit aussagekraeftiger.
 */
function merkmale(beg) {
  const m = [];
  const art = (beg.art || 'AC').toUpperCase();
  m.push(`art:${art}`);
  if (beg.nutzung) m.push(`art:${art}|nutzung:${normal(beg.nutzung)}`);
  const n = Number(beg.stellplaetze_gesamt) || 0;
  if (n > 0) {
    const klasse = n <= 10 ? 'bis10' : n <= 30 ? 'bis30' : n <= 100 ? 'bis100' : 'ueber100';
    m.push(`art:${art}|groesse:${klasse}`);
  }
  return m;
}

// ---------------------------------------------------------------------
// 1. Rueckfragen
// ---------------------------------------------------------------------

const PRUEFARTEN = [
  ['feld_fehlt', 'Feld ist leer'],
  ['medium_fehlt', 'Aufnahme mit diesem Titel fehlt'],
  ['pflichtfoto_fehlt', 'Eine der Pflichtaufnahmen aus den Einstellungen fehlt'],
  ['abschnitt_fehlt', 'Abschnitt dieses Typs fehlt'],
  ['trasse_null', 'Keine Trassenlänge erfasst'],
  ['zahl_kleiner', 'Zahl unterschreitet Grenze'],
  ['text_zu_kurz', 'Text kürzer als Mindestlänge'],
  ['keine_position', 'Keine Feststellung erfasst'],
];

/** Spalten, die eine Regel abfragen darf. Alles andere wird ignoriert. */
const ERLAUBTE_FELDER = new Set([
  'netz_vnb', 'netz_art', 'netz_leistung_kw', 'netz_reserve_kw', 'netz_zaehler', 'netz_ort',
  'netz_bemerkung', 'stellplaetze_gesamt', 'stellplaetze_ausbau', 'ladepunkte_ac',
  'ladepunkte_dc', 'leistung_je_lp_kw', 'lastmanagement', 'variante_empfehlung',
  'variante_begruendung', 'foerderung_moeglich', 'foerderung_hinweis', 'risiken', 'fazit',
  'nutzung', 'adresse', 'plz', 'ort', 'begleitung',
]);

function leer(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Alle offenen Rueckfragen zu einer Begehung.
 * Beantwortete Fragen erscheinen nicht erneut.
 */
async function pruefe(begehungId) {
  const beg = await db.one('SELECT * FROM begehungen WHERE id = $1', [begehungId]);
  if (!beg) return { offen: [], streng: [], beantwortet: [] };

  const [regeln, abschnitte, medienListe, positionen, antworten] = await Promise.all([
    db.all('SELECT * FROM pruefregeln WHERE aktiv = TRUE ORDER BY reihenfolge, id'),
    db.all('SELECT typ, laenge_m FROM begehung_abschnitte WHERE begehung_id = $1', [begehungId]),
    db.all('SELECT titel FROM begehung_medien WHERE begehung_id = $1', [begehungId]),
    db.all('SELECT id FROM begehung_positionen WHERE begehung_id = $1', [begehungId]),
    db.all('SELECT * FROM begehung_antworten WHERE begehung_id = $1', [begehungId]),
  ]);

  const pflicht = String(await h.einstellung('begehung_pflichtfotos', ''))
    .split(',').map((x) => x.trim()).filter(Boolean);

  const beantwortetIds = new Set(antworten.filter((a) => a.erledigt).map((a) => a.regel_id));
  const typen = new Set(abschnitte.map((a) => (a.typ || '').trim()));
  const titel = new Set(medienListe.map((m) => (m.titel || '').trim()));
  const trasse = abschnitte.reduce((s, a) => s + (Number(a.laenge_m) || 0), 0);
  const art = (beg.art || 'AC').toUpperCase();

  const fehlendeFotos = pflicht.filter((x) => !titel.has(x));

  const offen = [];
  for (const r of regeln) {
    if (r.gilt_fuer_art && r.gilt_fuer_art.toUpperCase() !== art) continue;
    if (beantwortetIds.has(r.id)) continue;

    let trifftZu = false;
    switch (r.pruefart) {
      case 'feld_fehlt':
        if (ERLAUBTE_FELDER.has(r.parameter)) trifftZu = leer(beg[r.parameter]);
        break;
      case 'medium_fehlt':
        trifftZu = !titel.has(String(r.parameter || '').trim());
        break;
      case 'pflichtfoto_fehlt':
        // Die Liste steht in den Einstellungen — eine Pflege, nicht zwei.
        trifftZu = fehlendeFotos.length > 0;
        break;
      case 'abschnitt_fehlt':
        trifftZu = !typen.has(String(r.parameter || '').trim());
        break;
      case 'trasse_null':
        trifftZu = trasse <= 0;
        break;
      case 'zahl_kliener': // Tippfehler-Toleranz: alte Datensaetze
      case 'zahl_kleiner':
        if (ERLAUBTE_FELDER.has(r.parameter)) {
          const z = Number(beg[r.parameter]);
          trifftZu = !Number.isFinite(z) || z < Number(r.vergleich || 0);
        }
        break;
      case 'text_zu_kurz':
        if (ERLAUBTE_FELDER.has(r.parameter)) {
          const t = String(beg[r.parameter] || '').trim();
          trifftZu = t.length < Number(r.vergleich || 1);
        }
        break;
      case 'keine_position':
        trifftZu = positionen.length === 0;
        break;
      default:
        trifftZu = false;
    }
    if (trifftZu) {
      offen.push(r.pruefart === 'pflichtfoto_fehlt'
        ? { ...r, frage: `${r.frage} Es fehlen: ${fehlendeFotos.join(' · ')}` }
        : r);
    }
  }

  const beantwortet = antworten
    .filter((a) => a.erledigt && a.antwort)
    .map((a) => ({ ...a, regel: regeln.find((r) => r.id === a.regel_id) || null }));

  return {
    offen,
    streng: offen.filter((r) => r.streng),
    beantwortet,
    trasse,
    fehlendeFotos,
  };
}

// ---------------------------------------------------------------------
// 2. Lernen aus dem Ergebnis
// ---------------------------------------------------------------------

/**
 * Ein beauftragtes Angebot auswerten.
 * Nur beauftragte Angebote zaehlen — ein Entwurf sagt nichts darueber aus,
 * was der Markt tatsaechlich kauft. Jedes Angebot wird nur einmal gezaehlt.
 */
async function lerneAusAngebot(angebotId) {
  const a = await db.one('SELECT * FROM angebote WHERE id = $1', [angebotId]);
  if (!a || a.status !== 'Beauftragt' || a.gelernt_am) return { gelernt: 0 };
  if (!a.begehung_id) {
    // Ohne Begehung fehlt der Objekttyp — dann gibt es nichts zu vergleichen.
    await db.query('UPDATE angebote SET gelernt_am = now() WHERE id = $1', [angebotId]);
    return { gelernt: 0 };
  }
  const beg = await db.one('SELECT * FROM begehungen WHERE id = $1', [a.begehung_id]);
  if (!beg) return { gelernt: 0 };

  const positionen = await db.all(
    `SELECT text, einheit FROM angebot_positionen
      WHERE angebot_id = $1 AND ist_titel = FALSE AND menge > 0`, [angebotId]
  );
  const schluessel = merkmale(beg);

  await db.tx(async (c) => {
    for (const m of schluessel) {
      await c.query(
        `INSERT INTO merkmal_zaehler (merkmal, gesamt, zuletzt_am) VALUES ($1,1,now())
         ON CONFLICT (merkmal) DO UPDATE SET gesamt = merkmal_zaehler.gesamt + 1, zuletzt_am = now()`,
        [m]
      );
      for (const p of positionen) {
        const t = String(p.text || '').trim();
        if (t.length < 6) continue;
        await c.query(
          `INSERT INTO erfahrungen (merkmal, text, einheit, treffer, zuletzt_am, beispiel)
           VALUES ($1,$2,$3,1,now(),$4)
           ON CONFLICT (merkmal, md5(text))
           DO UPDATE SET treffer = erfahrungen.treffer + 1, zuletzt_am = now()`,
          [m, t, p.einheit, a.nummer]
        );
      }
    }
    await c.query('UPDATE angebote SET gelernt_am = now() WHERE id = $1', [angebotId]);
  });

  return { gelernt: positionen.length, merkmale: schluessel };
}

// ---------------------------------------------------------------------
// 3. Vorschlaege
// ---------------------------------------------------------------------

/** Mindestens so viele vergleichbare Auftraege, bevor etwas vorgeschlagen wird. */
const MINDESTBASIS = 2;
/** Ab diesem Anteil gilt eine Position als ueblich. */
const SCHWELLE = 0.5;

/**
 * Was bei vergleichbaren Objekten ueblich war und hier noch fehlt.
 * Der Vergleich laeuft ueber die Positionstexte des Angebots bzw. der
 * Feststellungen — nicht ueber Kennungen, weil Positionen frei formuliert
 * werden. Deshalb wird grosszuegig normalisiert verglichen.
 */
async function vorschlaege(begehungId, vorhandeneTexte = []) {
  const beg = await db.one('SELECT * FROM begehungen WHERE id = $1', [begehungId]);
  if (!beg) return [];

  const schluessel = merkmale(beg);
  const zaehler = await db.all(
    'SELECT * FROM merkmal_zaehler WHERE merkmal = ANY($1::text[])', [schluessel]
  );
  const basis = new Map(zaehler.map((z) => [z.merkmal, z.gesamt]));
  const brauchbar = schluessel.filter((m) => (basis.get(m) || 0) >= MINDESTBASIS);
  if (!brauchbar.length) return [];

  const rows = await db.all(
    `SELECT * FROM erfahrungen WHERE merkmal = ANY($1::text[]) ORDER BY treffer DESC`,
    [brauchbar]
  );

  const schon = new Set(vorhandeneTexte.map((t) => normal(t)));
  const gesehen = new Set();
  const raus = [];

  for (const e of rows) {
    const gesamt = basis.get(e.merkmal) || 0;
    if (!gesamt) continue;
    const anteil = e.treffer / gesamt;
    if (anteil < SCHWELLE) continue;

    const k = normal(e.text);
    if (schon.has(k) || gesehen.has(k)) continue;
    gesehen.add(k);

    raus.push({
      text: e.text,
      einheit: e.einheit,
      treffer: e.treffer,
      gesamt,
      anteil,
      merkmal: e.merkmal,
      begruendung: `Bei ${e.treffer} von ${gesamt} vergleichbaren Objekten war diese Position dabei.`,
    });
  }
  // Die spezifischeren Merkmale (mit "|") zuerst, dann nach Haeufigkeit.
  raus.sort((a, b) => (b.merkmal.includes('|') - a.merkmal.includes('|')) || (b.anteil - a.anteil));
  return raus.slice(0, 12);
}

// ---------------------------------------------------------------------
// 4. Stueckliste
// ---------------------------------------------------------------------

/**
 * Materialliste aus den Mengen der Begehung.
 * Jede Zeile traegt ihre Rechnung sichtbar mit — 42 m Trasse x 1,00 + 5 %
 * ist nachpruefbar, "44 m" allein nicht.
 */
async function stueckliste(begehungId) {
  const beg = await db.one('SELECT * FROM begehungen WHERE id = $1', [begehungId]);
  if (!beg) return { gruppen: [], grundlage: null };

  const t = await db.one(
    'SELECT COALESCE(SUM(laenge_m),0) AS m FROM begehung_abschnitte WHERE begehung_id = $1', [begehungId]
  );
  const abschnitte = await db.all(
    'SELECT typ, COUNT(*)::int AS n FROM begehung_abschnitte WHERE begehung_id = $1 GROUP BY typ', [begehungId]
  );
  const proTyp = new Map(abschnitte.map((a) => [(a.typ || '').trim(), a.n]));

  const grundlage = {
    trassenlaenge: Number(t.m) || 0,
    stellplaetze_gesamt: Number(beg.stellplaetze_gesamt) || 0,
    stellplaetze_ausbau: Number(beg.stellplaetze_ausbau) || 0,
    ladepunkte_ac: Number(beg.ladepunkte_ac) || 0,
    ladepunkte_dc: Number(beg.ladepunkte_dc) || 0,
    art: (beg.art || 'AC').toUpperCase(),
  };

  const regeln = await db.all(
    'SELECT * FROM stueckliste_regeln WHERE aktiv = TRUE ORDER BY reihenfolge, id'
  );

  const gruppen = new Map();
  for (const r of regeln) {
    if (r.gilt_fuer_art && r.gilt_fuer_art.toUpperCase() !== grundlage.art) continue;

    let bezugswert;
    let bezugstext;
    if (r.bezug === 'fest') { bezugswert = 1; bezugstext = 'fest'; }
    else if (r.bezug === 'abschnitt_typ') {
      bezugswert = proTyp.get(String(r.parameter || '').trim()) || 0;
      bezugstext = `${bezugswert} × Abschnitt „${r.parameter}"`;
    } else if (grundlage[r.bezug] != null) {
      bezugswert = grundlage[r.bezug];
      bezugstext = `${new Intl.NumberFormat('de-DE').format(bezugswert)} ${r.bezug === 'trassenlaenge' ? 'm Trasse' : 'Stk.'}`;
    } else { continue; }

    if (!bezugswert) continue;

    const roh = bezugswert * Number(r.faktor);
    const mitZuschlag = roh * (1 + Number(r.verschnitt_pct) / 100);
    const menge = r.aufrunden ? Math.ceil(mitZuschlag) : Math.round(mitZuschlag * 100) / 100;

    const rechnung = [
      bezugstext,
      Number(r.faktor) !== 1 ? `× ${Number(r.faktor)}` : null,
      Number(r.verschnitt_pct) ? `+ ${Number(r.verschnitt_pct)} % Verschnitt` : null,
      r.aufrunden ? 'aufgerundet' : null,
    ].filter(Boolean).join(' ');

    const g = r.gruppe || 'Sonstiges';
    if (!gruppen.has(g)) gruppen.set(g, []);
    gruppen.get(g).push({
      artikel: r.artikel, beschreibung: r.beschreibung, einheit: r.einheit,
      menge, rechnung, regel_id: r.id,
    });
  }

  return {
    grundlage,
    gruppen: [...gruppen.entries()].map(([name, zeilen]) => ({ name, zeilen })),
  };
}

module.exports = {
  PRUEFARTEN, ERLAUBTE_FELDER, MINDESTBASIS, SCHWELLE,
  merkmale, normal, pruefe, lerneAusAngebot, vorschlaege, stueckliste,
};
