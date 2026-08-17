'use strict';
/**
 * Übernahme der Altdaten aus der Vorgängerversion.
 *
 * Bewusst als eigene Bibliothek, damit derselbe Code sowohl vom Skript
 * (scripts/import_altdaten.js) als auch von der Verwaltungsoberfläche genutzt
 * wird — und nicht zwei Fassungen auseinanderlaufen.
 *
 * Die Datei mit den Altdaten enthält personenbezogene Daten und liegt deshalb
 * NICHT im Repository. Sie wird einmalig über die Verwaltung hochgeladen.
 *
 * Wiederholtes Ausführen ist unbedenklich: Ein Kunde, den es schon gibt, wird
 * übersprungen und nicht überschrieben.
 */

const db = require('./db');

function alsDatum(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * @param {Array} zeilen  Inhalt der Altdatendatei
 * @returns {{gesamt:number, neu:number, vorhanden:number, uebersprungen:number, namen:string[]}}
 */
async function uebernehmen(zeilen) {
  if (!Array.isArray(zeilen)) {
    throw new Error('Die Datei enthält keine Liste von Datensätzen.');
  }

  const bericht = { gesamt: zeilen.length, neu: 0, vorhanden: 0, uebersprungen: 0, namen: [] };

  for (const z of zeilen) {
    const firma = String((z && z.firma) || '').trim();
    if (!firma) { bericht.uebersprungen += 1; continue; }

    const schon = await db.one('SELECT id FROM kunden WHERE lower(firma) = lower($1)', [firma]);
    if (schon) { bericht.vorhanden += 1; continue; }

    await db.tx(async (c) => {
      const k = (await c.query(
        'INSERT INTO kunden (firma, branche, quelle) VALUES ($1,$2,$3) RETURNING id',
        [firma, z.branche || null, 'Altdaten WWtec-Kundenliste']
      )).rows[0];

      for (const [name, telefon] of [[z.ap1, z.kontakt1], [z.ap2, z.kontakt2]]) {
        if (!name && !telefon) continue;
        await c.query(
          'INSERT INTO ansprechpartner (kunde_id, name, telefon) VALUES ($1,$2,$3)',
          [k.id, name || null, telefon || null]
        );
      }

      const phase = z.termin_am
        ? 'Projektbesprechung'
        : (z.kontakt_aufgenommen ? 'Kontaktaufnahme' : 'Terminanfrage');

      const p = (await c.query(
        `INSERT INTO projekte (kunde_id, bezeichnung, beschreibung, phase, potential, letzte_aktivitaet)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now())) RETURNING id`,
        [k.id, `Ladeinfrastruktur ${firma}`, z.termin_zsf || null, phase,
         z.potential || null, alsDatum(z.termin_am) || alsDatum(z.kontakt_aufgenommen)]
      )).rows[0];

      if (z.termin_am) {
        await c.query(
          `INSERT INTO termine (kunde_id, projekt_id, typ, mit_wem, datum, uhrzeit, ort, thema, bestaetigt, status, ergebnis)
           VALUES ($1,$2,'Kunde',$3,$4::date,$5,$6,$7,'ja','durchgeführt',$8)`,
          [k.id, p.id, z.ap1 || null, alsDatum(z.termin_am), z.termin_um || null,
           z.termin_ort || null, 'Erstgespräch (aus Altdaten)', z.termin_zsf || null]
        );
      }

      for (const eintrag of (z.activities || [])) {
        const [datum, text] = Array.isArray(eintrag) ? eintrag : [null, String(eintrag)];
        if (!text) continue;
        await c.query(
          'INSERT INTO aktivitaeten (kunde_id, projekt_id, datum, text) VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4)',
          [k.id, p.id, alsDatum(datum), text]
        );
      }

      if (z.rueckmeldung) {
        await c.query(
          'INSERT INTO aktivitaeten (kunde_id, projekt_id, text) VALUES ($1,$2,$3)',
          [k.id, p.id, `Rückmeldung aus Altdaten: ${z.rueckmeldung}`]
        );
      }
    });

    bericht.neu += 1;
    if (bericht.namen.length < 60) bericht.namen.push(firma);
  }

  return bericht;
}

module.exports = { uebernehmen };
