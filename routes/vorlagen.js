'use strict';
/**
 * Verwaltung der Angebotsvorlagen und der Textbausteine.
 *
 * Vorlagen werden nie geloescht, sondern auf aktiv = FALSE gesetzt: Angebote,
 * die aus einer Vorlage entstanden sind, behalten dadurch ihren Bezug.
 */

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');
const v = require('../lib/vorlagen');
const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router(), ['id', 'pid']);
const intern = auth.verlangt('admin', 'team');

const ARTEN = ['allgemein', 'Begehung', 'AC', 'DC', 'Retainer'];

// ===================== LISTE =====================
r.get('/', intern, async (req, res, next) => {
  try {
    res.render('vorlagen_liste', {
      titel: 'Angebotsvorlagen',
      vorlagen: await v.liste(false),
      ARTEN,
    });
  } catch (e) { next(e); }
});

r.post('/neu', intern, async (req, res, next) => {
  try {
    const name = h.txt(req.body.name);
    if (!name) { res.melde('Eine Vorlage braucht einen Namen.', 'warn'); return res.redirect('/vorlagen'); }
    const neu = await db.one(
      `INSERT INTO angebot_vorlagen (name, art, beschreibung, einleitung, hinweise, schlusstext)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, ARTEN.includes(req.body.art) ? req.body.art : 'allgemein', h.txt(req.body.beschreibung),
       'vielen Dank für Ihre Anfrage. Für das oben genannte Bauvorhaben unterbreiten wir Ihnen folgendes Angebot:',
       'Alle Preise verstehen sich in Euro, zzgl. der gesetzlichen Mehrwertsteuer. Zahlungsziel 14 Tage netto.',
       'Wir freuen uns auf Ihren Auftrag.']
    );
    await auth.protokoll(req, 'vorlage_angelegt', 'vorlage', neu.id, { name });
    res.melde('Vorlage angelegt.');
    res.redirect(`/vorlagen/${neu.id}`);
  } catch (e) { next(e); }
});

// ===================== BAUSTEINE =====================
// Steht bewusst vor /:id, sonst wuerde "bausteine" als Kennung gelesen.
r.get('/bausteine', intern, async (req, res, next) => {
  try {
    const kategorie = v.KATEGORIEN.some((k) => k[0] === req.query.kategorie)
      ? req.query.kategorie : v.KATEGORIEN[0][0];
    res.render('vorlagen_bausteine', {
      titel: 'Textbausteine',
      kategorie,
      KATEGORIEN: v.KATEGORIEN,
      bausteine: await db.all(
        `SELECT t.*, u.name AS von FROM textbausteine t
           LEFT JOIN benutzer u ON u.id = t.angelegt_von
          WHERE t.kategorie = $1 ORDER BY t.verwendet DESC, t.id`, [kategorie]),
      zaehler: await db.all('SELECT kategorie, COUNT(*)::int AS n FROM textbausteine GROUP BY kategorie'),
    });
  } catch (e) { next(e); }
});

r.post('/bausteine/neu', intern, async (req, res, next) => {
  try {
    const kategorie = v.KATEGORIEN.some((k) => k[0] === req.body.kategorie) ? req.body.kategorie : 'hinweis';
    const text = h.txt(req.body.text);
    if (!text) { res.melde('Ohne Text kein Baustein.', 'warn'); return res.redirect('/vorlagen/bausteine'); }
    await db.query(
      `INSERT INTO textbausteine (kategorie, text, angelegt_von) VALUES ($1,$2,$3)
       ON CONFLICT (kategorie, md5(text)) DO NOTHING`,
      [kategorie, text, req.benutzer.id]
    );
    res.melde('Baustein gespeichert.');
    res.redirect(`/vorlagen/bausteine?kategorie=${encodeURIComponent(kategorie)}`);
  } catch (e) { next(e); }
});

r.post('/bausteine/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = await db.one('SELECT kategorie FROM textbausteine WHERE id = $1', [id]);
    if (b && req.body.loeschen) {
      await db.query('DELETE FROM textbausteine WHERE id = $1', [id]);
      res.melde('Baustein entfernt.');
    } else if (b) {
      const text = h.txt(req.body.text);
      if (text) await db.query('UPDATE textbausteine SET text = $1 WHERE id = $2', [text, id]);
      res.melde('Baustein gespeichert.');
    }
    res.redirect(`/vorlagen/bausteine?kategorie=${encodeURIComponent(b ? b.kategorie : '')}`);
  } catch (e) { next(e); }
});

/** Auswahlliste fuer die Bausteinfelder in anderen Masken. */
r.get('/bausteine.json', intern, async (req, res, next) => {
  try {
    const kategorie = String(req.query.kategorie || '');
    if (!v.KATEGORIEN.some((k) => k[0] === kategorie)) return res.json([]);
    res.json(await v.bausteine(kategorie, 60));
  } catch (e) { next(e); }
});

// ===================== DETAIL =====================
r.get('/:id', intern, async (req, res, next) => {
  try {
    const vorlage = await v.laden(Number(req.params.id));
    if (!vorlage) return res.status(404).render('fehler', { titel: 'Vorlage nicht gefunden', text: 'Diese Vorlage existiert nicht (mehr).' });
    res.render('vorlage_detail', {
      titel: vorlage.name,
      vorlage, ARTEN,
      QUELLEN: v.MENGEN_QUELLEN,
      texte: await v.bausteineFuer(['einleitung', 'vorbemerkung', 'hinweis', 'schluss', 'position', 'langtext']),
    });
  } catch (e) { next(e); }
});

r.post('/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;

    if (b.deaktivieren) {
      await db.query('UPDATE angebot_vorlagen SET aktiv = FALSE, geaendert_am = now() WHERE id = $1', [id]);
      await auth.protokoll(req, 'vorlage_deaktiviert', 'vorlage', id);
      res.melde('Vorlage stillgelegt. Bestehende Angebote bleiben unverändert.');
      return res.redirect('/vorlagen');
    }
    if (b.aktivieren) {
      await db.query('UPDATE angebot_vorlagen SET aktiv = TRUE, geaendert_am = now() WHERE id = $1', [id]);
      res.melde('Vorlage wieder in Betrieb.');
      return res.redirect(`/vorlagen/${id}`);
    }

    await db.tx(async (c) => {
      if (b.ist_standard === 'on') {
        await c.query('UPDATE angebot_vorlagen SET ist_standard = FALSE WHERE ist_standard = TRUE');
      }
      await c.query(
        `UPDATE angebot_vorlagen SET name=$1, art=$2, beschreibung=$3, anrede=$4, einleitung=$5,
                vorbemerkungen=$6, hinweise=$7, schlusstext=$8, gueltigkeit_tage=$9,
                ist_standard=$10, geaendert_am=now()
          WHERE id=$11`,
        [h.txt(b.name) || 'Ohne Namen', ARTEN.includes(b.art) ? b.art : 'allgemein',
         h.txt(b.beschreibung), h.txt(b.anrede), h.txt(b.einleitung), h.txt(b.vorbemerkungen),
         h.txt(b.hinweise), h.txt(b.schlusstext), h.zuZahl(b.gueltigkeit_tage) ?? 30,
         b.ist_standard === 'on', id]
      );
    });

    await v.merkeMehrere([
      ['einleitung', b.einleitung], ['vorbemerkung', b.vorbemerkungen],
      ['hinweis', b.hinweise], ['schluss', b.schlusstext],
    ], req.benutzer.id);

    await auth.protokoll(req, 'vorlage_geaendert', 'vorlage', id);
    res.melde('Vorlage gespeichert.');
    res.redirect(`/vorlagen/${id}`);
  } catch (e) { next(e); }
});

/** Vorlage samt Positionen kopieren — der uebliche Weg zu einer Abwandlung. */
r.post('/:id/kopieren', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const alt = await v.laden(id);
    if (!alt) return res.redirect('/vorlagen');

    const neu = await db.tx(async (c) => {
      const x = (await c.query(
        `INSERT INTO angebot_vorlagen (name, art, beschreibung, anrede, einleitung, vorbemerkungen,
                                       hinweise, schlusstext, gueltigkeit_tage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [`${alt.name} (Kopie)`, alt.art, alt.beschreibung, alt.anrede, alt.einleitung,
         alt.vorbemerkungen, alt.hinweise, alt.schlusstext, alt.gueltigkeit_tage]
      )).rows[0];
      for (const p of alt.positionen) {
        await c.query(
          `INSERT INTO vorlage_positionen (vorlage_id, lfd, ist_titel, pos, text, langtext, einheit,
                                           menge_quelle, menge_fest, einzelpreis, nur_bei_art, hinweis)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [x.id, p.lfd, p.ist_titel, p.pos, p.text, p.langtext, p.einheit,
           p.menge_quelle, p.menge_fest, p.einzelpreis, p.nur_bei_art, p.hinweis]
        );
      }
      return x;
    });
    await auth.protokoll(req, 'vorlage_kopiert', 'vorlage', neu.id, { von: id });
    res.melde('Kopie angelegt.');
    res.redirect(`/vorlagen/${neu.id}`);
  } catch (e) { next(e); }
});

// ===================== POSITIONEN =====================
r.post('/:id/positionen', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    const text = h.txt(b.text);
    if (!text) { res.melde('Eine Position braucht einen Text.', 'warn'); return res.redirect(`/vorlagen/${id}`); }

    const m = await db.one('SELECT COALESCE(MAX(lfd),0)+1 AS n FROM vorlage_positionen WHERE vorlage_id=$1', [id]);
    await db.query(
      `INSERT INTO vorlage_positionen (vorlage_id, lfd, ist_titel, pos, text, langtext, einheit,
                                       menge_quelle, menge_fest, einzelpreis, nur_bei_art, hinweis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, m.n, b.ist_titel === 'on', h.txt(b.pos), text, h.txt(b.langtext), h.txt(b.einheit),
       v.QUELLEN_SCHLUESSEL.includes(b.menge_quelle) ? b.menge_quelle : 'fest',
       h.zuZahl(b.menge_fest) ?? 1, h.zuZahl(b.einzelpreis) ?? 0,
       ['AC', 'DC'].includes(b.nur_bei_art) ? b.nur_bei_art : null, h.txt(b.hinweis)]
    );
    await v.merkeMehrere([['position', text], ['langtext', b.langtext]], req.benutzer.id);
    res.melde('Position ergänzt.');
    res.redirect(`/vorlagen/${id}#positionen`);
  } catch (e) { next(e); }
});

r.post('/:id/positionen/:pid', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pid = Number(req.params.pid);
    const b = req.body;
    if (b.loeschen) {
      await db.query('DELETE FROM vorlage_positionen WHERE id=$1 AND vorlage_id=$2', [pid, id]);
      res.melde('Position entfernt.');
    } else {
      await db.query(
        `UPDATE vorlage_positionen SET lfd=$1, ist_titel=$2, pos=$3, text=$4, langtext=$5, einheit=$6,
                menge_quelle=$7, menge_fest=$8, einzelpreis=$9, nur_bei_art=$10, hinweis=$11
          WHERE id=$12 AND vorlage_id=$13`,
        [h.zuZahl(b.lfd) ?? 1, b.ist_titel === 'on', h.txt(b.pos), h.txt(b.text) || 'Position',
         h.txt(b.langtext), h.txt(b.einheit),
         v.QUELLEN_SCHLUESSEL.includes(b.menge_quelle) ? b.menge_quelle : 'fest',
         h.zuZahl(b.menge_fest) ?? 1, h.zuZahl(b.einzelpreis) ?? 0,
         ['AC', 'DC'].includes(b.nur_bei_art) ? b.nur_bei_art : null, h.txt(b.hinweis), pid, id]
      );
      res.melde('Position gespeichert.');
    }
    res.redirect(`/vorlagen/${id}#positionen`);
  } catch (e) { next(e); }
});

module.exports = r;
