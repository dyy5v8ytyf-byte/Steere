'use strict';
/**
 * Dashboard, Kunden, Projekte, Termine, Aufgaben.
 * Dieser gesamte Bereich ist Partnern verschlossen (siehe verlangt-Aufruf).
 */

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');
const kal = require('../lib/kalender');
const m365 = require('../lib/m365');
const { allesPruefen } = require('../lib/automatik');

const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router());
const intern = auth.verlangt('admin', 'team');

// ===================== DASHBOARD =====================
r.get('/', intern, async (req, res, next) => {
  try {
    const kennzahlen = await db.one(`
      SELECT
        (SELECT COUNT(*)::int FROM kunden) AS kunden,
        (SELECT COUNT(*)::int FROM projekte WHERE phase NOT IN ('Abgeschlossen','Verloren')) AS projekte_offen,
        (SELECT COUNT(*)::int FROM aufgaben WHERE erledigt = FALSE) AS aufgaben_offen,
        (SELECT COUNT(*)::int FROM aufgaben WHERE erledigt = FALSE AND faellig_am < CURRENT_DATE) AS aufgaben_ueberfaellig,
        (SELECT COUNT(*)::int FROM termine WHERE datum >= CURRENT_DATE AND status = 'geplant') AS termine_kommend,
        (SELECT COALESCE(SUM(angebotssumme),0) FROM projekte WHERE phase = 'Angebot') AS summe_angebot,
        (SELECT COALESCE(SUM(beauftragte_summe),0) FROM projekte WHERE phase IN ('Beauftragung','Terminierung','Umsetzung')) AS summe_beauftragt,
        (SELECT COALESCE(SUM(rechnungsbetrag),0) FROM projekte WHERE phase = 'Abgeschlossen') AS summe_abgerechnet
    `);

    const trichter = await db.all(`
      SELECT phase, COUNT(*)::int AS anzahl, COALESCE(SUM(angebotssumme),0) AS summe
        FROM projekte GROUP BY phase
    `);

    const naechsteTermine = await db.all(`
      SELECT t.*, k.firma, p.bezeichnung
        FROM termine t
        JOIN kunden k ON k.id = t.kunde_id
        LEFT JOIN projekte p ON p.id = t.projekt_id
       WHERE t.datum >= CURRENT_DATE AND t.status = 'geplant'
       ORDER BY t.datum, t.uhrzeit NULLS LAST
       LIMIT 8
    `);

    const offeneAufgaben = await db.all(`
      SELECT a.*, k.firma, p.bezeichnung, m.name AS mitarbeiter
        FROM aufgaben a
        LEFT JOIN kunden k ON k.id = a.kunde_id
        LEFT JOIN projekte p ON p.id = a.projekt_id
        LEFT JOIN mitarbeiter m ON m.id = a.mitarbeiter_id
       WHERE a.erledigt = FALSE
       ORDER BY a.faellig_am NULLS LAST, a.id
       LIMIT 10
    `);

    const letzteAktivitaeten = await db.all(`
      SELECT ak.*, k.firma, p.bezeichnung
        FROM aktivitaeten ak
        LEFT JOIN kunden k ON k.id = ak.kunde_id
        LEFT JOIN projekte p ON p.id = ak.projekt_id
       ORDER BY ak.datum DESC LIMIT 10
    `);

    res.render('dashboard', {
      titel: 'Übersicht',
      kennzahlen, trichter, naechsteTermine, offeneAufgaben, letzteAktivitaeten,
    });
  } catch (e) { next(e); }
});

r.post('/automatik', intern, async (req, res, next) => {
  try {
    const erg = await allesPruefen();
    await auth.protokoll(req, 'automatik_manuell', null, null, erg);
    res.melde(`Automatik gelaufen: ${erg.wiedervorlagen} Wiedervorlage(n), ${erg.aufgaben} neue Aufgabe(n).`);
    res.redirect('/');
  } catch (e) { next(e); }
});

