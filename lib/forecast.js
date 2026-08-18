'use strict';
/**
 * Soll, Ist, Abweichung und Hochrechnung.
 *
 * Zwei Regeln, die alles andere bestimmen:
 *
 *  1. Der Ist-Wert wird nie gespeichert, sondern immer aus den Belegen
 *     gerechnet. Eine gespeicherte Ist-Zahl waere binnen einer Woche falsch,
 *     und niemand wuesste, warum.
 *  2. Die Hochrechnung sagt dazu, woraus sie besteht. Eine Zahl, die
 *     Gewissheit vortaeuscht, ist im Vertrieb gefaehrlicher als gar keine.
 *
 * Umsatz  = festgeschriebene Rechnungen (ohne Stornos), nach Rechnungsdatum.
 * Eingang = beauftragte Angebote, nach Angebotsdatum.
 */

const db = require('./db');
const h = require('./helfer');

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/**
 * Ist-Umsatz je Monat eines Jahres.
 * Stornorechnungen zaehlen negativ — sie sind der einzige zulaessige Weg,
 * eine festgeschriebene Rechnung zu korrigieren, und muessen deshalb auch
 * in der Auswertung durchschlagen.
 */
async function umsatzMonate(jahr, benutzerId = null) {
  const wo = benutzerId ? 'AND r.erstellt_von = $2' : '';
  const p = benutzerId ? [jahr, benutzerId] : [jahr];
  const rows = await db.all(`
    SELECT EXTRACT(MONTH FROM r.datum)::int AS monat,
           COALESCE(SUM(CASE WHEN r.art = 'storno' THEN -r.netto ELSE r.netto END), 0) AS wert
      FROM rechnungen r
     WHERE EXTRACT(YEAR FROM r.datum) = $1
       AND r.festgeschrieben = TRUE ${wo}
     GROUP BY 1 ORDER BY 1`, p);
  const m = new Array(12).fill(0);
  for (const r of rows) m[r.monat - 1] = Number(r.wert);
  return m;
}

/** Auftragseingang je Monat: beauftragte Angebote. */
async function eingangMonate(jahr, benutzerId = null) {
  const wo = benutzerId ? 'AND a.erstellt_von = $2' : '';
  const p = benutzerId ? [jahr, benutzerId] : [jahr];
  const rows = await db.all(`
    SELECT EXTRACT(MONTH FROM a.datum)::int AS monat, COALESCE(SUM(a.netto), 0) AS wert
      FROM angebote a
     WHERE EXTRACT(YEAR FROM a.datum) = $1 AND a.status = 'Beauftragt' ${wo}
     GROUP BY 1 ORDER BY 1`, p);
  const m = new Array(12).fill(0);
  for (const r of rows) m[r.monat - 1] = Number(r.wert);
  return m;
}

/** Ziele eines Jahres, aufgeloest auf zwoelf Monate. */
async function zieleMonate(jahr, art = 'umsatz', benutzerId = null) {
  const rows = await db.all(
    `SELECT periode, periode_nr, wert FROM ziele
      WHERE jahr = $1 AND art = $2 AND COALESCE(benutzer_id, 0) = $3`,
    [jahr, art, benutzerId || 0]
  );
  const m = new Array(12).fill(0);
  let jahresziel = null;
  const quartale = new Array(4).fill(null);

  for (const r of rows) {
    const w = Number(r.wert);
    if (r.periode === 'monat' && r.periode_nr >= 1 && r.periode_nr <= 12) m[r.periode_nr - 1] = w;
    else if (r.periode === 'quartal' && r.periode_nr >= 1 && r.periode_nr <= 4) quartale[r.periode_nr - 1] = w;
    else if (r.periode === 'jahr') jahresziel = w;
  }

  // Feineres schlaegt groeberes: ein Monatsziel gilt, ein Quartalsziel wird
  // nur auf die Monate verteilt, die selbst keines haben.
  for (let q = 0; q < 4; q += 1) {
    if (quartale[q] == null) continue;
    const idx = [q * 3, q * 3 + 1, q * 3 + 2];
    const offen = idx.filter((i) => !m[i]);
    const belegt = idx.filter((i) => m[i]).reduce((s, i) => s + m[i], 0);
    if (offen.length) {
      const rest = (quartale[q] - belegt) / offen.length;
      for (const i of offen) m[i] = rest > 0 ? rest : 0;
    }
  }
  if (jahresziel != null) {
    const offen = m.map((v, i) => (v ? null : i)).filter((i) => i !== null);
    const belegt = m.reduce((s, v) => s + v, 0);
    if (offen.length) {
      const rest = (jahresziel - belegt) / offen.length;
      for (const i of offen) m[i] = rest > 0 ? rest : 0;
    }
  }
  return { monate: m, jahresziel, quartale };
}

