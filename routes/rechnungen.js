'use strict';
/**
 * Rechnungen.
 *
 * Bis zur Festschreibung ist eine Rechnung ein Entwurf und frei änderbar.
 * Mit der Festschreibung wird sie unveränderlich — das erzwingen Trigger in
 * der Datenbank, nicht nur diese Datei. Korrekturen laufen ausschließlich über
 * Storno und Neuausstellung, mit gegenseitigem Verweis.
 *
 * Die Rechnungsnummer wird ERST bei der Festschreibung endgültig vergeben.
 * Entwürfe tragen eine Vormerknummer (E-...), damit im festen Nummernkreis
 * keine Lücken durch verworfene Entwürfe entstehen — Lückenlosigkeit ist eine
 * der Anforderungen, an denen eine Prüfung hängt.
 */

const express = require('express');
const crypto = require('node:crypto');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');
const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router());
const intern = auth.verlangt('admin', 'team');

async function summenNeuRechnen(id) {
  const kopf = await db.one('SELECT mwst_satz, festgeschrieben FROM rechnungen WHERE id=$1', [id]);
  if (!kopf || kopf.festgeschrieben) return null;
  const s = await db.one(
    `SELECT COALESCE(SUM(ROUND(menge*einzelpreis,2)),0) AS netto
       FROM rechnung_positionen WHERE rechnung_id=$1 AND ist_titel=FALSE`, [id]);
  const netto = Number(s.netto);
  const mwst = Math.round(netto * Number(kopf.mwst_satz)) / 100;
  await db.query('UPDATE rechnungen SET netto=$1, mwst=$2, brutto=$3, geaendert_am=now() WHERE id=$4',
    [netto.toFixed(2), mwst.toFixed(2), (netto + mwst).toFixed(2), id]);
  return { netto, mwst, brutto: netto + mwst };
}

/**
 * Prüfsumme über den festgeschriebenen Inhalt — macht spätere Eingriffe erkennbar.
 *
 * Der optionale Transaktions-Client ist kein Beiwerk: Wird die Prüfsumme
 * innerhalb einer laufenden Transaktion gebildet (Storno), sieht ein zweiter
 * Verbindungsweg die noch nicht bestätigten Zeilen nicht und würde über einen
 * leeren Beleg hashen. Es gibt bewusst nur diese eine Berechnung, damit die
 * Prüfsumme einer Rechnung und die eines Stornos nach derselben Regel entsteht.
 */
async function pruefsumme(id, c = null) {
  const kopfSql = 'SELECT nummer, datum, kunde_id, netto, mwst, brutto, mwst_satz FROM rechnungen WHERE id=$1';
  const posSql = `SELECT lfd, text, einheit, menge, einzelpreis, gesamtpreis FROM rechnung_positionen
                   WHERE rechnung_id=$1 ORDER BY lfd, id`;
  const kopf = c ? (await c.query(kopfSql, [id])).rows[0] : await db.one(kopfSql, [id]);
  const pos = c ? (await c.query(posSql, [id])).rows : await db.all(posSql, [id]);
  return crypto.createHash('sha256').update(JSON.stringify({ kopf, pos })).digest('hex');
}

// ===================== LISTE =====================
r.get('/', intern, async (req, res, next) => {
  try {
    const filter = (req.query.f || '').trim();
    let wo = 'TRUE';
    if (filter === 'offen') wo = "rg.festgeschrieben AND rg.bezahlt_am IS NULL AND rg.art <> 'storno'";
    else if (filter === 'ueberfaellig') wo = "rg.festgeschrieben AND rg.bezahlt_am IS NULL AND rg.art <> 'storno' AND rg.faellig_am < CURRENT_DATE";
    else if (filter === 'entwurf') wo = 'NOT rg.festgeschrieben';

    const liste = await db.all(`
      SELECT rg.*, k.firma,
             (CURRENT_DATE - rg.faellig_am)::int AS tage_ueberfaellig
        FROM rechnungen rg JOIN kunden k ON k.id = rg.kunde_id
       WHERE ${wo}
       ORDER BY rg.festgeschrieben, rg.datum DESC, rg.id DESC`);

    const summen = await db.one(`
      SELECT COALESCE(SUM(brutto) FILTER (WHERE festgeschrieben AND bezahlt_am IS NULL AND art<>'storno'),0) AS offen,
             COALESCE(SUM(brutto) FILTER (WHERE festgeschrieben AND bezahlt_am IS NULL AND art<>'storno' AND faellig_am < CURRENT_DATE),0) AS ueberfaellig,
             COUNT(*) FILTER (WHERE NOT festgeschrieben)::int AS entwuerfe
        FROM rechnungen`);

    res.render('rechnungen_liste', { titel: 'Rechnungen', liste, filter, summen });
  } catch (e) { next(e); }
});

