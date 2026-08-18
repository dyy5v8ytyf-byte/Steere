'use strict';
/**
 * Microsoft Planner und Teams über Graph.
 *
 * ZWEI DINGE VORWEG, damit die Erwartung stimmt:
 *
 * 1. Diese Anbindung verlangt Berechtigungen, die die uebrige Anwendung
 *    nicht braucht — Tasks.ReadWrite, Group.Read.All, Team.ReadBasic.All,
 *    ChannelMessage.Send. Group.Read.All wird in den meisten Mandanten von
 *    Microsoft als zustimmungspflichtig eingestuft; ohne einen
 *    Administrator geht es dort nicht. Wird die Zustimmung nicht erteilt,
 *    bleibt dieser Bereich schlicht aus und der Rest laeuft weiter.
 *
 * 2. Planner ist kein zweiter Aufgabenspeicher, sondern ein Spiegel. Die
 *    fuehrende Aufgabe steht in STEER.E. Was in Planner abgehakt wird, wird
 *    hier uebernommen; alles andere geht von hier nach dort. Zwei Systeme,
 *    die beide fuehren wollen, enden in widerspruechlichen Listen — das ist
 *    genau der Zustand, den diese Plattform ersetzen soll.
 */

const crypto = require('node:crypto');
const db = require('./db');
const m365 = require('./m365');

// ---------------------------------------------------------------------
// Auswahl: Gruppen, Plaene, Eimer, Teams, Kanaele
// ---------------------------------------------------------------------

async function gruppen(benutzerId) {
  const a = await m365.graph(benutzerId, '/me/memberOf?$select=id,displayName&$top=100');
  return (a.value || [])
    .filter((g) => g['@odata.type'] === '#microsoft.graph.group' || g.displayName)
    .map((g) => ({ id: g.id, name: g.displayName }))
    .filter((g) => g.id && g.name);
}

async function plaene(benutzerId, gruppeId) {
  const a = await m365.graph(benutzerId, `/groups/${encodeURIComponent(gruppeId)}/planner/plans`);
  return (a.value || []).map((p) => ({ id: p.id, name: p.title }));
}

async function eimer(benutzerId, planId) {
  const a = await m365.graph(benutzerId, `/planner/plans/${encodeURIComponent(planId)}/buckets`);
  return (a.value || []).map((b) => ({ id: b.id, name: b.name }));
}

async function teams(benutzerId) {
  const a = await m365.graph(benutzerId, '/me/joinedTeams?$select=id,displayName');
  return (a.value || []).map((t) => ({ id: t.id, name: t.displayName }));
}

async function kanaele(benutzerId, teamId) {
  const a = await m365.graph(benutzerId, `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`);
  return (a.value || []).map((k) => ({ id: k.id, name: k.displayName }));
}

async function ziele(benutzerId) {
  await db.query('INSERT INTO m365_ziele (benutzer_id) VALUES ($1) ON CONFLICT DO NOTHING', [benutzerId]);
  return db.one('SELECT * FROM m365_ziele WHERE benutzer_id=$1', [benutzerId]);
}

// ---------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------

function abdruck(k) {
  return crypto.createHash('sha1').update(JSON.stringify(k)).digest('hex');
}

/**
 * Eine Aufgabe nach Planner schreiben oder dort aktualisieren.
 *
 * Planner verlangt bei jeder Aenderung das aktuelle ETag im If-Match-Kopf.
 * Ein veraltetes ETag liefert 412 — dann wird einmal frisch gelesen und
 * erneut versucht. Das ist der uebliche Weg; ein blindes Ueberschreiben
 * gibt es bei Planner nicht.
 */
