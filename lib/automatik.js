'use strict';
/**
 * Automatik: laeuft taeglich um 06:00 und kann im Dashboard manuell ausgeloest
 * werden. Sie legt Aufgaben an und verschiebt Phasen - sie loescht nichts.
 */

const cron = require('node-cron');
const db = require('./db');
const h = require('./helfer');

async function wiedervorlagePruefen() {
  const tage = Number(await h.einstellung('wiedervorlage_tage', '14')) || 14;
  const treffer = await db.all(
    `SELECT id, kunde_id, bezeichnung FROM projekte
      WHERE phase = 'Kontaktaufnahme'
        AND letzte_aktivitaet < now() - ($1 || ' days')::interval`,
    [String(tage)]
  );
  for (const p of treffer) {
    await db.tx(async (c) => {
      await c.query("UPDATE projekte SET phase = 'Wiedervorlage', wiedervorlage_am = CURRENT_DATE WHERE id = $1", [p.id]);
      await c.query(
        `INSERT INTO aktivitaeten (kunde_id, projekt_id, text, automatisch)
         VALUES ($1,$2,$3,TRUE)`,
        [p.kunde_id, p.id, `Automatisch auf Wiedervorlage gesetzt: ${tage} Tage ohne Aktivität in Kontaktaufnahme.`]
      );
    });
  }
  return treffer.length;
}

async function kundeInformierenPruefen() {
  const treffer = await db.all(
    `SELECT t.id, t.kunde_id, t.projekt_id, t.typ, t.datum, t.mit_wem
       FROM termine t
      WHERE t.typ IN ('Elektriker','Tiefbau')
        AND t.bestaetigt = 'ja'
        AND t.kunde_informiert = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM aufgaben a
           WHERE a.projekt_id IS NOT DISTINCT FROM t.projekt_id
             AND a.kunde_id = t.kunde_id
             AND a.erledigt = FALSE
             AND a.text LIKE 'Kunde über Termin informieren%'
        )`
  );
  for (const t of treffer) {
    await db.query(
      `INSERT INTO aufgaben (kunde_id, projekt_id, text, faellig_am, status)
       VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),'offen')`,
      [t.kunde_id, t.projekt_id,
       `Kunde über Termin informieren (${t.typ}${t.mit_wem ? ', ' + t.mit_wem : ''})`,
       t.datum]
    );
  }
  return treffer.length;
}

async function allesPruefen() {
  const a = await wiedervorlagePruefen();
  const b = await kundeInformierenPruefen();
  return { wiedervorlagen: a, aufgaben: b };
}

/**
 * Kalenderabgleich im Hintergrund.
 *
 * Bewusst nicht im 06:00-Lauf mit drin: Ein Termin, der um 09:00 in Outlook
 * verschoben wird, muss in Minuten hier stehen und nicht am naechsten
 * Morgen. Der Abstand ist einstellbar; unter fuenf Minuten geht es nicht,
 * damit ein Fehler nicht in eine Dauerschleife gegen Graph laeuft.
 */
function starteKalenderabgleich() {
  const kalender = require('./kalenderabgleich');
  const m365 = require('./m365');

  if (!m365.eingerichtet()) {
    console.log('[STEER.E] Kalenderabgleich ruht — Microsoft 365 ist nicht eingerichtet.');
    return;
  }

  (async () => {
    let minuten = 15;
    try {
      const e = await h.einstellung('kalender_abgleich_minuten', '15');
      const n = Number(e);
      if (Number.isFinite(n) && n >= 5 && n <= 240) minuten = Math.round(n);
    } catch (x) { /* Vorgabe bleibt */ }

    const planner = require('./planner');
    cron.schedule(`*/${minuten} * * * *`, async () => {
      try {
        const r = await kalender.alle();
        if (r.raus || r.rein) {
          console.log(`[STEER.E] Kalenderabgleich — ${r.rein} herein, ${r.raus} hinaus (${r.konten} Konto/Konten).`);
        }
      } catch (e) {
        console.error('[STEER.E] Kalenderabgleich fehlgeschlagen:', e.message);
      }
      // Planner und Teams laufen im selben Takt, aber getrennt gekapselt:
      // Ein fehlendes Recht fuer Planner darf den Kalender nicht mitreissen.
      try {
        const p = await planner.alle();
        if (p.aufgaben || p.meldungen) {
          console.log(`[STEER.E] Planner/Teams — ${p.aufgaben} Aufgabe(n), ${p.meldungen} Meldung(en).`);
        }
      } catch (e) {
        console.error('[STEER.E] Planner/Teams fehlgeschlagen:', e.message);
      }
    }, { timezone: 'Europe/Berlin' });
    console.log(`[STEER.E] Kalenderabgleich aktiv (alle ${minuten} Minuten).`);
  })();
}

function starteAutomatik() {
  if (process.env.AUTOMATIK === 'aus') {
    console.log('[STEER.E] Automatik ist per Variable deaktiviert.');
    return;
  }
  cron.schedule('0 6 * * *', async () => {
    try {
      const r = await allesPruefen();
      console.log(`[STEER.E] Automatik 06:00 — ${r.wiedervorlagen} Wiedervorlage(n), ${r.aufgaben} Aufgabe(n).`);
    } catch (e) {
      console.error('[STEER.E] Automatik fehlgeschlagen:', e.message);
    }
  }, { timezone: 'Europe/Berlin' });
  console.log('[STEER.E] Automatik aktiv (täglich 06:00 Europe/Berlin).');

  starteKalenderabgleich();
}

module.exports = { starteAutomatik, starteKalenderabgleich, allesPruefen };