// ===================== NEU =====================
r.get('/neu', intern, async (req, res, next) => {
  try {
    res.render('rechnung_neu', {
      titel: 'Neue Rechnung',
      kunden: await db.all('SELECT id, firma, adresse FROM kunden ORDER BY firma'),
      angebote: await db.all(`SELECT a.id, a.nummer, a.netto, a.bauvorhaben, k.firma
                                FROM angebote a JOIN kunden k ON k.id=a.kunde_id
                               WHERE a.status='Beauftragt' ORDER BY a.id DESC`),
      retainer: await db.all(`SELECT r.id, r.bezeichnung, r.entgelt_netto, o.name AS org
                                FROM retainer r JOIN organisationen o ON o.id=r.organisation_id
                               WHERE r.aktiv ORDER BY o.name`),
      e: await h.einstellungen(),
    });
  } catch (e) { next(e); }
});

r.post('/neu', intern, async (req, res, next) => {
  try {
    const b = req.body;
    const e = await h.einstellungen();
    const ziel = Number(e.rechnung_zahlungsziel_tage || 14);

    let kundeId = h.zuZahl(b.kunde_id);
    let angebotId = h.zuZahl(b.angebot_id);
    let retainerId = h.zuZahl(b.retainer_id);
    let positionen = [];
    let betreff = h.txt(b.betreff);

    // Aus einem beauftragten Angebot: Positionen werden übernommen.
    if (angebotId) {
      const a = await db.one('SELECT * FROM angebote WHERE id=$1', [angebotId]);
      if (a) {
        kundeId = a.kunde_id;
        betreff = betreff || `Rechnung zu Angebot ${a.nummer}${a.bauvorhaben ? ' — ' + a.bauvorhaben : ''}`;
        positionen = await db.all('SELECT * FROM angebot_positionen WHERE angebot_id=$1 ORDER BY lfd, id', [angebotId]);
      }
    }

    // Aus einem Retainer-Monat: eine Position, Nachweis über den Monatsbericht.
    if (retainerId && b.monat) {
      const ret = await db.one(`SELECT r.*, o.name AS org FROM retainer r
                                  JOIN organisationen o ON o.id=r.organisation_id WHERE r.id=$1`, [retainerId]);
      if (ret) {
        betreff = betreff || `Retainer ${ret.bezeichnung} — ${b.monat}`;
        positionen = [{
          lfd: 1, text: `${ret.bezeichnung} — Leistungszeitraum ${b.monat}`,
          langtext: 'Monatliches Kontingent gemäß Retainervertrag. Leistungsnachweis siehe Monatsbericht.',
          einheit: 'Monat', menge: 1, einzelpreis: ret.entgelt_netto, ist_titel: false,
        }];
      }
    }

    if (!kundeId) { res.melde('Bitte einen Kunden auswählen.', 'warn'); return res.redirect('/rechnungen/neu'); }

    const vormerk = `E-${Date.now().toString(36).toUpperCase()}`;
    const rg = await db.tx(async (c) => {
      const x = (await c.query(
        `INSERT INTO rechnungen (nummer, kunde_id, projekt_id, angebot_id, retainer_id, empfaenger, anrede,
                                 betreff, einleitung, hinweise, leistungszeitraum, zahlungsziel_tage,
                                 faellig_am, mwst_satz, erstellt_von)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CURRENT_DATE + $12::int, $13, $14) RETURNING *`,
        [vormerk, kundeId, h.zuZahl(b.projekt_id), angebotId, retainerId,
         h.txt(b.empfaenger), h.txt(b.anrede), betreff,
         h.txt(b.einleitung) || 'für die nachstehend aufgeführten Leistungen erlauben wir uns zu berechnen:',
         e.rechnung_fuss || null, h.txt(b.monat) || h.txt(b.leistungszeitraum), ziel,
         Number(e.mwst_satz || 19), req.benutzer.id]
      )).rows[0];

      let lfd = 1;
      for (const p of positionen) {
        await c.query(
          `INSERT INTO rechnung_positionen (rechnung_id, lfd, pos, text, langtext, einheit, menge, einzelpreis, gesamtpreis, ist_titel)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ROUND($7::numeric*$8::numeric,2), $9)`,
          [x.id, lfd, p.pos || null, p.text, p.langtext || null, p.einheit || null,
           p.menge ?? 1, p.einzelpreis ?? 0, p.ist_titel || false]
        );
        lfd += 1;
      }
      return x;
    });

    await summenNeuRechnen(rg.id);
    await auth.protokoll(req, 'rechnung_entwurf', 'rechnung', rg.id, { vormerk, positionen: positionen.length });
    res.melde('Rechnungsentwurf angelegt. Die endgültige Nummer wird bei der Festschreibung vergeben.');
    res.redirect(`/rechnungen/${rg.id}`);
  } catch (e) { next(e); }
});

