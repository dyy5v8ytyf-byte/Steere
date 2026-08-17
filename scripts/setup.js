'use strict';
/**
 * Einmalige Einrichtung: Migrationen anwenden und den ersten Administrator
 * anlegen. Laeuft beliebig oft; ein bereits vorhandener Benutzer wird nicht
 * ueberschrieben.
 *
 *   node scripts/setup.js "Lutz Niesmann" kontakt@wwtec.de
 */

const db = require('../lib/db');
const auth = require('../lib/auth');

(async () => {
  const name = process.argv[2] || 'Administrator';
  const email = (process.argv[3] || 'kontakt@wwtec.de').toLowerCase();

  await db.migrate();

  const vorhanden = await db.one('SELECT id FROM benutzer WHERE lower(email) = $1', [email]);
  if (vorhanden) {
    console.log(`\nBenutzer ${email} existiert bereits (ID ${vorhanden.id}). Es wurde nichts geaendert.`);
    console.log('Passwort zuruecksetzen geht in der Verwaltung.\n');
    await db.pool.end();
    return;
  }

  const org = await db.one("SELECT id FROM organisationen WHERE art = 'intern' ORDER BY id LIMIT 1");
  const passwort = auth.startPasswort();
  const { hash, salt } = auth.hashPasswort(passwort);

  const u = await db.one(
    `INSERT INTO benutzer (email, name, rolle, organisation_id, passwort_hash, passwort_salt, muss_wechseln)
     VALUES ($1,$2,'admin',$3,$4,$5,TRUE) RETURNING id`,
    [email, name, org ? org.id : null, hash, salt]
  );

  console.log('\n============================================================');
  console.log('  Administrator angelegt');
  console.log('------------------------------------------------------------');
  console.log(`  E-Mail:    ${email}`);
  console.log(`  Passwort:  ${passwort}`);
  console.log('------------------------------------------------------------');
  console.log('  Beim ersten Anmelden muss das Passwort geaendert werden.');
  console.log('  Dieses Startpasswort wird nirgends erneut angezeigt.');
  console.log('============================================================\n');

  await db.query(
    `INSERT INTO protokoll (benutzer_txt, aktion, objekt, objekt_id, details)
     VALUES ('Einrichtung','ersteinrichtung','benutzer',$1,$2)`,
    [String(u.id), JSON.stringify({ email, rolle: 'admin' })]
  );

  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
