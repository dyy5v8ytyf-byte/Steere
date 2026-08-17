'use strict';
/**
 * Datenbankzugriff (PostgreSQL) + Migrationslauf.
 *
 * GRUNDREGEL DIESER DATEI — bitte nicht aufweichen:
 * Migrationen sind ausschliesslich additiv. Es gibt keinen Pfad in diesem Code,
 * der Tabellen oder Spalten loescht. Aenderungen am laufenden System erfolgen
 * ueber neue, nummerierte Dateien in /migrations. Eine bereits angewandte
 * Migration wird nie erneut ausgefuehrt und nie veraendert.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('\n[STEER.E] DATABASE_URL ist nicht gesetzt.');
  console.error('           Auf Railway: Variable DATABASE_URL = ${{Postgres.DATABASE_URL}}');
  console.error('           Lokal:      DATABASE_URL=postgres://user:pass@localhost:5432/steere\n');
  process.exit(1);
}

// Railway-Postgres nutzt ein selbstsigniertes Zertifikat im internen Netz.
const needsSsl = /\bsslmode=require\b/.test(connectionString) || process.env.PGSSL === '1';

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[STEER.E] Unerwarteter Poolfehler:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

/** Genau eine Zeile oder null. */
async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

/** Alle Zeilen als Array. */
async function all(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

/** Callback in einer Transaktion ausfuehren; bei Fehler vollstaendiges Rollback. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Wendet alle noch nicht angewandten Migrationen an.
 * Jede Datei laeuft in einer eigenen Transaktion: entweder ganz oder gar nicht.
 */
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    TEXT
    )
  `);

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const appliedRows = await all('SELECT version, checksum FROM schema_migrations');
  const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]));

  const crypto = require('node:crypto');
  let count = 0;

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const sum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

    if (applied.has(file)) {
      // Bereits angewandte Migration wurde nachtraeglich veraendert -> laut warnen,
      // aber NICHT erneut ausfuehren. Korrektur gehoert in eine neue Datei.
      if (applied.get(file) && applied.get(file) !== sum) {
        console.warn(`[STEER.E] WARNUNG: Migration ${file} wurde nach dem Anwenden geaendert.`);
        console.warn('           Sie wird nicht erneut ausgefuehrt. Korrekturen bitte als neue Datei anlegen.');
      }
      continue;
    }

    process.stdout.write(`[STEER.E] Migration ${file} ... `);
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, sum]);
    });
    console.log('ok');
    count += 1;
  }

  if (count === 0) console.log('[STEER.E] Datenbankstand aktuell, keine Migration noetig.');
  else console.log(`[STEER.E] ${count} Migration(en) angewandt.`);
}

module.exports = { pool, query, one, all, tx, migrate };
