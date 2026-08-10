const cron = require('node-cron');
const dayjs = require('dayjs');
const { db } = require('./db/db');

// Regel (vom Nutzer vorgegeben): Kunde antwortet nach Kontaktaufnahme 14 Tage nicht
// -> automatisch auf "Wiedervorlage" setzen.
function runWiedervorlageCheck() {
  const cutoff = dayjs().subtract(14, 'day').format('YYYY-MM-DD');
  const due = db.prepare(`
    SELECT id, customer_id FROM projects
    WHERE phase = 'Kontaktaufnahme' AND date(letzte_aktivitaet_am) <= date(?)
  `).all(cutoff);

  if (!due.length) return { moved: 0 };

  const updateProject = db.prepare(`UPDATE projects SET phase = 'Wiedervorlage', wiedervorlage_am = datetime('now') WHERE id = ?`);
  const insLog = db.prepare(`INSERT INTO activity_log (customer_id, project_id, datum, text, automatisch) VALUES (?, ?, datetime('now'), ?, 1)`);

  const tx = db.transaction((rows) => {
    for (const row of rows) {
      updateProject.run(row.id);
      insLog.run(row.customer_id, row.id, 'Automatisch auf "Wiedervorlage" gesetzt (14 Tage ohne Rückmeldung seit letzter Aktivität).');
    }
  });
  tx(due);
  return { moved: due.length };
}

// Wenn ein Elektriker-/Tiefbau-Termin bestätigt wurde, aber der Kunde noch nicht
// informiert ist, wird ein ToDo erzeugt (falls nicht schon vorhanden).
function runKundeInformierenCheck() {
  const rows = db.prepare(`
    SELECT a.id as appointment_id, a.customer_id, a.project_id, a.typ, a.datum
    FROM appointments a
    WHERE a.bestaetigt = 'ja' AND a.kunde_informiert = 0 AND a.typ IN ('Elektriker','Tiefbau')
  `).all();

  const existing = db.prepare(`SELECT id FROM todos WHERE project_id = ? AND text LIKE ?`);
  const insTodo = db.prepare(`INSERT INTO todos (customer_id, project_id, text, faellig_am) VALUES (?, ?, ?, date('now'))`);

  let created = 0;
  for (const row of rows) {
    const marker = `Kunde informieren: ${row.typ}-Termin%`;
    const already = existing.get(row.project_id, marker);
    if (!already) {
      insTodo.run(row.customer_id, row.project_id, `Kunde informieren: ${row.typ}-Termin am ${row.datum || '(Datum offen)'} ist bestätigt.`);
      created++;
    }
  }
  return { created };
}

function runAllChecks() {
  const r1 = runWiedervorlageCheck();
  const r2 = runKundeInformierenCheck();
  return { ...r1, ...r2 };
}

function startCron() {
  // täglich um 06:00
  cron.schedule('0 6 * * *', () => {
    const result = runAllChecks();
    console.log('[cron] Tagescheck:', result);
  });
}

module.exports = { startCron, runAllChecks, runWiedervorlageCheck, runKundeInformierenCheck };
