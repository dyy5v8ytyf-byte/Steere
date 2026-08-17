'use strict';
/**
 * Verwaltung — nur fuer Rolle "admin".
 *
 * Hier liegt der Teil, den der Auftraggeber ausdruecklich verlangt hat:
 * Aenderungen am laufenden Programm, ohne dass Daten verloren gehen.
 * Deshalb gilt hier durchgehend:
 *   - Alles, was hier geaendert wird, ist ein Datensatz, keine Schemaaenderung.
 *   - Es gibt keine Funktion, die Kunden, Projekte, Angebote oder Protokolle
 *     loescht. Nicht mehr benoetigte Eintraege werden deaktiviert.
 *   - Vor jeder groesseren Aenderung kann mit einem Klick eine vollstaendige
 *     Sicherung als JSON gezogen werden.
 */

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');
const { uebernehmen } = require('../lib/altdaten');
const lernen = require('../lib/lernen');

const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router(), ['id', 'pid']);
const admin = auth.verlangt('admin');

// ===================== ÜBERSICHT =====================
r.get('/', admin, async (req, res, next) => {
  try {
    const stand = await db.all('SELECT * FROM schema_migrations ORDER BY version');
    const zahlen = await db.one(`
      SELECT (SELECT COUNT(*)::int FROM kunden) AS kunden,
             (SELECT COUNT(*)::int FROM projekte) AS projekte,
             (SELECT COUNT(*)::int FROM angebote) AS angebote,
             (SELECT COUNT(*)::int FROM preis_positionen WHERE aktiv) AS preise,
             (SELECT COUNT(*)::int FROM benutzer WHERE aktiv) AS benutzer,
             (SELECT COUNT(*)::int FROM protokoll) AS protokoll
    `);
    res.render('verwaltung_start', { titel: 'Verwaltung', stand, zahlen });
  } catch (e) { next(e); }
});

// ===================== EINSTELLUNGEN =====================
r.get('/einstellungen', admin, async (req, res, next) => {
  try {
    const liste = await db.all('SELECT * FROM einstellungen ORDER BY schluessel');
    res.render('verwaltung_einstellungen', { titel: 'Einstellungen', liste });
  } catch (e) { next(e); }
});

r.post('/einstellungen', admin, async (req, res, next) => {
  try {
    const geaendert = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (!k.startsWith('e_')) continue;
      const schluessel = k.slice(2);
      const alt = await db.one('SELECT wert FROM einstellungen WHERE schluessel = $1', [schluessel]);
      if (!alt || alt.wert === v) continue;
      await db.query('UPDATE einstellungen SET wert = $1, geaendert_am = now() WHERE schluessel = $2', [v, schluessel]);
      geaendert.push({ schluessel, von: alt.wert, auf: v });
    }
    h.pufferLeeren();
    if (geaendert.length) await auth.protokoll(req, 'einstellungen_geaendert', 'einstellungen', null, geaendert);
    res.melde(geaendert.length ? `${geaendert.length} Einstellung(en) gespeichert.` : 'Keine Änderung.');
    res.redirect('/verwaltung/einstellungen');
  } catch (e) { next(e); }
});

// ===================== BENUTZER =====================
r.get('/benutzer', admin, async (req, res, next) => {
  try {
    const liste = await db.all(`
      SELECT b.id, b.email, b.name, b.rolle, b.aktiv, b.muss_wechseln, b.letzter_login, o.name AS org
        FROM benutzer b LEFT JOIN organisationen o ON o.id = b.organisation_id
       ORDER BY b.aktiv DESC, b.rolle, b.name`);
    const organisationen = await db.all('SELECT * FROM organisationen WHERE aktiv = TRUE ORDER BY art, name');
    res.render('verwaltung_benutzer', {
      titel: 'Benutzer', liste, organisationen,
      neuesPasswort: req.session.neuesPasswort || null,
    });
    delete req.session.neuesPasswort;
  } catch (e) { next(e); }
});