// ===================== KUNDEN =====================
r.get('/kunden', intern, async (req, res, next) => {
  try {
    const suche = (req.query.q || '').trim();
    const phase = (req.query.phase || '').trim();
    const params = [];
    let wo = 'TRUE';

    if (suche) {
      params.push(`%${suche}%`);
      wo += ` AND (k.firma ILIKE $${params.length} OR k.branche ILIKE $${params.length}
                   OR EXISTS (SELECT 1 FROM ansprechpartner ap WHERE ap.kunde_id = k.id AND ap.name ILIKE $${params.length}))`;
    }
    if (phase) {
      params.push(phase);
      wo += ` AND EXISTS (SELECT 1 FROM projekte p WHERE p.kunde_id = k.id AND p.phase = $${params.length})`;
    }

    const kunden = await db.all(`
      SELECT k.*,
             (SELECT COUNT(*)::int FROM projekte p WHERE p.kunde_id = k.id) AS projekte,
             (SELECT string_agg(DISTINCT p.phase, ', ') FROM projekte p WHERE p.kunde_id = k.id) AS phasen,
             (SELECT ap.name FROM ansprechpartner ap WHERE ap.kunde_id = k.id ORDER BY ap.id LIMIT 1) AS ap_name,
             (SELECT ap.telefon FROM ansprechpartner ap WHERE ap.kunde_id = k.id ORDER BY ap.id LIMIT 1) AS ap_telefon,
             (SELECT MIN(p.potential) FROM projekte p WHERE p.kunde_id = k.id) AS potential
        FROM kunden k
       WHERE ${wo}
       ORDER BY k.firma
    `, params);

    res.render('kunden_liste', { titel: 'Kunden & Projekte', kunden, suche, phase });
  } catch (e) { next(e); }
});

r.get('/kunden/neu', intern, async (req, res, next) => {
  try {
    res.render('kunde_neu', {
      titel: 'Neuer Kunde',
      felder: await h.eigeneFelder('kunde'),
    });
  } catch (e) { next(e); }
});

r.post('/kunden/neu', intern, async (req, res, next) => {
  try {
    const b = req.body;
    const firma = h.txt(b.firma);
    if (!firma) { res.melde('Ohne Firmennamen kann kein Kunde angelegt werden.', 'warn'); return res.redirect('/kunden/neu'); }

    const kunde = await db.tx(async (c) => {
      const k = (await c.query(
        `INSERT INTO kunden (firma, branche, adresse, website, quelle, notiz)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [firma, h.txt(b.branche), h.txt(b.adresse), h.txt(b.website), h.txt(b.quelle), h.txt(b.notiz)]
      )).rows[0];

      if (h.txt(b.ap_name) || h.txt(b.ap_telefon) || h.txt(b.ap_email)) {
        await c.query(
          'INSERT INTO ansprechpartner (kunde_id, name, telefon, email, rolle) VALUES ($1,$2,$3,$4,$5)',
          [k.id, h.txt(b.ap_name), h.txt(b.ap_telefon), h.txt(b.ap_email), h.txt(b.ap_rolle)]
        );
      }
      if (h.txt(b.projekt_bezeichnung)) {
        await c.query(
          `INSERT INTO projekte (kunde_id, bezeichnung, beschreibung, phase, potential, gewerk)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [k.id, h.txt(b.projekt_bezeichnung), h.txt(b.projekt_beschreibung),
           h.txt(b.projekt_phase) || 'Terminanfrage', h.zuZahl(b.potential), h.txt(b.gewerk)]
        );
      }
      await c.query('INSERT INTO aktivitaeten (kunde_id, text) VALUES ($1,$2)', [k.id, 'Kunde angelegt.']);
      return k;
    });

    await h.eigeneFelderSpeichern('kunde', kunde.id, b);
    await auth.protokoll(req, 'kunde_angelegt', 'kunde', kunde.id, { firma });
    res.melde(`Kunde „${firma}" angelegt.`);
    res.redirect(`/kunden/${kunde.id}`);
  } catch (e) { next(e); }
});

