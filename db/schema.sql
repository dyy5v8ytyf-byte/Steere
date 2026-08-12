-- WWtec Salesmanagement / EPC-Steuerung – Datenmodell v1
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Vertrieb',   -- frei erweiterbar: Vertrieb, Projektmanager, Elektriker, Tiefbau, Admin, ...
  email TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firma TEXT NOT NULL,
  branche TEXT,
  adresse TEXT,
  website TEXT,
  quelle TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT,
  telefon TEXT,
  email TEXT,
  rolle TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  bezeichnung TEXT NOT NULL,
  beschreibung TEXT,
  projektmanager_id INTEGER REFERENCES employees(id),
  phase TEXT NOT NULL DEFAULT 'Terminanfrage',
  potential INTEGER,                       -- 1-3, aus Altdaten übernommen
  angebotssumme REAL,
  beauftragtesumme REAL,
  rechnungsbetrag REAL,
  baustellen_status TEXT,                  -- geplant / im_bau / beendet (nur relevant ab Beauftragung)
  erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
  letzte_aktivitaet_am TEXT NOT NULL DEFAULT (datetime('now')),
  wiedervorlage_am TEXT                    -- gesetzt bei Phase 'Wiedervorlage'
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  typ TEXT NOT NULL DEFAULT 'Kunde',        -- Kunde, Elektriker, Tiefbau
  mit_wem TEXT,                             -- Name Ansprechpartner / Subunternehmer
  datum TEXT,
  uhrzeit TEXT,
  ort TEXT,
  thema TEXT,
  bestaetigt TEXT NOT NULL DEFAULT 'offen', -- offen / ja / nein
  status TEXT NOT NULL DEFAULT 'geplant',   -- geplant / durchgeführt / verschoben / abgesagt
  ergebnis TEXT,                            -- Ergebnisstand / Notiz nach dem Termin
  kunde_informiert INTEGER NOT NULL DEFAULT 0,
  kunde_informiert_methode TEXT             -- Telefon / E-Mail / Persönlich / Sonstiges
);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  faellig_am TEXT,
  mitarbeiter_id INTEGER REFERENCES employees(id),
  erledigt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'offen',     -- offen / in Arbeit / erledigt / zurückgestellt
  notiz TEXT,                               -- Hinweis / Notiz zum ToDo
  erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  datum TEXT NOT NULL DEFAULT (datetime('now')),
  text TEXT NOT NULL,
  automatisch INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_projects_phase ON projects(phase);
CREATE INDEX IF NOT EXISTS idx_contacts_customer ON contacts(customer_id);
CREATE INDEX IF NOT EXISTS idx_appointments_project ON appointments(project_id);
CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);
