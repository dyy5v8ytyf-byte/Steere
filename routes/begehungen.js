'use strict';
/**
 * Begehungen.
 *
 * Der Ablauf ist bewusst starr: Eine Begehung wird immer entlang des
 * Strompfades aufgenommen — von der Stelle, an der der Strom ankommt, bis zum
 * letzten Abnehmer. Deshalb legt die Anwendung beim Anlegen bereits die
 * Standardabschnitte an, statt ein leeres Formular hinzustellen. Wer etwas
 * nicht braucht, entfernt es; wer etwas vergisst, sieht die Lücke.
 *
 * Die Freigabe prüft die Pflichtfotos. Eine Begehung ohne Bild vom
 * Netzanschluss ist kein Begehungsbericht, sondern eine Behauptung.
 */

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');
const medien = require('../lib/medien');
const vorlagen = require('../lib/vorlagen');
const lernen = require('../lib/lernen');
const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router(), ['id', 'pid', 'mid', 'rid']);
const intern = auth.verlangt('admin', 'team');

const STATUS = ['geplant', 'vor Ort', 'erfasst', 'freigegeben', 'in Angebot'];

async function abschnittstypen() {
  const s = await h.einstellung('begehung_abschnittstypen', '');
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}
async function pflichtfotos() {
  const s = await h.einstellung('begehung_pflichtfotos', '');
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

// ===================== LISTE =====================
r.get('/', intern, async (req, res, next) => {
  try {
    const status = (req.query.status || '').trim();
    const params = [];
    let wo = 'TRUE';
    if (status) { params.push(status); wo += ` AND b.status = $${params.length}`; }

    const liste = await db.all(`
      SELECT b.*, k.firma, p.bezeichnung AS projekt, u.name AS begeher,
             (SELECT COUNT(*)::int FROM begehung_medien m WHERE m.begehung_id = b.id) AS medien,
             (SELECT COUNT(*)::int FROM begehung_abschnitte a WHERE a.begehung_id = b.id) AS abschnitte,
             (SELECT COUNT(*)::int FROM begehung_positionen q WHERE q.begehung_id = b.id) AS positionen
        FROM begehungen b
        LEFT JOIN kunden k ON k.id = b.kunde_id
        LEFT JOIN projekte p ON p.id = b.projekt_id
        LEFT JOIN benutzer u ON u.id = b.begeher_id
       WHERE ${wo}
       ORDER BY COALESCE(b.termin_am, b.angelegt_am) DESC
    `, params);

    res.render('begehungen_liste', { titel: 'Begehungen', liste, status, STATUS });
  } catch (e) { next(e); }
});

// ===================== NEU =====================
r.get('/neu', intern, async (req, res, next) => {
  try {
    res.render('begehung_neu', {
      titel: 'Begehung planen',
      kunden: await db.all('SELECT id, firma FROM kunden ORDER BY firma'),
      projekte: await db.all(`SELECT p.id, p.bezeichnung, k.firma FROM projekte p
                                JOIN kunden k ON k.id = p.kunde_id
                               WHERE p.phase NOT IN ('Abgeschlossen','Verloren')
                               ORDER BY k.firma, p.bezeichnung`),
      vorgabeKunde: req.query.kunde ? Number(req.query.kunde) : null,
    });
  } catch (e) { next(e); }
});

r.post('/neu', intern, async (req, res, next) => {
  try {
    const b = req.body;
    const objekt = h.txt(b.objekt);
    if (!objekt) { res.melde('Ohne Objektbezeichnung geht es nicht.', 'warn'); return res.redirect('/begehungen/neu'); }

    const nummer = await h.naechsteNummer('BG');
    const typen = await abschnittstypen();

    const beg = await db.tx(async (c) => {
      const x = (await c.query(
        `INSERT INTO begehungen (nummer, kunde_id, projekt_id, objekt, adresse, plz, ort,
                                 termin_am, begeher_id, begleitung, art, nutzung, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'geplant') RETURNING *`,
        [nummer, h.zuZahl(b.kunde_id), h.zuZahl(b.projekt_id), objekt, h.txt(b.adresse),
         h.txt(b.plz), h.txt(b.ort), h.txt(b.termin_am) || null,
         h.zuZahl(b.begeher_id) || req.benutzer.id, h.txt(b.begleitung),
         h.txt(b.art) || 'AC', h.txt(b.nutzung)]
      )).rows[0];

      // Standardabschnitte vorbelegen — der Strompfad steht von Anfang an.
      const vorgabe = (h.txt(b.art) || 'AC') === 'DC'
        ? ['Netzanschluss / Übergabe', 'Zählerplatz / Messung', 'Trasse Außenbereich', 'Unterverteilung / Ladeverteiler', 'Ladepunkt DC (HPC)']
        : ['Netzanschluss / Übergabe', 'Zählerplatz / Messung', 'Hauptverteilung', 'Steigleitung', 'Trasse Innenbereich', 'Stromschiene', 'Abgangskasten', 'Ladepunkt AC (Wallbox)'];
      let lfd = 1;
      for (const typ of vorgabe) {
        if (!typen.includes(typ)) continue;
        await c.query('INSERT INTO begehung_abschnitte (begehung_id, lfd, typ) VALUES ($1,$2,$3)', [x.id, lfd, typ]);
        lfd += 1;
      }
      return x;
    });

    await auth.protokoll(req, 'begehung_angelegt', 'begehung', beg.id, { nummer, objekt });
    res.melde(`Begehung ${nummer} angelegt — der Strompfad ist vorbelegt.`);
    res.redirect(`/begehungen/${beg.id}`);
  } catch (e) { next(e); }
});

// ===================== DETAIL =====================
r.get('/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const begehung = await db.one(`
      SELECT b.*, k.firma, p.bezeichnung AS projekt, u.name AS begeher
        FROM begehungen b
        LEFT JOIN kunden k ON k.id = b.kunde_id
        LEFT JOIN projekte p ON p.id = b.projekt_id
        LEFT JOIN benutzer u ON u.id = b.begeher_id
       WHERE b.id = $1`, [id]);
    if (!begehung) return res.status(404).render('fehler', { titel: 'Begehung nicht gefunden', text: 'Diese Begehung existiert nicht (mehr).' });

    const [abschnitte, positionen, medienListe] = await Promise.all([
      db.all('SELECT * FROM begehung_abschnitte WHERE begehung_id = $1 ORDER BY lfd, id', [id]),
      db.all('SELECT * FROM begehung_positionen WHERE begehung_id = $1 ORDER BY lfd, id', [id]),
      db.all(`SELECT m.*, a.typ AS abschnitt_typ FROM begehung_medien m
                LEFT JOIN begehung_abschnitte a ON a.id = m.abschnitt_id
               WHERE m.begehung_id = $1 ORDER BY m.id`, [id]),
    ]);

    for (const m of medienListe) m.url = await medien.abrufAdresse(m.schluessel);

    const pflicht = await pflichtfotos();
    const vorhanden = new Set(medienListe.map((m) => (m.titel || '').trim()));
    const fehlend = pflicht.filter((p) => !vorhanden.has(p));

    // Rueckfragen und Erfahrungswerte. Beides ist rein intern und taucht
    // in keinem Dokument auf, das der Kunde zu sehen bekommt.
    const fragen = await lernen.pruefe(id);
    const rat = await lernen.vorschlaege(id, positionen.map((p) => p.text));

    res.render('begehung_detail', {
      titel: `Begehung ${begehung.nummer}`,
      begehung, abschnitte, positionen, medien: medienListe,
      typen: await abschnittstypen(), pflicht, fehlend, STATUS,
      speicherArt: medien.aktiveArt(),
      maxMB: medien.MAX_MB,
      kunden: await db.all('SELECT id, firma FROM kunden ORDER BY firma'),
      fragen, rat,
      vorlagenListe: await vorlagen.liste(true),
      bausteine: await vorlagen.bausteineFuer(['feststellung', 'risiko', 'fazit']),
    });
  } catch (e) { next(e); }
});

r.post('/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    await db.query(`
      UPDATE begehungen SET
        objekt=$1, adresse=$2, plz=$3, ort=$4, kunde_id=$5, termin_am=$6, durchgefuehrt_am=$7,
        begleitung=$8, art=$9, nutzung=$10, status=$11,
        netz_vnb=$12, netz_art=$13, netz_leistung_kw=$14, netz_reserve_kw=$15,
        netz_zaehler=$16, netz_ort=$17, netz_bemerkung=$18,
        stellplaetze_gesamt=$19, stellplaetze_ausbau=$20, ladepunkte_ac=$21, ladepunkte_dc=$22,
        leistung_je_lp_kw=$23, lastmanagement=$24,
        variante_empfehlung=$25, variante_begruendung=$26, foerderung_moeglich=$27,
        foerderung_hinweis=$28, risiken=$29, fazit=$30, geo_lat=$31, geo_lon=$32,
        geaendert_am=now()
      WHERE id=$33`,
      [h.txt(b.objekt), h.txt(b.adresse), h.txt(b.plz), h.txt(b.ort), h.zuZahl(b.kunde_id),
       h.txt(b.termin_am) || null, h.txt(b.durchgefuehrt_am) || null, h.txt(b.begleitung),
       h.txt(b.art) || 'AC', h.txt(b.nutzung), STATUS.includes(b.status) ? b.status : 'geplant',
       h.txt(b.netz_vnb), h.txt(b.netz_art), h.zuZahl(b.netz_leistung_kw), h.zuZahl(b.netz_reserve_kw),
       h.txt(b.netz_zaehler), h.txt(b.netz_ort), h.txt(b.netz_bemerkung),
       h.zuZahl(b.stellplaetze_gesamt), h.zuZahl(b.stellplaetze_ausbau),
       h.zuZahl(b.ladepunkte_ac), h.zuZahl(b.ladepunkte_dc), h.zuZahl(b.leistung_je_lp_kw),
       h.txt(b.lastmanagement), h.txt(b.variante_empfehlung), h.txt(b.variante_begruendung),
       h.txt(b.foerderung_moeglich), h.txt(b.foerderung_hinweis), h.txt(b.risiken), h.txt(b.fazit),
       h.zuZahl(b.geo_lat), h.zuZahl(b.geo_lon), id]
    );
    await vorlagen.merkeMehrere([['risiko', b.risiken], ['fazit', b.fazit]], req.benutzer.id);
    await auth.protokoll(req, 'begehung_geaendert', 'begehung', id);
    res.melde('Begehung gespeichert.');
    res.redirect(`/begehungen/${id}`);
  } catch (e) { next(e); }
});

// ===================== ABSCHNITTE =====================
r.post('/:id/abschnitte', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    const m = await db.one('SELECT COALESCE(MAX(lfd),0)+1 AS n FROM begehung_abschnitte WHERE begehung_id=$1', [id]);
    await db.query(
      `INSERT INTO begehung_abschnitte (begehung_id, lfd, typ, bezeichnung, von_ort, nach_ort,
                                        laenge_m, verlegeart, untergrund, querschnitt, bestand, hindernisse, bemerkung)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, m.n, h.txt(b.typ) || 'Trasse Innenbereich', h.txt(b.bezeichnung), h.txt(b.von_ort), h.txt(b.nach_ort),
       h.zuZahl(b.laenge_m), h.txt(b.verlegeart), h.txt(b.untergrund), h.txt(b.querschnitt),
       b.bestand === 'on', h.txt(b.hindernisse), h.txt(b.bemerkung)]
    );
    res.melde('Abschnitt ergänzt.');
    res.redirect(`/begehungen/${id}#pfad`);
  } catch (e) { next(e); }
});