// ===================== DETAIL =====================
r.get('/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rechnung = await db.one(`
      SELECT rg.*, k.firma, k.adresse, p.bezeichnung AS projekt,
             s.nummer AS storno_nummer, o.nummer AS original_nummer
        FROM rechnungen rg
        JOIN kunden k ON k.id = rg.kunde_id
        LEFT JOIN projekte p ON p.id = rg.projekt_id
        LEFT JOIN rechnungen s ON s.id = rg.storniert_durch
        LEFT JOIN rechnungen o ON o.id = rg.storno_zu
       WHERE rg.id=$1`, [id]);
    if (!rechnung) return res.status(404).render('fehler', { titel: 'Rechnung nicht gefunden', text: '' });

    const positionen = await db.all('SELECT * FROM rechnung_positionen WHERE rechnung_id=$1 ORDER BY lfd, id', [id]);
    res.render('rechnung_detail', { titel: `Rechnung ${rechnung.nummer}`, rechnung, positionen });
  } catch (e) { next(e); }
});

r.post('/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rg = await db.one('SELECT festgeschrieben FROM rechnungen WHERE id=$1', [id]);
    if (!rg) return res.redirect('/rechnungen');

    if (rg.festgeschrieben) {
      // Nur noch Zahlungserfassung.
      await db.query('UPDATE rechnungen SET bezahlt_am=$1::date, bezahlt_betrag=$2 WHERE id=$3',
        [h.txt(req.body.bezahlt_am), h.zuZahl(req.body.bezahlt_betrag), id]);
      await auth.protokoll(req, 'rechnung_zahlung', 'rechnung', id, { am: req.body.bezahlt_am });
      res.melde('Zahlung erfasst.');
      return res.redirect(`/rechnungen/${id}`);
    }

    const b = req.body;
    await db.query(
      `UPDATE rechnungen SET empfaenger=$1, anrede=$2, betreff=$3, einleitung=$4, hinweise=$5,
              leistungszeitraum=$6, datum=COALESCE($7::date, datum), zahlungsziel_tage=$8,
              faellig_am=COALESCE($7::date, datum) + $8::int, mwst_satz=$9, geaendert_am=now()
        WHERE id=$10`,
      [h.txt(b.empfaenger), h.txt(b.anrede), h.txt(b.betreff), h.txt(b.einleitung), h.txt(b.hinweise),
       h.txt(b.leistungszeitraum), h.txt(b.datum), h.zuZahl(b.zahlungsziel_tage) ?? 14,
       h.zuZahl(b.mwst_satz) ?? 19, id]
    );
    await summenNeuRechnen(id);
    res.melde('Entwurf gespeichert.');
    res.redirect(`/rechnungen/${id}`);
  } catch (e) { next(e); }
});

// ---------- Positionen (nur im Entwurf) ----------
r.post('/:id/positionen', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    const m = await db.one('SELECT COALESCE(MAX(lfd),0)+1 AS n FROM rechnung_positionen WHERE rechnung_id=$1', [id]);
    await db.query(
      `INSERT INTO rechnung_positionen (rechnung_id, lfd, pos, text, langtext, einheit, menge, einzelpreis, gesamtpreis, ist_titel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ROUND($7::numeric*$8::numeric,2), $9)`,
      [id, m.n, h.txt(b.pos), h.txt(b.text) || 'Position', h.txt(b.langtext), h.txt(b.einheit),
       h.zuZahl(b.menge) ?? 1, h.zuZahl(b.einzelpreis) ?? 0, b.ist_titel === 'on']
    );
    await summenNeuRechnen(id);
    res.redirect(`/rechnungen/${id}`);
  } catch (e) { next(e); }
});

r.post('/:id/positionen/:pid', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pid = Number(req.params.pid);
    if (req.body.loeschen) {
      await db.query('DELETE FROM rechnung_positionen WHERE id=$1 AND rechnung_id=$2', [pid, id]);
    } else {
      const b = req.body;
      await db.query(
        `UPDATE rechnung_positionen SET lfd=$1, pos=$2, text=$3, einheit=$4, menge=$5, einzelpreis=$6,
                gesamtpreis=ROUND($5::numeric*$6::numeric,2)
          WHERE id=$7 AND rechnung_id=$8`,
        [h.zuZahl(b.lfd) ?? 1, h.txt(b.pos), h.txt(b.text) || 'Position', h.txt(b.einheit),
         h.zuZahl(b.menge) ?? 1, h.zuZahl(b.einzelpreis) ?? 0, pid, id]
      );
    }
    await summenNeuRechnen(id);
    res.redirect(`/rechnungen/${id}`);
  } catch (e) { next(e); }
});

// ===================== FESTSCHREIBEN =====================
r.post('/:id/festschreiben', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rg = await db.one('SELECT * FROM rechnungen WHERE id=$1', [id]);
    if (!rg) return res.redirect('/rechnungen');
    if (rg.festgeschrieben) { res.melde('Diese Rechnung ist bereits festgeschrieben.', 'warn'); return res.redirect(`/rechnungen/${id}`); }

    const anzahl = await db.one('SELECT COUNT(*)::int AS n FROM rechnung_positionen WHERE rechnung_id=$1 AND NOT ist_titel', [id]);
    if (anzahl.n === 0) { res.melde('Eine Rechnung ohne Position lässt sich nicht festschreiben.', 'warn'); return res.redirect(`/rechnungen/${id}`); }
    if (!rg.empfaenger) { res.melde('Ohne Empfängeranschrift ist die Rechnung nicht vollständig.', 'warn'); return res.redirect(`/rechnungen/${id}`); }

    await summenNeuRechnen(id);

    // Nummernvergabe, Festschreibung und Projektfortschreibung gehoeren in
    // einen Schritt. Scheitert eines davon, faellt auch die gezogene Nummer
    // zurueck — sonst entstuende eine Luecke im Nummernkreis.
    const fest = await db.tx(async (c) => {
      const nr = await h.naechsteNummer('RE', c);
      await c.query('UPDATE rechnungen SET nummer=$1 WHERE id=$2', [nr, id]);

      const summe = await pruefsumme(id, c);
      await c.query(
        `UPDATE rechnungen SET festgeschrieben=TRUE, festgeschrieben_am=now(),
                festgeschrieben_von=$1, pruefsumme=$2 WHERE id=$3`,
        [req.benutzer.id, summe, id]
      );
      if (rg.projekt_id) {
        const netto = (await c.query('SELECT netto FROM rechnungen WHERE id=$1', [id])).rows[0].netto;
        await c.query(
          'UPDATE projekte SET rechnungsbetrag=COALESCE(rechnungsbetrag,0)+$1, letzte_aktivitaet=now() WHERE id=$2',
          [netto, rg.projekt_id]
        );
      }
      return { nr, summe };
    });
    await auth.protokoll(req, 'rechnung_festgeschrieben', 'rechnung', id, { nummer: fest.nr, pruefsumme: fest.summe });
    res.melde(`Rechnung ${fest.nr} festgeschrieben. Sie ist ab jetzt unveränderlich.`);
    res.redirect(`/rechnungen/${id}`);
  } catch (e) { next(e); }
});

// ===================== STORNIEREN =====================
r.post('/:id/stornieren', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rg = await db.one('SELECT * FROM rechnungen WHERE id=$1', [id]);
    if (!rg || !rg.festgeschrieben) { res.melde('Nur festgeschriebene Rechnungen werden storniert. Entwürfe können bearbeitet werden.', 'warn'); return res.redirect(`/rechnungen/${id}`); }
    if (rg.storniert_durch) { res.melde('Diese Rechnung wurde bereits storniert.', 'warn'); return res.redirect(`/rechnungen/${id}`); }

    const grund = h.txt(req.body.grund) || 'Storno';

    /*
     * Reihenfolge innerhalb der Transaktion, und zwar genau so:
     *
     *  1. Nummer ziehen — mit dem Transaktions-Client, damit sie bei einem
     *     Abbruch zurueckfaellt und keine Luecke in der Nummernfolge bleibt.
     *  2. Stornokopf zunaechst OHNE Festschreibung anlegen. Der Trigger
     *     rechnungsposition_unveraenderlich() verbietet jede Position an einer
     *     festgeschriebenen Rechnung — also auch die erste. Wurde der Kopf
     *     sofort festgeschrieben, scheiterte jeder Storno an der eigenen
     *     Schutzregel.
     *  3. Positionen schreiben.
     *  4. Pruefsumme ueber den fertigen Beleg bilden — im selben Client,
     *     sonst sieht sie die noch nicht sichtbaren Zeilen nicht.
     *  5. Erst jetzt festschreiben.
     *
     * Die Positionen werden 1:1 uebernommen, nicht negiert. Der Kopf des
     * Stornos traegt denselben positiven Betrag; die Umkehrung passiert
     * ueberall im Haus ueber die Belegart ('storno' zaehlt negativ). Waeren
     * die Positionen negativ und der Kopf positiv, widerspraeche der
     * gedruckte Beleg sich selbst.
     */
    const storno = await db.tx(async (c) => {
      const nummer = await h.naechsteNummer('RE', c);
      const s = (await c.query(
        `INSERT INTO rechnungen (nummer, art, kunde_id, projekt_id, angebot_id, retainer_id, storno_zu,
                                 empfaenger, anrede, betreff, einleitung, hinweise, datum, faellig_am,
                                 mwst_satz, netto, mwst, brutto, festgeschrieben, erstellt_von)
         VALUES ($1,'storno',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_DATE,CURRENT_DATE,$12,$13,$14,$15,
                 FALSE, $16) RETURNING *`,
        [nummer, rg.kunde_id, rg.projekt_id, rg.angebot_id, rg.retainer_id, rg.id,
         rg.empfaenger, rg.anrede, `Storno zu Rechnung ${rg.nummer}`,
         `hiermit stornieren wir unsere Rechnung ${rg.nummer} vom ${new Date(rg.datum).toLocaleDateString('de-DE')} vollständig. Grund: ${grund}.`,
         null, rg.mwst_satz, rg.netto, rg.mwst, rg.brutto, req.benutzer.id]
      )).rows[0];

      const pos = (await c.query('SELECT * FROM rechnung_positionen WHERE rechnung_id=$1 ORDER BY lfd, id', [rg.id])).rows;
      for (const p of pos) {
        await c.query(
          `INSERT INTO rechnung_positionen (rechnung_id, lfd, pos, text, langtext, einheit, menge, einzelpreis, gesamtpreis, ist_titel)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [s.id, p.lfd, p.pos, p.text, p.langtext, p.einheit,
           p.menge, p.einzelpreis, p.ist_titel ? 0 : p.gesamtpreis, p.ist_titel]
        );
      }

      const summe = await pruefsumme(s.id, c);
      await c.query(
        `UPDATE rechnungen SET festgeschrieben=TRUE, festgeschrieben_am=now(),
                festgeschrieben_von=$1, pruefsumme=$2 WHERE id=$3`,
        [req.benutzer.id, summe, s.id]
      );
      await c.query('UPDATE rechnungen SET storniert_durch=$1 WHERE id=$2', [s.id, rg.id]);

      // Das Storno nimmt den Umsatz aus dem Projekt wieder heraus. Ohne diese
      // Zeile bliebe der Rechnungsbetrag des Projekts auf dem alten Stand.
      if (rg.projekt_id) {
        await c.query(
          'UPDATE projekte SET rechnungsbetrag=COALESCE(rechnungsbetrag,0)-$1, letzte_aktivitaet=now() WHERE id=$2',
          [rg.netto, rg.projekt_id]
        );
      }
      return s;
    });

    await auth.protokoll(req, 'rechnung_storniert', 'rechnung', id, { storno: storno.nummer, grund });
    res.melde(`Storno ${storno.nummer} erzeugt. Für eine Korrektur legen Sie jetzt eine neue Rechnung an.`);
    res.redirect(`/rechnungen/${storno.id}`);
  } catch (e) { next(e); }
});

// ===================== DRUCK =====================
r.get('/:id/druck', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rechnung = await db.one(`
      SELECT rg.*, k.firma, k.adresse, o.nummer AS original_nummer
        FROM rechnungen rg JOIN kunden k ON k.id=rg.kunde_id
        LEFT JOIN rechnungen o ON o.id = rg.storno_zu WHERE rg.id=$1`, [id]);
    if (!rechnung) return res.status(404).render('fehler', { titel: 'Nicht gefunden', text: '' });
    const positionen = await db.all('SELECT * FROM rechnung_positionen WHERE rechnung_id=$1 ORDER BY lfd, id', [id]);
    res.render('rechnung_druck', {
      titel: `Rechnung ${rechnung.nummer}`, rechnung, positionen,
      e: await h.einstellungen(), layout: false,
    });
  } catch (e) { next(e); }
});

module.exports = r;
