'use strict';
/**
 * STEER.E Plattform — Einstiegspunkt.
 * Westphal Wavetec GmbH · Sales, Kunden, Angebote, Retainer.
 */

const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);

const db = require('./lib/db');
const auth = require('./lib/auth');
const h = require('./lib/helfer');
const { starteAutomatik } = require('./lib/automatik');
const erststart = require('./lib/erststart');

const app = express();
const PORT = process.env.PORT || 3000;

// Hinter dem Railway-Proxy: sonst werden sichere Cookies nie gesetzt.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// ---------- Sitzungen ----------
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 24) {
  console.error('\n[STEER.E] SESSION_SECRET fehlt oder ist zu kurz (mind. 24 Zeichen).');
  console.error('           Auf Railway als Variable setzen, z. B. mit ${{ secret(48) }}\n');
  process.exit(1);
}

app.use(session({
  store: new PgStore({ pool: db.pool, tableName: 'sitzungen', createTableIfMissing: true }),
  name: 'steere.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 10, // 10 Stunden
  },
}));

// ---------- Sicherheitskopfzeilen ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ---------- Anzeigemodus hell/dunkel ----------
app.use((req, res, next) => {
  const m = /(?:^|;\s*)steere_modus=(hell|dunkel)/.exec(req.headers.cookie || '');
  res.locals.modus = m ? m[1] : 'dunkel';
  next();
});
app.get('/modus/:wahl', (req, res) => {
  const wahl = req.params.wahl === 'hell' ? 'hell' : 'dunkel';
  res.setHeader('Set-Cookie', `steere_modus=${wahl}; Path=/; Max-Age=31536000; SameSite=Lax`);
  res.redirect(req.get('referer') || '/');
});

app.use(auth.sitzung());

// ---------- Helfer in allen Views ----------
app.locals.eur = h.eur;
app.locals.zahl = h.zahl;
app.locals.datum = h.datum;
app.locals.datumZeit = h.datumZeit;
app.locals.fuerFeld = h.fuerFeld;
app.locals.faellig = h.faellig;
app.locals.appName = 'STEER.E';

app.use(async (req, res, next) => {
  try {
    res.locals.phasen = await h.phasen();
    res.locals.pfad = req.path;
    res.locals.hinweis = req.session ? req.session.hinweis : null;
    if (req.session) delete req.session.hinweis;
    next();
  } catch (e) { next(e); }
});

/** Kurznachricht bis zur naechsten Seite mitnehmen. */
app.use((req, res, next) => {
  res.melde = (text, art = 'ok') => { req.session.hinweis = { text, art }; };
  next();
});

// ---------- Routen ----------
app.get('/gesund', (req, res) => res.json({ status: 'ok', zeit: new Date().toISOString() }));

app.use('/', require('./routes/anmeldung'));
app.use('/', require('./routes/crm'));
app.use('/angebote', require('./routes/angebote'));
app.use('/preise', require('./routes/preise'));
app.use('/vorlagen', require('./routes/vorlagen'));
app.use('/m365', require('./routes/m365'));
app.use('/begehungen', require('./routes/begehungen'));
app.use('/rechnungen', require('./routes/rechnungen'));
app.use('/kalkulator', require('./routes/kalkulator'));
app.use('/finanzen', require('./routes/finanzen'));
app.use('/partner', require('./routes/partner'));
app.use('/verwaltung', require('./routes/verwaltung'));

app.use((req, res) => {
  res.status(404).render('fehler', {
    titel: 'Seite nicht gefunden',
    text: 'Diese Adresse gibt es nicht. Vermutlich ein alter Link.',
  });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[STEER.E] Fehler:', err);
  res.status(500).render('fehler', {
    titel: 'Da ist etwas schiefgegangen',
    text: process.env.NODE_ENV === 'production'
      ? 'Der Vorgang konnte nicht abgeschlossen werden. Es wurde nichts gespeichert.'
      : String(err && err.stack ? err.stack : err),
  });
});

// ---------- Start ----------
(async () => {
  try {
    await db.migrate();
    starteAutomatik();
    app.listen(PORT, () => {
      console.log(`[STEER.E] laeuft auf Port ${PORT}`);
      // Erst zuhoeren, dann einrichten: der Port ist sofort offen, und ein
      // Preisimport von 1.792 Positionen haelt kein Deployment auf.
      erststart.erledigen();
    });
  } catch (e) {
    console.error('[STEER.E] Start fehlgeschlagen:', e);
    process.exit(1);
  }
})();