r.get('/kunden/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const kunde = await db.one('SELECT * FROM kunden WHERE id = $1', [id]);
    if (!kunde) return res.status(404).render('fehler', { titel: 'Kunde nicht gefunden', text: 'Dieser Kunde existiert nicht (mehr).' });

    const [ansprechpartner, projekte, termine, aufgaben, aktivitaeten, angebote, mitarbeiter, organisationen] = await Promise.all([
      db.all('SELECT * FROM ansprechpartner WHERE kunde_id = $1 ORDER BY id', [id]),
      db.all(`SELECT p.*, m.name AS pm,
                     (SELECT string_agg(o.name, ', ') FROM projekt_partner pp JOIN organisationen o ON o.id = pp.organisation_id WHERE pp.projekt_id = p.id) AS partner
                FROM projekte p LEFT JOIN mitarbeiter m ON m.id = p.projektmanager_id
               WHERE p.kunde_id = $1 ORDER BY p.id DESC`, [id]),
      db.all('SELECT * FROM termine WHERE kunde_id = $1 ORDER BY datum DESC NULLS LAST, id DESC', [id]),
      db.all(`SELECT a.*, m.name AS mitarbeiter FROM aufgaben a LEFT JOIN mitarbeiter m ON m.id = a.mitarbeiter_id
               WHERE a.kunde_id = $1 ORDER BY a.erledigt, a.faellig_am NULLS LAST, a.id`, [id]),
      db.all('SELECT * FROM aktivitaeten WHERE kunde_id = $1 ORDER BY datum DESC LIMIT 50', [id]),
      db.all('SELECT * FROM angebote WHERE kunde_id = $1 ORDER BY id DESC', [id]),
      db.all('SELECT * FROM mitarbeiter WHERE aktiv = TRUE ORDER BY name'),
      db.all("SELECT * FROM organisationen WHERE art = 'partner' AND aktiv = TRUE ORDER BY name"),
    ]);

    res.render('kunde_detail', {
      titel: kunde.firma, kunde, ansprechpartner, projekte, termine, aufgaben,
      aktivitaeten, angebote, mitarbeiter, organisationen,
      felder: await h.eigeneFelder('kunde', id),
    });
  } catch (e) { next(e); }
});

r.post('/kunden/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    await db.query(
      'UPDATE kunden SET firma=$1, branche=$2, adresse=$3, website=$4, quelle=$5, notiz=$6 WHERE id=$7',
      [h.txt(b.firma), h.txt(b.branche), h.txt(b.adresse), h.txt(b.website), h.txt(b.quelle), h.txt(b.notiz), id]
    );
    await h.eigeneFelderSpeichern('kunde', id, b);
    await auth.protokoll(req, 'kunde_geaendert', 'kunde', id);
    res.melde('Kunde gespeichert.');
    res.redirect(`/kunden/${id}`);
  } catch (e) { next(e); }
});

r.post('/kunden/:id/ansprechpartner', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    if (h.txt(b.name) || h.txt(b.telefon) || h.txt(b.email)) {
      await db.query(
        'INSERT INTO ansprechpartner (kunde_id, name, telefon, email, rolle) VALUES ($1,$2,$3,$4,$5)',
        [id, h.txt(b.name), h.txt(b.telefon), h.txt(b.email), h.txt(b.rolle)]
      );
      res.melde('Ansprechpartner hinzugefügt.');
    }
    res.redirect(`/kunden/${id}`);
  } catch (e) { next(e); }
});

r.post('/kunden/:id/notiz', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const text = h.txt(req.body.text);
    if (text) {
      await db.query(
        'INSERT INTO aktivitaeten (kunde_id, projekt_id, benutzer_id, text) VALUES ($1,$2,$3,$4)',
        [id, h.zuZahl(req.body.projekt_id), req.benutzer.id, text]
      );
      if (req.body.projekt_id) {
        await db.query('UPDATE projekte SET letzte_aktivitaet = now() WHERE id = $1', [Number(req.body.projekt_id)]);
      }
      res.melde('Notiz gespeichert.');
    }
    res.redirect(`/kunden/${id}`);
  } catch (e) { next(e); }
});