async function aufgabeSchreiben(benutzerId, aufgabe) {
  const z = await ziele(benutzerId);
  if (!z || !z.plan_id) {
    const e = new Error('Es ist noch kein Planner-Plan ausgewählt.');
    e.nichtEingerichtet = true;
    throw e;
  }

  const zuordnung = await db.one(
    'SELECT * FROM m365_aufgabe_planner WHERE aufgabe_id=$1 AND benutzer_id=$2',
    [aufgabe.id, benutzerId]
  );

  const titel = String(aufgabe.text || 'Aufgabe').slice(0, 255);
  const inhalt = {
    title: titel,
    ...(aufgabe.faellig_am ? { dueDateTime: new Date(aufgabe.faellig_am).toISOString() } : {}),
    ...(aufgabe.erledigt ? { percentComplete: 100 } : { percentComplete: 0 }),
  };
  const hash = abdruck(inhalt);
  if (zuordnung && zuordnung.stand_hash === hash) return { unveraendert: true };

  if (!zuordnung) {
    const neu = await m365.graph(benutzerId, '/planner/tasks', {
      method: 'POST',
      body: JSON.stringify({
        planId: z.plan_id,
        ...(z.eimer_id ? { bucketId: z.eimer_id } : {}),
        ...inhalt,
      }),
    });
    await db.query(
      `INSERT INTO m365_aufgabe_planner (aufgabe_id, benutzer_id, planner_id, etag, stand_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [aufgabe.id, benutzerId, neu.id, neu['@odata.etag'] || null, hash]
    );
    return { angelegt: true, id: neu.id };
  }

  let etag = zuordnung.etag;
  for (let versuch = 0; versuch < 2; versuch += 1) {
    try {
      await m365.graph(benutzerId, `/planner/tasks/${encodeURIComponent(zuordnung.planner_id)}`, {
        method: 'PATCH',
        headers: { 'If-Match': etag || '*' },
        body: JSON.stringify(inhalt),
      });
      await db.query('UPDATE m365_aufgabe_planner SET stand_hash=$1, stand_am=now() WHERE id=$2',
        [hash, zuordnung.id]);
      return { aktualisiert: true };
    } catch (err) {
      const veraltet = /412|precondition/i.test(err.message);
      const weg = /404|not found|ErrorItemNotFound/i.test(err.message);
      if (weg) {
        await db.query('DELETE FROM m365_aufgabe_planner WHERE id=$1', [zuordnung.id]);
        return aufgabeSchreiben(benutzerId, aufgabe);
      }
      if (!veraltet || versuch === 1) throw err;
      const frisch = await m365.graph(benutzerId, `/planner/tasks/${encodeURIComponent(zuordnung.planner_id)}`);
      etag = frisch['@odata.etag'];
    }
  }
  return { aktualisiert: false };
}

/** Erledigt-Stand aus Planner zurueckholen. Nur diese eine Eigenschaft. */
async function erledigtHolen(benutzerId) {
  const paare = await db.all(
    `SELECT p.*, a.erledigt FROM m365_aufgabe_planner p
       JOIN aufgaben a ON a.id = p.aufgabe_id
      WHERE p.benutzer_id = $1 AND a.erledigt = FALSE`,
    [benutzerId]
  );
  let uebernommen = 0;
  for (const p of paare) {
    try {
      const t = await m365.graph(benutzerId, `/planner/tasks/${encodeURIComponent(p.planner_id)}`);
      if (Number(t.percentComplete) === 100) {
        await db.query("UPDATE aufgaben SET erledigt=TRUE, status='erledigt' WHERE id=$1", [p.aufgabe_id]);
        await db.query('UPDATE m365_aufgabe_planner SET etag=$1, stand_am=now() WHERE id=$2',
          [t['@odata.etag'] || null, p.id]);
        uebernommen += 1;
      }
    } catch (err) {
      if (/404|not found/i.test(err.message)) {
        await db.query('DELETE FROM m365_aufgabe_planner WHERE id=$1', [p.id]);
      }
    }
  }
  return uebernommen;
}

/** Alle offenen Aufgaben spiegeln. */
async function aufgabenSpiegeln(benutzerId) {
  const z = await ziele(benutzerId);
  if (!z || !z.plan_id || !z.aufgaben_spiegeln) return { aus: true, raus: 0, rein: 0 };

  const rein = await erledigtHolen(benutzerId);
  const offene = await db.all(
    `SELECT a.* FROM aufgaben a
      WHERE NOT a.planner_aus
        AND (a.erledigt = FALSE OR a.id IN (SELECT aufgabe_id FROM m365_aufgabe_planner WHERE benutzer_id=$1))
      ORDER BY a.id DESC LIMIT 200`,
    [benutzerId]
  );
  let raus = 0;
  for (const a of offene) {
    try {
      const e = await aufgabeSchreiben(benutzerId, a);
      if (e.angelegt || e.aktualisiert) raus += 1;
    } catch (err) { /* einzelne Aufgabe scheitern lassen, nicht den Lauf */ }
  }
  return { raus, rein };
}

// ---------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------

/**
 * Meldung in den gewaehlten Kanal.
 *
 * Doppelte Meldungen werden ueber m365_meldungen ausgeschlossen: Derselbe
 * Anlass zum selben Bezug geht genau einmal hinaus, auch ueber Neustarts
 * hinweg. Ein Kanal, der dieselbe Sache dreimal meldet, wird nach zwei
 * Wochen nicht mehr gelesen.
 */
async function melden(benutzerId, { anlass, bezugArt, bezugId, text, html }) {
  const z = await ziele(benutzerId);
  if (!z || !z.team_id || !z.kanal_id) return { aus: true };

  const schon = await db.one(
    'SELECT id FROM m365_meldungen WHERE anlass=$1 AND bezug_art=$2 AND bezug_id=$3 AND fehler IS NULL',
    [anlass, bezugArt, bezugId]
  );
  if (schon) return { schonGemeldet: true };

  try {
    await m365.graph(benutzerId,
      `/teams/${encodeURIComponent(z.team_id)}/channels/${encodeURIComponent(z.kanal_id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: { contentType: html ? 'html' : 'text', content: html || text },
        }),
      });
    await db.query(
      'INSERT INTO m365_meldungen (benutzer_id, anlass, bezug_art, bezug_id, text) VALUES ($1,$2,$3,$4,$5)',
      [benutzerId, anlass, bezugArt, bezugId, String(html || text).slice(0, 500)]
    );
    return { gesendet: true };
  } catch (err) {
    await db.query(
      'INSERT INTO m365_meldungen (benutzer_id, anlass, bezug_art, bezug_id, text, fehler) VALUES ($1,$2,$3,$4,$5,$6)',
      [benutzerId, anlass, bezugArt, bezugId, String(html || text).slice(0, 500), err.message.slice(0, 300)]
    );
    return { fehler: err.message };
  }
}

