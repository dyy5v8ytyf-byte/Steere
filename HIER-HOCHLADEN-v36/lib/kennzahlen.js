'use strict';
/**
 * Finanzkennzahlen.
 *
 * Alle Werte kommen ausschliesslich aus dieser Datenbank — es gibt keine
 * gepflegte Nebenrechnung und keine Zahl, die jemand von Hand eintragen
 * muesste. Was hier steht, laesst sich auf einen Beleg zurueckfuehren.
 *
 * Bewusste Festlegungen, damit die Zahlen vergleichbar bleiben:
 *   - Umsatz zaehlt nach Rechnungsdatum, nicht nach Zahlungseingang.
 *   - Stornorechnungen zaehlen negativ und heben die Ursprungsrechnung auf.
 *   - Angebotsvolumen zaehlt nur Angebote im Status "Versendet".
 *   - Auftragsbestand = beauftragt, aber noch nicht abgerechnet.
 */

const db = require('./db');

async function uebersicht() {
  const k = await db.one(`
    SELECT
      (SELECT COALESCE(SUM(netto),0) FROM angebote WHERE status = 'Versendet')            AS angebote_offen,
      (SELECT COUNT(*)::int         FROM angebote WHERE status = 'Versendet')            AS angebote_anzahl,
      (SELECT COALESCE(SUM(netto),0) FROM angebote WHERE status = 'Beauftragt')           AS beauftragt,
      (SELECT COALESCE(SUM(CASE WHEN art='storno' THEN -netto ELSE netto END),0)
         FROM rechnungen WHERE festgeschrieben
           AND date_trunc('year', datum) = date_trunc('year', CURRENT_DATE))              AS umsatz_jahr,
      (SELECT COALESCE(SUM(CASE WHEN art='storno' THEN -netto ELSE netto END),0)
         FROM rechnungen WHERE festgeschrieben
           AND date_trunc('month', datum) = date_trunc('month', CURRENT_DATE))            AS umsatz_monat,
      (SELECT COALESCE(SUM(brutto),0) FROM rechnungen
        WHERE festgeschrieben AND bezahlt_am IS NULL AND ausgeglichen_am IS NULL AND art <> 'storno')                 AS offen_gesamt,
      (SELECT COALESCE(SUM(brutto),0) FROM rechnungen
        WHERE festgeschrieben AND bezahlt_am IS NULL AND ausgeglichen_am IS NULL AND art <> 'storno'
          AND faellig_am < CURRENT_DATE)                                                  AS ueberfaellig,
      (SELECT COUNT(*)::int FROM rechnungen
        WHERE festgeschrieben AND bezahlt_am IS NULL AND ausgeglichen_am IS NULL AND art <> 'storno'
          AND faellig_am < CURRENT_DATE)                                                  AS ueberfaellig_anzahl,
      (SELECT COALESCE(SUM(entgelt_netto),0) FROM retainer WHERE aktiv)                   AS retainer_monat,
      (SELECT COUNT(*)::int FROM begehungen WHERE status IN ('geplant','vor Ort'))        AS begehungen_offen,
      (SELECT COUNT(*)::int FROM begehungen WHERE status = 'erfasst')                     AS begehungen_erfasst
  `);

  // Auftragsbestand: beauftragte Angebote abzueglich dessen, was dazu bereits
  // in Rechnung gestellt wurde.
  const bestand = await db.one(`
    SELECT COALESCE(SUM(a.netto),0) - COALESCE((
      SELECT SUM(CASE WHEN r.art='storno' THEN -r.netto ELSE r.netto END)
        FROM rechnungen r
       WHERE r.festgeschrieben AND r.angebot_id IN (SELECT id FROM angebote WHERE status='Beauftragt')
    ),0) AS wert
      FROM angebote a WHERE a.status = 'Beauftragt'
  `);
  k.auftragsbestand = Number(bestand.wert);

  return k;
}

/** Umsatz je Monat der letzten zwölf Monate — Grundlage für den Verlauf. */
async function umsatzverlauf(monate = 12) {
  return db.all(`
    WITH reihe AS (
      SELECT date_trunc('month', CURRENT_DATE) - (n || ' months')::interval AS monat
        FROM generate_series(0, $1::int - 1) AS n
    )
    SELECT to_char(r.monat, 'YYYY-MM') AS monat,
           COALESCE(SUM(CASE WHEN re.art='storno' THEN -re.netto ELSE re.netto END), 0) AS umsatz,
           COUNT(re.id)::int AS anzahl
      FROM reihe r
      LEFT JOIN rechnungen re
             ON date_trunc('month', re.datum) = r.monat AND re.festgeschrieben
     GROUP BY r.monat
     ORDER BY r.monat
  `, [monate]);
}

/** Die zehn umsatzstärksten Kunden im laufenden Jahr. */
async function topKunden(anzahl = 10) {
  return db.all(`
    SELECT k.id, k.firma,
           SUM(CASE WHEN r.art='storno' THEN -r.netto ELSE r.netto END) AS umsatz,
           COUNT(*)::int AS rechnungen
      FROM rechnungen r JOIN kunden k ON k.id = r.kunde_id
     WHERE r.festgeschrieben
       AND date_trunc('year', r.datum) = date_trunc('year', CURRENT_DATE)
     GROUP BY k.id, k.firma
     HAVING SUM(CASE WHEN r.art='storno' THEN -r.netto ELSE r.netto END) <> 0
     ORDER BY umsatz DESC
     LIMIT $1
  `, [anzahl]);
}

/** Offene Posten nach Alter — die Frage "wer schuldet uns wie lange schon". */
async function offenePosten() {
  return db.all(`
    SELECT r.id, r.nummer, r.datum, r.faellig_am, r.brutto, k.firma,
           (CURRENT_DATE - r.faellig_am)::int AS tage_ueberfaellig
      FROM rechnungen r JOIN kunden k ON k.id = r.kunde_id
     WHERE r.festgeschrieben AND r.bezahlt_am IS NULL AND r.art <> 'storno'
     ORDER BY r.faellig_am NULLS LAST
  `);
}

/** Retainer-Auslastung im laufenden Monat je Organisation. */
async function retainerAuslastung(monat = null) {
  const m = monat || new Date().toISOString().slice(0, 7);
  return db.all(`
    SELECT r.id, r.bezeichnung, o.name AS organisation, r.stunden_monat, r.entgelt_netto,
           COALESCE((SELECT SUM(stunden) FROM leistungen l
                      WHERE l.retainer_id = r.id AND l.monat = $1), 0)
         + COALESCE((SELECT SUM(stunden) FROM zeiterfassung z
                      WHERE z.retainer_id = r.id AND z.monat = $1 AND z.im_retainer), 0) AS ist_stunden,
           COALESCE((SELECT SUM(stunden) FROM zeiterfassung z
                      WHERE z.retainer_id = r.id AND z.monat = $1 AND NOT z.im_retainer), 0) AS extra_stunden,
           COALESCE((SELECT SUM(km) FROM zeiterfassung z
                      WHERE z.retainer_id = r.id AND z.monat = $1), 0) AS km
      FROM retainer r JOIN organisationen o ON o.id = r.organisation_id
     WHERE r.aktiv
     ORDER BY o.name
  `, [m]);
}

module.exports = { uebersicht, umsatzverlauf, topKunden, offenePosten, retainerAuslastung };
