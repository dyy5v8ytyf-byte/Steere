'use strict';
/**
 * Altdatenübernahme von der Kommandozeile.
 *
 *   node scripts/import_altdaten.js [pfad/zur/datei.json]
 *
 * Ohne Argument wird db/seed/altdaten_kunden.json erwartet. Diese Datei liegt
 * NICHT im Repository (personenbezogene Daten). Auf dem Server geht die
 * Übernahme bequemer über Verwaltung → Altdaten übernehmen.
 */

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { uebernehmen } = require('../lib/altdaten');

const datei = process.argv[2] || path.join(__dirname, '..', 'db', 'seed', 'altdaten_kunden.json');

(async () => {
  await db.migrate();

  if (!fs.existsSync(datei)) {
    console.log(`\nKeine Altdatendatei gefunden: ${datei}`);
    console.log('Übernahme über die Verwaltung: /verwaltung/altdaten\n');
    await db.pool.end();
    return;
  }

  const zeilen = JSON.parse(fs.readFileSync(datei, 'utf8'));
  console.log(`\n[STEER.E] ${zeilen.length} Altdatensätze werden geprüft ...`);
  const b = await uebernehmen(zeilen);
  console.log(`[STEER.E] ${b.neu} Kunde(n) übernommen, ${b.vorhanden} waren bereits vorhanden `
            + `und blieben unangetastet, ${b.uebersprungen} ohne Firmennamen übersprungen.\n`);

  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