/**
 * Die Ereignisse, die eine Meldung wert sind — je nach Schalter.
 * Wird von der Automatik aufgerufen; sucht selbst, was seit dem letzten Mal
 * dazugekommen ist.
 */
async function meldungenPruefen(benutzerId) {
  const z = await ziele(benutzerId);
  if (!z || !z.team_id || !z.kanal_id) return 0;
  let anzahl = 0;

  if (z.melde_angebot) {
    const neue = await db.all(
      `SELECT a.id, a.nummer, a.netto, a.bauvorhaben, k.firma FROM angebote a
         JOIN kunden k ON k.id=a.kunde_id
        WHERE a.status='Versendet' AND a.geaendert_am > now() - INTERVAL '2 days'
          AND NOT EXISTS (SELECT 1 FROM m365_meldungen m
                           WHERE m.anlass='angebot_versendet' AND m.bezug_art='angebot'
                             AND m.bezug_id=a.id AND m.fehler IS NULL)
        LIMIT 20`);
    for (const a of neue) {
      const e = await melden(benutzerId, {
        anlass: 'angebot_versendet', bezugArt: 'angebot', bezugId: a.id,
        text: `Angebot ${a.nummer} an ${a.firma} versendet — ${Number(a.netto).toLocaleString('de-DE')} € netto`
          + (a.bauvorhaben ? ` (${a.bauvorhaben})` : ''),
      });
      if (e.gesendet) anzahl += 1;
    }
  }

  if (z.melde_auftrag) {
    const neue = await db.all(
      `SELECT a.id, a.nummer, a.netto, k.firma FROM angebote a
         JOIN kunden k ON k.id=a.kunde_id
        WHERE a.status='Beauftragt' AND a.geaendert_am > now() - INTERVAL '2 days'
          AND NOT EXISTS (SELECT 1 FROM m365_meldungen m
                           WHERE m.anlass='auftrag' AND m.bezug_art='angebot'
                             AND m.bezug_id=a.id AND m.fehler IS NULL)
        LIMIT 20`);
    for (const a of neue) {
      const e = await melden(benutzerId, {
        anlass: 'auftrag', bezugArt: 'angebot', bezugId: a.id,
        text: `Auftrag: ${a.firma} hat Angebot ${a.nummer} beauftragt — ${Number(a.netto).toLocaleString('de-DE')} € netto.`,
      });
      if (e.gesendet) anzahl += 1;
    }
  }

  if (z.melde_rechnung) {
    const neue = await db.all(
      `SELECT r.id, r.nummer, r.brutto, k.firma FROM rechnungen r
         JOIN kunden k ON k.id=r.kunde_id
        WHERE r.festgeschrieben AND r.festgeschrieben_am > now() - INTERVAL '2 days'
          AND NOT EXISTS (SELECT 1 FROM m365_meldungen m
                           WHERE m.anlass='rechnung' AND m.bezug_art='rechnung'
                             AND m.bezug_id=r.id AND m.fehler IS NULL)
        LIMIT 20`);
    for (const r of neue) {
      const e = await melden(benutzerId, {
        anlass: 'rechnung', bezugArt: 'rechnung', bezugId: r.id,
        text: `Rechnung ${r.nummer} an ${r.firma} festgeschrieben — ${Number(r.brutto).toLocaleString('de-DE')} € brutto.`,
      });
      if (e.gesendet) anzahl += 1;
    }
  }

  return anzahl;
}

/** Alles, was der Hintergrundlauf fuer Planner und Teams tut. */
async function alle() {
  if (!m365.eingerichtet()) return { konten: 0 };
  const konten = await db.all(
    `SELECT k.benutzer_id FROM m365_konten k
       JOIN m365_ziele z ON z.benutzer_id = k.benutzer_id
      WHERE z.plan_id IS NOT NULL OR z.kanal_id IS NOT NULL`);
  let aufgaben = 0; let meldungen = 0;
  for (const k of konten) {
    try {
      const s = await aufgabenSpiegeln(k.benutzer_id);
      aufgaben += (s.raus || 0) + (s.rein || 0);
      meldungen += await meldungenPruefen(k.benutzer_id);
    } catch (e) { /* ein Konto darf den Lauf nicht anhalten */ }
  }
  return { konten: konten.length, aufgaben, meldungen };
}

module.exports = {
  gruppen, plaene, eimer, teams, kanaele, ziele,
  aufgabeSchreiben, erledigtHolen, aufgabenSpiegeln,
  melden, meldungenPruefen, alle,
};
