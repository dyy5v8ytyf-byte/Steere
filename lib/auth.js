'use strict';
/**
 * Anmeldung, Passwoerter, Rollen.
 *
 * Passwoerter werden mit scrypt aus node:crypto gehasht - bewusst ohne externe
 * Abhaengigkeit, damit es keinen Build-Schritt gibt, der auf Railway scheitern
 * kann. scrypt ist fuer diesen Zweck ausreichend und in Node fest eingebaut.
 */

const crypto = require('node:crypto');
const db = require('./db');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPasswort(passwort, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(passwort.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString('hex');
  return { hash, salt };
}

function pruefePasswort(passwort, hash, salt) {
  const versuch = crypto.scryptSync(passwort.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  const soll = Buffer.from(hash, 'hex');
  if (soll.length !== versuch.length) return false;
  return crypto.timingSafeEqual(soll, versuch);
}

/** Startpasswort fuer neu angelegte Benutzer: lesbar, aber nicht ratbar. */
function startPasswort() {
  const woerter = ['Anker','Kompass','Trasse','Schiene','Fundament','Leitung','Kabel','Sockel','Peilung','Kurs'];
  const w = woerter[crypto.randomInt(woerter.length)];
  return `${w}-${crypto.randomInt(1000, 9999)}-${crypto.randomBytes(2).toString('hex')}`;
}

const SPERRE_AB = 8;              // Fehlversuche
const SPERRE_MINUTEN = 15;

async function anmelden(email, passwort) {
  const u = await db.one(
    'SELECT * FROM benutzer WHERE lower(email) = lower($1) AND aktiv = TRUE',
    [String(email || '').trim()]
  );

  // Immer gleich lange rechnen, damit man an der Antwortzeit nicht ablesen
  // kann, ob es die Adresse gibt.
  if (!u) {
    hashPasswort(String(passwort || 'x'));
    return { ok: false, grund: 'unbekannt' };
  }
  if (u.gesperrt_bis && new Date(u.gesperrt_bis) > new Date()) {
    return { ok: false, grund: 'gesperrt', bis: u.gesperrt_bis };
  }
  if (!pruefePasswort(String(passwort || ''), u.passwort_hash, u.passwort_salt)) {
    const versuche = u.fehlversuche + 1;
    const sperren = versuche >= SPERRE_AB;
    await db.query(
      `UPDATE benutzer SET fehlversuche = $1,
              gesperrt_bis = CASE WHEN $2 THEN now() + ($3 || ' minutes')::interval ELSE gesperrt_bis END
       WHERE id = $4`,
      [sperren ? 0 : versuche, sperren, String(SPERRE_MINUTEN), u.id]
    );
    return { ok: false, grund: sperren ? 'gesperrt' : 'falsch' };
  }

  await db.query(
    'UPDATE benutzer SET letzter_login = now(), fehlversuche = 0, gesperrt_bis = NULL WHERE id = $1',
    [u.id]
  );
  return { ok: true, benutzer: u };
}

/** Wird bei jedem Request ausgefuehrt und legt req.benutzer an. */
function sitzung() {
  return async function (req, res, next) {
    res.locals.benutzer = null;
    req.benutzer = null;
    if (req.session && req.session.benutzerId) {
      const u = await db.one(
        `SELECT b.*, o.name AS org_name, o.kuerzel AS org_kuerzel, o.art AS org_art
           FROM benutzer b LEFT JOIN organisationen o ON o.id = b.organisation_id
          WHERE b.id = $1 AND b.aktiv = TRUE`,
        [req.session.benutzerId]
      );
      if (u) {
        delete u.passwort_hash;
        delete u.passwort_salt;
        req.benutzer = u;
        res.locals.benutzer = u;
      } else {
        req.session.destroy(() => {});
      }
    }
    next();
  };
}

/** Zugriffsschutz. Ohne Argument: jede angemeldete Rolle. */
function verlangt(...rollen) {
  return function (req, res, next) {
    if (!req.benutzer) {
      const ziel = encodeURIComponent(req.originalUrl || '/');
      return res.redirect(`/anmelden?weiter=${ziel}`);
    }
    if (req.benutzer.muss_wechseln && !req.path.startsWith('/passwort')) {
      return res.redirect('/passwort');
    }
    if (rollen.length && !rollen.includes(req.benutzer.rolle)) {
      return res.status(403).render('fehler', {
        titel: 'Kein Zugriff',
        text: 'Für diesen Bereich fehlt Ihrer Rolle die Berechtigung. Wenden Sie sich an die Administration.',
      });
    }
    next();
  };
}

/**
 * Prueft, ob ein Projekt fuer die Organisation des Partners freigegeben ist.
 * Partner erreichen Projektdaten ausschliesslich ueber die /partner-Routen,
 * und dort ausschliesslich ueber diese Pruefung. Die uebrigen Bereiche sind
 * per verlangt('admin','team') fuer Partner vollstaendig gesperrt - damit gibt
 * es keine zweite Stelle, an der die Einschraenkung vergessen werden koennte.
 */
async function partnerDarfProjekt(benutzer, projektId) {
  if (!benutzer || benutzer.rolle !== 'partner' || !benutzer.organisation_id) return false;
  const t = await db.one(
    'SELECT 1 FROM projekt_partner WHERE projekt_id = $1 AND organisation_id = $2',
    [projektId, benutzer.organisation_id]
  );
  return Boolean(t);
}

async function protokoll(req, aktion, objekt, objektId, details) {
  try {
    await db.query(
      `INSERT INTO protokoll (benutzer_id, benutzer_txt, aktion, objekt, objekt_id, details)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        req.benutzer ? req.benutzer.id : null,
        req.benutzer ? `${req.benutzer.name} <${req.benutzer.email}>` : 'System',
        aktion, objekt || null, objektId != null ? String(objektId) : null,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (e) {
    console.error('[STEER.E] Protokoll konnte nicht geschrieben werden:', e.message);
  }
}

module.exports = {
  hashPasswort, pruefePasswort, startPasswort,
  anmelden, sitzung, verlangt, partnerDarfProjekt, protokoll,
};