/** Offene Pipeline: was noch kommen kann. */
async function pipeline(jahr, benutzerId = null) {
  const wo = benutzerId ? 'AND a.erstellt_von = $2' : '';
  const p = benutzerId ? [jahr, benutzerId] : [jahr];
  const r = await db.one(`
    SELECT
      COALESCE(SUM(CASE WHEN a.status = 'Versendet' THEN a.netto END), 0) AS versendet,
      COALESCE(SUM(CASE WHEN a.status = 'Beauftragt'
                         AND NOT EXISTS (SELECT 1 FROM rechnungen x
                                          WHERE x.angebot_id = a.id AND x.festgeschrieben)
                        THEN a.netto END), 0) AS beauftragt_offen
      FROM angebote a
     WHERE EXTRACT(YEAR FROM a.datum) = $1 ${wo}`, p);
  return { versendet: Number(r.versendet), beauftragtOffen: Number(r.beauftragt_offen) };
}

function quartalAus(monate) {
  return [0, 1, 2, 3].map((q) => monate.slice(q * 3, q * 3 + 3).reduce((s, v) => s + v, 0));
}

/**
 * Vollstaendige Auswertung eines Jahres.
 * `bisMonat` trennt Vergangenheit von Zukunft — nur bis dorthin ist ein
 * Soll-Ist-Vergleich ehrlich. Was danach kommt, ist Plan, nicht Rueckstand.
 */
async function jahr(jahrZahl, art = 'umsatz', benutzerId = null, heute = new Date()) {
  const istMonate = art === 'auftragseingang'
    ? await eingangMonate(jahrZahl, benutzerId)
    : await umsatzMonate(jahrZahl, benutzerId);
  const { monate: sollMonate, jahresziel } = await zieleMonate(jahrZahl, art, benutzerId);
  const pipe = await pipeline(jahrZahl, benutzerId);
  const e = await h.einstellungen();

  const laufend = heute.getFullYear() === jahrZahl;
  const bisMonat = laufend ? heute.getMonth() + 1 : 12;

  const istSumme = istMonate.reduce((s, v) => s + v, 0);
  const sollSumme = sollMonate.reduce((s, v) => s + v, 0);
  const sollBisher = sollMonate.slice(0, bisMonat).reduce((s, v) => s + v, 0);

  // Hochrechnung: was schon da ist, plus die gewichtete Pipeline.
  const gVersendet = Number(e.forecast_gewicht_versendet || 40) / 100;
  const gBeauftragt = Number(e.forecast_gewicht_beauftragt || 95) / 100;
  const erwartet = pipe.beauftragtOffen * gBeauftragt + pipe.versendet * gVersendet;
  const hochrechnung = laufend ? istSumme + erwartet : istSumme;

  const abwMonate = istMonate.map((v, i) => v - sollMonate[i]);

  return {
    jahr: jahrZahl, art, benutzerId, laufend, bisMonat,
    monate: MONATE, monateKurz: MONATE_KURZ,
    ist: istMonate, soll: sollMonate, abweichung: abwMonate,
    istQuartal: quartalAus(istMonate), sollQuartal: quartalAus(sollMonate),
    abweichungQuartal: quartalAus(istMonate).map((v, i) => v - quartalAus(sollMonate)[i]),
    istSumme, sollSumme, sollBisher, jahresziel,
    abweichungBisher: istSumme - sollBisher,
    erfuellungBisher: sollBisher > 0 ? istSumme / sollBisher : null,
    erfuellungJahr: sollSumme > 0 ? istSumme / sollSumme : null,
    pipeline: pipe,
    gewichte: { versendet: gVersendet, beauftragt: gBeauftragt },
    erwartet, hochrechnung,
    hochrechnungErfuellung: sollSumme > 0 ? hochrechnung / sollSumme : null,
  };
}

/**
 * Prämienstand je Mitarbeiter.
 * Die Rechnung wird mitgeliefert, nicht nur das Ergebnis — wer eine Prämie
 * nicht nachrechnen kann, glaubt sie auch nicht.
 */
