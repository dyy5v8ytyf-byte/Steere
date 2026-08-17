'use strict';
/**
 * Importiert den Preiskatalog aus den JSON-Dateien in db/seed/.
 * Quelle: Angebotsmatrix_S4C.xlsx (Standard-LVs Tiefbau/Elektro und
 * 428 Marktpreise aus 18 realen Altangeboten).
 *
 * Wiederholtes Ausfuehren ist unbedenklich: bereits vorhandene Positionen
 * werden aktualisiert, keine wird doppelt angelegt und keine geloescht.
 */

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const seed = path.join(__dirname, '..', 'db', 'seed');

function lade(datei) {
  const p = path.join(seed, datei);
  if (!fs.existsSync(p)) { console.warn(`  ! ${datei} nicht gefunden, uebersprungen`); return []; }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function schreibe(zeilen, abbilden, bezeichnung) {
  let neu = 0; let aktualisiert = 0;
  for (const z of zeilen) {
    const p = abbilden(z);
    if (!p.text) continue;
    const r = await db.one(
      `INSERT INTO preis_positionen
         (herkunft, gewerk, pos, kategorie, text, einheit, stoffe_ek, loehne,
          vk_aktuell, vk_ziel, markt_min, markt_median, markt_max, belege, quelle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (herkunft, coalesce(pos,''), md5(text)) DO UPDATE SET
         einheit = EXCLUDED.einheit, stoffe_ek = EXCLUDED.stoffe_ek, loehne = EXCLUDED.loehne,
         vk_aktuell = EXCLUDED.vk_aktuell, vk_ziel = EXCLUDED.vk_ziel,
         markt_min = EXCLUDED.markt_min, markt_median = EXCLUDED.markt_median,
         markt_max = EXCLUDED.markt_max, belege = EXCLUDED.belege,
         geaendert_am = now()
       RETURNING (xmax = 0) AS ist_neu`,
      [p.herkunft, p.gewerk, p.pos, p.kategorie, p.text, p.einheit, p.stoffe, p.loehne,
       p.vk_aktuell, p.vk_ziel, p.min, p.median, p.max, p.belege, p.quelle]
    );
    if (r && r.ist_neu) neu += 1; else aktualisiert += 1;
  }
  console.log(`  ${bezeichnung}: ${neu} neu, ${aktualisiert} aktualisiert`);
}

(async () => {
  await db.migrate();
  console.log('\n[STEER.E] Preiskatalog wird importiert ...');

  await schreibe(lade('preise_tiefbau.json'), (z) => ({
    herkunft: 'standard_tiefbau', gewerk: 'Tiefbau', pos: z.pos, kategorie: null,
    text: z.text, einheit: z.einheit, stoffe: null, loehne: null,
    vk_aktuell: z.vk_aktuell, vk_ziel: z.vk_ziel,
    min: null, median: null, max: null, belege: null,
    quelle: 'Standard-LV Tiefbau (Preise_StandardLVTiefbau_aktuell.xlsx)',
  }), 'Standard-LV Tiefbau');

  await schreibe(lade('preise_elektro.json'), (z) => ({
    herkunft: 'standard_elektro', gewerk: 'Elektro', pos: z.pos, kategorie: null,
    text: z.text, einheit: z.einheit, stoffe: z.stoffe, loehne: z.loehne,
    vk_aktuell: z.vk_aktuell, vk_ziel: z.vk_ziel,
    min: null, median: null, max: null, belege: null,
    quelle: 'Standard-LV Elektro (Einkaufspreise_StandardLVElektro.xlsx)',
  }), 'Standard-LV Elektro');

  await schreibe(lade('marktpreise.json'), (z) => ({
    herkunft: 'markt',
    gewerk: ['Tiefbau', 'Elektro'].includes(z.kategorie) ? z.kategorie : 'Sonstiges',
    pos: null, kategorie: z.kategorie, text: z.text, einheit: z.einheit,
    stoffe: null, loehne: null, vk_aktuell: null, vk_ziel: z.median,
    min: z.min, median: z.median, max: z.max, belege: z.belege,
    quelle: z.quelle ? `Altangebot: ${z.quelle}` : 'Altangebot',
  }), 'Marktpreise aus Altangeboten');

  const summe = await db.one('SELECT COUNT(*)::int AS n FROM preis_positionen WHERE aktiv');
  console.log(`\n[STEER.E] Preiskatalog enthaelt jetzt ${summe.n.toLocaleString('de-DE')} aktive Positionen.\n`);

  console.log('Hinweis: Die Preise spiegeln den Stand der eingelesenen Dokumente,');
  console.log('nicht die tagesaktuelle Marktlage. Vor Versand eines Angebots pruefen.\n');

  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
