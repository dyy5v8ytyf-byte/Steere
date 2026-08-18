'use strict';
/**
 * Verbindung zu Microsoft 365 und die Aktionen, die darauf aufbauen.
 *
 * Getrennt von der Verwaltung, weil das Verbinden jeder Benutzer für sich
 * selbst tut — nicht der Administrator für andere.
 */

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');
const m365 = require('../lib/m365');
const kalender = require('../lib/kalenderabgleich');
const planner = require('../lib/planner');
const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router(), ['id']);
const intern = auth.verlangt('admin', 'team');

// ===================== VERBINDEN =====================
r.get('/verbinden', intern, async (req, res, next) => {
  try {
    if (!m365.eingerichtet()) {
      res.melde('Microsoft 365 ist noch nicht eingerichtet — es fehlen die Variablen M365_CLIENT_ID und M365_CLIENT_SECRET.', 'warn');
      return res.redirect('/verwaltung/m365');
    }
    const zurueck = h.txt(req.query.zurueck) || '/verwaltung/m365';
    // Nur eigene Adressen als Rücksprungziel — sonst wäre das eine offene
    // Weiterleitung, über die sich Fremdseiten anspringen ließen.
    const sicher = /^\/[A-Za-z0-9/_.-]*$/.test(zurueck) ? zurueck : '/verwaltung/m365';
    res.redirect(await m365.anmeldeAdresse(req, req.benutzer.id, sicher));
  } catch (e) { next(e); }
});

r.get('/rueckgabe', intern, async (req, res, next) => {
  try {
    if (req.query.error) {
      res.melde(`Microsoft hat die Anmeldung abgelehnt: ${req.query.error_description || req.query.error}`, 'fehler');
      return res.redirect('/verwaltung/m365');
    }
    const code = h.txt(req.query.code);
    const zustand = h.txt(req.query.state);
    if (!code || !zustand) {
      res.melde('Die Rückmeldung von Microsoft war unvollständig.', 'warn');
      return res.redirect('/verwaltung/m365');
    }
    const { zurueckZu } = await m365.rueckgabeVerarbeiten(req, code, zustand);
    await auth.protokoll(req, 'm365_verbunden', 'm365', req.benutzer.id);
    res.melde('Microsoft 365 ist verbunden.');
    res.redirect(zurueckZu);
  } catch (e) {
    console.error('[STEER.E] M365-Rückgabe:', e.message);
    res.melde('Verbindung fehlgeschlagen: ' + e.message, 'fehler');
    res.redirect('/verwaltung/m365');
  }
});

r.post('/trennen', intern, async (req, res, next) => {
  try {
    await m365.trennen(req.benutzer.id);
    await auth.protokoll(req, 'm365_getrennt', 'm365', req.benutzer.id);
    res.melde('Verbindung getrennt. In Ihrem Microsoft-Konto können Sie die Freigabe zusätzlich unter „Meine Apps" widerrufen.');
    res.redirect('/verwaltung/m365');
  } catch (e) { next(e); }
});

// ===================== TERMIN IN DEN KALENDER =====================
/** Datum und Freitext-Uhrzeit zu Graph-Zeiten machen. */
function zeiten(datum, uhrzeit, dauerMin) {
  const kal = require('../lib/kalender');
  const z = kal.zeitLesen(uhrzeit);
  const ende = kal.endzeitLesen(uhrzeit);
  const d = datum instanceof Date ? datum : new Date(datum);
  const tag = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;

  if (!z) {
    const naechster = new Date(d); naechster.setDate(naechster.getDate() + 1);
    return { ganztags: true, beginn: tag(d), ende: tag(naechster) };
  }
  const a = new Date(d); a.setHours(z.stunde, z.minute, 0, 0);
  const b = new Date(a);
  if (ende) b.setHours(ende.stunde, ende.minute, 0, 0);
  else b.setMinutes(b.getMinutes() + (dauerMin || 60));
  const stempel = (x) => `${tag(x)}T${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}:00`;
  return { ganztags: false, beginn: stempel(a), ende: stempel(b) };
}