async function praemien(jahrZahl, heute = new Date()) {
  const regeln = await db.all(`
    SELECT p.*, u.name FROM praemien p JOIN benutzer u ON u.id = p.benutzer_id
     WHERE p.jahr = $1 ORDER BY u.name, p.periode, p.periode_nr`, [jahrZahl]);
  if (!regeln.length) return [];

  const raus = [];
  for (const r of regeln) {
    const istMonate = r.art === 'auftragseingang'
      ? await eingangMonate(jahrZahl, r.benutzer_id)
      : await umsatzMonate(jahrZahl, r.benutzer_id);

    let ist = 0;
    let bezeichnung = '';
    if (r.periode === 'quartal') {
      const q = Math.min(Math.max(Number(r.periode_nr), 1), 4);
      ist = istMonate.slice((q - 1) * 3, q * 3).reduce((s, v) => s + v, 0);
      bezeichnung = `Q${q} ${jahrZahl}`;
    } else if (r.periode === 'monat') {
      const m = Math.min(Math.max(Number(r.periode_nr), 1), 12);
      ist = istMonate[m - 1];
      bezeichnung = `${MONATE[m - 1]} ${jahrZahl}`;
    } else {
      ist = istMonate.reduce((s, v) => s + v, 0);
      bezeichnung = `Jahr ${jahrZahl}`;
    }

    const ziel = Number(r.ziel_wert);
    const erreichtPct = ziel > 0 ? (ist / ziel) * 100 : 0;
    const schwelle = Number(r.schwelle_pct);
    const deckel = Number(r.deckel_pct);
    const angerechnet = Math.min(erreichtPct, deckel);
    const praemie = erreichtPct >= schwelle
      ? Math.round(Number(r.praemie_voll) * angerechnet) / 100
      : 0;

    raus.push({
      id: r.id, benutzerId: r.benutzer_id, name: r.name, bezeichnung,
      art: r.art, ziel, ist, erreichtPct, schwelle, deckel, angerechnet,
      praemieVoll: Number(r.praemie_voll), praemie,
      unterSchwelle: erreichtPct < schwelle,
      amDeckel: erreichtPct > deckel,
      rechnung: erreichtPct < schwelle
        ? `${erreichtPct.toFixed(1)} % erreicht — unter der Schwelle von ${schwelle} %, daher keine Prämie.`
        : `${Number(r.praemie_voll).toLocaleString('de-DE', { minimumFractionDigits: 2 })} € × ${angerechnet.toFixed(1)} %`
          + (erreichtPct > deckel ? ` (auf den Deckel von ${deckel} % begrenzt)` : ''),
      hinweis: r.hinweis,
    });
  }
  return raus;
}

/** Umsatzanteile für die Tortendarstellung. Rest wird gebündelt. */
async function anteile(jahrZahl, nach = 'kunde', grenze = 5) {
  const spalte = nach === 'gewerk' ? "COALESCE(NULLIF(p.gewerk,''),'ohne Gewerk')" : 'k.firma';
  const rows = await db.all(`
    SELECT ${spalte} AS name,
           COALESCE(SUM(CASE WHEN r.art = 'storno' THEN -r.netto ELSE r.netto END), 0) AS wert
      FROM rechnungen r
      LEFT JOIN kunden k ON k.id = r.kunde_id
      LEFT JOIN projekte p ON p.id = r.projekt_id
     WHERE EXTRACT(YEAR FROM r.datum) = $1 AND r.festgeschrieben = TRUE
     GROUP BY 1 HAVING COALESCE(SUM(CASE WHEN r.art = 'storno' THEN -r.netto ELSE r.netto END), 0) > 0
     ORDER BY 2 DESC`, [jahrZahl]);

  const alle = rows.map((r) => ({ name: r.name || 'ohne Zuordnung', wert: Number(r.wert) }));
  if (alle.length <= grenze) return alle;
  const oben = alle.slice(0, grenze);
  const rest = alle.slice(grenze).reduce((s, x) => s + x.wert, 0);
  if (rest > 0) oben.push({ name: `${alle.length - grenze} weitere`, wert: rest });
  return oben;
}

module.exports = {
  MONATE, MONATE_KURZ,
  umsatzMonate, eingangMonate, zieleMonate, pipeline, jahr, praemien, anteile, quartalAus,
};
