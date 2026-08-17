'use strict';
/**
 * Retainer-Kalkulator und Zeiterfassung.
 *
 * Rechenlogik nach eurer Tabelle Leistungsnachweis-Fierax-Retainer-und-mehr:
 *   - Kontingent in Stunden je Monat, Entgelt netto je Monat
 *   - impliziter Stundensatz = Entgelt / Kontingent
 *   - Leistungen ausserhalb des Kontingents zum Satz stundensatz_extra (120 €)
 *   - Fahrtkosten je Kilometer ab Startort (0,50 €)
 *   - Bausteine mit Plan-Stunden ergeben den Monatsverlauf
 *
 * Der Kalkulator rechnet in beide Richtungen: aus Bausteinen und Plan-Stunden
 * ein Entgelt, oder aus einem Wunschentgelt das Kontingent, das dabei
 * herauskommt. Das ist die Frage, die im Kundengespraech wirklich gestellt
 * wird.
 */

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helfer');
const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router());
const intern = auth.verlangt('admin', 'team');

/** Die eine Stelle, an der gerechnet wird. */
function rechne(p) {
  const kontingent = Number(p.stunden_monat) || 0;
  const entgelt = Number(p.entgelt_netto) || 0;
  const laufzeit = Number(p.laufzeit_monate) || 12;
  const satzExtra = Number(p.stundensatz_extra) || 120;
  const kmSatz = Number(p.km_satz) || 0.5;
  const kmMonat = Number(p.km_monat) || 0;
  const extraStunden = Number(p.extra_stunden) || 0;

  const implizit = kontingent > 0 ? entgelt / kontingent : 0;
  const nachlass = satzExtra > 0 ? (1 - implizit / satzExtra) * 100 : 0;
  const fahrt = kmMonat * kmSatz;
  const extra = extraStunden * satzExtra;

  return {
    kontingent, entgelt, laufzeit, satzExtra, kmSatz, kmMonat, extraStunden,
    implizit,
    nachlassProzent: nachlass,
    vergleichswert: kontingent * satzExtra,       // was dieselben Stunden einzeln kosten würden
    ersparnisMonat: kontingent * satzExtra - entgelt,
    fahrtkosten: fahrt,
    extraLeistung: extra,
    monatGesamt: entgelt + fahrt + extra,
    jahreswert: entgelt * laufzeit,
    jahresstunden: kontingent * laufzeit,
  };
}

// ===================== KALKULATOR =====================
r.get('/', intern, async (req, res, next) => {
  try {
    const q = req.query;
    const eingabe = {
      stunden_monat: h.zuZahl(q.stunden_monat) ?? 80,
      entgelt_netto: h.zuZahl(q.entgelt_netto) ?? 7500,
      laufzeit_monate: h.zuZahl(q.laufzeit_monate) ?? 12,
      stundensatz_extra: h.zuZahl(q.stundensatz_extra) ?? 120,
      km_satz: h.zuZahl(q.km_satz) ?? 0.5,
      km_monat: h.zuZahl(q.km_monat) ?? 0,
      extra_stunden: h.zuZahl(q.extra_stunden) ?? 0,
    };

    // Rückwärts rechnen: Wunsch-Stundensatz vorgeben, Entgelt ergibt sich.
    if (h.zuZahl(q.ziel_satz)) {
      eingabe.entgelt_netto = Math.round(eingabe.stunden_monat * h.zuZahl(q.ziel_satz));
    }

    const erg = rechne(eingabe);
    const retainer = await db.all(`
      SELECT r.*, o.name AS org FROM retainer r JOIN organisationen o ON o.id=r.organisation_id
       ORDER BY r.aktiv DESC, o.name`);
    const organisationen = await db.all("SELECT * FROM organisationen WHERE art='partner' AND aktiv ORDER BY name");

    res.render('kalkulator', {
      titel: 'Retainer-Kalkulator', eingabe, erg, retainer, organisationen,
      // Drei übliche Zuschnitte als Startpunkt für das Gespräch.
      varianten: [
        { name: 'Einstieg', stunden: 40, entgelt: 4200 },
        { name: 'Standard', stunden: 80, entgelt: 7500 },
        { name: 'Ausbau', stunden: 120, entgelt: 10800 },
      ].map((v) => ({ ...v, satz: v.entgelt / v.stunden })),
    });
  } catch (e) { next(e); }
});