r.post('/:id/abschnitte/:pid', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pid = Number(req.params.pid);
    const b = req.body;
    if (b.loeschen) {
      await db.query('DELETE FROM begehung_abschnitte WHERE id=$1 AND begehung_id=$2', [pid, id]);
      res.melde('Abschnitt entfernt.');
    } else {
      await db.query(
        `UPDATE begehung_abschnitte SET lfd=$1, typ=$2, bezeichnung=$3, von_ort=$4, nach_ort=$5,
                laenge_m=$6, verlegeart=$7, untergrund=$8, querschnitt=$9, bestand=$10,
                hindernisse=$11, bemerkung=$12
          WHERE id=$13 AND begehung_id=$14`,
        [h.zuZahl(b.lfd) ?? 1, h.txt(b.typ), h.txt(b.bezeichnung), h.txt(b.von_ort), h.txt(b.nach_ort),
         h.zuZahl(b.laenge_m), h.txt(b.verlegeart), h.txt(b.untergrund), h.txt(b.querschnitt),
         b.bestand === 'on', h.txt(b.hindernisse), h.txt(b.bemerkung), pid, id]
      );
    }
    res.redirect(`/begehungen/${id}#pfad`);
  } catch (e) { next(e); }
});

// ===================== FESTSTELLUNGEN / MENGEN =====================
r.post('/:id/positionen', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    const text = h.txt(b.text);
    if (text) {
      const m = await db.one('SELECT COALESCE(MAX(lfd),0)+1 AS n FROM begehung_positionen WHERE begehung_id=$1', [id]);
      await db.query(
        `INSERT INTO begehung_positionen (begehung_id, abschnitt_id, lfd, gewerk, text, einheit, menge, bemerkung)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, h.zuZahl(b.abschnitt_id), m.n, h.txt(b.gewerk) || 'Elektro', text,
         h.txt(b.einheit), h.zuZahl(b.menge) ?? 1, h.txt(b.bemerkung)]
      );
      await vorlagen.merke('feststellung', text, req.benutzer.id);
      res.melde('Feststellung erfasst.');
    }
    res.redirect(`/begehungen/${id}#mengen`);
  } catch (e) { next(e); }
});