// ===================== PROJEKTE =====================
r.post('/kunden/:id/projekte', intern, async (req, res, next) => {
  try {
    const kundeId = Number(req.params.id);
    const b = req.body;
    const bez = h.txt(b.bezeichnung);
    if (!bez) { res.melde('Projekt braucht eine Bezeichnung.', 'warn'); return res.redirect(`/kunden/${kundeId}`); }

    // Doppelanlage erkennen, aber nicht verhindern - der Mensch entscheidet.
    const bestehende = await db.all('SELECT id, bezeichnung, beschreibung FROM projekte');
    const aehnlich = bestehende.filter((p) =>
      h.aehnlichkeit(`${bez} ${b.beschreibung || ''}`, `${p.bezeichnung} ${p.beschreibung || ''}`) > 0.6
    );

    const p = await db.one(
      `INSERT INTO projekte (kunde_id, bezeichnung, beschreibung, phase, potential, gewerk, projektmanager_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [kundeId, bez, h.txt(b.beschreibung), h.txt(b.phase) || 'Terminanfrage',
       h.zuZahl(b.potential), h.txt(b.gewerk), h.zuZahl(b.projektmanager_id)]
    );
    await db.query('INSERT INTO aktivitaeten (kunde_id, projekt_id, benutzer_id, text) VALUES ($1,$2,$3,$4)',
      [kundeId, p.id, req.benutzer.id, `Projekt „${bez}" angelegt.`]);
    await auth.protokoll(req, 'projekt_angelegt', 'projekt', p.id, { bezeichnung: bez });

    res.melde(aehnlich.length
      ? `Projekt angelegt. Hinweis: ${aehnlich.length} ähnliche(s) Projekt(e) vorhanden — bitte auf Doppelanlage prüfen.`
      : 'Projekt angelegt.', aehnlich.length ? 'warn' : 'ok');
    res.redirect(`/kunden/${kundeId}`);
  } catch (e) { next(e); }
});

r.post('/projekte/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    const alt = await db.one('SELECT * FROM projekte WHERE id = $1', [id]);
    if (!alt) return res.status(404).render('fehler', { titel: 'Projekt nicht gefunden', text: 'Dieses Projekt existiert nicht (mehr).' });

    const neuePhase = h.txt(b.phase) || alt.phase;
    await db.query(
      `UPDATE projekte SET bezeichnung=$1, beschreibung=$2, phase=$3, potential=$4, gewerk=$5,
              projektmanager_id=$6, angebotssumme=$7, beauftragte_summe=$8, rechnungsbetrag=$9,
              baustellen_status=$10, wiedervorlage_am=$11, letzte_aktivitaet=now()
        WHERE id=$12`,
      [h.txt(b.bezeichnung) || alt.bezeichnung, h.txt(b.beschreibung), neuePhase,
       h.zuZahl(b.potential), h.txt(b.gewerk), h.zuZahl(b.projektmanager_id),
       h.zuZahl(b.angebotssumme), h.zuZahl(b.beauftragte_summe), h.zuZahl(b.rechnungsbetrag),
       h.txt(b.baustellen_status), h.txt(b.wiedervorlage_am), id]
    );

    if (neuePhase !== alt.phase) {
      await db.query('INSERT INTO aktivitaeten (kunde_id, projekt_id, benutzer_id, text) VALUES ($1,$2,$3,$4)',
        [alt.kunde_id, id, req.benutzer.id, `Phase: ${alt.phase} → ${neuePhase}`]);
    }
    await h.eigeneFelderSpeichern('projekt', id, b);
    await auth.protokoll(req, 'projekt_geaendert', 'projekt', id, { phase_alt: alt.phase, phase_neu: neuePhase });
    res.melde('Projekt gespeichert.');
    res.redirect(`/kunden/${alt.kunde_id}`);
  } catch (e) { next(e); }
});

