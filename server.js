const express = require('express');
const path = require('path');
const dayjs = require('dayjs');
const { db, isNew } = require('./db/db');
const { seed } = require('./db/seed');
const { startCron, runAllChecks } = require('./cron');
const { findSimilarProjects } = require('./lib/similar');
const {
  PHASES, PHASE_COLORS, DEFAULT_ROLES, BAUSTELLEN_STATUS,
  APPOINTMENT_STATUS, INFORM_METHODS, TODO_STATUS,
} = require('./constants');

// Beim allerersten Start (leere DB): Altdaten aus der WWtec-Excel importieren.
const customerCount = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
if (customerCount === 0) {
  console.log('Leere Datenbank erkannt – importiere Altdaten aus WWtec Kunden 5.xlsx ...');
  seed();
}
// Startklassen für Mitarbeiter-Rollen anlegen, falls noch keine Mitarbeiter existieren.
const employeeCount = db.prepare('SELECT COUNT(*) AS n FROM employees').get().n;
if (employeeCount === 0) {
  const ins = db.prepare('INSERT INTO employees (name, role) VALUES (?, ?)');
  ins.run('(Platzhalter Vertrieb)', 'Vertrieb');
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.locals.PHASES = PHASES;
app.locals.PHASE_COLORS = PHASE_COLORS;
app.locals.BAUSTELLEN_STATUS = BAUSTELLEN_STATUS;
app.locals.APPOINTMENT_STATUS = APPOINTMENT_STATUS;
app.locals.INFORM_METHODS = INFORM_METHODS;
app.locals.TODO_STATUS = TODO_STATUS;
app.locals.dayjs = dayjs;

// Liefert eine CSS-Klasse für Fälligkeits-/Termin-Datum, damit Deadlines optisch
// auffallen: überfällig = rot, fällig binnen 2 Tagen = gelb/orange.
app.locals.dueClass = function (dateStr, done) {
  if (!dateStr || done) return '';
  const diff = dayjs(dateStr).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (diff < 0) return 'due-overdue';
  if (diff <= 2) return 'due-soon';
  return '';
};

function touchProject(projectId) {
  db.prepare(`UPDATE projects SET letzte_aktivitaet_am = datetime('now') WHERE id = ?`).run(projectId);
}

// ---------------------------------------------------------------- Dashboard
app.get('/', (req, res) => {
  const counts = db.prepare(`SELECT phase, COUNT(*) as n FROM projects GROUP BY phase`).all();
  const countMap = Object.fromEntries(counts.map((c) => [c.phase, c.n]));
  const totalCustomers = db.prepare('SELECT COUNT(*) as n FROM customers').get().n;
  const openTodos = db.prepare('SELECT COUNT(*) as n FROM todos WHERE erledigt = 0').get().n;
  const sums = db.prepare(`
    SELECT COALESCE(SUM(angebotssumme),0) as angebot, COALESCE(SUM(beauftragtesumme),0) as beauftragt,
           COALESCE(SUM(rechnungsbetrag),0) as rechnung
    FROM projects
  `).get();
  const wiedervorlageFaellig = db.prepare(`
    SELECT COUNT(*) as n FROM projects WHERE phase = 'Kontaktaufnahme' AND date(letzte_aktivitaet_am) <= date('now','-14 day')
  `).get().n;
  res.render('dashboard', { countMap, totalCustomers, openTodos, sums, wiedervorlageFaellig });
});

app.post('/admin/cron-jetzt', (req, res) => {
  const result = runAllChecks();
  res.redirect('/?cron=' + encodeURIComponent(JSON.stringify(result)));
});

// ---------------------------------------------------------------- Kunden
app.get('/kunden', (req, res) => {
  const { phase, q } = req.query;
  let sql = `
    SELECT c.id as customer_id, c.firma, c.branche,
           p.id as project_id, p.bezeichnung, p.phase, p.potential, p.letzte_aktivitaet_am
    FROM customers c
    LEFT JOIN projects p ON p.customer_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (phase) { sql += ' AND p.phase = ?'; params.push(phase); }
  if (q) { sql += ' AND c.firma LIKE ?'; params.push(`%${q}%`); }
  // Kunden alphabetisch (ABC), Projekte je Kunde nach letzter Aktivität.
  sql += ' ORDER BY c.firma COLLATE NOCASE ASC, p.letzte_aktivitaet_am DESC';
  const rows = db.prepare(sql).all(...params);
  res.render('kunden_liste', { rows, phase: phase || '', q: q || '' });
});

app.get('/kunden/neu', (req, res) => {
  const employees = db.prepare('SELECT * FROM employees WHERE active = 1').all();
  res.render('kunde_neu', { employees });
});

app.post('/kunden', (req, res) => {
  const { firma, branche, adresse, website, quelle, ap1_name, ap1_kontakt, projekt_beschreibung, projektmanager_id } = req.body;
  const info = db.prepare(`INSERT INTO customers (firma, branche, adresse, website, quelle) VALUES (?, ?, ?, ?, ?)`)
    .run(firma, branche || null, adresse || null, website || null, quelle || null);
  const customerId = info.lastInsertRowid;
  if (ap1_name) {
    const isEmail = ap1_kontakt && ap1_kontakt.includes('@');
    db.prepare(`INSERT INTO contacts (customer_id, name, telefon, email) VALUES (?, ?, ?, ?)`)
      .run(customerId, ap1_name, isEmail ? null : (ap1_kontakt || null), isEmail ? ap1_kontakt : null);
  }
  const projInfo = db.prepare(`INSERT INTO projects (customer_id, bezeichnung, beschreibung, phase, projektmanager_id) VALUES (?, ?, ?, 'Terminanfrage', ?)`)
    .run(customerId, `Ladeinfrastruktur-Projekt ${firma}`, projekt_beschreibung || null, projektmanager_id || null);
  db.prepare(`INSERT INTO activity_log (customer_id, project_id, text) VALUES (?, ?, 'Neu angelegt.')`)
    .run(customerId, projInfo.lastInsertRowid);
  res.redirect(`/kunden/${customerId}`);
});

app.get('/kunden/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).send('Kunde nicht gefunden');
  const contacts = db.prepare('SELECT * FROM contacts WHERE customer_id = ?').all(customer.id);
  const projects = db.prepare('SELECT * FROM projects WHERE customer_id = ? ORDER BY erstellt_am DESC').all(customer.id);
  const appointments = db.prepare('SELECT * FROM appointments WHERE customer_id = ? ORDER BY datum DESC').all(customer.id);
  const todos = db.prepare('SELECT t.*, e.name as mitarbeiter_name FROM todos t LEFT JOIN employees e ON e.id = t.mitarbeiter_id WHERE t.customer_id = ? ORDER BY t.erledigt, t.faellig_am').all(customer.id);
  const log = db.prepare('SELECT * FROM activity_log WHERE customer_id = ? ORDER BY datum DESC').all(customer.id);
  const employees = db.prepare('SELECT * FROM employees WHERE active = 1').all();

  const projectsWithSimilar = projects.map((p) => ({
    ...p,
    similar: findSimilarProjects(db, p.id, p.beschreibung),
  }));

  res.render('kunde_detail', { customer, contacts, projects: projectsWithSimilar, appointments, todos, log, employees });
});

// Kundenstammdaten bearbeiten (Firma, Branche, Adresse, Website, Quelle).
app.post('/kunden/:id/bearbeiten', (req, res) => {
  const { firma, branche, adresse, website, quelle } = req.body;
  db.prepare(`UPDATE customers SET firma = ?, branche = ?, adresse = ?, website = ?, quelle = ? WHERE id = ?`)
    .run(firma, branche || null, adresse || null, website || null, quelle || null, req.params.id);
  db.prepare(`INSERT INTO activity_log (customer_id, text) VALUES (?, 'Kundendaten bearbeitet.')`).run(req.params.id);
  res.redirect(`/kunden/${req.params.id}`);
});

// Kunde löschen (kaskadiert auf Kontakte/Projekte/Termine/ToDos/Log). Bestätigung im Frontend.
app.post('/kunden/:id/loeschen', (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.redirect('/kunden');
});

app.post('/kunden/:id/kontakte', (req, res) => {
  const { name, telefon, email, rolle } = req.body;
  db.prepare('INSERT INTO contacts (customer_id, name, telefon, email, rolle) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.id, name, telefon || null, email || null, rolle || null);
  res.redirect(`/kunden/${req.params.id}`);
});

// Ansprechpartner bearbeiten / löschen.
app.post('/kontakte/:id/bearbeiten', (req, res) => {
  const { name, telefon, email, rolle, customer_id } = req.body;
  db.prepare('UPDATE contacts SET name = ?, telefon = ?, email = ?, rolle = ? WHERE id = ?')
    .run(name, telefon || null, email || null, rolle || null, req.params.id);
  res.redirect(`/kunden/${customer_id}`);
});

app.post('/kontakte/:id/loeschen', (req, res) => {
  const { customer_id } = req.body;
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.redirect(`/kunden/${customer_id}`);
});

app.post('/kunden/:id/projekte', (req, res) => {
  const { bezeichnung, beschreibung, projektmanager_id } = req.body;
  const info = db.prepare(`INSERT INTO projects (customer_id, bezeichnung, beschreibung, projektmanager_id) VALUES (?, ?, ?, ?)`)
    .run(req.params.id, bezeichnung, beschreibung || null, projektmanager_id || null);
  db.prepare(`INSERT INTO activity_log (customer_id, project_id, text) VALUES (?, ?, 'Neues Projekt angelegt.')`)
    .run(req.params.id, info.lastInsertRowid);
  res.redirect(`/kunden/${req.params.id}`);
});

app.post('/kunden/:id/log', (req, res) => {
  const { project_id, text } = req.body;
  db.prepare('INSERT INTO activity_log (customer_id, project_id, text) VALUES (?, ?, ?)')
    .run(req.params.id, project_id || null, text);
  if (project_id) touchProject(project_id);
  res.redirect(`/kunden/${req.params.id}`);
});

// ---------------------------------------------------------------- Projekte
app.post('/projekte/:id/phase', (req, res) => {
  const { phase, customer_id } = req.body;
  db.prepare('UPDATE projects SET phase = ? WHERE id = ?').run(phase, req.params.id);
  db.prepare(`INSERT INTO activity_log (customer_id, project_id, text) VALUES (?, ?, ?)`)
    .run(customer_id, req.params.id, `Phase manuell geändert auf "${phase}".`);
  touchProject(req.params.id);
  res.redirect(`/kunden/${customer_id}`);
});

app.post('/projekte/:id/finanzen', (req, res) => {
  const { customer_id, angebotssumme, beauftragtesumme, rechnungsbetrag, baustellen_status, projektmanager_id, potential } = req.body;
  db.prepare(`UPDATE projects SET angebotssumme = ?, beauftragtesumme = ?, rechnungsbetrag = ?, baustellen_status = ?, projektmanager_id = ?, potential = ? WHERE id = ?`)
    .run(angebotssumme || null, beauftragtesumme || null, rechnungsbetrag || null, baustellen_status || null, projektmanager_id || null, potential || null, req.params.id);
  touchProject(req.params.id);
  res.redirect(`/kunden/${customer_id}`);
});

app.post('/projekte/:id/loeschen', (req, res) => {
  const { customer_id } = req.body;
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.redirect(`/kunden/${customer_id}`);
});

// ---------------------------------------------------------------- Termine
app.get('/termine', (req, res) => {
  const { typ, bestaetigt, status } = req.query;
  let sql = `
    SELECT a.*, c.firma, p.bezeichnung as projekt
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE 1=1
  `;
  const params = [];
  if (typ) { sql += ' AND a.typ = ?'; params.push(typ); }
  if (bestaetigt) { sql += ' AND a.bestaetigt = ?'; params.push(bestaetigt); }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  sql += ' ORDER BY (a.datum IS NULL), a.datum ASC';
  const rows = db.prepare(sql).all(...params);
  res.render('termine', { rows, typ: typ || '', bestaetigt: bestaetigt || '', status: status || '' });
});

app.post('/kunden/:id/termine', (req, res) => {
  const { project_id, typ, mit_wem, datum, uhrzeit, ort, thema } = req.body;
  db.prepare(`INSERT INTO appointments (customer_id, project_id, typ, mit_wem, datum, uhrzeit, ort, thema) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.params.id, project_id || null, typ, mit_wem || null, datum || null, uhrzeit || null, ort || null, thema || null);
  if (project_id) touchProject(project_id);
  res.redirect(`/kunden/${req.params.id}`);
});

