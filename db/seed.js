// Importiert die 46 Alt-Leads aus WWtec Kunden 5.xlsx in das neue Datenmodell.
// Wird nur ausgeführt, wenn die customers-Tabelle noch leer ist (siehe server.js).
const fs = require('fs');
const path = require('path');
const { db } = require('./db');

// Grobe Übernahme der im Excel-Export bereits berechneten Pipeline-Stage
// (siehe WWtec_Salesmanagement.xlsx) auf die neuen, feineren Workflow-Phasen.
function mapStage(rec) {
  const stage = rec.stage;
  const map = {
    'Termin geplant': 'Projektbesprechung',
    'Angebot / Verhandlung': 'Angebot',
    'Interesse – Termin offen': 'Kontaktaufnahme',
    'Termin gehabt – Follow-up nötig': 'Wiedervorlage',
    'Rückmeldung ausstehend': 'Terminanfrage',
    'Kontaktiert – keine Rückmeldung': 'Kontaktaufnahme',
    'Neuer Lead': 'Terminanfrage',
  };
  return map[stage] || 'Terminanfrage';
}

function seed() {
  const raw = fs.readFileSync(path.join(__dirname, 'seed_data.json'), 'utf8');
  const records = JSON.parse(raw);

  const insCustomer = db.prepare(`INSERT INTO customers (firma, branche, created_at) VALUES (?, ?, datetime('now'))`);
  const insContact = db.prepare(`INSERT INTO contacts (customer_id, name, telefon, email, rolle) VALUES (?, ?, ?, ?, ?)`);
  const insProject = db.prepare(`INSERT INTO projects
      (customer_id, bezeichnung, beschreibung, phase, potential, erstellt_am, letzte_aktivitaet_am)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insAppointment = db.prepare(`INSERT INTO appointments
      (customer_id, project_id, typ, mit_wem, datum, uhrzeit, ort, thema, bestaetigt)
      VALUES (?, ?, 'Kunde', ?, ?, ?, ?, ?, 'offen')`);
  const insTodo = db.prepare(`INSERT INTO todos (customer_id, project_id, text, erledigt, erstellt_am) VALUES (?, ?, ?, 1, ?)`);
  const insLog = db.prepare(`INSERT INTO activity_log (customer_id, project_id, datum, text, automatisch) VALUES (?, ?, ?, ?, 0)`);

  const tx = db.transaction((records) => {
    for (const rec of records) {
      let firma = rec.firma;
      if (!firma) firma = '⚠ Firma fehlt (Altdaten-Import, bitte ergänzen)';

      const custInfo = insCustomer.run(firma, rec.branche || null);
      const customerId = custInfo.lastInsertRowid;

      // Kontaktperson(en) – Telefon/E-Mail steckten in der Alt-Excel in einem Feld
      if (rec.ap1) {
        const kontakt1 = rec.kontakt1 != null ? String(rec.kontakt1) : null;
        const isEmail = kontakt1 && kontakt1.includes('@');
        insContact.run(customerId, rec.ap1, isEmail ? null : kontakt1, isEmail ? kontakt1 : null, null);
      }
      if (rec.ap2) {
        const kontakt2 = rec.kontakt2 != null ? String(rec.kontakt2) : null;
        const isEmail = kontakt2 && kontakt2.includes('@');
        insContact.run(customerId, rec.ap2, isEmail ? null : kontakt2, isEmail ? kontakt2 : null, null);
      }

      const phase = mapStage(rec);
      const letzteAktivitaet = (rec.activities && rec.activities.length && rec.activities[0][0])
        ? rec.activities[0][0]
        : (rec.kontakt_aufgenommen ? rec.kontakt_aufgenommen.slice(0, 10) : new Date().toISOString().slice(0, 10));

      const projInfo = insProject.run(
        customerId,
        `Ladeinfrastruktur-Projekt ${firma}`,
        rec.termin_zsf || null,
        phase,
        rec.potential || null,
        rec.kontakt_aufgenommen || new Date().toISOString(),
        letzteAktivitaet
      );
      const projectId = projInfo.lastInsertRowid;

      // geplanter/nächster Termin
      if (rec.naechster_termin_datum) {
        insAppointment.run(
          customerId, projectId, rec.ap1 || null,
          rec.naechster_termin_datum, rec.naechster_termin_zeit || null,
          rec.naechster_termin_ort || null, rec.naechster_termin_thema || null
        );
      }
      // vergangener strukturierter Termin (nur als Aktivitäts-Log, kein appointment)
      if (rec.termin_am && !rec.naechster_termin_datum) {
        const d = rec.termin_am.slice(0, 10);
        insLog.run(customerId, projectId, d, `Termin gehabt${rec.termin_um ? ' um ' + rec.termin_um : ''}${rec.termin_ort ? ' (' + rec.termin_ort + ')' : ''}: ${rec.termin_zsf || ''}`);
      }

      // ToDo-Historie als Aktivitäten-Log übernehmen
      for (const [datum, text] of (rec.activities || [])) {
        insLog.run(customerId, projectId, datum || new Date().toISOString().slice(0, 10), text);
      }
      if (rec.info_versendet) {
        insLog.run(customerId, projectId, rec.info_versendet.slice(0, 10), 'Infomaterial versendet');
      }
    }
  });

  tx(records);
  console.log(`Seed abgeschlossen: ${records.length} Kunden/Projekte importiert.`);
}

module.exports = { seed };

if (require.main === module) {
  seed();
}
