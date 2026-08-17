'use strict';
/**
 * Angebote: aus dem Preiskatalog zusammenstellen, rechnen, drucken.
 * Die Summen werden immer aus den Positionen neu berechnet und nie aus dem
 * Formular uebernommen - so kann eine Angebotssumme nicht stillschweigend
 * von den Positionen abweichen.
 */

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');
const vorlagen = require('../lib/vorlagen');
const lernen = require('../lib/lernen');

const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router(), ['id', 'pid']);
const intern = auth.verlangt('admin', 'team');

const STATUS = ['Entwurf', 'Versendet', 'Beauftragt', 'Abgelehnt', 'Storniert'];

async function summenNeuRechnen(angebotId) {
  const a = await db.one('SELECT mwst_satz FROM angebote WHERE id = $1', [angebotId]);
  const satz = Number(a ? a.mwst_satz : 19);
  const s = await db.one(
    `SELECT COALESCE(SUM(ROUND(menge * einzelpreis, 2)), 0) AS netto
       FROM angebot_positionen WHERE angebot_id = $1 AND ist_titel = FALSE`,
    [angebotId]
  );
  const netto = Number(s.netto);
  const mwst = Math.round(netto * satz) / 100;
  await db.query(
    'UPDATE angebote SET netto=$1, mwst=$2, brutto=$3, geaendert_am=now() WHERE id=$4',
    [netto.toFixed(2), mwst.toFixed(2), (netto + mwst).toFixed(2), angebotId]
  );
  return { netto, mwst, brutto: netto + mwst };
}

// ---------- Liste ----------
r.get('/', intern, async (req, res, next) => {
  try {
    const status = (req.query.status || '').trim();
    const params = [];
    let wo = 'TRUE';
    if (status) { params.push(status); wo += ` AND a.status = $${params.length}`; }

    const angebote = await db.all(`
      SELECT a.*, k.firma, p.bezeichnung AS projekt,
             (SELECT COUNT(*)::int FROM angebot_positionen ap WHERE ap.angebot_id = a.id AND ap.ist_titel = FALSE) AS positionen
        FROM angebote a
        JOIN kunden k ON k.id = a.kunde_id
        LEFT JOIN projekte p ON p.id = a.projekt_id
       WHERE ${wo}
       ORDER BY a.id DESC
    `, params);

    res.render('angebote_liste', { titel: 'Angebote', angebote, status, STATUS });
  } catch (e) { next(e); }
});

// ---------- Neu ----------
r.get('/neu', intern, async (req, res, next) => {
  try {
    const kunden = await db.all('SELECT id, firma FROM kunden ORDER BY firma');
    const projekte = await db.all(`
      SELECT p.id, p.bezeichnung, p.kunde_id, k.firma
        FROM projekte p JOIN kunden k ON k.id = p.kunde_id
       WHERE p.phase NOT IN ('Abgeschlossen','Verloren') ORDER BY k.firma, p.bezeichnung
    `);
    const e = await h.einstellungen();
    res.render('angebot_neu', {
      titel: 'Neues Angebot', kunden, projekte,
      vorlagenListe: await vorlagen.liste(true),
      vorgabeKunde: req.query.kunde ? Number(req.query.kunde) : null,
      vorgabeProjekt: req.query.projekt ? Number(req.query.projekt) : null,
      einstellungen: e,
    });
  } catch (e) { next(e); }
});

r.post('/neu', intern, async (req, res, next) => {
  try {
    const b = req.body;
    const kundeId = h.zuZahl(b.kunde_id);
    if (!kundeId) { res.melde('Bitte einen Kunden auswählen.', 'warn'); return res.redirect('/angebote/neu'); }

    const e = await h.einstellungen();

    // Vorlage, falls gewählt: sie liefert Texte und Positionsgerüst.
    const vorlage = h.zuZahl(b.vorlage_id) ? await vorlagen.laden(h.zuZahl(b.vorlage_id)) : null;
    const gueltig = Number((vorlage && vorlage.gueltigkeit_tage) || e.angebot_gueltigkeit_tage || 30);
    const nummer = await h.naechsteNummer('AN');

    const a = await db.tx(async (c) => {
      const x = (await c.query(
        `INSERT INTO angebote (nummer, kunde_id, projekt_id, empfaenger, anrede, bauvorhaben, gewerk,
                               einleitung, vorbemerkungen, hinweise, schlusstext, mwst_satz,
                               gueltig_bis, vorlage_id, erstellt_von)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CURRENT_DATE + $13::int, $14, $15) RETURNING *`,
        [nummer, kundeId, h.zuZahl(b.projekt_id), h.txt(b.empfaenger),
         h.txt(b.anrede) || (vorlage ? vorlage.anrede : null),
         h.txt(b.bauvorhaben), h.txt(b.gewerk),
         h.txt(b.einleitung) || (vorlage && vorlage.einleitung)
           || 'vielen Dank für Ihre Anfrage. Für das oben genannte Bauvorhaben unterbreiten wir Ihnen folgendes Angebot:',
         vorlage ? vorlage.vorbemerkungen : null,
         h.txt(b.hinweise) || (vorlage && vorlage.hinweise) || standardHinweise(gueltig),
         vorlage ? vorlage.schlusstext : null,
         Number(e.mwst_satz || 19), gueltig, vorlage ? vorlage.id : null, req.benutzer.id]
      )).rows[0];
      if (vorlage) {
        await vorlagen.positionenSchreiben(c, x.id, vorlage, null, vorlage.art);
        await vorlagen.summenNeuRechnen(c, x.id);
      }
      return x;
    });

    await auth.protokoll(req, 'angebot_angelegt', 'angebot', a.id, { nummer, vorlage: vorlage ? vorlage.name : null });
    res.melde(vorlage
      ? `Angebot ${nummer} nach Vorlage „${vorlage.name}“ angelegt.`
      : `Angebot ${nummer} angelegt.`);
    res.redirect(`/angebote/${a.id}`);
  } catch (e) { next(e); }
});