/** Aus einer Kalkulation einen echten Retainer anlegen. */
r.post('/uebernehmen', intern, async (req, res, next) => {
  try {
    const b = req.body;
    const orgId = h.zuZahl(b.organisation_id);
    if (!orgId) { res.melde('Bitte eine Organisation auswählen.', 'warn'); return res.redirect('/kalkulator'); }

    const ret = await db.one(
      `INSERT INTO retainer (organisation_id, bezeichnung, stunden_monat, entgelt_netto,
                             stundensatz_extra, km_satz, laufzeit_monate, start_am, hinweis, aktiv)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, CURRENT_DATE),$9,TRUE) RETURNING id`,
      [orgId, h.txt(b.bezeichnung) || 'Retainer', h.zuZahl(b.stunden_monat) ?? 80,
       h.zuZahl(b.entgelt_netto) ?? 0, h.zuZahl(b.stundensatz_extra) ?? 120,
       h.zuZahl(b.km_satz) ?? 0.5, h.zuZahl(b.laufzeit_monate) ?? 12,
       h.txt(b.start_am), h.txt(b.hinweis)]
    );
    await auth.protokoll(req, 'retainer_aus_kalkulation', 'retainer', ret.id);
    res.melde('Retainer angelegt. Bausteine lassen sich jetzt ergänzen.');
    res.redirect(`/kalkulator/${ret.id}/bausteine`);
  } catch (e) { next(e); }
});

// ===================== BAUSTEINE =====================
r.get('/:id/bausteine', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ret = await db.one(`SELECT r.*, o.name AS org FROM retainer r
                                JOIN organisationen o ON o.id=r.organisation_id WHERE r.id=$1`, [id]);
    if (!ret) return res.status(404).render('fehler', { titel: 'Retainer nicht gefunden', text: '' });
    const bausteine = await db.all('SELECT * FROM retainer_bausteine WHERE retainer_id=$1 ORDER BY lfd, id', [id]);
    const summe = bausteine.reduce((s, x) => s + Number(x.stunden_plan), 0);
    res.render('kalkulator_bausteine', {
      titel: `Bausteine · ${ret.bezeichnung}`, ret, bausteine, summe,
      erg: rechne(ret),
    });
  } catch (e) { next(e); }
});

r.post('/:id/bausteine', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;

    if (b.vorlage) {
      // Die sechs Bausteine aus eurem bestehenden Retainer als Startpunkt.
      const vorlage = [
        ['Baustein 1', 'Kundenliste erstellen', 1, 1, 8],
        ['Baustein 1', 'Potenzialanalyse', 1, 2, 12],
        ['Baustein 1', 'Priorisierung', 2, 2, 6],
        ['Baustein 1', 'Anspracheplan', 2, 3, 8],
        ['Baustein 2', 'Strukturierte Kundenansprache', 4, 12, 40],
        ['Baustein 3', 'Marketingkampagne', 4, 12, 12],
        ['Baustein 4', 'Angebotsvorlage entwickeln', 2, 2, 10],
        ['Baustein 4', 'Kalkulationsmodell entwickeln', 2, 3, 16],
        ['Baustein 4', 'GAEB-Vorlagen entwickeln', 3, 4, 16],
        ['Baustein 4', 'Gemeinsame Präsentation für Kundentermine', 2, 2, 8],
        ['Baustein 4', 'Formular für Vor-Ort-Begehungen entwickeln', 1, 1, 10],
        ['Baustein 5', 'PM-Prozesse definieren: Kick-off, Steuerung, QS und Aufmaß, Abnahme, Reporting, Rollen', 1, 2, 20],
        ['Baustein 5', 'Pilotprojekt gemeinsam steuern, QS-Checklisten, Wissenstransfer, NU-Bewertungsmatrix', 3, 4, 24],
        ['Baustein 5', 'Parallele Steuerung von 2–3 Projekten, Reporting-Routine, Prozessoptimierung', 5, 8, 40],
        ['Baustein 5', 'Eigenständige Steuerung, Support bei komplexen Fällen, Jahresgespräch, Planung Folgejahr', 9, 12, 30],
        ['Baustein 6', 'Gemeinsame Projekte identifizieren: Bestandskunden, Ausschreibungen, Netzwerk, Pipeline', 1, 12, 30],
      ];
      let lfd = 1;
      for (const [bs, inhalt, von, bis, std] of vorlage) {
        await db.query(
          `INSERT INTO retainer_bausteine (retainer_id, baustein, inhalt, von_monat, bis_monat, stunden_plan, lfd)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, bs, inhalt, von, bis, std, lfd]);
        lfd += 1;
      }
      res.melde('Vorlage mit 16 Bausteinen eingefügt. Stunden und Zeiträume bitte anpassen.');
    } else if (h.txt(b.inhalt)) {
      const m = await db.one('SELECT COALESCE(MAX(lfd),0)+1 AS n FROM retainer_bausteine WHERE retainer_id=$1', [id]);
      await db.query(
        `INSERT INTO retainer_bausteine (retainer_id, baustein, inhalt, von_monat, bis_monat, stunden_plan, lfd)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, h.txt(b.baustein) || 'Baustein', h.txt(b.inhalt), h.zuZahl(b.von_monat),
         h.zuZahl(b.bis_monat), h.zuZahl(b.stunden_plan) ?? 0, m.n]
      );
      res.melde('Baustein ergänzt.');
    }
    res.redirect(`/kalkulator/${id}/bausteine`);
  } catch (e) { next(e); }
});

