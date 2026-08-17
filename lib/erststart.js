'use strict';
/**
 * Ersteinrichtung beim allerersten Start.
 *
 * Hintergrund: Preiskatalog und erster Administrator wurden bisher von Hand
 * in einer Railway-Shell angelegt. Diese Shell gibt es nicht in jedem Tarif,
 * und ein Deployment, das ohne Terminal nicht benutzbar wird, ist kein
 * fertiges Deployment. Deshalb erledigt die Anwendung beides selbst — aber
 * ausschliesslich dann, wenn es noch nichts gibt.
 *
 * Die Skripte werden als eigener Prozess gestartet, nicht eingebunden. So
 * bleibt der bereits geprueft laufende Code unveraendert, und sein
 * abschliessendes pool.end() reisst nicht die Verbindung des Servers mit.
 *
 * Beides laeuft NACH app.listen(): der Port ist sofort offen, der Import
 * darf in Ruhe ein paar Sekunden brauchen.
 */

const path = require('path');
const { fork } = require('child_process');
const db = require('./db');

const WURZEL = path.join(__dirname, '..');

/** Ein Einrichtungsskript ausfuehren und seine Ausgabe durchreichen. */
function starteSkript(datei, argumente = []) {
  return new Promise((fertig) => {
    const kind = fork(path.join(WURZEL, 'scripts', datei), argumente, {
      cwd: WURZEL,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    kind.on('exit', (code) => fertig(code === 0));
    kind.on('error', (e) => {
      console.error(`[STEER.E] ${datei} konnte nicht gestartet werden:`, e.message);
      fertig(false);
    });
  });
}

async function erledigen() {
  try {
    // ---------- Preiskatalog ----------
    const preise = await db.one('SELECT COUNT(*)::int AS n FROM preis_positionen');
    if (preise.n === 0) {
      console.log('[STEER.E] Preiskatalog ist leer — er wird jetzt einmalig eingelesen.');
      const ok = await starteSkript('import_preise.js');
      if (!ok) {
        console.error('[STEER.E] Der Preisimport ist fehlgeschlagen. Die Anwendung laeuft trotzdem;');
        console.error('          der Katalog laesst sich spaeter mit "npm run import:preise" nachziehen.');
      }
    }

    // ---------- Erster Administrator ----------
    const benutzer = await db.one('SELECT COUNT(*)::int AS n FROM benutzer');
    if (benutzer.n === 0) {
      const name = process.env.ADMIN_NAME || 'Lutz Niesmann';
      const email = (process.env.ADMIN_EMAIL || 'kontakt@wwtec.de').toLowerCase();
      console.log('[STEER.E] Es gibt noch keinen Benutzer — der erste Administrator wird angelegt.');
      console.log('[STEER.E] Das Startpasswort steht gleich darunter und wird NIE WIEDER angezeigt.');
      await starteSkript('setup.js', [name, email]);
    }
  } catch (e) {
    // Die Ersteinrichtung darf den Serverstart niemals verhindern.
    console.error('[STEER.E] Ersteinrichtung uebersprungen:', e.message);
  }
}

module.exports = { erledigen };