r.post('/benutzer', admin, async (req, res, next) => {
  try {
    const b = req.body;

    if (b.id) {
      // Der letzte aktive Administrator darf sich nicht selbst aussperren.
      if (b.aktiv !== 'on' || b.rolle !== 'admin') {
        const admins = await db.one("SELECT COUNT(*)::int AS n FROM benutzer WHERE rolle='admin' AND aktiv=TRUE AND id <> $1", [Number(b.id)]);
        if (admins.n === 0) {
          res.melde('Das ist der letzte aktive Administrator. Rolle und Status bleiben unverändert.', 'warn');
          return res.redirect('/verwaltung/benutzer');
        }
      }
      await db.query(
        'UPDATE benutzer SET name=$1, rolle=$2, organisation_id=$3, aktiv=$4 WHERE id=$5',
        [h.txt(b.name), ['admin', 'team', 'partner'].includes(b.rolle) ? b.rolle : 'team',
         h.zuZahl(b.organisation_id), b.aktiv === 'on', Number(b.id)]
      );
      await auth.protokoll(req, 'benutzer_geaendert', 'benutzer', b.id, { rolle: b.rolle, aktiv: b.aktiv === 'on' });
      res.melde('Benutzer gespeichert.');

    } else if (b.zuruecksetzen) {
      const neu = auth.startPasswort();
      const { hash, salt } = auth.hashPasswort(neu);
      await db.query(
        'UPDATE benutzer SET passwort_hash=$1, passwort_salt=$2, muss_wechseln=TRUE, fehlversuche=0, gesperrt_bis=NULL WHERE id=$3',
        [hash, salt, Number(b.zuruecksetzen)]
      );
      const u = await db.one('SELECT email FROM benutzer WHERE id = $1', [Number(b.zuruecksetzen)]);
      req.session.neuesPasswort = { email: u.email, passwort: neu };
      await auth.protokoll(req, 'passwort_zurueckgesetzt', 'benutzer', b.zuruecksetzen);
      res.melde('Passwort zurückgesetzt. Bitte einmalig weitergeben — es wird nicht erneut angezeigt.');

    } else {
      const email = h.txt(b.email);
      const name = h.txt(b.name);
      if (!email || !name) { res.melde('Name und E-Mail sind Pflicht.', 'warn'); return res.redirect('/verwaltung/benutzer'); }
      const vorhanden = await db.one('SELECT id FROM benutzer WHERE lower(email) = lower($1)', [email]);
      if (vorhanden) { res.melde('Diese E-Mail-Adresse gibt es bereits.', 'warn'); return res.redirect('/verwaltung/benutzer'); }

      const neu = auth.startPasswort();
      const { hash, salt } = auth.hashPasswort(neu);
      const u = await db.one(
        `INSERT INTO benutzer (email, name, rolle, organisation_id, passwort_hash, passwort_salt)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [email, name, ['admin', 'team', 'partner'].includes(b.rolle) ? b.rolle : 'team',
         h.zuZahl(b.organisation_id), hash, salt]
      );
      req.session.neuesPasswort = { email, passwort: neu };
      await auth.protokoll(req, 'benutzer_angelegt', 'benutzer', u.id, { email, rolle: b.rolle });
      res.melde('Benutzer angelegt. Startpasswort bitte einmalig weitergeben.');
    }
    res.redirect('/verwaltung/benutzer');
  } catch (e) { next(e); }
});

// ===================== ORGANISATIONEN =====================
r.get('/organisationen', admin, async (req, res, next) => {
  try {
    const liste = await db.all(`
      SELECT o.*, (SELECT COUNT(*)::int FROM benutzer b WHERE b.organisation_id = o.id) AS benutzer,
             (SELECT COUNT(*)::int FROM projekt_partner pp WHERE pp.organisation_id = o.id) AS projekte
        FROM organisationen o ORDER BY o.art, o.name`);
    const retainer = await db.all(`
      SELECT r.*, o.name AS org FROM retainer r JOIN organisationen o ON o.id = r.organisation_id ORDER BY r.id`);
    res.render('verwaltung_organisationen', { titel: 'Organisationen & Retainer', liste, retainer });
  } catch (e) { next(e); }
});

r.post('/organisationen', admin, async (req, res, next) => {
  try {
    const b = req.body;
    if (b.id) {
      await db.query('UPDATE organisationen SET name=$1, kuerzel=$2, art=$3, aktiv=$4 WHERE id=$5',
        [h.txt(b.name), h.txt(b.kuerzel), b.art === 'intern' ? 'intern' : 'partner', b.aktiv === 'on', Number(b.id)]);
    } else if (h.txt(b.name)) {
      await db.query('INSERT INTO organisationen (name, kuerzel, art) VALUES ($1,$2,$3)',
        [h.txt(b.name), h.txt(b.kuerzel), b.art === 'intern' ? 'intern' : 'partner']);
    }
    await auth.protokoll(req, 'organisation_gespeichert', 'organisation', b.id || null);
    res.melde('Gespeichert.');
    res.redirect('/verwaltung/organisationen');
  } catch (e) { next(e); }
});

r.post('/retainer', admin, async (req, res, next) => {
  try {
    const b = req.body;
    if (b.id) {
      await db.query(
        `UPDATE retainer SET bezeichnung=$1, stunden_monat=$2, entgelt_netto=$3, start_am=$4::date,
                ende_am=$5::date, aktiv=$6, hinweis=$7 WHERE id=$8`,
        [h.txt(b.bezeichnung), h.zuZahl(b.stunden_monat) ?? 0, h.zuZahl(b.entgelt_netto) ?? 0,
         h.txt(b.start_am), h.txt(b.ende_am), b.aktiv === 'on', h.txt(b.hinweis), Number(b.id)]
      );
    } else if (h.zuZahl(b.organisation_id)) {
      await db.query(
        `INSERT INTO retainer (organisation_id, bezeichnung, stunden_monat, entgelt_netto, start_am, hinweis)
         VALUES ($1,$2,$3,$4,$5::date,$6)`,
        [h.zuZahl(b.organisation_id), h.txt(b.bezeichnung) || 'Retainer',
         h.zuZahl(b.stunden_monat) ?? 80, h.zuZahl(b.entgelt_netto) ?? 0, h.txt(b.start_am), h.txt(b.hinweis)]
      );
    }
    await auth.protokoll(req, 'retainer_gespeichert', 'retainer', b.id || null);
    res.melde('Gespeichert.');
    res.redirect('/verwaltung/organisationen');
  } catch (e) { next(e); }
});

// ===================== EIGENE FELDER =====================
r.get('/felder', admin, async (req, res, next) => {
  try {
    const liste = await db.all('SELECT * FROM felder ORDER BY bereich, reihenfolge, id');
    const belegung = await db.all('SELECT feld_id, COUNT(*)::int AS n FROM feld_werte GROUP BY feld_id');
    const m = new Map(belegung.map((x) => [x.feld_id, x.n]));
    res.render('verwaltung_felder', {
      titel: 'Eigene Felder',
      liste: liste.map((f) => ({ ...f, belegt: m.get(f.id) || 0 })),
    });
  } catch (e) { next(e); }
});

r.post('/felder', admin, async (req, res, next) => {
  try {
    const b = req.body;
    if (b.id) {
      // Der Schluessel bleibt unveraenderlich - sonst verlieren bestehende
      // Werte ihren Bezug. Bezeichnung und Reihenfolge sind frei aenderbar.
      await db.query(
        'UPDATE felder SET bezeichnung=$1, typ=$2, optionen=$3, pflicht=$4, reihenfolge=$5, aktiv=$6 WHERE id=$7',
        [h.txt(b.bezeichnung), h.txt(b.typ) || 'text', h.txt(b.optionen),
         b.pflicht === 'on', h.zuZahl(b.reihenfolge) ?? 100, b.aktiv === 'on', Number(b.id)]
      );
      res.melde('Feld gespeichert. Bereits erfasste Werte bleiben erhalten.');
    } else {
      const bezeichnung = h.txt(b.bezeichnung);
      if (!bezeichnung) { res.melde('Bezeichnung fehlt.', 'warn'); return res.redirect('/verwaltung/felder'); }
      const schluessel = bezeichnung.toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `feld_${Date.now()}`;
      await db.query(
        `INSERT INTO felder (bereich, schluessel, bezeichnung, typ, optionen, pflicht, reihenfolge)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (bereich, schluessel) DO NOTHING`,
        [['kunde', 'projekt', 'angebot'].includes(b.bereich) ? b.bereich : 'projekt',
         schluessel, bezeichnung, h.txt(b.typ) || 'text', h.txt(b.optionen),
         b.pflicht === 'on', h.zuZahl(b.reihenfolge) ?? 100]
      );
      res.melde('Feld angelegt. Es erscheint sofort in den Masken.');
    }
    await auth.protokoll(req, 'feld_gespeichert', 'feld', b.id || null, { bezeichnung: b.bezeichnung });
    res.redirect('/verwaltung/felder');
  } catch (e) { next(e); }
});

// ===================== SICHERUNG =====================
r.get('/sicherung', admin, async (req, res, next) => {
  try {
    const tabellen = [
      'organisationen', 'benutzer', 'mitarbeiter', 'kunden', 'ansprechpartner', 'projekte',
      'projekt_partner', 'termine', 'aufgaben', 'aktivitaeten', 'einstellungen',
      'preis_positionen', 'angebote', 'angebot_positionen', 'nummernkreise',
      'retainer', 'leistungen', 'felder', 'feld_werte',
    ];
    const sicherung = {
      erzeugt_am: new Date().toISOString(),
      erzeugt_von: req.benutzer.email,
      schema: (await db.all('SELECT version, applied_at FROM schema_migrations ORDER BY version')),
      daten: {},
    };
    for (const t of tabellen) {
      sicherung.daten[t] = await db.all(`SELECT * FROM ${t}`);
    }
    // Passwort-Hashes gehoeren nicht in eine Datei, die per Mail wandert.
    sicherung.daten.benutzer = sicherung.daten.benutzer.map((u) => {
      const { passwort_hash, passwort_salt, ...rest } = u; // eslint-disable-line no-unused-vars
      return rest;
    });

    await auth.protokoll(req, 'sicherung_erzeugt', null, null, { tabellen: tabellen.length });
    const name = `steere-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(JSON.stringify(sicherung, null, 2));
  } catch (e) { next(e); }
});

// ===================== PROTOKOLL =====================
r.get('/protokoll', admin, async (req, res, next) => {
  try {
    const seite = Math.max(1, Number(req.query.seite || 1));
    const proSeite = 100;
    const gesamt = (await db.one('SELECT COUNT(*)::int AS n FROM protokoll')).n;
    const eintraege = await db.all(
      'SELECT * FROM protokoll ORDER BY zeitpunkt DESC LIMIT $1 OFFSET $2',
      [proSeite, (seite - 1) * proSeite]
    );
    res.render('verwaltung_protokoll', {
      titel: 'Änderungsprotokoll', eintraege, seite, seiten: Math.ceil(gesamt / proSeite), gesamt,
    });
  } catch (e) { next(e); }
});

// ===================== ASSISTENT =====================
r.get('/assistent', admin, async (req, res, next) => {
  try {
    const e = await h.einstellungen(true);
    const vorschlaege = await db.all('SELECT * FROM ki_vorschlaege ORDER BY erstellt_am DESC LIMIT 50');
    res.render('verwaltung_assistent', {
      titel: 'Projektassistent',
      aktiv: e.ki_aktiv === '1',
      schluesselVorhanden: Boolean(process.env.ANTHROPIC_API_KEY),
      modell: e.ki_modell,
      vorschlaege,
    });
  } catch (e) { next(e); }
});

// ===================== ALTDATEN ÜBERNEHMEN =====================
// Die Altdatendatei enthält personenbezogene Daten und liegt deshalb nicht im
// Repository. Sie wird hier einmalig hochgeladen. Der Vorgang ist wiederholbar:
// bereits vorhandene Kunden werden übersprungen, nie überschrieben.
r.get('/altdaten', admin, async (req, res, next) => {
  try {
    const zahlen = await db.one(`
      SELECT (SELECT COUNT(*)::int FROM kunden) AS kunden,
             (SELECT COUNT(*)::int FROM kunden WHERE quelle = 'Altdaten WWtec-Kundenliste') AS aus_altdaten
    `);
    res.render('verwaltung_altdaten', {
      titel: 'Altdaten übernehmen', zahlen,
      bericht: req.session.altdatenBericht || null,
      fehler: null,
    });
    delete req.session.altdatenBericht;
  } catch (e) { next(e); }
});

r.post('/altdaten', admin, async (req, res, next) => {
  try {
    const roh = String(req.body.inhalt || '').trim();
    if (!roh) {
      req.session.altdatenBericht = null;
      res.melde('Es wurde keine Datei ausgewählt.', 'warn');
      return res.redirect('/verwaltung/altdaten');
    }

    let zeilen;
    try {
      zeilen = JSON.parse(roh);
    } catch (e) {
      res.melde('Die Datei ist kein gültiges JSON. Bitte die Originaldatei seed_data.json verwenden.', 'fehler');
      return res.redirect('/verwaltung/altdaten');
    }

    const bericht = await uebernehmen(zeilen);
    req.session.altdatenBericht = bericht;
    await auth.protokoll(req, 'altdaten_uebernommen', null, null, {
      gesamt: bericht.gesamt, neu: bericht.neu, vorhanden: bericht.vorhanden,
    });
    res.melde(`${bericht.neu} Kunde(n) übernommen, ${bericht.vorhanden} waren bereits vorhanden.`);
    res.redirect('/verwaltung/altdaten');
  } catch (e) { next(e); }
});

// ===================== REGELN =====================
/**
 * Die beiden Regelwerke, mit denen sich die Anwendung ohne Programmierer
 * schaerfen laesst:
 *   - Pruefregeln:        welche Rueckfragen eine Begehung ausloest
 *   - Stuecklistenregeln: wie aus Mengen Material wird
 * Beides sind Datensaetze. Wer eine Regel entfernt, verliert keine Begehung.
 */
const BEZUEGE = ['fest', 'trassenlaenge', 'stellplaetze_gesamt', 'stellplaetze_ausbau',
  'ladepunkte_ac', 'ladepunkte_dc', 'abschnitt_typ'];

r.get('/regeln', admin, async (req, res, next) => {
  try {
    res.render('verwaltung_regeln', {
      titel: 'Regeln',
      pruefregeln: await db.all('SELECT * FROM pruefregeln ORDER BY reihenfolge, id'),
      slregeln: await db.all('SELECT * FROM stueckliste_regeln ORDER BY reihenfolge, id'),
      PRUEFARTEN: lernen.PRUEFARTEN,
      FELDER: [...lernen.ERLAUBTE_FELDER].sort(),
      BEZUEGE,
    });
  } catch (e) { next(e); }
});

r.post('/regeln/pruef', admin, async (req, res, next) => {
  try {
    const b = req.body;
    const frage = h.txt(b.frage);
    if (!frage) { res.melde('Eine Regel braucht eine Frage.', 'warn'); return res.redirect('/verwaltung/regeln'); }
    const neu = await db.one(
      `INSERT INTO pruefregeln (name, pruefart, parameter, vergleich, frage, warum, streng, gilt_fuer_art, reihenfolge)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [h.txt(b.name) || frage.slice(0, 40),
       lernen.PRUEFARTEN.some((x) => x[0] === b.pruefart) ? b.pruefart : 'feld_fehlt',
       h.txt(b.parameter), h.zuZahl(b.vergleich), frage, h.txt(b.warum),
       b.streng === 'on', ['AC', 'DC'].includes(b.gilt_fuer_art) ? b.gilt_fuer_art : null,
       h.zuZahl(b.reihenfolge) ?? 200]
    );
    await auth.protokoll(req, 'pruefregel_angelegt', 'regel', neu.id, { frage });
    res.melde('Regel angelegt. Sie greift ab der nächsten Begehungsansicht.');
    res.redirect('/verwaltung/regeln');
  } catch (e) { next(e); }
});

r.post('/regeln/pruef/:id', admin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    if (b.umschalten) {
      await db.query('UPDATE pruefregeln SET aktiv = NOT aktiv WHERE id = $1', [id]);
      res.melde('Regel umgeschaltet.');
    } else {
      await db.query(
        `UPDATE pruefregeln SET name=$1, pruefart=$2, parameter=$3, vergleich=$4, frage=$5,
                warum=$6, streng=$7, gilt_fuer_art=$8, reihenfolge=$9 WHERE id=$10`,
        [h.txt(b.name) || 'Regel',
         lernen.PRUEFARTEN.some((x) => x[0] === b.pruefart) ? b.pruefart : 'feld_fehlt',
         h.txt(b.parameter), h.zuZahl(b.vergleich), h.txt(b.frage) || 'Frage',
         h.txt(b.warum), b.streng === 'on',
         ['AC', 'DC'].includes(b.gilt_fuer_art) ? b.gilt_fuer_art : null,
         h.zuZahl(b.reihenfolge) ?? 200, id]
      );
      res.melde('Regel gespeichert.');
    }
    await auth.protokoll(req, 'pruefregel_geaendert', 'regel', id);
    res.redirect('/verwaltung/regeln');
  } catch (e) { next(e); }
});

r.post('/regeln/stueck', admin, async (req, res, next) => {
  try {
    const b = req.body;
    const artikel = h.txt(b.artikel);
    if (!artikel) { res.melde('Ohne Artikel keine Regel.', 'warn'); return res.redirect('/verwaltung/regeln#stueck'); }
    const neu = await db.one(
      `INSERT INTO stueckliste_regeln (gruppe, artikel, beschreibung, einheit, bezug, parameter,
                                       faktor, verschnitt_pct, aufrunden, gilt_fuer_art, reihenfolge)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [h.txt(b.gruppe) || 'Elektro', artikel, h.txt(b.beschreibung), h.txt(b.einheit) || 'Stk.',
       BEZUEGE.includes(b.bezug) ? b.bezug : 'fest', h.txt(b.parameter),
       h.zuZahl(b.faktor) ?? 1, h.zuZahl(b.verschnitt_pct) ?? 0, b.aufrunden === 'on',
       ['AC', 'DC'].includes(b.gilt_fuer_art) ? b.gilt_fuer_art : null, h.zuZahl(b.reihenfolge) ?? 300]
    );
    await auth.protokoll(req, 'stueckregel_angelegt', 'regel', neu.id, { artikel });
    res.melde('Stücklistenregel angelegt.');
    res.redirect('/verwaltung/regeln#stueck');
  } catch (e) { next(e); }
});

r.post('/regeln/stueck/:id', admin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    if (b.umschalten) {
      await db.query('UPDATE stueckliste_regeln SET aktiv = NOT aktiv WHERE id = $1', [id]);
      res.melde('Regel umgeschaltet.');
    } else {
      await db.query(
        `UPDATE stueckliste_regeln SET gruppe=$1, artikel=$2, beschreibung=$3, einheit=$4, bezug=$5,
                parameter=$6, faktor=$7, verschnitt_pct=$8, aufrunden=$9, gilt_fuer_art=$10,
                reihenfolge=$11 WHERE id=$12`,
        [h.txt(b.gruppe) || 'Elektro', h.txt(b.artikel) || 'Artikel', h.txt(b.beschreibung),
         h.txt(b.einheit) || 'Stk.', BEZUEGE.includes(b.bezug) ? b.bezug : 'fest', h.txt(b.parameter),
         h.zuZahl(b.faktor) ?? 1, h.zuZahl(b.verschnitt_pct) ?? 0, b.aufrunden === 'on',
         ['AC', 'DC'].includes(b.gilt_fuer_art) ? b.gilt_fuer_art : null,
         h.zuZahl(b.reihenfolge) ?? 300, id]
      );
      res.melde('Regel gespeichert.');
    }
    await auth.protokoll(req, 'stueckregel_geaendert', 'regel', id);
    res.redirect('/verwaltung/regeln#stueck');
  } catch (e) { next(e); }
});