r.post('/:id/bausteine/:pid', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pid = Number(req.params.pid);
    if (req.body.loeschen) {
      await db.query('DELETE FROM retainer_bausteine WHERE id=$1 AND retainer_id=$2', [pid, id]);
    } else {
      const b = req.body;
      await db.query(
        `UPDATE retainer_bausteine SET baustein=$1, inhalt=$2, von_monat=$3, bis_monat=$4,
                stunden_plan=$5, erledigt=$6 WHERE id=$7 AND retainer_id=$8`,
        [h.txt(b.baustein), h.txt(b.inhalt), h.zuZahl(b.von_monat), h.zuZahl(b.bis_monat),
         h.zuZahl(b.stunden_plan) ?? 0, b.erledigt === 'on', pid, id]
      );
    }
    res.redirect(`/kalkulator/${id}/bausteine`);
  } catch (e) { next(e); }
});

// ===================== ZEITERFASSUNG =====================
r.get('/zeiten', intern, async (req, res, next) => {
  try {
    const monat = req.query.monat || new Date().toISOString().slice(0, 7);
    const zeiten = await db.all(`
      SELECT z.*, r.bezeichnung AS retainer, o.name AS org, p.bezeichnung AS projekt
        FROM zeiterfassung z
        LEFT JOIN retainer r ON r.id = z.retainer_id
        LEFT JOIN organisationen o ON o.id = r.organisation_id
        LEFT JOIN projekte p ON p.id = z.projekt_id
       WHERE z.monat = $1 ORDER BY z.datum, z.id`, [monat]);

    const summe = zeiten.reduce((s, z) => ({
      stunden: s.stunden + Number(z.stunden),
      imRetainer: s.imRetainer + (z.im_retainer ? Number(z.stunden) : 0),
      extra: s.extra + (z.im_retainer ? 0 : Number(z.stunden)),
      km: s.km + Number(z.km),
    }), { stunden: 0, imRetainer: 0, extra: 0, km: 0 });

    res.render('zeiterfassung', {
      titel: `Zeiterfassung ${monat}`, zeiten, monat, summe,
      retainer: await db.all(`SELECT r.id, r.bezeichnung, r.stundensatz_extra, r.km_satz, o.name AS org
                                FROM retainer r JOIN organisationen o ON o.id=r.organisation_id
                               WHERE r.aktiv ORDER BY o.name`),
      projekte: await db.all(`SELECT p.id, p.bezeichnung, k.firma FROM projekte p
                                JOIN kunden k ON k.id=p.kunde_id
                               WHERE p.phase NOT IN ('Abgeschlossen','Verloren') ORDER BY k.firma`),
    });
  } catch (e) { next(e); }
});

r.post('/zeiten', intern, async (req, res, next) => {
  try {
    const b = req.body;
    const taetigkeit = h.txt(b.taetigkeit);
    if (!taetigkeit) { res.melde('Ohne Tätigkeit lässt sich keine Zeit erfassen.', 'warn'); return res.redirect('/kalkulator/zeiten'); }

    // Stunden aus von/bis abzüglich Pause, falls nicht direkt angegeben.
    let stunden = h.zuZahl(b.stunden);
    if (stunden == null && b.von && b.bis) {
      const [vh, vm] = String(b.von).split(':').map(Number);
      const [bh, bm] = String(b.bis).split(':').map(Number);
      if ([vh, vm, bh, bm].every(Number.isFinite)) {
        stunden = ((bh * 60 + bm) - (vh * 60 + vm) - (h.zuZahl(b.pause_min) || 0)) / 60;
      }
    }
    const datum = h.txt(b.datum) || new Date().toISOString().slice(0, 10);

    await db.query(
      `INSERT INTO zeiterfassung (retainer_id, projekt_id, begehung_id, benutzer_id, wer, datum, monat,
                                  von, bis, pause_min, stunden, taetigkeit, im_retainer, km, reiseanschrift)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [h.zuZahl(b.retainer_id), h.zuZahl(b.projekt_id), h.zuZahl(b.begehung_id), req.benutzer.id,
       h.txt(b.wer) || req.benutzer.name, datum, datum.slice(0, 7),
       h.txt(b.von), h.txt(b.bis), h.zuZahl(b.pause_min) ?? 0,
       Math.max(0, Number(stunden) || 0), taetigkeit,
       b.im_retainer !== 'nein', h.zuZahl(b.km) ?? 0, h.txt(b.reiseanschrift)]
    );
    res.melde('Zeit erfasst.');
    res.redirect(`/kalkulator/zeiten?monat=${datum.slice(0, 7)}`);
  } catch (e) { next(e); }
});

r.post('/zeiten/:id/loeschen', intern, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const z = await db.one('SELECT monat, abgerechnet FROM zeiterfassung WHERE id=$1', [id]);
    if (z && z.abgerechnet) {
      res.melde('Bereits abgerechnete Zeiten werden nicht gelöscht.', 'warn');
      return res.redirect(`/kalkulator/zeiten?monat=${z.monat}`);
    }
    await db.query('DELETE FROM zeiterfassung WHERE id=$1', [id]);
    res.melde('Eintrag entfernt.');
    res.redirect(`/kalkulator/zeiten?monat=${z ? z.monat : ''}`);
  } catch (e) { next(e); }
});

module.exports = r;