r.post('/projekte/:id/partner', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const orgId = h.zuZahl(req.body.organisation_id);
    const p = await db.one('SELECT kunde_id FROM projekte WHERE id = $1', [id]);
    if (!p) return res.redirect('/kunden');

    if (req.body.entfernen) {
      await db.query('DELETE FROM projekt_partner WHERE projekt_id = $1 AND organisation_id = $2', [id, orgId]);
      await auth.protokoll(req, 'partner_freigabe_entzogen', 'projekt', id, { organisation_id: orgId });
      res.melde('Freigabe entzogen. Der Partner sieht das Projekt nicht mehr.');
    } else if (orgId) {
      await db.query(
        `INSERT INTO projekt_partner (projekt_id, organisation_id, rolle) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [id, orgId, h.txt(req.body.rolle) || 'Nachunternehmer']
      );
      await auth.protokoll(req, 'partner_freigabe_erteilt', 'projekt', id, { organisation_id: orgId });
      res.melde('Projekt für den Partner freigegeben.');
    }
    res.redirect(`/kunden/${p.kunde_id}`);
  } catch (e) { next(e); }
});

// ===================== TERMINE =====================
r.get('/termine', intern, async (req, res, next) => {
  try {
    const termine = await db.all(`
      SELECT t.*, k.firma, k.adresse, p.bezeichnung,
             (SELECT a.email FROM ansprechpartner a
               WHERE a.kunde_id = k.id AND a.email IS NOT NULL AND a.email <> ''
               ORDER BY a.id LIMIT 1) AS kunde_email,
             (SELECT a.name FROM ansprechpartner a
               WHERE a.kunde_id = k.id AND a.email IS NOT NULL AND a.email <> ''
               ORDER BY a.id LIMIT 1) AS kunde_ap
        FROM termine t JOIN kunden k ON k.id = t.kunde_id
        LEFT JOIN projekte p ON p.id = t.projekt_id
       ORDER BY t.datum DESC NULLS LAST, t.uhrzeit DESC NULLS LAST
    `);

    // Vorbereitete Mail je Termin — der Text entsteht hier, damit die
    // Ansicht nur noch verlinken muss.
    const e = await h.einstellungen();
    for (const t of termine) {
      if (!t.kunde_email) { t.mailto = null; continue; }
      const wann = t.datum
        ? new Date(t.datum).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
        : 'noch abzustimmen';
      t.mailto = kal.mailto({
        an: t.kunde_email,
        betreff: `Terminbestätigung — ${t.thema || t.typ} am ${t.datum ? new Date(t.datum).toLocaleDateString('de-DE') : ''}`.trim(),
        text: [
          kal.anrede({ name: t.kunde_ap }),
          '',
          `hiermit bestätigen wir unseren Termin am ${wann}${t.uhrzeit ? ', ' + t.uhrzeit + ' Uhr' : ''}.`,
          t.ort ? `Ort: ${t.ort}` : null,
          t.thema ? `Thema: ${t.thema}` : null,
          '',
          'Sollte Ihnen der Termin nicht passen, geben Sie uns bitte kurz Bescheid.',
          kal.signatur(req.benutzer, e),
        ].filter((z) => z !== null).join('\n'),
      });
    }

    const verbindung = await m365.konto(req.benutzer.id);
    res.render('termine', {
      titel: 'Termine', termine,
      m365Verbunden: !!verbindung,
    });
  } catch (e) { next(e); }
});

/**
 * Termin als Kalenderdatei.
 *
 * Outlook, Apple Kalender und Thunderbird tragen die Datei beim Oeffnen ein.
 * ?einladung=1 macht daraus eine Terminanfrage an den Ansprechpartner —
 * Outlook zeigt sie dann als Einladung zum Versenden.
 */
r.get('/termine/:id/kalender.ics', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const t = await db.one(`
      SELECT t.*, k.firma, k.adresse,
             (SELECT a.email FROM ansprechpartner a WHERE a.kunde_id = k.id
               AND a.email IS NOT NULL AND a.email <> '' ORDER BY a.id LIMIT 1) AS ap_email,
             (SELECT a.name FROM ansprechpartner a WHERE a.kunde_id = k.id
               AND a.email IS NOT NULL AND a.email <> '' ORDER BY a.id LIMIT 1) AS ap_name
        FROM termine t JOIN kunden k ON k.id = t.kunde_id WHERE t.id = $1`, [id]);
    if (!t) return res.status(404).render('fehler', { titel: 'Termin nicht gefunden', text: '' });
    if (!t.datum) {
      res.melde('Dieser Termin hat kein Datum — ohne Datum lässt sich kein Kalendereintrag erzeugen.', 'warn');
      return res.redirect('/termine');
    }

    const einladung = req.query.einladung === '1' && !!t.ap_email;
    const e = await h.einstellungen();

    const inhalt = kal.datei({
      kennung: `termin-${t.id}@steere.wwtec.de`,
      datum: t.datum,
      uhrzeit: t.uhrzeit,
      dauerMin: 60,
      titel: `${t.typ}: ${t.firma}${t.thema ? ' — ' + t.thema : ''}`,
      ort: t.ort || t.adresse || null,
      beschreibung: [
        t.thema ? `Thema: ${t.thema}` : null,
        t.mit_wem ? `Mit: ${t.mit_wem}` : null,
        `Kunde: ${t.firma}`,
      ].filter(Boolean).join('\n'),
      einladung,
      organisator: einladung ? { name: req.benutzer.name, email: e.firma_mail || 'kontakt@wwtec.de' } : null,
      teilnehmer: einladung ? [{ name: t.ap_name, email: t.ap_email }] : [],
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8; method=' + (einladung ? 'REQUEST' : 'PUBLISH'));
    res.setHeader('Content-Disposition',
      `attachment; filename="${kal.dateiname(t.firma + '_' + (t.thema || t.typ))}"`);
    res.send(inhalt);
  } catch (e) { next(e); }
});

r.post('/kunden/:id/termine', intern, async (req, res, next) => {
  try {
    const kundeId = Number(req.params.id);
    const b = req.body;
    await db.query(
      `INSERT INTO termine (kunde_id, projekt_id, typ, mit_wem, datum, uhrzeit, ort, thema, bestaetigt, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [kundeId, h.zuZahl(b.projekt_id), h.txt(b.typ) || 'Kunde', h.txt(b.mit_wem),
       h.txt(b.datum), h.txt(b.uhrzeit), h.txt(b.ort), h.txt(b.thema),
       h.txt(b.bestaetigt) || 'offen', 'geplant']
    );
    if (b.projekt_id) await db.query('UPDATE projekte SET letzte_aktivitaet = now() WHERE id = $1', [Number(b.projekt_id)]);
    res.melde('Termin angelegt.');
    res.redirect(`/kunden/${kundeId}`);
  } catch (e) { next(e); }
});

