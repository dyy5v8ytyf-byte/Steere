'use strict';
/**
 * Stammdatenübernahme.
 *
 * Von aussen gibt es keinen Zugriff auf die Datenbank — deshalb kommen
 * vorbereitete Daten als Datei herein und werden hier eingelesen. Der
 * Vorgang ist beliebig wiederholbar: Vorhandenes wird uebersprungen und
 * niemals ueberschrieben. Wer eine Zeile in der Anwendung geaendert hat,
 * behaelt seine Aenderung auch dann, wenn die Datei erneut eingelesen wird.
 *
 * Bewusst getrennt von lib/altdaten.js: dort geht es um die alte
 * Kundenliste, hier um Vertraege, Angebote und Vorgaenge.
 */

const db = require('./db');
const h = require('./helfer');

/** Zahl aus dem Paket, null wenn unbrauchbar. */
function z(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function uebernehmen(paket, benutzerId = null) {
  if (!paket || typeof paket !== 'object') throw new Error('Die Datei enthält kein lesbares Paket.');

  const bericht = {
    organisationen: { neu: 0, vorhanden: 0 },
    retainer: { neu: 0, vorhanden: 0, bausteine: 0 },
    kunden: { neu: 0, vorhanden: 0 },
    ansprechpartner: { neu: 0, vorhanden: 0 },
    projekte: { neu: 0, vorhanden: 0 },
    angebote: { neu: 0, vorhanden: 0, positionen: 0 },
    begehungen: { neu: 0, vorhanden: 0 },
    hinweise: [],
  };

  await db.tx(async (c) => {
    // ---------- Organisationen ----------
    const orgIds = new Map();
    for (const o of paket.organisationen || []) {
      const name = h.txt(o.name);
      if (!name) continue;
      const da = (await c.query('SELECT id FROM organisationen WHERE lower(name) = lower($1)', [name])).rows[0];
      if (da) { orgIds.set(name, da.id); bericht.organisationen.vorhanden += 1; continue; }
      const neu = (await c.query(
        'INSERT INTO organisationen (name, kuerzel, art) VALUES ($1,$2,$3) RETURNING id',
        [name, h.txt(o.kuerzel), h.txt(o.art) || 'partner']
      )).rows[0];
      orgIds.set(name, neu.id);
      bericht.organisationen.neu += 1;
    }

    // ---------- Retainer ----------
    for (const r of paket.retainer || []) {
      const orgName = h.txt(r.organisation);
      let orgId = orgIds.get(orgName);
      if (!orgId && orgName) {
        const o = (await c.query('SELECT id FROM organisationen WHERE lower(name) = lower($1)', [orgName])).rows[0];
        orgId = o ? o.id : null;
      }
      if (!orgId) {
        bericht.hinweise.push(`Retainer „${r.bezeichnung}" übersprungen — Organisation „${orgName}" nicht gefunden.`);
        continue;
      }
      const da = (await c.query(
        'SELECT id FROM retainer WHERE organisation_id = $1 AND bezeichnung = $2', [orgId, r.bezeichnung]
      )).rows[0];
      if (da) { bericht.retainer.vorhanden += 1; continue; }

      const neu = (await c.query(
        `INSERT INTO retainer (organisation_id, bezeichnung, stunden_monat, entgelt_netto,
                               stundensatz_extra, km_satz, start_am, laufzeit_monate, start_ort, hinweis, aktiv)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE) RETURNING id`,
        // Die Spalten mit NOT NULL bekommen die Vorgaben des Schemas, wenn
        // das Paket dazu nichts sagt — sonst scheitert die ganze Übernahme
        // an einem Feld, das niemand ausgefüllt hat.
        [orgId, r.bezeichnung, z(r.stunden_monat) ?? 80, z(r.entgelt_netto) ?? 0,
         z(r.stundensatz_extra) ?? 120, z(r.km_satz) ?? 0.50, h.txt(r.start_am),
         z(r.laufzeit_monate) ?? 12, h.txt(r.start_ort) || 'Ahrensburg', h.txt(r.hinweis)]
      )).rows[0];
      bericht.retainer.neu += 1;

      let lfd = 0;
      for (const b of r.bausteine || []) {
        lfd += 1;
        await c.query(
          `INSERT INTO retainer_bausteine (retainer_id, baustein, inhalt, von_monat, bis_monat, stunden_plan, lfd)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [neu.id, h.txt(b.baustein) || 'Baustein', h.txt(b.inhalt),
           z(b.von_monat), z(b.bis_monat), z(b.stunden_plan) ?? 0, lfd]
        );
        bericht.retainer.bausteine += 1;
      }
    }

    // ---------- Kunden ----------
    const kundenIds = new Map();
    for (const k of paket.kunden || []) {
      const firma = h.txt(k.firma);
      if (!firma) continue;
      const da = (await c.query('SELECT id FROM kunden WHERE lower(firma) = lower($1)', [firma])).rows[0];
      if (da) { kundenIds.set(firma, da.id); bericht.kunden.vorhanden += 1; continue; }
      const neu = (await c.query(
        'INSERT INTO kunden (firma, branche, adresse, quelle, notiz) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [firma, h.txt(k.branche), h.txt(k.adresse), h.txt(k.quelle), h.txt(k.notiz)]
      )).rows[0];
      kundenIds.set(firma, neu.id);
      bericht.kunden.neu += 1;
    }

    async function kundeFinden(name) {
      const firma = h.txt(name);
      if (!firma) return null;
      if (kundenIds.has(firma)) return kundenIds.get(firma);
      const k = (await c.query('SELECT id FROM kunden WHERE lower(firma) = lower($1)', [firma])).rows[0];
      if (k) kundenIds.set(firma, k.id);
      return k ? k.id : null;
    }

    // ---------- Ansprechpartner ----------
    for (const a of paket.ansprechpartner || []) {
      const kid = await kundeFinden(a.kunde);
      const name = h.txt(a.name);
      if (!kid || !name) continue;
      const da = (await c.query(
        'SELECT id FROM ansprechpartner WHERE kunde_id = $1 AND lower(name) = lower($2)', [kid, name]
      )).rows[0];
      if (da) { bericht.ansprechpartner.vorhanden += 1; continue; }
      await c.query(
        'INSERT INTO ansprechpartner (kunde_id, name, telefon, email, rolle) VALUES ($1,$2,$3,$4,$5)',
        [kid, name, h.txt(a.telefon), h.txt(a.email), h.txt(a.rolle)]
      );
      bericht.ansprechpartner.neu += 1;
    }

    // ---------- Projekte ----------
    for (const p of paket.projekte || []) {
      const kid = await kundeFinden(p.kunde);
      if (!kid) { bericht.hinweise.push(`Projekt „${p.bezeichnung}" übersprungen — Kunde nicht gefunden.`); continue; }
      const nummer = h.txt(p.nummer);
      const da = nummer
        ? (await c.query('SELECT id FROM projekte WHERE nummer = $1', [nummer])).rows[0]
        : (await c.query('SELECT id FROM projekte WHERE kunde_id = $1 AND bezeichnung = $2',
                         [kid, h.txt(p.bezeichnung)])).rows[0];
      if (da) { bericht.projekte.vorhanden += 1; continue; }

      await c.query(
        `INSERT INTO projekte (kunde_id, nummer, bezeichnung, beschreibung, phase, angebotssumme, gewerk)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [kid, nummer, h.txt(p.bezeichnung) || 'Ohne Bezeichnung', h.txt(p.beschreibung),
         h.txt(p.phase) || 'Abgeschlossen', z(p.angebotssumme), h.txt(p.gewerk)]
      );
      bericht.projekte.neu += 1;
    }

    // ---------- Angebote ----------
    for (const a of paket.angebote || []) {
      const nummer = h.txt(a.nummer);
      if (!nummer) continue;
      const da = (await c.query('SELECT id FROM angebote WHERE nummer = $1', [nummer])).rows[0];
      if (da) { bericht.angebote.vorhanden += 1; continue; }
      const kid = await kundeFinden(a.kunde);
      if (!kid) { bericht.hinweise.push(`Angebot ${nummer} übersprungen — Kunde nicht gefunden.`); continue; }

      const neu = (await c.query(
        `INSERT INTO angebote (nummer, kunde_id, empfaenger, anrede, bauvorhaben, gewerk, einleitung,
                               vorbemerkungen, hinweise, schlusstext, mwst_satz, datum, status, erstellt_von)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::date, CURRENT_DATE),$13,$14) RETURNING id`,
        [nummer, kid, h.txt(a.empfaenger), h.txt(a.anrede), h.txt(a.bauvorhaben), h.txt(a.gewerk),
         h.txt(a.einleitung), h.txt(a.vorbemerkungen), h.txt(a.hinweise), h.txt(a.schlusstext),
         z(a.mwst_satz) ?? 19, h.txt(a.datum), h.txt(a.status) || 'Entwurf', benutzerId]
      )).rows[0];
      bericht.angebote.neu += 1;

      let lfd = 0;
      for (const p of a.positionen || []) {
        lfd += 1;
        const menge = z(p.menge) ?? 0;
        const ep = z(p.einzelpreis) ?? 0;
        await c.query(
          `INSERT INTO angebot_positionen (angebot_id, lfd, ist_titel, pos, text, langtext, einheit,
                                           menge, einzelpreis, gesamtpreis)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ROUND($8::numeric * $9::numeric, 2))`,
          [neu.id, lfd, !!p.ist_titel, h.txt(p.pos), h.txt(p.text) || 'Position', h.txt(p.langtext),
           h.txt(p.einheit), p.ist_titel ? 0 : menge, p.ist_titel ? 0 : ep]
        );
        bericht.angebote.positionen += 1;
      }

      // Summen aus den Positionen bilden — nie aus der Datei uebernehmen.
      const s = (await c.query(
        `SELECT COALESCE(SUM(ROUND(menge * einzelpreis, 2)), 0) AS netto
           FROM angebot_positionen WHERE angebot_id = $1 AND ist_titel = FALSE`, [neu.id]
      )).rows[0];
      const netto = Number(s.netto);
      const satz = z(a.mwst_satz) ?? 19;
      const mwst = Math.round(netto * satz) / 100;
      await c.query('UPDATE angebote SET netto=$1, mwst=$2, brutto=$3 WHERE id=$4',
        [netto.toFixed(2), mwst.toFixed(2), (netto + mwst).toFixed(2), neu.id]);
    }

    // ---------- Begehungen ----------
    for (const b of paket.begehungen || []) {
      const nummer = h.txt(b.nummer);
      const da = nummer
        ? (await c.query('SELECT id FROM begehungen WHERE nummer = $1', [nummer])).rows[0] : null;
      if (da) { bericht.begehungen.vorhanden += 1; continue; }
      const kid = await kundeFinden(b.kunde);

      const neu = (await c.query(
        `INSERT INTO begehungen (nummer, kunde_id, objekt, adresse, plz, ort, art, nutzung, status, fazit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [nummer || await h.naechsteNummer('BG'), kid, h.txt(b.objekt) || 'Objekt',
         h.txt(b.adresse), h.txt(b.plz), h.txt(b.ort), h.txt(b.art) || 'AC',
         h.txt(b.nutzung), h.txt(b.status) || 'geplant', h.txt(b.hinweis)]
      )).rows[0];
      bericht.begehungen.neu += 1;

      // Strompfad vorbelegen, damit die Begehung nicht leer beginnt.
      const typen = String(await h.einstellung('begehung_abschnittstypen', ''))
        .split(',').map((x) => x.trim()).filter(Boolean);
      const vorgabe = (h.txt(b.art) || 'AC') === 'DC'
        ? ['Netzanschluss / Übergabe', 'Zählerplatz / Messung', 'Trasse Außenbereich',
           'Unterverteilung / Ladeverteiler', 'Ladepunkt DC (HPC)']
        : ['Netzanschluss / Übergabe', 'Zählerplatz / Messung', 'Hauptverteilung', 'Steigleitung',
           'Trasse Innenbereich', 'Stromschiene', 'Abgangskasten', 'Ladepunkt AC (Wallbox)'];
      let lfd = 0;
      for (const typ of vorgabe) {
        if (!typen.includes(typ)) continue;
        lfd += 1;
        await c.query('INSERT INTO begehung_abschnitte (begehung_id, lfd, typ) VALUES ($1,$2,$3)',
          [neu.id, lfd, typ]);
      }
    }
  });

  return bericht;
}

module.exports = { uebernehmen };
