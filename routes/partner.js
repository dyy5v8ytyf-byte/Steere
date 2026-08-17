'use strict';
/**
 * Partnerbereich (z. B. FiERAX).
 *
 * Ein Partner sieht ausschliesslich Projekte, die seiner Organisation
 * ausdruecklich freigegeben wurden, und ausschliesslich die Felder, die hier
 * abgefragt werden. Kundenkontakte, Angebotssummen und Aktivitaeten anderer
 * Kunden sind nicht Teil der Abfragen - nicht nur ausgeblendet, sondern
 * gar nicht erst geladen.
 *
 * Zusaetzlich erfasst der Partner hier seine Retainer-Leistungen. Daraus
 * entsteht der Monatsnachweis, der bisher von Hand in Word gepflegt wurde.
 */

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');

const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router());
const partnerOderIntern = auth.verlangt('admin', 'team', 'partner');

/** Organisation, deren Daten angezeigt werden. Interne duerfen umschalten. */
async function zielOrganisation(req) {
  if (req.benutzer.rolle === 'partner') return req.benutzer.organisation_id;
  const gewuenscht = Number(req.query.org || 0);
  if (gewuenscht) return gewuenscht;
  const erste = await db.one("SELECT id FROM organisationen WHERE art = 'partner' AND aktiv = TRUE ORDER BY id LIMIT 1");
  return erste ? erste.id : null;
}

r.get('/', partnerOderIntern, async (req, res, next) => {
  try {
    const orgId = await zielOrganisation(req);
    if (!orgId) {
      return res.render('partner_uebersicht', {
        titel: 'Partnerbereich', org: null, projekte: [], retainer: null,
        monat: null, leistungen: [], summe: 0, organisationen: [],
      });
    }

    const org = await db.one('SELECT * FROM organisationen WHERE id = $1', [orgId]);

    const projekte = await db.all(`
      SELECT p.id, p.nummer, p.bezeichnung, p.phase, p.gewerk, p.baustellen_status,
             p.letzte_aktivitaet, k.firma, pp.rolle AS partnerrolle
        FROM projekt_partner pp
        JOIN projekte p ON p.id = pp.projekt_id
        JOIN kunden k ON k.id = p.kunde_id
       WHERE pp.organisation_id = $1
       ORDER BY p.letzte_aktivitaet DESC
    `, [orgId]);

    const retainer = await db.one(
      'SELECT * FROM retainer WHERE organisation_id = $1 AND aktiv = TRUE ORDER BY id LIMIT 1', [orgId]
    );

    const monat = (req.query.monat || new Date().toISOString().slice(0, 7));
    let leistungen = [];
    let summe = 0;
    if (retainer) {
      leistungen = await db.all(
        `SELECT l.*, b.name AS erfasst_von FROM leistungen l
           LEFT JOIN benutzer b ON b.id = l.benutzer_id
          WHERE l.retainer_id = $1 AND l.monat = $2 ORDER BY l.id`,
        [retainer.id, monat]
      );
      summe = leistungen.reduce((s, l) => s + Number(l.stunden), 0);
    }

    const organisationen = req.benutzer.rolle === 'partner'
      ? []
      : await db.all("SELECT * FROM organisationen WHERE art = 'partner' AND aktiv = TRUE ORDER BY name");

    res.render('partner_uebersicht', {
      titel: org ? `Partnerbereich · ${org.name}` : 'Partnerbereich',
      org, projekte, retainer, monat, leistungen, summe, organisationen,
    });
  } catch (e) { next(e); }
});

// ---------- Projektdetail (eingeschraenkt) ----------
r.get('/projekt/:id', partnerOderIntern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (req.benutzer.rolle === 'partner') {
      const erlaubt = await auth.partnerDarfProjekt(req.benutzer, id);
      if (!erlaubt) {
        return res.status(403).render('fehler', {
          titel: 'Kein Zugriff',
          text: 'Dieses Projekt ist für Ihre Organisation nicht freigegeben.',
        });
      }
    }

    const projekt = await db.one(`
      SELECT p.id, p.bezeichnung, p.beschreibung, p.phase, p.gewerk, p.baustellen_status,
             p.letzte_aktivitaet, k.firma
        FROM projekte p JOIN kunden k ON k.id = p.kunde_id WHERE p.id = $1`, [id]);
    if (!projekt) return res.status(404).render('fehler', { titel: 'Projekt nicht gefunden', text: '' });

    // Nur Termine der eigenen Gewerke, keine Kundentermine.
    const termine = await db.all(
      `SELECT datum, uhrzeit, ort, thema, typ, status, bestaetigt
         FROM termine WHERE projekt_id = $1 AND typ IN ('Tiefbau','Elektriker')
        ORDER BY datum DESC NULLS LAST`, [id]
    );

    res.render('partner_projekt', { titel: projekt.bezeichnung, projekt, termine });
  } catch (e) { next(e); }
});