app.get('/termine/:id/bearbeiten', (req, res) => {
  const appointment = db.prepare(`
    SELECT a.*, c.firma FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.id = ?
  `).get(req.params.id);
  if (!appointment) return res.status(404).send('Termin nicht gefunden');
  const projects = db.prepare('SELECT * FROM projects WHERE customer_id = ?').all(appointment.customer_id);
  res.render('termin_bearbeiten', { appointment, projects });
});

app.post('/termine/:id/bearbeiten', (req, res) => {
  const { customer_id, project_id, typ, mit_wem, datum, uhrzeit, ort, thema, bestaetigt, status, ergebnis } = req.body;
  db.prepare(`
    UPDATE appointments SET project_id = ?, typ = ?, mit_wem = ?, datum = ?, uhrzeit = ?, ort = ?, thema = ?, bestaetigt = ?, status = ?, ergebnis = ?
    WHERE id = ?
  `).run(project_id || null, typ, mit_wem || null, datum || null, uhrzeit || null, ort || null, thema || null, bestaetigt, status, ergebnis || null, req.params.id);
  if (project_id) touchProject(project_id);
  res.redirect(`/kunden/${customer_id}`);
});

app.post('/termine/:id/loeschen', (req, res) => {
  const { redirect, customer_id } = req.body;
  db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  res.redirect(redirect || (customer_id ? `/kunden/${customer_id}` : '/termine'));
});

