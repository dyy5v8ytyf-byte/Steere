'use strict';
/**
 * Preiskatalog: durchsuchen, korrigieren, ergaenzen.
 * Bestehende Positionen werden nie geloescht, sondern auf aktiv = FALSE
 * gesetzt. Angebote, die eine Position verwenden, behalten dadurch ihren
 * Bezug und ihre Preise.
 */

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');

const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router());
const intern = auth.verlangt('admin', 'team');

r.get('/', intern, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const gewerk = (req.query.gewerk || '').trim();
    const herkunft = (req.query.herkunft || '').trim();
    const seite = Math.max(1, Number(req.query.seite || 1));
    const proSeite = 60;

    const params = [];
    let wo = 'aktiv = TRUE';
    if (q) {
      params.push(`%${q}%`);
      wo += ` AND (text ILIKE $${params.length} OR pos ILIKE $${params.length} OR kategorie ILIKE $${params.length})`;
    }
    if (gewerk) { params.push(gewerk); wo += ` AND gewerk = $${params.length}`; }
    if (herkunft) { params.push(herkunft); wo += ` AND herkunft = $${params.length}`; }

    const gesamt = (await db.one(`SELECT COUNT(*)::int AS n FROM preis_positionen WHERE ${wo}`, params)).n;
    params.push(proSeite, (seite - 1) * proSeite);
    const positionen = await db.all(
      `SELECT * FROM preis_positionen WHERE ${wo}
        ORDER BY gewerk, pos NULLS LAST, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );

    const statistik = await db.all(
      `SELECT herkunft, gewerk, COUNT(*)::int AS n FROM preis_positionen WHERE aktiv = TRUE
        GROUP BY herkunft, gewerk ORDER BY herkunft`
    );

    // Wenn aus einem Angebot heraus gesucht wird, kann direkt uebernommen werden.
    const angebotId = req.query.angebot ? Number(req.query.angebot) : null;

    res.render('preise', {
      titel: 'Preiskatalog', positionen, statistik, gesamt, q, gewerk, herkunft,
      seite, proSeite, seiten: Math.ceil(gesamt / proSeite), angebotId,
    });
  } catch (e) { next(e); }
});

r.post('/neu', intern, async (req, res, next) => {
  try {
    const b = req.body;
    const text = h.txt(b.text);
    if (!text) { res.melde('Eine Position braucht einen Text.', 'warn'); return res.redirect('/preise'); }
    const p = await db.one(
      `INSERT INTO preis_positionen (herkunft, gewerk, pos, kategorie, text, einheit, vk_ziel, quelle)
       VALUES ('eigen',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [h.txt(b.gewerk) || 'Sonstiges', h.txt(b.pos), h.txt(b.kategorie), text,
       h.txt(b.einheit), h.zuZahl(b.vk_ziel), `Eigene Anlage durch ${req.benutzer.name}`]
    );
    await auth.protokoll(req, 'preisposition_angelegt', 'preis', p.id, { text });
    res.melde('Position angelegt.');
    res.redirect('/preise');
  } catch (e) { next(e); }
});

r.post('/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    if (b.deaktivieren) {
      await db.query('UPDATE preis_positionen SET aktiv = FALSE, geaendert_am = now() WHERE id = $1', [id]);
      await auth.protokoll(req, 'preisposition_deaktiviert', 'preis', id);
      res.melde('Position deaktiviert. Bestehende Angebote bleiben unverändert.');
    } else {
      await db.query(
        `UPDATE preis_positionen SET text=$1, einheit=$2, vk_ziel=$3, vk_aktuell=$4, geaendert_am=now()
          WHERE id=$5`,
        [h.txt(b.text), h.txt(b.einheit), h.zuZahl(b.vk_ziel), h.zuZahl(b.vk_aktuell), id]
      );
      await auth.protokoll(req, 'preisposition_geaendert', 'preis', id);
      res.melde('Position gespeichert.');
    }
    res.redirect(req.get('referer') || '/preise');
  } catch (e) { next(e); }
});

/**
 * Aus einer nur internen Position eine eigene machen.
 * Uebernommen werden Text, Einheit und Gewerk — der PREIS NICHT.
 * Er muss bewusst gesetzt werden; genau darin liegt die Trennung zur fremden
 * Kalkulationsgrundlage.
 */
r.post('/:id/uebernehmen', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const q = await db.one('SELECT * FROM preis_positionen WHERE id = $1', [id]);
    if (!q) return res.redirect('/preise');

    const vorhanden = await db.one(
      "SELECT id FROM preis_positionen WHERE herkunft = 'eigen' AND abgeleitet_von = $1", [id]
    );
    if (vorhanden) {
      res.melde('Zu dieser Position gibt es bereits eine eigene Fassung.', 'warn');
      return res.redirect(`/preise?q=${encodeURIComponent(q.text.slice(0, 40))}`);
    }

    const neu = await db.one(
      `INSERT INTO preis_positionen (herkunft, gewerk, pos, kategorie, text, einheit,
                                     vk_ziel, quelle, nur_intern, abgeleitet_von, herkunft_hinweis)
       VALUES ('eigen',$1,$2,$3,$4,$5,$6,$7,FALSE,$8,$9) RETURNING id`,
      [q.gewerk, q.pos, q.kategorie, q.text, q.einheit,
       h.zuZahl(req.body.vk_ziel),
       `Eigene Position, angelegt von ${req.benutzer.name}`,
       q.id,
       'Struktur aus einem eingelesenen Standard-LV übernommen. Preis eigenständig kalkuliert.']
    );
    await auth.protokoll(req, 'preisposition_uebernommen', 'preis', neu.id, { von: id });
    res.melde('Als eigene Position übernommen. Bitte jetzt den eigenen Preis eintragen — ohne Preis lässt sie sich nicht in ein Angebot ziehen.');
    res.redirect(`/preise?herkunft=eigen&q=${encodeURIComponent(q.text.slice(0, 40))}`);
  } catch (e) { next(e); }
});

module.exports = r;