function standardHinweise(gueltig) {
  return [
    'Alle Preise verstehen sich in Euro, zzgl. der gesetzlichen Mehrwertsteuer. Zahlungsziel 14 Tage netto.',
    `Dieses Angebot ist freibleibend und für die Dauer von ${gueltig} Tagen ab Angebotsdatum gültig.`,
    'Sämtliche angebotenen Leistungen stehen unter dem Vorbehalt der technischen Umsetzbarkeit vor Ort sowie der Freigabe durch den zuständigen Verteilnetzbetreiber (VNB). Sollten sich im Zuge der Begehung bauliche oder technische Gegebenheiten zeigen, die eine Umsetzung in der angebotenen Form nicht zulassen, behalten wir uns eine entsprechende Anpassung von Leistung und Preis nach vorheriger Abstimmung mit Ihnen vor.',
  ].join('\n\n');
}

// ---------- Bearbeiten ----------
r.get('/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const angebot = await db.one(`
      SELECT a.*, k.firma, k.adresse, p.bezeichnung AS projekt
        FROM angebote a JOIN kunden k ON k.id = a.kunde_id
        LEFT JOIN projekte p ON p.id = a.projekt_id
       WHERE a.id = $1`, [id]);
    if (!angebot) return res.status(404).render('fehler', { titel: 'Angebot nicht gefunden', text: 'Dieses Angebot existiert nicht (mehr).' });

    const positionen = await db.all(
      'SELECT * FROM angebot_positionen WHERE angebot_id = $1 ORDER BY lfd, id', [id]
    );
    // Erfahrungswerte nur, wenn das Angebot aus einer Begehung stammt.
    const rat = angebot.begehung_id
      ? await lernen.vorschlaege(angebot.begehung_id, positionen.map((p) => p.text))
      : [];

    res.render('angebot_detail', {
      titel: `Angebot ${angebot.nummer}`, angebot, positionen, STATUS,
      felder: await h.eigeneFelder('angebot', id),
      rat,
      texte: await vorlagen.bausteineFuer(['einleitung', 'vorbemerkung', 'hinweis', 'schluss', 'position', 'langtext']),
      vorlagenListe: await vorlagen.liste(true),
    });
  } catch (e) { next(e); }
});

r.post('/:id', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    await db.query(
      `UPDATE angebote SET empfaenger=$1, anrede=$2, bauvorhaben=$3, gewerk=$4, einleitung=$5,
              vorbemerkungen=$6, hinweise=$7, schlusstext=$8, status=$9,
              datum=COALESCE($10::date, datum), gueltig_bis=$11::date,
              mwst_satz=$12, geaendert_am=now()
        WHERE id=$13`,
      [h.txt(b.empfaenger), h.txt(b.anrede), h.txt(b.bauvorhaben), h.txt(b.gewerk),
       h.txt(b.einleitung), h.txt(b.vorbemerkungen), h.txt(b.hinweise), h.txt(b.schlusstext),
       STATUS.includes(b.status) ? b.status : 'Entwurf',
       h.txt(b.datum), h.txt(b.gueltig_bis), h.zuZahl(b.mwst_satz) ?? 19, id]
    );
    await summenNeuRechnen(id);
    await h.eigeneFelderSpeichern('angebot', id, b);

    // Beauftragte Angebote schreiben ihre Summe ins Projekt zurueck.
    const a = await db.one('SELECT * FROM angebote WHERE id = $1', [id]);
    if (a.projekt_id) {
      if (a.status === 'Beauftragt') {
        await db.query('UPDATE projekte SET beauftragte_summe = $1, letzte_aktivitaet = now() WHERE id = $2', [a.netto, a.projekt_id]);
      } else if (a.status === 'Versendet') {
        await db.query('UPDATE projekte SET angebotssumme = $1, letzte_aktivitaet = now() WHERE id = $2', [a.netto, a.projekt_id]);
      }
    }
    await vorlagen.merkeMehrere([
      ['einleitung', b.einleitung], ['vorbemerkung', b.vorbemerkungen],
      ['hinweis', b.hinweise], ['schluss', b.schlusstext],
    ], req.benutzer.id);

    // Aus einer Beauftragung lässt sich lernen: was wurde tatsächlich
    // gekauft. Entwürfe sagen dazu nichts.
    let gelernt = null;
    if (a.status === 'Beauftragt') {
      try { gelernt = await lernen.lerneAusAngebot(id); }
      catch (err) { console.error('[STEER.E] Auswertung fehlgeschlagen:', err.message); }
    }

    await auth.protokoll(req, 'angebot_geaendert', 'angebot', id, { status: a.status });
    res.melde(gelernt && gelernt.gelernt
      ? `Angebot gespeichert. ${gelernt.gelernt} Position(en) als Erfahrungswert für vergleichbare Objekte vermerkt.`
      : 'Angebot gespeichert.');
    res.redirect(`/angebote/${id}`);
  } catch (e) { next(e); }
});

// ---------- Positionen ----------
r.post('/:id/positionen', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;

    const naechsteLfd = async () => {
      const m = await db.one('SELECT COALESCE(MAX(lfd),0)+1 AS n FROM angebot_positionen WHERE angebot_id = $1', [id]);
      return m.n;
    };

    if (b.aus_katalog) {
      // Eine oder mehrere Katalogpositionen uebernehmen.
      const ids = [].concat(b.katalog_id || []).map(Number).filter(Boolean);
      for (const kid of ids) {
        const k = await db.one('SELECT * FROM preis_positionen WHERE id = $1', [kid]);
        if (!k) continue;
        const preis = k.vk_ziel ?? k.vk_aktuell ?? k.markt_median ?? 0;
        await db.query(
          `INSERT INTO angebot_positionen (angebot_id, lfd, quelle_id, pos, text, einheit, menge, einzelpreis, gesamtpreis)
           VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7)`,
          [id, await naechsteLfd(), k.id, k.pos, k.text, k.einheit, Number(preis).toFixed(4)]
        );
      }
      res.melde(`${ids.length} Position(en) übernommen.`);
    } else if (b.frei) {
      await db.query(
        `INSERT INTO angebot_positionen (angebot_id, lfd, pos, text, langtext, einheit, menge, einzelpreis, gesamtpreis, ist_titel)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ROUND($7::numeric * $8::numeric, 2), $9)`,
        [id, await naechsteLfd(), h.txt(b.pos), h.txt(b.text) || 'Position', h.txt(b.langtext),
         h.txt(b.einheit), h.zuZahl(b.menge) ?? 1, h.zuZahl(b.einzelpreis) ?? 0, b.ist_titel === 'on']
      );
      res.melde('Position hinzugefügt.');
    }

    await summenNeuRechnen(id);
    res.redirect(`/angebote/${id}`);
  } catch (e) { next(e); }
});

r.post('/:id/positionen/:pid', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pid = Number(req.params.pid);
    const b = req.body;

    if (b.loeschen) {
      await db.query('DELETE FROM angebot_positionen WHERE id = $1 AND angebot_id = $2', [pid, id]);
      res.melde('Position entfernt.');
    } else {
      const menge = h.zuZahl(b.menge) ?? 1;
      const ep = h.zuZahl(b.einzelpreis) ?? 0;
      await db.query(
        `UPDATE angebot_positionen SET lfd=$1, pos=$2, text=$3, langtext=$4, einheit=$5,
                menge=$6, einzelpreis=$7, gesamtpreis=ROUND($6::numeric * $7::numeric, 2)
          WHERE id=$8 AND angebot_id=$9`,
        [h.zuZahl(b.lfd) ?? 1, h.txt(b.pos), h.txt(b.text) || 'Position', h.txt(b.langtext),
         h.txt(b.einheit), menge, ep, pid, id]
      );
    }
    await summenNeuRechnen(id);
    res.redirect(`/angebote/${id}`);
  } catch (e) { next(e); }
});

// ---------- Druckansicht ----------
r.get('/:id/druck', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const angebot = await db.one(`
      SELECT a.*, k.firma, k.adresse FROM angebote a JOIN kunden k ON k.id = a.kunde_id WHERE a.id = $1`, [id]);
    if (!angebot) return res.status(404).render('fehler', { titel: 'Angebot nicht gefunden', text: '' });
    const positionen = await db.all('SELECT * FROM angebot_positionen WHERE angebot_id = $1 ORDER BY lfd, id', [id]);
    res.render('angebot_druck', {
      titel: `Angebot ${angebot.nummer}`, angebot, positionen,
      e: await h.einstellungen(), layout: false,
    });
  } catch (e) { next(e); }
});

module.exports = r;
