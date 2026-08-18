'use strict';
/**
 * Forecast: Soll, Ist, Abweichung — Monat, Quartal, Jahr.
 * Dazu Mitarbeiterziele und der daraus errechnete Prämienstand.
 */

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');
const fc = require('../lib/forecast');
const dia = require('../lib/diagramm');
const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router(), ['id']);
const intern = auth.verlangt('admin', 'team');
const admin = auth.verlangt('admin');

const ARTEN = [['umsatz', 'Umsatz (festgeschriebene Rechnungen)'],
  ['auftragseingang', 'Auftragseingang (beauftragte Angebote)']];

r.get('/', intern, async (req, res, next) => {
  try {
    const heute = new Date();
    const jahr = Number(req.query.jahr) || heute.getFullYear();
    const art = ARTEN.some((a) => a[0] === req.query.art) ? req.query.art : 'umsatz';

    const d = await fc.jahr(jahr, art, null, heute);
    const anteile = await fc.anteile(jahr, req.query.nach === 'gewerk' ? 'gewerk' : 'kunde', 5);
    const praemien = await fc.praemien(jahr, heute);

    // Diagramme serverseitig — sie sollen auch im Ausdruck stehen.
    const monatsPunkte = d.monateKurz.map((n, i) => ({ name: n, ist: d.ist[i], soll: d.soll[i] }));
    const quartalPunkte = [0, 1, 2, 3].map((q) => ({
      name: `Q${q + 1}`, ist: d.istQuartal[q], soll: d.sollQuartal[q],
    }));

    /*
     * Ein Quartal, das noch nicht angefangen hat, ist kein Rueckstand.
     * Bei den Monaten war das schon berücksichtigt, bei den Quartalen nicht
     * — im August stand deshalb bei Q4 eine Abweichung von −135.000 €, als
     * hätte jemand etwas versäumt. Angebrochen zählt, künftig nicht.
     */
    const ersterMonat = (q) => q * 3 + 1;
    const quartalKuenftig = (q) => d.laufend && ersterMonat(q) > d.bisMonat;
    const erstesKuenftigesQuartal = [0, 1, 2, 3].findIndex(quartalKuenftig);

    res.render('forecast', {
      titel: 'Forecast', d, art, ARTEN, jahr, anteile, praemien,
      nach: req.query.nach === 'gewerk' ? 'gewerk' : 'kunde',
      jahre: await db.all(`
        SELECT DISTINCT EXTRACT(YEAR FROM datum)::int AS j FROM rechnungen
        UNION SELECT DISTINCT EXTRACT(YEAR FROM datum)::int FROM angebote
        UNION SELECT $1::int ORDER BY 1 DESC`, [heute.getFullYear()]),
      svgMonat: dia.sollIst({
        titel: `${art === 'umsatz' ? 'Umsatz' : 'Auftragseingang'} je Monat, Ist gegen Ziel`,
        punkte: monatsPunkte, bisIndex: d.laufend ? d.bisMonat : null, id: 'monat',
      }),
      svgAbwMonat: dia.abweichung({
        titel: 'Abweichung zum Monatsziel', punkte: d.monateKurz.map((n, i) => ({
          name: n,
          // Ein Monat, der noch nicht gelaufen ist, hat keine Abweichung —
          // auch keine von null. Sonst stünde dort viermal "+0".
          leer: d.laufend && i >= d.bisMonat,
          wert: d.laufend && i >= d.bisMonat ? 0 : d.abweichung[i],
        })), id: 'abwm',
      }),
      quartalKuenftig: [0, 1, 2, 3].map(quartalKuenftig),
      svgQuartal: dia.sollIst({
        titel: 'Quartale, Ist gegen Ziel', punkte: quartalPunkte, hoehe: 190, id: 'q',
        bisIndex: erstesKuenftigesQuartal >= 0 ? erstesKuenftigesQuartal : null,
      }),
      svgAbwQuartal: dia.abweichung({
        titel: 'Abweichung je Quartal',
        punkte: [0, 1, 2, 3].map((q) => ({
          name: `Q${q + 1}`,
          leer: quartalKuenftig(q),
          wert: quartalKuenftig(q) ? 0 : d.abweichungQuartal[q],
        })),
        hoehe: 170, id: 'abwq',
      }),
      svgRing: dia.ring({ titel: 'Umsatzanteile', punkte: anteile, id: 'ring' }),
      // Der Verlauf in der Kachel endet am laufenden Monat. Liefe er bis
      // Dezember weiter, zeigte er einen Absturz auf null — die restlichen
      // Monate sind aber nicht eingebrochen, sie sind nur noch nicht da.
      svgSpark: dia.spark({
        werte: d.ist, bis: d.laufend ? d.bisMonat : null, id: 'spark-ist',
      }),
      messlatte: (ist, ziel, schwelle) => dia.messlatte({ ist, ziel, schwelle }),
    });
  } catch (e) { next(e); }
});