r.post('/termine/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    const t = await db.one('SELECT * FROM termine WHERE id = $1', [id]);
    if (!t) return res.redirect('/termine');
    await db.query(
      `UPDATE termine SET typ=$1, mit_wem=$2, datum=$3, uhrzeit=$4, ort=$5, thema=$6,
              bestaetigt=$7, status=$8, ergebnis=$9, kunde_informiert=$10, kunde_informiert_methode=$11
        WHERE id=$12`,
      [h.txt(b.typ) || t.typ, h.txt(b.mit_wem), h.txt(b.datum), h.txt(b.uhrzeit), h.txt(b.ort),
       h.txt(b.thema), h.txt(b.bestaetigt) || 'offen', h.txt(b.status) || 'geplant',
       h.txt(b.ergebnis), b.kunde_informiert === 'on' || b.kunde_informiert === 'true',
       h.txt(b.kunde_informiert_methode), id]
    );
    res.melde('Termin gespeichert.');
    res.redirect(req.get('referer') || `/kunden/${t.kunde_id}`);
  } catch (e) { next(e); }
});

// ===================== AUFGABEN =====================
r.get('/aufgaben', intern, async (req, res, next) => {
  try {
    const zeigeErledigte = req.query.alle === '1';
    const aufgaben = await db.all(`
      SELECT a.*, k.firma, p.bezeichnung, m.name AS mitarbeiter
        FROM aufgaben a
        LEFT JOIN kunden k ON k.id = a.kunde_id
        LEFT JOIN projekte p ON p.id = a.projekt_id
        LEFT JOIN mitarbeiter m ON m.id = a.mitarbeiter_id
       ${zeigeErledigte ? '' : 'WHERE a.erledigt = FALSE'}
       ORDER BY a.erledigt, a.faellig_am NULLS LAST, a.id
    `);
    const mitarbeiter = await db.all('SELECT * FROM mitarbeiter WHERE aktiv = TRUE ORDER BY name');
    res.render('aufgaben', { titel: 'Aufgaben', aufgaben, mitarbeiter, zeigeErledigte });
  } catch (e) { next(e); }
});