r.post('/termin/:id', intern, async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const t = await db.one(`
      SELECT t.*, k.firma, k.adresse,
             (SELECT a.email FROM ansprechpartner a WHERE a.kunde_id = k.id
               AND a.email IS NOT NULL AND a.email <> '' ORDER BY a.id LIMIT 1) AS ap_email,
             (SELECT a.name FROM ansprechpartner a WHERE a.kunde_id = k.id
               AND a.email IS NOT NULL AND a.email <> '' ORDER BY a.id LIMIT 1) AS ap_name
        FROM termine t JOIN kunden k ON k.id = t.kunde_id WHERE t.id = $1`, [id]);
    if (!t) return res.status(404).render('fehler', { titel: 'Termin nicht gefunden', text: '' });
    if (!t.datum) {
      res.melde('Ohne Datum lässt sich kein Kalendereintrag schreiben.', 'warn');
      return res.redirect('/termine');
    }

    const mitGast = req.body.einladen === '1' && !!t.ap_email;
    const z = zeiten(t.datum, t.uhrzeit, 60);
    const e = await m365.terminSchreiben(req.benutzer.id, {
      ereignisId: t.m365_ereignis_id,
      titel: `${t.typ}: ${t.firma}${t.thema ? ' — ' + t.thema : ''}`,
      beginn: z.beginn, ende: z.ende, ganztags: z.ganztags,
      ort: t.ort || t.adresse || null,
      beschreibung: [t.thema ? `Thema: ${t.thema}` : null, t.mit_wem ? `Mit: ${t.mit_wem}` : null,
        `Kunde: ${t.firma}`, 'Angelegt aus STEER.E.'].filter(Boolean).join('\n'),
      teilnehmer: mitGast ? [{ name: t.ap_name, email: t.ap_email }] : [],
    });

    if (e && e.id) {
      await db.query('UPDATE termine SET m365_ereignis_id = $1, m365_stand_am = now() WHERE id = $2', [e.id, id]);
    }
    await auth.protokoll(req, 'm365_termin_geschrieben', 'termin', id, { einladung: mitGast });
    res.melde(t.m365_ereignis_id
      ? 'Der Termin wurde in Ihrem Outlook-Kalender aktualisiert.'
      : (mitGast ? `Termin angelegt und Einladung an ${t.ap_email} versendet.` : 'Termin in Ihrem Outlook-Kalender angelegt.'));
    res.redirect('/termine');
  } catch (e) {
    res.melde(e.nichtVerbunden ? e.message : 'Der Termin konnte nicht geschrieben werden: ' + e.message, 'fehler');
    res.redirect('/termine');
  }
});

r.post('/begehung/:id', intern, async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const b = await db.one(`
      SELECT b.*, k.firma,
             (SELECT a.email FROM ansprechpartner a WHERE a.kunde_id = k.id
               AND a.email IS NOT NULL AND a.email <> '' ORDER BY a.id LIMIT 1) AS ap_email,
             (SELECT a.name FROM ansprechpartner a WHERE a.kunde_id = k.id
               AND a.email IS NOT NULL AND a.email <> '' ORDER BY a.id LIMIT 1) AS ap_name
        FROM begehungen b LEFT JOIN kunden k ON k.id = b.kunde_id WHERE b.id = $1`, [id]);
    if (!b) return res.status(404).render('fehler', { titel: 'Begehung nicht gefunden', text: '' });
    if (!b.termin_am) {
      res.melde('Diese Begehung hat noch keinen Termin.', 'warn');
      return res.redirect(`/begehungen/${id}`);
    }

    const d = new Date(b.termin_am);
    const uhr = (d.getHours() === 0 && d.getMinutes() === 0) ? null
      : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const z = zeiten(d, uhr, 90);
    const mitGast = req.body.einladen === '1' && !!b.ap_email;

    const e = await m365.terminSchreiben(req.benutzer.id, {
      ereignisId: b.m365_ereignis_id,
      titel: `Begehung ${b.nummer} — ${b.objekt}${b.firma ? ' (' + b.firma + ')' : ''}`,
      beginn: z.beginn, ende: z.ende, ganztags: z.ganztags,
      ort: [b.adresse, [b.plz, b.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
      beschreibung: [
        `Aufnahme des Strompfades von der Einspeisung bis zum Ladepunkt (${b.art}).`,
        b.nutzung ? `Nutzung: ${b.nutzung}` : null,
        'Mitzubringen: Kamera, 360°-Kamera, Maßband, Zugang zu Technikräumen.',
      ].filter(Boolean).join('\n'),
      teilnehmer: mitGast ? [{ name: b.ap_name, email: b.ap_email }] : [],
    });

    if (e && e.id) {
      await db.query('UPDATE begehungen SET m365_ereignis_id = $1, m365_stand_am = now() WHERE id = $2', [e.id, id]);
    }
    await auth.protokoll(req, 'm365_begehung_geschrieben', 'begehung', id);
    res.melde(b.m365_ereignis_id ? 'Begehungstermin im Kalender aktualisiert.' : 'Begehungstermin im Kalender angelegt.');
    res.redirect(`/begehungen/${id}`);
  } catch (e) {
    res.melde(e.nichtVerbunden ? e.message : 'Der Termin konnte nicht geschrieben werden: ' + e.message, 'fehler');
    res.redirect(`/begehungen/${id}`);
  }
});