// ===================== ZIELE PFLEGEN =====================
r.get('/ziele', admin, async (req, res, next) => {
  try {
    const jahr = Number(req.query.jahr) || new Date().getFullYear();
    res.render('forecast_ziele', {
      titel: 'Ziele und Prämien', jahr, ARTEN,
      ziele: await db.all(`
        SELECT z.*, u.name AS benutzer FROM ziele z
          LEFT JOIN benutzer u ON u.id = z.benutzer_id
         WHERE z.jahr = $1 ORDER BY z.art, COALESCE(z.benutzer_id,0), z.periode, z.periode_nr`, [jahr]),
      praemien: await db.all(`
        SELECT p.*, u.name AS benutzer FROM praemien p JOIN benutzer u ON u.id = p.benutzer_id
         WHERE p.jahr = $1 ORDER BY u.name, p.periode_nr`, [jahr]),
      benutzer: await db.all("SELECT id, name FROM benutzer WHERE aktiv AND rolle <> 'partner' ORDER BY name"),
      MONATE: fc.MONATE,
    });
  } catch (e) { next(e); }
});

r.post('/ziele', admin, async (req, res, next) => {
  try {
    const b = req.body;
    const jahr = h.zuZahl(b.jahr) || new Date().getFullYear();
    const wert = h.zuZahl(b.wert);
    if (wert == null) { res.melde('Ohne Wert kein Ziel.', 'warn'); return res.redirect(`/forecast/ziele?jahr=${jahr}`); }

    const periode = ['monat', 'quartal', 'jahr'].includes(b.periode) ? b.periode : 'monat';
    const nr = periode === 'jahr' ? 0 : (h.zuZahl(b.periode_nr) || 1);
    await db.query(
      `INSERT INTO ziele (jahr, periode, periode_nr, art, benutzer_id, wert, hinweis)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (jahr, periode, periode_nr, art, COALESCE(benutzer_id, 0))
       DO UPDATE SET wert = EXCLUDED.wert, hinweis = EXCLUDED.hinweis, geaendert_am = now()`,
      [jahr, periode, nr, ARTEN.some((a) => a[0] === b.art) ? b.art : 'umsatz',
       h.zuZahl(b.benutzer_id) || null, wert, h.txt(b.hinweis)]
    );
    await auth.protokoll(req, 'ziel_gesetzt', 'ziel', null, { jahr, periode, nr, wert });
    res.melde('Ziel gespeichert.');
    res.redirect(`/forecast/ziele?jahr=${jahr}`);
  } catch (e) { next(e); }
});