r.post('/:id/positionen/:pid', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pid = Number(req.params.pid);
    if (req.body.loeschen) {
      await db.query('DELETE FROM begehung_positionen WHERE id=$1 AND begehung_id=$2', [pid, id]);
    } else {
      const b = req.body;
      await db.query(
        'UPDATE begehung_positionen SET gewerk=$1, text=$2, einheit=$3, menge=$4, bemerkung=$5 WHERE id=$6 AND begehung_id=$7',
        [h.txt(b.gewerk), h.txt(b.text), h.txt(b.einheit), h.zuZahl(b.menge) ?? 1, h.txt(b.bemerkung), pid, id]
      );
    }
    res.redirect(`/begehungen/${id}#mengen`);
  } catch (e) { next(e); }
});

// ===================== MEDIEN =====================
// Schritt 1: Der Browser holt sich eine Hochladeadresse.
r.post('/:id/medien/anmelden', intern, express.json(), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { dateiname, mime, art, groesse } = req.body || {};
    const kind = ['foto', 'video', 'panorama360', 'video360', 'dokument'].includes(art) ? art : 'foto';

    if (!medien.mimeErlaubt(kind, mime)) {
      return res.status(400).json({ fehler: `Dateityp ${mime || '(unbekannt)'} ist für ${kind} nicht zugelassen.` });
    }
    const grenze = medien.MAX_MB[kind] * 1024 * 1024;
    if (Number(groesse) > grenze) {
      return res.status(400).json({ fehler: `Die Datei ist größer als ${medien.MAX_MB[kind]} MB und wird nicht angenommen.` });
    }

    const schluessel = medien.schluesselBauen(id, dateiname);
    const ziel = await medien.hochladeAdresse(schluessel, mime);
    res.json({ schluessel, ...ziel });
  } catch (e) { next(e); }
});

