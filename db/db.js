const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wwtec.sqlite');
const isNew = !fs.existsSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Leichte Migration für bereits laufende Installationen: CREATE TABLE IF NOT EXISTS
// legt keine neuen Spalten in bereits existierenden Tabellen an, daher hier per
// ALTER TABLE nachziehen (idempotent, ignoriert "duplicate column"-Fehler).
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('appointments', 'status', "TEXT NOT NULL DEFAULT 'geplant'");
ensureColumn('appointments', 'ergebnis', 'TEXT');
ensureColumn('appointments', 'kunde_informiert_methode', 'TEXT');
ensureColumn('todos', 'status', "TEXT NOT NULL DEFAULT 'offen'");
ensureColumn('todos', 'notiz', 'TEXT');

module.exports = { db, isNew, DB_PATH };