// ===================== MAIL SENDEN =====================
/**
 * Der Anhang kommt als Base64 aus dem Browser. Die Anwendung erzeugt kein
 * PDF selbst — dafuer braeuchte es einen Renderer im Container, der fuer
 * diesen einen Zweck zu teuer erkauft waere. Der Anwender sichert die
 * Druckansicht als PDF und waehlt sie hier aus.
 */
r.post('/mail', intern, express.json({ limit: '8mb' }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const ergebnis = await m365.mailSenden(req.benutzer.id, {
      an: b.an, kopie: b.kopie, betreff: b.betreff, text: b.text,
      anhang: b.anhang && b.anhang.inhalt ? b.anhang : null,
    });

    await db.query(
      `INSERT INTO m365_nachrichten (kunde_id, projekt_id, angebot_id, an, betreff, auszug,
                                     anhang_name, gesendet_von)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [h.zuZahl(b.kunde_id), h.zuZahl(b.projekt_id), h.zuZahl(b.angebot_id),
       ergebnis.an, ergebnis.betreff, String(b.text || '').slice(0, 400),
       b.anhang ? b.anhang.name : null, req.benutzer.id]
    );
    if (h.zuZahl(b.kunde_id)) {
      await db.query(
        'INSERT INTO aktivitaeten (kunde_id, projekt_id, benutzer_id, text) VALUES ($1,$2,$3,$4)',
        [h.zuZahl(b.kunde_id), h.zuZahl(b.projekt_id), req.benutzer.id,
         `Mail an ${ergebnis.an}: ${ergebnis.betreff}${b.anhang ? ' (mit Anhang)' : ''}`]
      );
    }
    await auth.protokoll(req, 'm365_mail_gesendet', 'mail', h.zuZahl(b.angebot_id), { an: ergebnis.an });
    res.json({ ok: true, an: ergebnis.an });
  } catch (e) {
    res.status(e.nichtVerbunden ? 409 : 400).json({ ok: false, fehler: e.message });
  }
});

// ===================== KALENDERABGLEICH =====================
r.get('/kalender', intern, async (req, res, next) => {
  try {
    const zustand = await kalender.zustand(req.benutzer.id);
    res.render('m365_kalender', {
      titel: 'Kalenderabgleich',
      eingerichtet: m365.eingerichtet(),
      konto: await m365.konto(req.benutzer.id),
      zustand,
      vorgaenge: zustand ? await kalender.letzteVorgaenge(req.benutzer.id, 25) : [],
      offen: await db.one(
        `SELECT COUNT(*)::int AS n FROM termine t
          WHERE t.datum >= CURRENT_DATE - 30 AND NOT t.kalender_aus`),
      abgekoppelt: await db.all(
        `SELECT t.id, t.datum, t.thema, t.typ, k.firma FROM termine t
           JOIN kunden k ON k.id = t.kunde_id
          WHERE t.kalender_aus ORDER BY t.datum DESC LIMIT 25`),
    });
  } catch (e) { next(e); }
});

r.post('/kalender/jetzt', intern, async (req, res, next) => {
  try {
    if (!m365.eingerichtet()) {
      res.melde('Microsoft 365 ist nicht eingerichtet.', 'warn');
      return res.redirect('/m365/kalender');
    }
    const e = await kalender.fuerBenutzer(req.benutzer.id);
    if (e.aus) res.melde('Der Abgleich ist für Ihr Konto ausgeschaltet.', 'warn');
    else if (e.fehler) res.melde(`Abgleich mit Fehler beendet: ${e.fehler}`, 'fehler');
    else res.melde(`Abgeglichen — ${e.rein} Änderung(en) aus Outlook übernommen, ${e.raus} nach Outlook geschrieben.`);
    await auth.protokoll(req, 'm365_kalender_abgeglichen', 'kalender', null, e);
    res.redirect('/m365/kalender');
  } catch (e) { next(e); }
});

r.post('/kalender/einstellung', intern, async (req, res, next) => {
  try {
    const richtung = ['beide', 'raus', 'rein'].includes(req.body.richtung) ? req.body.richtung : 'beide';
    await db.query(
      `INSERT INTO m365_abgleich (benutzer_id, aktiv, richtung) VALUES ($1,$2,$3)
       ON CONFLICT (benutzer_id) DO UPDATE SET aktiv = EXCLUDED.aktiv, richtung = EXCLUDED.richtung`,
      [req.benutzer.id, req.body.aktiv === 'on', richtung]
    );
    res.melde('Einstellung gespeichert.');
    res.redirect('/m365/kalender');
  } catch (e) { next(e); }
});

/** Einen abgekoppelten Termin wieder in den Abgleich nehmen. */
r.post('/kalender/:id/wieder', intern, async (req, res, next) => {
  try {
    await db.query('UPDATE termine SET kalender_aus=FALSE WHERE id=$1', [Number(req.params.id)]);
    res.melde('Der Termin wird beim nächsten Lauf wieder abgeglichen.');
    res.redirect('/m365/kalender');
  } catch (e) { next(e); }
});

// ===================== PLANNER UND TEAMS =====================
/**
 * Die Auswahllisten werden nur geladen, wenn ein Konto verbunden ist — und
 * einzeln abgesichert. Fehlt die Zustimmung fuer Group.Read.All, soll die
 * Seite trotzdem aufgehen und erklaeren, was fehlt, statt in einer
 * Fehlerseite zu enden.
 */
r.get('/planner', intern, async (req, res, next) => {
  try {
    const konto = await m365.konto(req.benutzer.id);
    const z = konto ? await planner.ziele(req.benutzer.id) : null;

    const holen = async (fn) => {
      try { return { liste: await fn(), fehler: null }; } catch (e) { return { liste: [], fehler: e.message }; }
    };
    const g = konto ? await holen(() => planner.gruppen(req.benutzer.id)) : { liste: [], fehler: null };
    const t = konto ? await holen(() => planner.teams(req.benutzer.id)) : { liste: [], fehler: null };
    const p = konto && z && z.gruppe_id ? await holen(() => planner.plaene(req.benutzer.id, z.gruppe_id)) : { liste: [], fehler: null };
    const b = konto && z && z.plan_id ? await holen(() => planner.eimer(req.benutzer.id, z.plan_id)) : { liste: [], fehler: null };
    const k = konto && z && z.team_id ? await holen(() => planner.kanaele(req.benutzer.id, z.team_id)) : { liste: [], fehler: null };

    res.render('m365_planner', {
      titel: 'Planner und Teams',
      eingerichtet: m365.eingerichtet(),
      plannerGewuenscht: m365.plannerGewuenscht(),
      erweiterte: m365.ERWEITERTE_BEREICHE,
      konto, ziele: z,
      gruppen: g, plaene: p, eimer: b, teams: t, kanaele: k,
      meldungen: await db.all(
        `SELECT * FROM m365_meldungen ORDER BY gesendet_am DESC LIMIT 20`),
      gespiegelt: await db.one(
        'SELECT COUNT(*)::int AS n FROM m365_aufgabe_planner WHERE benutzer_id=$1', [req.benutzer.id]),
    });
  } catch (e) { next(e); }
});

r.post('/planner/ziele', intern, async (req, res, next) => {
  try {
    const b = req.body;
    const namen = (liste, id) => {
      try { return (JSON.parse(liste || '[]').find((x) => x.id === id) || {}).name || null; } catch (x) { return null; }
    };
    await db.query(
      `INSERT INTO m365_ziele (benutzer_id, gruppe_id, gruppe_name, plan_id, plan_name, eimer_id, eimer_name,
                               team_id, team_name, kanal_id, kanal_name,
                               melde_angebot, melde_auftrag, melde_begehung, melde_rechnung,
                               aufgaben_spiegeln, geaendert_am)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       ON CONFLICT (benutzer_id) DO UPDATE SET
         gruppe_id=EXCLUDED.gruppe_id, gruppe_name=EXCLUDED.gruppe_name,
         plan_id=EXCLUDED.plan_id, plan_name=EXCLUDED.plan_name,
         eimer_id=EXCLUDED.eimer_id, eimer_name=EXCLUDED.eimer_name,
         team_id=EXCLUDED.team_id, team_name=EXCLUDED.team_name,
         kanal_id=EXCLUDED.kanal_id, kanal_name=EXCLUDED.kanal_name,
         melde_angebot=EXCLUDED.melde_angebot, melde_auftrag=EXCLUDED.melde_auftrag,
         melde_begehung=EXCLUDED.melde_begehung, melde_rechnung=EXCLUDED.melde_rechnung,
         aufgaben_spiegeln=EXCLUDED.aufgaben_spiegeln, geaendert_am=now()`,
      [req.benutzer.id,
       h.txt(b.gruppe_id), namen(b.gruppen_json, h.txt(b.gruppe_id)),
       h.txt(b.plan_id), namen(b.plaene_json, h.txt(b.plan_id)),
       h.txt(b.eimer_id), namen(b.eimer_json, h.txt(b.eimer_id)),
       h.txt(b.team_id), namen(b.teams_json, h.txt(b.team_id)),
       h.txt(b.kanal_id), namen(b.kanaele_json, h.txt(b.kanal_id)),
       b.melde_angebot === 'on', b.melde_auftrag === 'on',
       b.melde_begehung === 'on', b.melde_rechnung === 'on',
       b.aufgaben_spiegeln === 'on']
    );
    res.melde('Auswahl gespeichert.');
    res.redirect('/m365/planner');
  } catch (e) { next(e); }
});

r.post('/planner/jetzt', intern, async (req, res, next) => {
  try {
    const s = await planner.aufgabenSpiegeln(req.benutzer.id);
    const m = await planner.meldungenPruefen(req.benutzer.id);
    if (s.aus) res.melde('Das Spiegeln der Aufgaben ist ausgeschaltet oder es fehlt der Plan.', 'warn');
    else res.melde(`Planner: ${s.raus} hinaus, ${s.rein} als erledigt übernommen. Teams: ${m} Meldung(en).`);
    res.redirect('/m365/planner');
  } catch (e) {
    res.melde('Der Abgleich ist gescheitert: ' + e.message, 'fehler');
    res.redirect('/m365/planner');
  }
});

/** Probemeldung — damit sich der Kanal einmal ohne echten Vorgang prüfen lässt. */
r.post('/planner/probe', intern, async (req, res, next) => {
  try {
    const e = await planner.melden(req.benutzer.id, {
      anlass: `probe_${Date.now()}`, bezugArt: 'probe', bezugId: 0,
      text: 'Probemeldung aus STEER.E. Wenn Sie das hier lesen, funktioniert die Verbindung in diesen Kanal.',
    });
    if (e.aus) res.melde('Es ist noch kein Teams-Kanal ausgewählt.', 'warn');
    else if (e.fehler) res.melde('Die Meldung ging nicht hinaus: ' + e.fehler, 'fehler');
    else res.melde('Probemeldung gesendet. Schauen Sie in den Kanal.');
    res.redirect('/m365/planner');
  } catch (e) { next(e); }
});

module.exports = r;