// Schritt 2: Nach erfolgreichem Upload wird die Datei eingetragen.
r.post('/:id/medien/eintragen', intern, express.json(), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const m = await db.one(
      `INSERT INTO begehung_medien (begehung_id, abschnitt_id, art, schluessel, dateiname, groesse,
                                    mime, titel, aufgenommen_am, geo_lat, geo_lon, hochgeladen_von)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [id, h.zuZahl(b.abschnitt_id), b.art || 'foto', b.schluessel, b.dateiname,
       h.zuZahl(b.groesse), b.mime, h.txt(b.titel), b.aufgenommen_am || null,
       h.zuZahl(b.geo_lat), h.zuZahl(b.geo_lon), req.benutzer.id]
    );
    await auth.protokoll(req, 'medium_hochgeladen', 'begehung', id, { art: b.art, titel: b.titel });
    res.json({ ok: true, id: m.id });
  } catch (e) { next(e); }
});

// Lokale Ablage (nur wenn kein Object Storage eingerichtet ist).
r.put('/medien/lokal/:schluessel', intern, express.raw({ type: '*/*', limit: '1500mb' }), async (req, res, next) => {
  try {
    if (medien.aktiveArt() !== 'lokal') return res.status(400).json({ fehler: 'Object Storage ist aktiv.' });
    const fs = require('fs');
    const ziel = medien.lokalSchreibenVorbereiten(decodeURIComponent(req.params.schluessel));
    fs.writeFileSync(ziel, req.body);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.get('/medien/lokal/:schluessel', intern, async (req, res, next) => {
  try {
    const fs = require('fs');
    const ziel = medien.lokalerPfad(decodeURIComponent(req.params.schluessel));
    if (!ziel || !fs.existsSync(ziel)) return res.status(404).end();
    res.sendFile(ziel);
  } catch (e) { next(e); }
});

r.post('/:id/medien/:mid/loeschen', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const mid = Number(req.params.mid);
    const m = await db.one('SELECT * FROM begehung_medien WHERE id=$1 AND begehung_id=$2', [mid, id]);
    if (m) {
      try { await medien.loeschen(m.schluessel); } catch (e) { console.error('[STEER.E] Datei nicht löschbar:', e.message); }
      await db.query('DELETE FROM begehung_medien WHERE id=$1', [mid]);
      await auth.protokoll(req, 'medium_geloescht', 'begehung', id, { titel: m.titel });
      res.melde('Aufnahme entfernt.');
    }
    res.redirect(`/begehungen/${id}#medien`);
  } catch (e) { next(e); }
});

