'use strict';
const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');

const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router());

r.get('/anmelden', (req, res) => {
  if (req.benutzer) return res.redirect('/');
  res.render('anmelden', { titel: 'Anmelden', fehler: null, weiter: req.query.weiter || '/' });
});

r.post('/anmelden', async (req, res, next) => {
  try {
    const { email, passwort } = req.body;
    const erg = await auth.anmelden(email, passwort);

    if (!erg.ok) {
      const texte = {
        unbekannt: 'E-Mail-Adresse oder Passwort stimmt nicht.',
        falsch: 'E-Mail-Adresse oder Passwort stimmt nicht.',
        gesperrt: 'Zu viele Fehlversuche. Das Konto ist für 15 Minuten gesperrt.',
      };
      return res.status(401).render('anmelden', {
        titel: 'Anmelden',
        fehler: texte[erg.grund] || 'Anmeldung nicht möglich.',
        weiter: req.body.weiter || '/',
      });
    }

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.benutzerId = erg.benutzer.id;
      auth.protokoll({ benutzer: erg.benutzer }, 'anmeldung', 'benutzer', erg.benutzer.id);
      const weiter = String(req.body.weiter || '/');
      res.redirect(weiter.startsWith('/') ? weiter : '/');
    });
  } catch (e) { next(e); }
});

r.post('/abmelden', (req, res) => {
  req.session.destroy(() => res.redirect('/anmelden'));
});
r.get('/abmelden', (req, res) => {
  req.session.destroy(() => res.redirect('/anmelden'));
});

// ---------- Passwort aendern ----------
r.get('/passwort', auth.verlangt(), (req, res) => {
  res.render('passwort', { titel: 'Passwort ändern', fehler: null });
});

r.post('/passwort', auth.verlangt(), async (req, res, next) => {
  try {
    const { alt, neu, neu2 } = req.body;
    const u = await db.one('SELECT * FROM benutzer WHERE id = $1', [req.benutzer.id]);

    const zeige = (fehler) => res.status(400).render('passwort', { titel: 'Passwort ändern', fehler });

    if (!auth.pruefePasswort(String(alt || ''), u.passwort_hash, u.passwort_salt)) {
      return zeige('Das bisherige Passwort stimmt nicht.');
    }
    if (String(neu || '').length < 12) {
      return zeige('Das neue Passwort muss mindestens 12 Zeichen haben.');
    }
    if (neu !== neu2) {
      return zeige('Die beiden neuen Passwörter stimmen nicht überein.');
    }
    if (neu === alt) {
      return zeige('Das neue Passwort muss sich vom bisherigen unterscheiden.');
    }

    const { hash, salt } = auth.hashPasswort(String(neu));
    await db.query(
      'UPDATE benutzer SET passwort_hash = $1, passwort_salt = $2, muss_wechseln = FALSE WHERE id = $3',
      [hash, salt, u.id]
    );
    await auth.protokoll(req, 'passwort_geaendert', 'benutzer', u.id);
    res.melde('Passwort geändert.');
    res.redirect('/');
  } catch (e) { next(e); }
});

module.exports = r;