r.post('/aufgaben/neu', intern, async (req, res, next) => {
  try {
    const b = req.body;
    const text = h.txt(b.text);
    if (text) {
      await db.query(
        `INSERT INTO aufgaben (kunde_id, projekt_id, text, faellig_am, mitarbeiter_id, notiz)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [h.zuZahl(b.kunde_id), h.zuZahl(b.projekt_id), text, h.txt(b.faellig_am),
         h.zuZahl(b.mitarbeiter_id), h.txt(b.notiz)]
      );
      res.melde('Aufgabe angelegt.');
    }
    res.redirect(req.get('referer') || '/aufgaben');
  } catch (e) { next(e); }
});

r.post('/aufgaben/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    if (b.umschalten) {
      await db.query(
        `UPDATE aufgaben SET erledigt = NOT erledigt,
                status = CASE WHEN NOT erledigt THEN 'erledigt' ELSE 'offen' END
          WHERE id = $1`, [id]
      );
    } else {
      await db.query(
        `UPDATE aufgaben SET text=$1, faellig_am=$2, mitarbeiter_id=$3, status=$4, notiz=$5,
                erledigt = ($4 = 'erledigt')
          WHERE id=$6`,
        [h.txt(b.text), h.txt(b.faellig_am), h.zuZahl(b.mitarbeiter_id),
         h.txt(b.status) || 'offen', h.txt(b.notiz), id]
      );
    }
    res.redirect(req.get('referer') || '/aufgaben');
  } catch (e) { next(e); }
});

// ===================== MITARBEITER =====================
r.get('/mitarbeiter', intern, async (req, res, next) => {
  try {
    const liste = await db.all('SELECT * FROM mitarbeiter ORDER BY aktiv DESC, name');
    const rollen = (await h.einstellung('mitarbeiter_rollen', '')).split(',').map((s) => s.trim()).filter(Boolean);
    res.render('mitarbeiter', { titel: 'Mitarbeiter', liste, rollen });
  } catch (e) { next(e); }
});

r.post('/mitarbeiter', intern, async (req, res, next) => {
  try {
    const b = req.body;
    if (b.id) {
      await db.query('UPDATE mitarbeiter SET name=$1, rolle=$2, email=$3, aktiv=$4 WHERE id=$5',
        [h.txt(b.name), h.txt(b.rolle), h.txt(b.email), b.aktiv === 'on', Number(b.id)]);
    } else if (h.txt(b.name)) {
      await db.query('INSERT INTO mitarbeiter (name, rolle, email) VALUES ($1,$2,$3)',
        [h.txt(b.name), h.txt(b.rolle) || 'Vertrieb', h.txt(b.email)]);
    }
    res.melde('Gespeichert.');
    res.redirect('/mitarbeiter');
  } catch (e) { next(e); }
});

module.exports = r;