/** Ein Jahresziel gleichmäßig auf zwölf Monate verteilen. */
r.post('/ziele/verteilen', admin, async (req, res, next) => {
  try {
    const jahr = h.zuZahl(req.body.jahr) || new Date().getFullYear();
    const summe = h.zuZahl(req.body.summe);
    const art = ARTEN.some((a) => a[0] === req.body.art) ? req.body.art : 'umsatz';
    const benutzerId = h.zuZahl(req.body.benutzer_id) || null;
    if (!summe) { res.melde('Ohne Jahressumme lässt sich nichts verteilen.', 'warn'); return res.redirect(`/forecast/ziele?jahr=${jahr}`); }

    const jeMonat = Math.round((summe / 12) * 100) / 100;
    await db.tx(async (c) => {
      for (let m = 1; m <= 12; m += 1) {
        await c.query(
          `INSERT INTO ziele (jahr, periode, periode_nr, art, benutzer_id, wert, hinweis)
           VALUES ($1,'monat',$2,$3,$4,$5,$6)
           ON CONFLICT (jahr, periode, periode_nr, art, COALESCE(benutzer_id, 0))
           DO UPDATE SET wert = EXCLUDED.wert, geaendert_am = now()`,
          [jahr, m, art, benutzerId, jeMonat, `Aus Jahresziel ${summe} gleichmäßig verteilt`]
        );
      }
    });
    res.melde(`Jahresziel auf zwölf Monate verteilt — ${jeMonat.toLocaleString('de-DE')} € je Monat. Einzelne Monate lassen sich danach überschreiben.`);
    res.redirect(`/forecast/ziele?jahr=${jahr}`);
  } catch (e) { next(e); }
});

r.post('/ziele/:id/loeschen', admin, async (req, res, next) => {
  try {
    const z = await db.one('SELECT jahr FROM ziele WHERE id = $1', [Number(req.params.id)]);
    await db.query('DELETE FROM ziele WHERE id = $1', [Number(req.params.id)]);
    res.melde('Ziel entfernt.');
    res.redirect(`/forecast/ziele?jahr=${z ? z.jahr : ''}`);
  } catch (e) { next(e); }
});

// ===================== PRÄMIEN =====================
r.post('/praemien', admin, async (req, res, next) => {
  try {
    const b = req.body;
    const jahr = h.zuZahl(b.jahr) || new Date().getFullYear();
    const benutzerId = h.zuZahl(b.benutzer_id);
    if (!benutzerId) { res.melde('Bitte einen Mitarbeiter wählen.', 'warn'); return res.redirect(`/forecast/ziele?jahr=${jahr}`); }

    const periode = ['monat', 'quartal', 'jahr'].includes(b.periode) ? b.periode : 'quartal';
    await db.query(
      `INSERT INTO praemien (benutzer_id, jahr, periode, periode_nr, art, ziel_wert,
                             praemie_voll, schwelle_pct, deckel_pct, hinweis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (benutzer_id, jahr, periode, periode_nr, art)
       DO UPDATE SET ziel_wert = EXCLUDED.ziel_wert, praemie_voll = EXCLUDED.praemie_voll,
                     schwelle_pct = EXCLUDED.schwelle_pct, deckel_pct = EXCLUDED.deckel_pct,
                     hinweis = EXCLUDED.hinweis`,
      [benutzerId, jahr, periode, periode === 'jahr' ? 0 : (h.zuZahl(b.periode_nr) || 1),
       ARTEN.some((a) => a[0] === b.art) ? b.art : 'umsatz',
       h.zuZahl(b.ziel_wert) ?? 0, h.zuZahl(b.praemie_voll) ?? 0,
       h.zuZahl(b.schwelle_pct) ?? 80, h.zuZahl(b.deckel_pct) ?? 120, h.txt(b.hinweis)]
    );
    await auth.protokoll(req, 'praemie_gesetzt', 'praemie', benutzerId, { jahr, periode });
    res.melde('Prämienregel gespeichert.');
    res.redirect(`/forecast/ziele?jahr=${jahr}`);
  } catch (e) { next(e); }
});

r.post('/praemien/:id/loeschen', admin, async (req, res, next) => {
  try {
    const p = await db.one('SELECT jahr FROM praemien WHERE id = $1', [Number(req.params.id)]);
    await db.query('DELETE FROM praemien WHERE id = $1', [Number(req.params.id)]);
    res.melde('Prämienregel entfernt.');
    res.redirect(`/forecast/ziele?jahr=${p ? p.jahr : ''}`);
  } catch (e) { next(e); }
});

module.exports = r;
