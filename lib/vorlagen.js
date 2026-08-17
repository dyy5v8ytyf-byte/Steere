'use strict';
/**
 * Angebotsvorlagen und Textbausteine.
 *
 * Eine Vorlage ist der Textrahmen eines Angebots plus ein Positionsgeruest.
 * Die Mengen kommen, wo moeglich, aus der Begehung; die Preise kommen NIE aus
 * der Vorlage, wenn sie dort nicht ausdruecklich hinterlegt sind. Das ist
 * Absicht: eine Vorlage soll die Sprache vereinheitlichen, nicht die
 * Kalkulation ersetzen.
 *
 * Textbausteine sind der Speicher, der mit der Nutzung waechst. Was einmal
 * getippt wurde, steht beim naechsten Mal zur Auswahl.
 */

const db = require('./db');
const h = require('./helfer');

const MENGEN_QUELLEN = [
  ['fest', 'Feste Menge'],
  ['stellplaetze_gesamt', 'Stellplätze gesamt (aus Begehung)'],
  ['stellplaetze_ausbau', 'Stellplätze im Ausbau (aus Begehung)'],
  ['ladepunkte_ac', 'Ladepunkte AC (aus Begehung)'],
  ['ladepunkte_dc', 'Ladepunkte DC (aus Begehung)'],
  ['trassenlaenge', 'Trassenlänge in m (Summe der Abschnitte)'],
  ['offen', 'Offen — muss von Hand gesetzt werden'],
];
const QUELLEN_SCHLUESSEL = MENGEN_QUELLEN.map((q) => q[0]);

const KATEGORIEN = [
  ['einleitung', 'Einleitung'],
  ['vorbemerkung', 'Vorbemerkung'],
  ['hinweis', 'Hinweis / Vorbehalt'],
  ['schluss', 'Schlusssatz'],
  ['position', 'Positionstext'],
  ['langtext', 'Langtext'],
  ['feststellung', 'Feststellung (Begehung)'],
  ['risiko', 'Risiko (Begehung)'],
  ['fazit', 'Fazit (Begehung)'],
];

/**
 * Mengenkontext einer Begehung.
 * Die Trassenlaenge ist die Summe der erfassten Abschnittslaengen — nicht
 * geschaetzt, sondern das, was vor Ort aufgenommen wurde.
 */
async function kontextAusBegehung(begehungId) {
  if (!begehungId) return null;
  const b = await db.one(
    `SELECT stellplaetze_gesamt, stellplaetze_ausbau, ladepunkte_ac, ladepunkte_dc, art
       FROM begehungen WHERE id = $1`, [begehungId]
  );
  if (!b) return null;
  const t = await db.one(
    'SELECT COALESCE(SUM(laenge_m), 0) AS m FROM begehung_abschnitte WHERE begehung_id = $1',
    [begehungId]
  );
  return {
    stellplaetze_gesamt: b.stellplaetze_gesamt,
    stellplaetze_ausbau: b.stellplaetze_ausbau,
    ladepunkte_ac: b.ladepunkte_ac,
    ladepunkte_dc: b.ladepunkte_dc,
    trassenlaenge: Number(t.m) || 0,
    art: b.art,
  };
}

/**
 * Menge einer Vorlageposition bestimmen.
 * Fehlt der Wert in der Begehung, bleibt die Menge 0 — sichtbar leer ist
 * besser als still geraten.
 */
function mengeBestimmen(pos, kontext) {
  const q = pos.menge_quelle || 'fest';
  if (q === 'fest') return Number(pos.menge_fest) || 0;
  if (q === 'offen') return 0;
  if (!kontext) return 0;
  const v = kontext[q];
  return v == null ? 0 : Number(v) || 0;
}

/** Vorlage mit Positionen laden. */
async function laden(id) {
  const v = await db.one('SELECT * FROM angebot_vorlagen WHERE id = $1', [id]);
  if (!v) return null;
  v.positionen = await db.all(
    'SELECT * FROM vorlage_positionen WHERE vorlage_id = $1 ORDER BY lfd, id', [id]
  );
  return v;
}

async function liste(nurAktive = true) {
  return db.all(`
    SELECT v.*, (SELECT COUNT(*)::int FROM vorlage_positionen p WHERE p.vorlage_id = v.id) AS positionen,
           (SELECT COUNT(*)::int FROM angebote a WHERE a.vorlage_id = v.id) AS verwendet
      FROM angebot_vorlagen v
     ${nurAktive ? 'WHERE v.aktiv = TRUE' : ''}
     ORDER BY v.ist_standard DESC, v.art, v.name`);
}