// ===================== RÜCKFRAGEN =====================
/**
 * Eine Rueckfrage beantworten.
 *
 * Eine Frage verschwindet auf zwei Wegen: entweder wird das fehlende Feld
 * gefuellt — dann greift die Regel von selbst nicht mehr — oder es gibt einen
 * Grund, warum es hier nicht gilt. Dieser Grund wird festgehalten, nicht
 * einfach weggeklickt. Beim naechsten Objekt steht er zum Nachlesen da.
 */
r.post('/:id/fragen/:rid', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rid = Number(req.params.rid);
    const antwort = h.txt(req.body.antwort);
    if (!antwort) {
      res.melde('Bitte kurz begründen, warum die Frage hier nicht gilt.', 'warn');
      return res.redirect(`/begehungen/${id}#fragen`);
    }
    await db.query(
      `INSERT INTO begehung_antworten (begehung_id, regel_id, antwort, erledigt, von)
       VALUES ($1,$2,$3,TRUE,$4)
       ON CONFLICT (begehung_id, regel_id)
       DO UPDATE SET antwort = EXCLUDED.antwort, erledigt = TRUE, am = now(), von = EXCLUDED.von`,
      [id, rid, antwort, req.benutzer.id]
    );
    await auth.protokoll(req, 'begehung_frage_beantwortet', 'begehung', id, { regel: rid });
    res.melde('Antwort festgehalten.');
    res.redirect(`/begehungen/${id}#fragen`);
  } catch (e) { next(e); }
});

