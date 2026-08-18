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

    /*
     * Forecast-Stand auf der Startseite.
     *
     * Absichtlich derselbe Rechenweg wie im Forecast selbst — nicht eine
     * zweite, aehnliche Abfrage. Zwei Rechenwege fuer dieselbe Zahl
     * driften auseinander, und dann steht auf der Startseite etwas
     * anderes als im Bericht. Wem das einmal passiert ist, der glaubt
     * beiden Zahlen nicht mehr.
     */
    const jetzt = new Date();
    const fc = require('../lib/forecast');
    const dia = require('../lib/diagramm');
    const fcJahr = await fc.jahr(jetzt.getFullYear(), 'umsatz', null, jetzt);
    const forecast = {
      jahr: jetzt.getFullYear(),
      ist: fcJahr.istSumme,
      ziel: fcJahr.sollSumme,
      zielBisher: fcJahr.sollBisher,
      abweichung: fcJahr.abweichungBisher,
      erfuellung: fcJahr.erfuellungBisher,
      hochrechnung: fcJahr.hochrechnung,
      hochrechnungErfuellung: fcJahr.hochrechnungErfuellung,
      laufend: fcJahr.laufend,
      svgSpark: dia.spark({
        werte: fcJahr.ist, bis: fcJahr.laufend ? fcJahr.bisMonat : null, id: 'db-spark',
      }),
      svgMonat: dia.sollIst({
        titel: 'Umsatz je Monat, Ist gegen Ziel',
        punkte: fcJahr.monateKurz.map((n, i) => ({ name: n, ist: fcJahr.ist[i], soll: fcJahr.soll[i] })),
        bisIndex: fcJahr.laufend ? fcJahr.bisMonat : null, hoehe: 150, id: 'db-monat',
      }),
    };

    // Termine mit Ampelbedarf: was vorbei ist und noch offen steht.
    const nachzufassen = await db.all(`
      SELECT t.*, k.firma FROM termine t JOIN kunden k ON k.id = t.kunde_id
       WHERE t.datum < CURRENT_DATE AND t.status = 'geplant'
       ORDER BY t.datum DESC LIMIT 6`);

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
      forecast, nachzufassen,
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
        `INSERT INTO ansprechpartner (kunde_id, name, telefon, mobil, email, rolle, position, bemerkung)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, h.txt(b.name), h.txt(b.telefon), h.txt(b.mobil), h.txt(b.email),
         h.txt(b.rolle), h.txt(b.position), h.txt(b.bemerkung)]
      );
      res.melde('Ansprechpartner hinzugefügt.');
    }
    res.redirect(`/kunden/${id}`);
  } catch (e) { next(e); }
});

/**
 * Ansprechpartner aendern.
 *
 * Bis 3.6 gab es nur das Anlegen — ein Zahlendreher in einer Telefonnummer
 * blieb dauerhaft stehen und wurde in der Praxis dadurch geloest, dass man
 * denselben Menschen ein zweites Mal anlegte. Danach standen zwei
 * Ansprechpartner da und niemand wusste, welcher stimmt.
 */
r.post('/kunden/:id/ansprechpartner/:apId', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const apId = Number(req.params.apId);
    const b = req.body;

    if (b.entfernen) {
      /*
       * Deaktivieren statt loeschen: Der Ansprechpartner haengt an
       * Terminen, Angeboten und Gespraechsnotizen der Vergangenheit. Wird
       * er entfernt, wird die Historie unlesbar — dort stuende dann ein
       * Gespraech mit niemandem.
       */
      await db.query('UPDATE ansprechpartner SET aktiv=FALSE, geaendert_am=now() WHERE id=$1 AND kunde_id=$2',
        [apId, id]);
      await auth.protokoll(req, 'ansprechpartner_deaktiviert', 'ansprechpartner', apId, {});
      res.melde('Ansprechpartner ist nicht mehr aktiv. Die Angaben bleiben für die Historie erhalten.');
      return res.redirect(`/kunden/${id}`);
    }

    if (b.aktivieren) {
      await db.query('UPDATE ansprechpartner SET aktiv=TRUE, geaendert_am=now() WHERE id=$1 AND kunde_id=$2',
        [apId, id]);
      res.melde('Ansprechpartner wieder aktiv.');
      return res.redirect(`/kunden/${id}`);
    }

    await db.query(
      `UPDATE ansprechpartner SET name=$1, telefon=$2, mobil=$3, email=$4, rolle=$5,
              position=$6, bemerkung=$7, geaendert_am=now()
        WHERE id=$8 AND kunde_id=$9`,
      [h.txt(b.name), h.txt(b.telefon), h.txt(b.mobil), h.txt(b.email), h.txt(b.rolle),
       h.txt(b.position), h.txt(b.bemerkung), apId, id]
    );
    await auth.protokoll(req, 'ansprechpartner_geaendert', 'ansprechpartner', apId, { name: h.txt(b.name) });
    res.melde('Ansprechpartner geändert.');
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
    /*
     * Gefiltert wird in der Datenbank, nicht in der Ansicht — sonst laedt
     * die Seite bei tausend Terminen alles und blendet neunhundert davon
     * wieder aus. "spaet" ist dabei die einzige abgeleitete Stufe: vorbei
     * und noch nicht als durchgefuehrt oder abgesagt vermerkt.
     */
    const filter = ['offen', 'heute', 'spaet', 'fertig'].includes(req.query.f) ? req.query.f : '';
    const wo = {
      offen: "t.status = 'geplant'",
      heute: "t.datum = CURRENT_DATE AND t.status = 'geplant'",
      spaet: "t.datum < CURRENT_DATE AND t.status = 'geplant'",
      fertig: "t.status = 'durchgeführt'",
    }[filter] || 'TRUE';

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
       WHERE ${wo}
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
      titel: 'Termine', termine, filter,
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

    const status = h.txt(b.status) || 'geplant';

    /*
     * Der Zeitpunkt der Durchfuehrung wird beim Umschalten gesetzt, nicht
     * beim Speichern jedes Feldes — sonst wanderte er bei jeder spaeteren
     * Korrektur mit und waere als Nachweis wertlos. Wird der Status wieder
     * zurueckgenommen, faellt er weg; ein Termin, der doch nicht
     * stattgefunden hat, soll keinen Durchfuehrungszeitpunkt behalten.
     */
    const wurdeDurchgefuehrt = status === 'durchgeführt';
    const durchgefuehrt = wurdeDurchgefuehrt
      ? (t.durchgefuehrt_am || new Date())
      : null;

    await db.query(
      `UPDATE termine SET typ=$1, mit_wem=$2, datum=$3, uhrzeit=$4, ende_uhrzeit=$5, ort=$6, thema=$7,
              bestaetigt=$8, status=$9, ergebnis=$10, kunde_informiert=$11,
              kunde_informiert_methode=$12, durchgefuehrt_am=$13,
              abgesagt_am = CASE WHEN $9 = 'abgesagt' THEN COALESCE(abgesagt_am, now()) ELSE NULL END
        WHERE id=$14`,
      [h.txt(b.typ) || t.typ, h.txt(b.mit_wem), h.txt(b.datum), h.txt(b.uhrzeit), h.txt(b.ende_uhrzeit),
       h.txt(b.ort), h.txt(b.thema), h.txt(b.bestaetigt) || 'offen', status,
       h.txt(b.ergebnis), b.kunde_informiert === 'on' || b.kunde_informiert === 'true',
       h.txt(b.kunde_informiert_methode), durchgefuehrt, id]
    );

    // Eine Terminverschiebung ist eine Aktivitaet am Kunden — sie soll in
    // der Historie stehen und nicht nur den Datensatz stillschweigend aendern.
    const altesDatum = t.datum ? new Date(t.datum).toLocaleDateString('de-DE') : 'ohne Datum';
    const neuesDatum = h.txt(b.datum) ? new Date(h.txt(b.datum)).toLocaleDateString('de-DE') : 'ohne Datum';
    if (altesDatum !== neuesDatum || (t.uhrzeit || '') !== (h.txt(b.uhrzeit) || '')) {
      await db.query(
        'INSERT INTO aktivitaeten (kunde_id, projekt_id, benutzer_id, text) VALUES ($1,$2,$3,$4)',
        [t.kunde_id, t.projekt_id, req.benutzer.id,
         `Termin verschoben: ${altesDatum}${t.uhrzeit ? ' ' + t.uhrzeit : ''} → ${neuesDatum}${h.txt(b.uhrzeit) ? ' ' + h.txt(b.uhrzeit) : ''}`]
      );
    }

    await auth.protokoll(req, 'termin_geaendert', 'termin', id, { status, datum: h.txt(b.datum) });
    res.melde('Termin gespeichert.');
    res.redirect(req.get('referer') || `/kunden/${t.kunde_id}`);
  } catch (e) { next(e); }
});

/**
 * Termin loeschen.
 *
 * Anders als bei einer Rechnung ist ein Termin kein Beleg — ein
 * versehentlich angelegter darf verschwinden. Was bleibt, ist der Eintrag
 * im Aenderungsprotokoll und in der Kundenhistorie: Dass ein Termin
 * bestand und wieder entfernt wurde, kann fuer die Nachvollziehbarkeit
 * wichtiger sein als der Termin selbst.
 */
r.post('/termine/:id/loeschen', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const t = await db.one(
      'SELECT t.*, k.firma FROM termine t JOIN kunden k ON k.id=t.kunde_id WHERE t.id=$1', [id]);
    if (!t) return res.redirect('/termine');

    await db.query(
      'INSERT INTO aktivitaeten (kunde_id, projekt_id, benutzer_id, text) VALUES ($1,$2,$3,$4)',
      [t.kunde_id, t.projekt_id, req.benutzer.id,
       `Termin gelöscht: ${t.typ}${t.datum ? ' am ' + new Date(t.datum).toLocaleDateString('de-DE') : ''}`
       + `${t.thema ? ' — ' + t.thema : ''}`]
    );
    await db.query('DELETE FROM termine WHERE id=$1', [id]);
    await auth.protokoll(req, 'termin_geloescht', 'termin', id,
      { firma: t.firma, datum: t.datum, typ: t.typ, thema: t.thema });

    res.melde('Termin gelöscht. Der Vorgang steht in der Kundenhistorie und im Änderungsprotokoll.');
    res.redirect(req.get('referer') || '/termine');
  } catch (e) { next(e); }
});

// ===================== AUFGABEN =====================
r.get('/aufgaben', intern, async (req, res, next) => {
  try {
    /*
     * Erledigte Aufgaben verschwanden bis 3.6 vollstaendig. Damit war nicht
     * mehr zu sehen, was jemand abgearbeitet hat — und wer nachweisen
     * wollte, dass eine Zusage eingehalten wurde, fand nichts.
     *
     * Jetzt ist die Vorgabe: Erledigtes der letzten 30 Tage bleibt stehen,
     * abgesetzt und mit Zeitpunkt. Aelteres laesst sich einblenden. Ein
     * vollstaendiges Ausblenden gibt es nicht mehr.
     */
    const alle = req.query.alle === '1';
    const aufgaben = await db.all(`
      SELECT a.*, k.firma, p.bezeichnung, m.name AS mitarbeiter,
             u.name AS erledigt_von_name
        FROM aufgaben a
        LEFT JOIN kunden k ON k.id = a.kunde_id
        LEFT JOIN projekte p ON p.id = a.projekt_id
        LEFT JOIN mitarbeiter m ON m.id = a.mitarbeiter_id
        LEFT JOIN benutzer u ON u.id = a.erledigt_von
       ${alle ? '' : "WHERE a.erledigt = FALSE OR a.erledigt_am > now() - INTERVAL '30 days'"}
       ORDER BY a.erledigt, a.faellig_am NULLS LAST, a.id
    `);
    const mitarbeiter = await db.all('SELECT * FROM mitarbeiter WHERE aktiv = TRUE ORDER BY name');
    const aelter = await db.one(
      "SELECT COUNT(*)::int AS n FROM aufgaben WHERE erledigt AND (erledigt_am IS NULL OR erledigt_am <= now() - INTERVAL '30 days')");
    res.render('aufgaben', {
      titel: 'Aufgaben', aufgaben, mitarbeiter,
      alle, aelterAnzahl: aelter ? aelter.n : 0,
    });
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
      // Zeitpunkt und Person mitschreiben. Ohne die beiden ist "erledigt"
      // eine Behauptung ohne Absender.
      await db.query(
        `UPDATE aufgaben SET erledigt = NOT erledigt,
                status = CASE WHEN NOT erledigt THEN 'erledigt' ELSE 'offen' END,
                erledigt_am = CASE WHEN NOT erledigt THEN now() ELSE NULL END,
                erledigt_von = CASE WHEN NOT erledigt THEN $2::int ELSE NULL END
          WHERE id = $1`, [id, req.benutzer.id]
      );
    } else {
      await db.query(
        `UPDATE aufgaben SET text=$1, faellig_am=$2, mitarbeiter_id=$3, status=$4, notiz=$5,
                erledigt = ($4 = 'erledigt'),
                erledigt_am = CASE WHEN $4 = 'erledigt' THEN COALESCE(erledigt_am, now()) ELSE NULL END,
                erledigt_von = CASE WHEN $4 = 'erledigt' THEN COALESCE(erledigt_von, $7::int) ELSE NULL END
          WHERE id=$6`,
        [h.txt(b.text), h.txt(b.faellig_am), h.zuZahl(b.mitarbeiter_id),
         h.txt(b.status) || 'offen', h.txt(b.notiz), id, req.benutzer.id]
      );
    }
    res.redirect(req.get('referer') || '/aufgaben');
  } catch (e) { next(e); }
});

/** Aufgabe entfernen — nur, was nie hätte entstehen sollen. */
r.post('/aufgaben/:id/loeschen', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const a = await db.one('SELECT * FROM aufgaben WHERE id=$1', [id]);
    if (!a) return res.redirect('/aufgaben');
    await db.query('DELETE FROM aufgaben WHERE id=$1', [id]);
    await auth.protokoll(req, 'aufgabe_geloescht', 'aufgabe', id, { text: a.text });
    res.melde('Aufgabe gelöscht.');
    res.redirect(req.get('referer') || '/aufgaben');
  } catch (e) { next(e); }
});

// ===================== MITARBEITER =====================
r.get('/mitarbeiter', intern, async (req, res, next) => {
  try {
    const liste = await db.all(`
      SELECT m.*, u.email AS konto_email, u.rolle AS konto_rolle,
             (SELECT COUNT(*)::int FROM projekte p WHERE p.projektmanager_id = m.id) AS projekte,
             (SELECT COUNT(*)::int FROM aufgaben a WHERE a.mitarbeiter_id = m.id AND NOT a.erledigt) AS offene
        FROM mitarbeiter m
        LEFT JOIN benutzer u ON u.id = m.benutzer_id
       ORDER BY m.aktiv DESC, m.name`);
    const rollen = (await h.einstellung('mitarbeiter_rollen', '')).split(',').map((s) => s.trim()).filter(Boolean);
    res.render('mitarbeiter', {
      titel: 'Mitarbeiter', liste, rollen,
      // Freie Anmeldekonten, die noch keinem Mitarbeiter zugeordnet sind.
      konten: await db.all(`
        SELECT b.id, b.name, b.email FROM benutzer b
         WHERE b.rolle <> 'partner' AND b.aktiv
           AND NOT EXISTS (SELECT 1 FROM mitarbeiter m WHERE m.benutzer_id = b.id)
         ORDER BY b.name`),
    });
  } catch (e) { next(e); }
});

r.post('/mitarbeiter', intern, async (req, res, next) => {
  try {
    const b = req.body;
    const felder = [h.txt(b.name), h.txt(b.rolle) || 'Vertrieb', h.txt(b.email), h.txt(b.telefon),
      h.txt(b.mobil), h.txt(b.funktion), h.txt(b.kuerzel), h.txt(b.eintritt_am),
      h.txt(b.bemerkung), h.zuZahl(b.benutzer_id)];

    if (b.id) {
      await db.query(
        `UPDATE mitarbeiter SET name=$1, rolle=$2, email=$3, telefon=$4, mobil=$5, funktion=$6,
                kuerzel=$7, eintritt_am=$8::date, bemerkung=$9, benutzer_id=$10, aktiv=$11
          WHERE id=$12`,
        [...felder, b.aktiv === 'on', Number(b.id)]);
      await auth.protokoll(req, 'mitarbeiter_geaendert', 'mitarbeiter', Number(b.id), { name: h.txt(b.name) });
      res.melde('Mitarbeiter gespeichert.');
    } else if (h.txt(b.name)) {
      const neu = await db.one(
        `INSERT INTO mitarbeiter (name, rolle, email, telefon, mobil, funktion, kuerzel,
                                  eintritt_am, bemerkung, benutzer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10) RETURNING id`, felder);
      await auth.protokoll(req, 'mitarbeiter_angelegt', 'mitarbeiter', neu.id, { name: h.txt(b.name) });
      res.melde(`${h.txt(b.name)} angelegt. Jetzt als Projektmanager und für Aufgaben auswählbar.`);
    } else {
      res.melde('Ohne Namen kein Mitarbeiter.', 'warn');
    }
    res.redirect('/mitarbeiter');
  } catch (e) { next(e); }
});

module.exports = r;