// ---------- Leistungen erfassen ----------
r.post('/leistungen', partnerOderIntern, async (req, res, next) => {
  try {
    const b = req.body;
    const retainerId = Number(b.retainer_id);
    const retainer = await db.one('SELECT * FROM retainer WHERE id = $1', [retainerId]);
    if (!retainer) { res.melde('Retainer nicht gefunden.', 'warn'); return res.redirect('/partner'); }

    if (req.benutzer.rolle === 'partner' && retainer.organisation_id !== req.benutzer.organisation_id) {
      return res.status(403).render('fehler', { titel: 'Kein Zugriff', text: 'Dieser Retainer gehört nicht zu Ihrer Organisation.' });
    }

    const titel = h.txt(b.titel);
    if (!titel) { res.melde('Bitte eine Bezeichnung angeben.', 'warn'); return res.redirect(`/partner?monat=${b.monat || ''}`); }

    await db.query(
      `INSERT INTO leistungen (retainer_id, projekt_id, benutzer_id, datum, monat, titel, beschreibung, status, stunden)
       VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7,$8,$9)`,
      [retainerId, h.zuZahl(b.projekt_id), req.benutzer.id, h.txt(b.datum),
       h.txt(b.monat) || new Date().toISOString().slice(0, 7),
       titel, h.txt(b.beschreibung), h.txt(b.status) || 'laufend', h.zuZahl(b.stunden) ?? 0]
    );
    await auth.protokoll(req, 'leistung_erfasst', 'retainer', retainerId, { titel, stunden: b.stunden });
    res.melde('Leistung erfasst.');
    res.redirect(`/partner?monat=${encodeURIComponent(b.monat || '')}`);
  } catch (e) { next(e); }
});

r.post('/leistungen/:id/loeschen', partnerOderIntern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const l = await db.one(
      `SELECT l.*, r.organisation_id FROM leistungen l JOIN retainer r ON r.id = l.retainer_id WHERE l.id = $1`, [id]
    );
    if (!l) return res.redirect('/partner');
    if (req.benutzer.rolle === 'partner' && l.organisation_id !== req.benutzer.organisation_id) {
      return res.status(403).render('fehler', { titel: 'Kein Zugriff', text: '' });
    }
    await db.query('DELETE FROM leistungen WHERE id = $1', [id]);
    await auth.protokoll(req, 'leistung_geloescht', 'leistung', id, { titel: l.titel, stunden: l.stunden });
    res.melde('Leistung entfernt.');
    res.redirect(`/partner?monat=${encodeURIComponent(l.monat)}`);
  } catch (e) { next(e); }
});

// ---------- Monatsnachweis ----------
r.get('/nachweis', partnerOderIntern, async (req, res, next) => {
  try {
    const orgId = await zielOrganisation(req);
    const monat = req.query.monat || new Date().toISOString().slice(0, 7);
    const org = await db.one('SELECT * FROM organisationen WHERE id = $1', [orgId]);
    const retainer = await db.one('SELECT * FROM retainer WHERE organisation_id = $1 AND aktiv = TRUE ORDER BY id LIMIT 1', [orgId]);
    if (!retainer) return res.status(404).render('fehler', { titel: 'Kein Retainer', text: 'Für diese Organisation ist kein aktiver Retainer hinterlegt.' });

    const leistungen = await db.all(
      'SELECT * FROM leistungen WHERE retainer_id = $1 AND monat = $2 ORDER BY id', [retainer.id, monat]
    );
    const ist = leistungen.reduce((s, l) => s + Number(l.stunden), 0);
    const kontingent = Number(retainer.stunden_monat);
    const abrechenbar = Math.min(ist, kontingent);
    const entgelt = Number(retainer.entgelt_netto);

    res.render('partner_nachweis', {
      titel: `Monatsnachweis ${monat}`,
      org, retainer, monat, leistungen, ist, kontingent, abrechenbar, entgelt,
      mehrleistung: Math.max(0, ist - kontingent),
      impliziterSatz: abrechenbar > 0 ? entgelt / abrechenbar : 0,
      e: await h.einstellungen(),
      layout: false,
    });
  } catch (e) { next(e); }
});

module.exports = r;