r.post('/:id/fragen/:rid/zurueck', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await db.query('DELETE FROM begehung_antworten WHERE begehung_id=$1 AND regel_id=$2',
      [id, Number(req.params.rid)]);
    res.melde('Frage ist wieder offen.');
    res.redirect(`/begehungen/${id}#fragen`);
  } catch (e) { next(e); }
});

// ===================== STÜCKLISTE =====================
r.get('/:id/stueckliste', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const begehung = await db.one(`
      SELECT b.*, k.firma FROM begehungen b LEFT JOIN kunden k ON k.id = b.kunde_id WHERE b.id=$1`, [id]);
    if (!begehung) return res.status(404).render('fehler', { titel: 'Nicht gefunden', text: '' });

    const liste = await lernen.stueckliste(id);
    res.render('begehung_stueckliste', {
      titel: `Stückliste ${begehung.nummer}`,
      begehung, liste, e: await h.einstellungen(),
    });
  } catch (e) { next(e); }
});

/** Stueckliste als Feststellungen in die Begehung uebernehmen. */
r.post('/:id/stueckliste/uebernehmen', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const liste = await lernen.stueckliste(id);
    const gewaehlt = new Set([].concat(req.body.regel_id || []).map(Number));
    let n = 0;

    await db.tx(async (c) => {
      let lfd = (await c.query(
        'SELECT COALESCE(MAX(lfd),0) AS n FROM begehung_positionen WHERE begehung_id=$1', [id]
      )).rows[0].n;
      for (const g of liste.gruppen) {
        for (const z of g.zeilen) {
          if (gewaehlt.size && !gewaehlt.has(z.regel_id)) continue;
          lfd += 1;
          await c.query(
            `INSERT INTO begehung_positionen (begehung_id, lfd, gewerk, text, einheit, menge, bemerkung)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, lfd, g.name === 'Tiefbau' ? 'Tiefbau' : g.name === 'Elektro' ? 'Elektro' : 'Sonstiges',
             z.artikel, z.einheit, z.menge, `Aus Stückliste: ${z.rechnung}`]
          );
          n += 1;
        }
      }
    });
    await auth.protokoll(req, 'stueckliste_uebernommen', 'begehung', id, { positionen: n });
    res.melde(`${n} Position(en) aus der Stückliste übernommen.`);
    res.redirect(`/begehungen/${id}#mengen`);
  } catch (e) { next(e); }
});

// ===================== FREIGABE =====================
r.post('/:id/freigeben', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pflicht = await pflichtfotos();
    const vorhanden = await db.all('SELECT titel FROM begehung_medien WHERE begehung_id=$1', [id]);
    const menge = new Set(vorhanden.map((v) => (v.titel || '').trim()));
    const fehlend = pflicht.filter((p) => !menge.has(p));

    if (fehlend.length) {
      res.melde(`Freigabe nicht möglich — es fehlen Pflichtaufnahmen: ${fehlend.join(', ')}.`, 'warn');
      return res.redirect(`/begehungen/${id}#medien`);
    }
    // Die strengen Rueckfragen sind die Freigabebedingung. Was dort offen
    // ist, wuerde spaeter im Angebot fehlen — deshalb lieber jetzt.
    const fragen = await lernen.pruefe(id);
    if (fragen.streng.length) {
      res.melde(
        `Freigabe nicht möglich — ${fragen.streng.length} Punkt(e) sind offen: ${fragen.streng.map((f) => f.name).join(', ')}.`,
        'warn'
      );
      return res.redirect(`/begehungen/${id}#fragen`);
    }

    await db.query("UPDATE begehungen SET status='freigegeben', geaendert_am=now() WHERE id=$1", [id]);
    await auth.protokoll(req, 'begehung_freigegeben', 'begehung', id);
    res.melde('Begehung freigegeben. Sie kann jetzt in ein Angebot überführt werden.');
    res.redirect(`/begehungen/${id}`);
  } catch (e) { next(e); }
});

// ===================== IN ANGEBOT ÜBERFÜHREN =====================
r.post('/:id/zu-angebot', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const beg = await db.one('SELECT * FROM begehungen WHERE id=$1', [id]);
    if (!beg) return res.redirect('/begehungen');
    if (!beg.kunde_id) {
      res.melde('Ohne Kunden lässt sich kein Angebot erzeugen. Bitte oben einen Kunden zuordnen.', 'warn');
      return res.redirect(`/begehungen/${id}`);
    }
    // Der Knopf erscheint erst nach der Freigabe — die Prüfung gehört
    // trotzdem hierher. Ein Link lässt sich auch von Hand aufrufen.
    if (beg.status !== 'freigegeben' && beg.status !== 'in Angebot') {
      res.melde('Erst freigeben, dann überführen. Die Freigabe ist die Stelle, an der die Vollständigkeit geprüft wird.', 'warn');
      return res.redirect(`/begehungen/${id}#fragen`);
    }

    const posten = await db.all('SELECT * FROM begehung_positionen WHERE begehung_id=$1 ORDER BY lfd, id', [id]);
    const e = await h.einstellungen();

    // Vorlage waehlen: was gewaehlt wurde, sonst die passende nach Art,
    // sonst die Standardvorlage. Ohne Vorlage bleibt es beim Mengengeruest.
    let vorlage = null;
    const gewaehlt = h.zuZahl(req.body.vorlage_id);
    if (gewaehlt) vorlage = await vorlagen.laden(gewaehlt);
    if (!vorlage) {
      const kandidat = await db.one(
        `SELECT id FROM angebot_vorlagen WHERE aktiv = TRUE AND (art = $1 OR ist_standard = TRUE)
          ORDER BY (art = $1) DESC, ist_standard DESC LIMIT 1`, [beg.art || 'AC']
      );
      if (kandidat) vorlage = await vorlagen.laden(kandidat.id);
    }

    const kontext = await vorlagen.kontextAusBegehung(id);
    const nummer = await h.naechsteNummer('AN');
    let ausVorlage = 0;

    const angebot = await db.tx(async (c) => {
      const a = (await c.query(
        `INSERT INTO angebote (nummer, kunde_id, projekt_id, bauvorhaben, gewerk, anrede, einleitung,
                               vorbemerkungen, hinweise, schlusstext, mwst_satz, gueltig_bis,
                               vorlage_id, begehung_id, erstellt_von)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CURRENT_DATE + $12::int, $13,$14,$15) RETURNING *`,
        [nummer, beg.kunde_id, beg.projekt_id,
         [beg.objekt, beg.adresse, [beg.plz, beg.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '),
         `Ladeinfrastruktur ${beg.art} — auf Grundlage der Begehung ${beg.nummer}`,
         vorlage ? vorlage.anrede : null,
         (vorlage && vorlage.einleitung)
           || 'vielen Dank für Ihre Anfrage. Auf Grundlage unserer Vor-Ort-Begehung unterbreiten wir Ihnen folgendes Angebot:',
         vorlage ? vorlage.vorbemerkungen : null,
         (vorlage && vorlage.hinweise) || e.rechnung_fuss || null,
         vorlage ? vorlage.schlusstext : null,
         Number(e.mwst_satz || 19),
         Number((vorlage && vorlage.gueltigkeit_tage) || e.angebot_gueltigkeit_tage || 30),
         vorlage ? vorlage.id : null, id, req.benutzer.id]
      )).rows[0];

      // Zuerst das Geruest der Vorlage — es traegt die Sprache und die
      // Mengen, die sich aus der Begehung ableiten lassen.
      if (vorlage) {
        ausVorlage = await vorlagen.positionenSchreiben(c, a.id, vorlage, kontext, beg.art);
      }

      // Danach die Feststellungen vor Ort. Sie stehen unter einer eigenen
      // Ueberschrift, damit erkennbar bleibt, was aus der Begehung stammt
      // und was aus dem Standard.
      if (posten.length) {
        let lfd = (await c.query(
          'SELECT COALESCE(MAX(lfd),0) AS n FROM angebot_positionen WHERE angebot_id=$1', [a.id]
        )).rows[0].n;
        for (const gewerk of ['Tiefbau', 'Elektro', 'Sonstiges']) {
          const teil = posten.filter((p) => (p.gewerk || 'Sonstiges') === gewerk);
          if (!teil.length) continue;
          lfd += 1;
          await c.query(
            `INSERT INTO angebot_positionen (angebot_id, lfd, text, ist_titel, menge, einzelpreis, gesamtpreis)
             VALUES ($1,$2,$3,TRUE,0,0,0)`,
            [a.id, lfd, `${gewerk} — Feststellungen aus der Begehung`]
          );
          for (const p of teil) {
            lfd += 1;
            await c.query(
              `INSERT INTO angebot_positionen (angebot_id, lfd, text, langtext, einheit, menge, einzelpreis, gesamtpreis)
               VALUES ($1,$2,$3,$4,$5,$6,0,0)`,
              [a.id, lfd, p.text, p.bemerkung, p.einheit, p.menge]
            );
          }
        }
      }

      await vorlagen.summenNeuRechnen(c, a.id);
      await c.query("UPDATE begehungen SET status='in Angebot', geaendert_am=now() WHERE id=$1", [id]);
      await c.query(
        'INSERT INTO aktivitaeten (kunde_id, projekt_id, benutzer_id, text) VALUES ($1,$2,$3,$4)',
        [beg.kunde_id, beg.projekt_id, req.benutzer.id,
         `Angebot ${nummer} aus Begehung ${beg.nummer} erzeugt.`]
      );
      return a;
    });

    await auth.protokoll(req, 'begehung_zu_angebot', 'begehung', id,
      { angebot: nummer, positionen: posten.length, vorlage: vorlage ? vorlage.name : null });
    res.melde(vorlage
      ? `Angebot ${nummer} nach Vorlage „${vorlage.name}" erzeugt — ${ausVorlage} Position(en) aus der Vorlage, ${posten.length} aus der Begehung. Preise ohne Wert müssen noch gesetzt werden.`
      : `Angebot ${nummer} mit ${posten.length} Position(en) erzeugt. Es wurde keine Vorlage gefunden — die Texte sind der Standard.`);
    res.redirect(`/angebote/${angebot.id}`);
  } catch (e) { next(e); }
});

// ===================== BERICHT =====================
r.get('/:id/bericht', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const begehung = await db.one(`
      SELECT b.*, k.firma, u.name AS begeher FROM begehungen b
        LEFT JOIN kunden k ON k.id = b.kunde_id
        LEFT JOIN benutzer u ON u.id = b.begeher_id WHERE b.id=$1`, [id]);
    if (!begehung) return res.status(404).render('fehler', { titel: 'Nicht gefunden', text: '' });

    const abschnitte = await db.all('SELECT * FROM begehung_abschnitte WHERE begehung_id=$1 ORDER BY lfd, id', [id]);
    const positionen = await db.all('SELECT * FROM begehung_positionen WHERE begehung_id=$1 ORDER BY lfd, id', [id]);
    const medienListe = await db.all(
      "SELECT * FROM begehung_medien WHERE begehung_id=$1 AND art IN ('foto','panorama360') ORDER BY id", [id]);
    for (const m of medienListe) m.url = await medien.abrufAdresse(m.schluessel, 240);

    res.render('begehung_bericht', {
      titel: `Begehungsbericht ${begehung.nummer}`,
      begehung, abschnitte, positionen, medien: medienListe,
      e: await h.einstellungen(), layout: false,
    });
  } catch (e) { next(e); }
});

module.exports = r;
