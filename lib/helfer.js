'use strict';
/** Formatierung, Einstellungen und kleine Helfer, die in Views gebraucht werden. */

const db = require('./db');

// ---------- Einstellungen ----------
// Werden gepuffert, damit nicht jede Seite die Tabelle liest. Nach dem
// Speichern in der Verwaltung wird der Puffer verworfen.
let puffer = null;
let pufferZeit = 0;
const PUFFER_MS = 30000;

async function einstellungen(frisch = false) {
  if (!frisch && puffer && Date.now() - pufferZeit < PUFFER_MS) return puffer;
  const rows = await db.all('SELECT schluessel, wert FROM einstellungen');
  puffer = Object.fromEntries(rows.map((r) => [r.schluessel, r.wert]));
  pufferZeit = Date.now();
  return puffer;
}
function pufferLeeren() { puffer = null; }

async function einstellung(schluessel, standard = null) {
  const e = await einstellungen();
  return e[schluessel] != null ? e[schluessel] : standard;
}

async function phasen() {
  const s = await einstellung('phasen', '');
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

// ---------- Formatierung ----------
const nfEur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const nfZahl = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

function eur(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? nfEur.format(n) : '—';
}
function zahl(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? nfZahl.format(n) : '—';
}
function datum(v) {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function datumZeit(v) {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fuerFeld(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** CSS-Klasse fuer Faelligkeiten: ueberfaellig rot, binnen 2 Tagen gelb. */
function faellig(dateStr, erledigt) {
  if (!dateStr || erledigt) return '';
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  const heute = new Date(); heute.setHours(0, 0, 0, 0);
  const diff = Math.round((d - heute) / 86400000);
  if (diff < 0) return 'ist-ueberfaellig';
  if (diff <= 2) return 'ist-bald';
  return '';
}

/**
 * Zahl aus einem Formularfeld.
 *
 * Muss beide Schreibweisen sicher unterscheiden, weil im Alltag beide getippt
 * werden: "1.234,56" (deutsch) und "1234.56" (aus Excel oder Tastenfeld).
 * Ein Punkt ist NUR dann Tausendertrennzeichen, wenn er auch als solches
 * dasteht - sonst wird aus 62.4 versehentlich 624, und ein Angebot ist um den
 * Faktor zehn falsch.
 */
function zuZahl(v) {
  if (v == null || v === '') return null;
  let s = String(v).trim().replace(/\s/g, '').replace(/€/g, '');
  if (s === '') return null;

  const hatKomma = s.includes(',');
  const hatPunkt = s.includes('.');

  if (hatKomma && hatPunkt) {
    // Beides vorhanden: das letzte Zeichen von beiden ist das Dezimaltrennzeichen.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hatKomma) {
    s = s.replace(',', '.');
  } else if (hatPunkt) {
    // Nur Punkte: Tausendertrennung erkennt man am Muster 1.234 / 1.234.567.
    // Alles andere (62.4, 0.5, 1234.56) ist ein Dezimalpunkt.
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Positive ganze Zahl aus einem Routenparameter, sonst null. */
function zuId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function txt(v) {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? null : s;
}

/**
 * Naechste Nummer aus einem Nummernkreis, kollisionsfrei.
 *
 * Wird ein Transaktions-Client uebergeben, laeuft der Zaehler in derselben
 * Transaktion wie der Vorgang, fuer den die Nummer gezogen wird. Bricht der
 * Vorgang ab, faellt die Nummer mit zurueck. Ohne diesen Client waere eine
 * fehlgeschlagene Rechnung eine verbrauchte Nummer — und damit eine Luecke
 * in der Nummernfolge, die die GoBD gerade nicht zulaesst.
 */
async function naechsteNummer(bereich = 'AN', c = null) {
  const jahr = new Date().getFullYear();
  const sql = `INSERT INTO nummernkreise (bereich, jahr, letzte) VALUES ($1,$2,1)
     ON CONFLICT (bereich, jahr) DO UPDATE SET letzte = nummernkreise.letzte + 1
     RETURNING letzte`;
  const r = c
    ? (await c.query(sql, [bereich, jahr])).rows[0]
    : await db.one(sql, [bereich, jahr]);
  return `${bereich}-${jahr}-${String(r.letzte).padStart(4, '0')}`;
}

/** Wortueberlappung zweier Texte - erkennt doppelt angelegte Projekte. */
function aehnlichkeit(a, b) {
  const norm = (s) => new Set(
    String(s || '').toLowerCase().replace(/[^a-zäöüß0-9\s]/g, ' ')
      .split(/\s+/).filter((w) => w.length > 3)
  );
  const A = norm(a); const B = norm(b);
  if (!A.size || !B.size) return 0;
  let treffer = 0;
  for (const w of A) if (B.has(w)) treffer += 1;
  return treffer / Math.min(A.size, B.size);
}

/** Eigene Felder eines Bereichs inkl. Werte fuer ein Objekt. */
async function eigeneFelder(bereich, objektId = null) {
  const felder = await db.all(
    'SELECT * FROM felder WHERE bereich = $1 AND aktiv = TRUE ORDER BY reihenfolge, id',
    [bereich]
  );
  if (!objektId || !felder.length) return felder.map((f) => ({ ...f, wert: null }));
  const werte = await db.all(
    'SELECT feld_id, wert FROM feld_werte WHERE objekt_id = $1 AND feld_id = ANY($2::int[])',
    [objektId, felder.map((f) => f.id)]
  );
  const m = new Map(werte.map((w) => [w.feld_id, w.wert]));
  return felder.map((f) => ({ ...f, wert: m.has(f.id) ? m.get(f.id) : null }));
}

async function eigeneFelderSpeichern(bereich, objektId, body) {
  const felder = await db.all(
    'SELECT id, schluessel FROM felder WHERE bereich = $1 AND aktiv = TRUE', [bereich]
  );
  for (const f of felder) {
    const wert = txt(body[`feld_${f.id}`]);
    if (wert === null) {
      await db.query('DELETE FROM feld_werte WHERE feld_id = $1 AND objekt_id = $2', [f.id, objektId]);
    } else {
      await db.query(
        `INSERT INTO feld_werte (feld_id, objekt_id, wert) VALUES ($1,$2,$3)
         ON CONFLICT (feld_id, objekt_id) DO UPDATE SET wert = EXCLUDED.wert`,
        [f.id, objektId, wert]
      );
    }
  }
}

module.exports = {
  einstellungen, einstellung, pufferLeeren, phasen,
  eur, zahl, datum, datumZeit, fuerFeld, faellig, zuZahl, txt,
  naechsteNummer, aehnlichkeit, eigeneFelder, eigeneFelderSpeichern, zuId,
};