/**
 * Positionen einer Vorlage in ein bestehendes Angebot schreiben.
 * Laeuft innerhalb der uebergebenen Verbindung, damit ein Fehler nichts
 * halb Fertiges hinterlaesst.
 */
async function positionenSchreiben(c, angebotId, vorlage, kontext, art) {
  let lfd = (await c.query(
    'SELECT COALESCE(MAX(lfd),0) AS n FROM angebot_positionen WHERE angebot_id = $1', [angebotId]
  )).rows[0].n;

  let geschrieben = 0;
  for (const p of vorlage.positionen) {
    // Bloecke, die nur fuer AC oder nur fuer DC gedacht sind, ueberspringen.
    if (p.nur_bei_art && art && p.nur_bei_art !== art) continue;
    lfd += 1;
    const menge = p.ist_titel ? 0 : mengeBestimmen(p, kontext);
    const ep = p.ist_titel ? 0 : Number(p.einzelpreis) || 0;
    await c.query(
      `INSERT INTO angebot_positionen (angebot_id, lfd, ist_titel, pos, text, langtext, einheit,
                                       menge, einzelpreis, gesamtpreis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ROUND($8::numeric * $9::numeric, 2))`,
      [angebotId, lfd, p.ist_titel, p.pos, p.text, p.langtext, p.einheit,
       Number(menge).toFixed(3), Number(ep).toFixed(4)]
    );
    geschrieben += 1;
  }
  return geschrieben;
}

/** Summen eines Angebots aus seinen Positionen neu bilden. */
async function summenNeuRechnen(c, angebotId) {
  const a = (await c.query('SELECT mwst_satz FROM angebote WHERE id = $1', [angebotId])).rows[0];
  const satz = Number(a ? a.mwst_satz : 19);
  const s = (await c.query(
    `SELECT COALESCE(SUM(ROUND(menge * einzelpreis, 2)), 0) AS netto
       FROM angebot_positionen WHERE angebot_id = $1 AND ist_titel = FALSE`, [angebotId]
  )).rows[0];
  const netto = Number(s.netto);
  const mwst = Math.round(netto * satz) / 100;
  await c.query(
    'UPDATE angebote SET netto=$1, mwst=$2, brutto=$3, geaendert_am=now() WHERE id=$4',
    [netto.toFixed(2), mwst.toFixed(2), (netto + mwst).toFixed(2), angebotId]
  );
}

/**
 * Textbaustein merken.
 * Der Zaehler entscheidet spaeter ueber die Reihenfolge im Auswahlfeld —
 * haeufig Benutztes steht oben.
 */
async function merke(kategorie, text, benutzerId = null) {
  const t = h.txt(text);
  if (!t || t.length < 8 || t.length > 4000) return;
  await db.query(
    `INSERT INTO textbausteine (kategorie, text, verwendet, zuletzt_am, angelegt_von)
     VALUES ($1,$2,1,now(),$3)
     ON CONFLICT (kategorie, md5(text))
     DO UPDATE SET verwendet = textbausteine.verwendet + 1, zuletzt_am = now()`,
    [kategorie, t, benutzerId]
  );
}

/** Mehrere Kategorien in einem Rutsch merken. */
async function merkeMehrere(paare, benutzerId = null) {
  for (const [kategorie, text] of paare) {
    try { await merke(kategorie, text, benutzerId); }
    catch (e) { console.error('[STEER.E] Baustein nicht gemerkt:', e.message); }
  }
}

async function bausteine(kategorie, grenze = 40) {
  return db.all(
    `SELECT id, text, verwendet FROM textbausteine WHERE kategorie = $1
      ORDER BY verwendet DESC, id LIMIT $2`, [kategorie, grenze]
  );
}

/** Alle Bausteine gruppiert — fuer die Auswahlfelder einer Seite. */
async function bausteineFuer(kategorien) {
  const rows = await db.all(
    `SELECT kategorie, id, text, verwendet FROM textbausteine
      WHERE kategorie = ANY($1::text[]) ORDER BY kategorie, verwendet DESC, id`,
    [kategorien]
  );
  const m = {};
  for (const k of kategorien) m[k] = [];
  for (const r of rows) (m[r.kategorie] = m[r.kategorie] || []).push(r);
  return m;
}

module.exports = {
  MENGEN_QUELLEN, QUELLEN_SCHLUESSEL, KATEGORIEN,
  kontextAusBegehung, mengeBestimmen, laden, liste,
  positionenSchreiben, summenNeuRechnen,
  merke, merkeMehrere, bausteine, bausteineFuer,
};