// ===================== ERFAHRUNGEN =====================
/**
 * Einsehbar machen, was die Anwendung "gelernt" hat. Wer eine Zahl nicht
 * nachvollziehen kann, soll sie loeschen koennen — sonst ist es eine
 * Blackbox, und die hat in einem Angebotsprozess nichts zu suchen.
 */
r.get('/erfahrungen', admin, async (req, res, next) => {
  try {
    const zaehler = await db.all('SELECT * FROM merkmal_zaehler ORDER BY gesamt DESC, merkmal');
    const rows = await db.all(`
      SELECT e.*, z.gesamt FROM erfahrungen e
        LEFT JOIN merkmal_zaehler z ON z.merkmal = e.merkmal
       ORDER BY e.merkmal, e.treffer DESC`);
    const gruppen = [];
    for (const row of rows) {
      let g = gruppen.find((x) => x.merkmal === row.merkmal);
      if (!g) { g = { merkmal: row.merkmal, gesamt: row.gesamt || 0, zeilen: [] }; gruppen.push(g); }
      g.zeilen.push(row);
    }
    res.render('verwaltung_erfahrungen', {
      titel: 'Erfahrungswerte', zaehler, gruppen,
      MINDESTBASIS: lernen.MINDESTBASIS, SCHWELLE: lernen.SCHWELLE,
    });
  } catch (e) { next(e); }
});

r.post('/erfahrungen/:id', admin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await db.query('DELETE FROM erfahrungen WHERE id = $1', [id]);
    await auth.protokoll(req, 'erfahrung_entfernt', 'erfahrung', id);
    res.melde('Erfahrungswert entfernt.');
    res.redirect('/verwaltung/erfahrungen');
  } catch (e) { next(e); }
});

module.exports = r;