app.post('/termine/:id/bestaetigen', (req, res) => {
  const { status, redirect } = req.body; // ja / nein / offen
  db.prepare('UPDATE appointments SET bestaetigt = ? WHERE id = ?').run(status, req.params.id);
  res.redirect(redirect || '/termine');
});

// "Kunde informiert" = der Kunde wurde über den bestätigten Elektriker-/Tiefbau-Termin
// in Kenntnis gesetzt. Die Methode (Telefon/E-Mail/Persönlich/Sonstiges) wird mit erfasst.
app.post('/termine/:id/informiert', (req, res) => {
  const { redirect, methode } = req.body;
  db.prepare('UPDATE appointments SET kunde_informiert = 1, kunde_informiert_methode = ? WHERE id = ?')
    .run(methode || 'Sonstiges', req.params.id);
  res.redirect(redirect || '/termine');
});

// ---------------------------------------------------------------- ToDos
app.get('/todos', (req, res) => {
  const { mitarbeiter_id, status, q } = req.query;
  let sql = `
    SELECT t.*, c.firma, e.name as mitarbeiter_name
    FROM todos t
    JOIN customers c ON c.id = t.customer_id
    LEFT JOIN employees e ON e.id = t.mitarbeiter_id
    WHERE 1=1
  `;
  const params = [];
  if (mitarbeiter_id) { sql += ' AND t.mitarbeiter_id = ?'; params.push(mitarbeiter_id); }
  if (status) { sql += ' AND t.status = ?'; params.push(status); }
  if (q) { sql += ' AND c.firma LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY t.erledigt, t.faellig_am IS NULL, t.faellig_am';
  const rows = db.prepare(sql).all(...params);
  const employees = db.prepare('SELECT * FROM employees WHERE active = 1').all();
  const customers = db.prepare('SELECT id, firma FROM customers ORDER BY firma COLLATE NOCASE ASC').all();
  res.render('todos', { rows, employees, customers, mitarbeiter_id: mitarbeiter_id || '', status: status || '', q: q || '' });
});

// ToDo direkt aus der zentralen Liste anlegen (Kunde per Dropdown wählen).
app.post('/todos', (req, res) => {
  const { customer_id, text, faellig_am, mitarbeiter_id, notiz } = req.body;
  db.prepare('INSERT INTO todos (customer_id, text, faellig_am, mitarbeiter_id, notiz) VALUES (?, ?, ?, ?, ?)')
    .run(customer_id, text, faellig_am || null, mitarbeiter_id || null, notiz || null);
  res.redirect('/todos');
});

app.post('/todos/:id/erledigt', (req, res) => {
  db.prepare(`
    UPDATE todos SET erledigt = 1 - erledigt, status = CASE WHEN erledigt = 0 THEN 'erledigt' ELSE 'offen' END
    WHERE id = ?
  `).run(req.params.id);
  res.redirect(req.body.redirect || '/todos');
});

app.post('/kunden/:id/todos', (req, res) => {
  const { project_id, text, faellig_am, mitarbeiter_id, notiz } = req.body;
  db.prepare('INSERT INTO todos (customer_id, project_id, text, faellig_am, mitarbeiter_id, notiz) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.params.id, project_id || null, text, faellig_am || null, mitarbeiter_id || null, notiz || null);
  res.redirect(`/kunden/${req.params.id}`);
});

app.get('/todos/:id/bearbeiten', (req, res) => {
  const todo = db.prepare(`SELECT t.*, c.firma FROM todos t JOIN customers c ON c.id = t.customer_id WHERE t.id = ?`).get(req.params.id);
  if (!todo) return res.status(404).send('ToDo nicht gefunden');
  const employees = db.prepare('SELECT * FROM employees WHERE active = 1').all();
  res.render('todo_bearbeiten', { todo, employees });
});

app.post('/todos/:id/bearbeiten', (req, res) => {
  const { customer_id, text, faellig_am, mitarbeiter_id, notiz, status } = req.body;
  db.prepare(`
    UPDATE todos SET text = ?, faellig_am = ?, mitarbeiter_id = ?, notiz = ?, status = ?, erledigt = ?
    WHERE id = ?
  `).run(text, faellig_am || null, mitarbeiter_id || null, notiz || null, status, status === 'erledigt' ? 1 : 0, req.params.id);
  res.redirect(`/kunden/${customer_id}`);
});

app.post('/todos/:id/loeschen', (req, res) => {
  const { redirect } = req.body;
  db.prepare('DELETE FROM todos WHERE id = ?').run(req.params.id);
  res.redirect(redirect || '/todos');
});

// ---------------------------------------------------------------- Mitarbeiter
app.get('/mitarbeiter', (req, res) => {
  const rows = db.prepare('SELECT * FROM employees ORDER BY active DESC, role, name').all();
  res.render('mitarbeiter', { rows, DEFAULT_ROLES });
});

app.post('/mitarbeiter', (req, res) => {
  const { name, role, email } = req.body;
  db.prepare('INSERT INTO employees (name, role, email) VALUES (?, ?, ?)').run(name, role, email || null);
  res.redirect('/mitarbeiter');
});

app.post('/mitarbeiter/:id/bearbeiten', (req, res) => {
  const { name, role, email } = req.body;
  db.prepare('UPDATE employees SET name = ?, role = ?, email = ? WHERE id = ?').run(name, role, email || null, req.params.id);
  res.redirect('/mitarbeiter');
});

app.post('/mitarbeiter/:id/toggle', (req, res) => {
  db.prepare('UPDATE employees SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/mitarbeiter');
});

startCron();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WWtec Salesmanagement läuft auf Port ${PORT}`));
