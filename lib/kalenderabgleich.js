'use strict';
/**
 * Kalenderabgleich STEER.E <-> Outlook, in beide Richtungen.
 *
 * ======================================================================
 * WAS ABGEGLICHEN WIRD — UND WAS BEWUSST NICHT
 * ======================================================================
 *
 * Hinweg (STEER.E -> Outlook): jeder Termin mit Datum im Zeitfenster.
 *
 * Rueckweg (Outlook -> STEER.E): AUSSCHLIESSLICH Ereignisse, die aus
 * STEER.E stammen. Erkannt werden sie an zwei Merkmalen: der Kategorie
 * "STEER.E" und einer bestehenden Zuordnung in m365_termin_ereignis.
 *
 * Das ist keine Bequemlichkeit, sondern Absicht. Ein Postfach enthaelt
 * Arzttermine, Elterngespraeche und Privates. Waere der Rueckweg offen,
 * stuenden diese Eintraege in einer Vertriebsdatenbank, die gesichert,
 * exportiert und von Kollegen eingesehen wird — und liessen sich spaeter
 * nicht mehr zuverlaessig heraustrennen. Es gibt keinen Schalter dafuer.
 *
 * ======================================================================
 * WER GEWINNT BEI EINEM KONFLIKT
 * ======================================================================
 *
 * Wurde derselbe Termin auf beiden Seiten geaendert, gewinnt die juengere
 * Aenderung: termine.geaendert_am gegen lastModifiedDateTime aus Graph.
 * Die unterlegene Fassung geht nicht still verloren — sie steht in
 * m365_abgleich_protokoll, mit Zeitpunkt und Richtung.
 *
 * Eine Absage in Outlook loescht den Termin hier NICHT. Sie setzt ihn auf
 * "abgesagt" und haelt den Zeitpunkt fest. Loeschen ist eine Entscheidung
 * des Anwenders, nicht die Nebenwirkung eines Hintergrundlaufs.
 */

const db = require('./db');
const m365 = require('./m365');

const KATEGORIE = 'STEER.E';

// ---------------------------------------------------------------------
// Hilfsmittel
// ---------------------------------------------------------------------

function zwei(n) { return String(n).padStart(2, '0'); }

/** Datum als YYYY-MM-DD, unabhaengig von der Zeitzone des Servers. */
function tagText(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${zwei(x.getMonth() + 1)}-${zwei(x.getDate())}`;
}

/**
 * Uhrzeit aus dem freien Textfeld lesen.
 * Bewusst konservativ: Was nicht eindeutig ist, gilt als ganztaegig. Ein
 * geratener Termin um 9 Uhr ist schlimmer als ein ganztaegiger Eintrag.
 */
function zeitLesen(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = s.match(/(\d{1,2})\s*(?::|\.|h|Uhr)?\s*(\d{2})?/i);
  if (!m) return null;
  const stunde = Number(m[1]);
  const minute = m[2] == null ? 0 : Number(m[2]);
  if (!Number.isInteger(stunde) || stunde < 0 || stunde > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { stunde, minute };
}

function endzeitLesen(text) {
  const m = String(text || '').match(/(?:bis|-|–|—)\s*(\d{1,2})\s*(?::|\.|h|Uhr)?\s*(\d{2})?/i);
  if (!m) return null;
  const stunde = Number(m[1]);
  const minute = m[2] == null ? 0 : Number(m[2]);
  if (stunde < 0 || stunde > 23 || minute < 0 || minute > 59) return null;
  return { stunde, minute };
}

/** Beginn und Ende als Ortszeit-Zeichenketten fuer Graph. */
function zeiten(datum, uhrzeit, endeUhrzeit, dauerMinuten = 60) {
  const tag = tagText(datum);
  const von = zeitLesen(uhrzeit);
  if (!von) return { ganztags: true, beginn: tag, ende: tag };

  const bis = endzeitLesen(uhrzeit) || zeitLesen(endeUhrzeit);
  let endStunde; let endMinute;
  if (bis) {
    endStunde = bis.stunde; endMinute = bis.minute;
  } else {
    const gesamt = von.stunde * 60 + von.minute + dauerMinuten;
    endStunde = Math.floor(gesamt / 60) % 24; endMinute = gesamt % 60;
  }
  return {
    ganztags: false,
    beginn: `${tag}T${zwei(von.stunde)}:${zwei(von.minute)}:00`,
    ende: `${tag}T${zwei(endStunde)}:${zwei(endMinute)}:00`,
  };
}

/**
 * Fingerabdruck des zu sendenden Inhalts.
 * Nur wenn er sich aendert, wird geschrieben — sonst bekaeme jeder
 * Teilnehmer bei jedem Lauf eine Aenderungsmail.
 */
function abdruck(k) {
  return JSON.stringify([k.subject, k.start.dateTime, k.end.dateTime, k.isAllDay,
    k.location ? k.location.displayName : null, k.body.content,
    (k.attendees || []).map((a) => a.emailAddress.address).sort()]);
}

async function protokoll(benutzerId, terminId, richtung, vorgang, hinweis = null) {
  await db.query(
    `INSERT INTO m365_abgleich_protokoll (benutzer_id, termin_id, richtung, vorgang, hinweis)
     VALUES ($1,$2,$3,$4,$5)`,
    [benutzerId, terminId, richtung, vorgang, hinweis]
  );
}

async function fenster() {
  const e = await db.all(
    `SELECT schluessel, wert FROM einstellungen
      WHERE schluessel IN ('kalender_fenster_tage_zurueck','kalender_fenster_tage_voraus')`
  );
  const w = Object.fromEntries(e.map((x) => [x.schluessel, Number(x.wert)]));
  const zurueck = Number.isFinite(w.kalender_fenster_tage_zurueck) ? w.kalender_fenster_tage_zurueck : 30;
  const voraus = Number.isFinite(w.kalender_fenster_tage_voraus) ? w.kalender_fenster_tage_voraus : 365;
  const von = new Date(); von.setDate(von.getDate() - zurueck);
  const bis = new Date(); bis.setDate(bis.getDate() + voraus);
  return { von, bis };
}

// ---------------------------------------------------------------------
// Hinweg: STEER.E -> Outlook
// ---------------------------------------------------------------------

/** Ereigniskoerper aus einem Termin bauen. */
function koerperBauen(t, mitGast) {
  const z = zeiten(t.datum, t.uhrzeit, t.ende_uhrzeit);
  return {
    subject: `${t.typ}: ${t.firma}${t.thema ? ' — ' + t.thema : ''}`,
    body: {
      contentType: 'text',
      content: [
        t.thema ? `Thema: ${t.thema}` : null,
        t.mit_wem ? `Mit: ${t.mit_wem}` : null,
        `Kunde: ${t.firma}`,
        '',
        'Dieser Termin wird mit STEER.E abgeglichen. Änderungen an Zeit, Ort',
        'und Titel gelten in beide Richtungen.',
      ].filter((x) => x !== null).join('\n'),
    },
    start: z.ganztags
      ? { dateTime: `${z.beginn}T00:00:00`, timeZone: 'Europe/Berlin' }
      : { dateTime: z.beginn, timeZone: 'Europe/Berlin' },
    end: z.ganztags
      ? { dateTime: `${z.ende}T00:00:00`, timeZone: 'Europe/Berlin' }
      : { dateTime: z.ende, timeZone: 'Europe/Berlin' },
    isAllDay: z.ganztags,
    location: (t.ort || t.adresse) ? { displayName: t.ort || t.adresse } : undefined,
    // Die Kategorie ist das Erkennungsmerkmal fuer den Rueckweg. Ohne sie
    // waere ein Ereignis, dessen Zuordnung verloren ging, nicht mehr von
    // einem privaten Eintrag zu unterscheiden.
    categories: [KATEGORIE],
    attendees: mitGast && t.ap_email
      ? [{ emailAddress: { address: t.ap_email, name: t.ap_name || t.ap_email }, type: 'required' }]
      : [],
  };
}

async function hinweg(benutzerId, { von, bis }) {
  const termine = await db.all(
    `SELECT t.*, k.firma, k.adresse,
            (SELECT a.email FROM ansprechpartner a WHERE a.kunde_id = k.id
              AND a.email IS NOT NULL AND a.email <> '' ORDER BY a.id LIMIT 1) AS ap_email,
            (SELECT a.name FROM ansprechpartner a WHERE a.kunde_id = k.id
              AND a.email IS NOT NULL AND a.email <> '' ORDER BY a.id LIMIT 1) AS ap_name,
            z.ereignis_id, z.stand_hash
       FROM termine t
       JOIN kunden k ON k.id = t.kunde_id
       LEFT JOIN m365_termin_ereignis z ON z.termin_id = t.id AND z.benutzer_id = $1
      WHERE t.datum BETWEEN $2::date AND $3::date
        AND NOT t.kalender_aus`,
    [benutzerId, tagText(von), tagText(bis)]
  );

  let geschrieben = 0;
  for (const t of termine) {
    // Ein abgesagter Termin, der noch nie im Kalender stand, kommt auch
    // nicht mehr hinein.
    if (t.status === 'abgesagt' && !t.ereignis_id) continue;

    const koerper = koerperBauen(t, false);
    if (t.status === 'abgesagt') koerper.subject = `Abgesagt: ${koerper.subject}`;
    const hash = abdruck(koerper);
    if (t.ereignis_id && t.stand_hash === hash) continue; // nichts Neues

    try {
      let ereignis;
      if (t.ereignis_id) {
        try {
          ereignis = await m365.graph(benutzerId, `/me/events/${encodeURIComponent(t.ereignis_id)}`,
            { method: 'PATCH', body: JSON.stringify(koerper) });
        } catch (err) {
          if (!/not found|ErrorItemNotFound/i.test(err.message)) throw err;
          // Im Kalender geloescht: Zuordnung wegwerfen und neu anlegen.
          await db.query('DELETE FROM m365_termin_ereignis WHERE termin_id=$1 AND benutzer_id=$2',
            [t.id, benutzerId]);
          ereignis = await m365.graph(benutzerId, '/me/events',
            { method: 'POST', body: JSON.stringify(koerper) });
          await protokoll(benutzerId, t.id, 'raus', 'neu_angelegt',
            'Das Ereignis war im Kalender nicht mehr vorhanden und wurde neu angelegt.');
        }
      } else {
        ereignis = await m365.graph(benutzerId, '/me/events',
          { method: 'POST', body: JSON.stringify(koerper) });
      }

      if (ereignis && ereignis.id) {
        await db.query(
          `INSERT INTO m365_termin_ereignis (termin_id, benutzer_id, ereignis_id, etag, stand_hash, stand_am)
           VALUES ($1,$2,$3,$4,$5, now())
           ON CONFLICT (termin_id, benutzer_id) DO UPDATE SET
             ereignis_id = EXCLUDED.ereignis_id, etag = EXCLUDED.etag,
             stand_hash = EXCLUDED.stand_hash, stand_am = now()`,
          [t.id, benutzerId, ereignis.id, ereignis['@odata.etag'] || null, hash]
        );
        // Die alte Spalte bleibt gefuellt, damit der Einzelknopf in der
        // Terminliste weiter funktioniert.
        await db.query('UPDATE termine SET m365_ereignis_id=$1, m365_stand_am=now() WHERE id=$2',
          [ereignis.id, t.id]);
        geschrieben += 1;
      }
    } catch (err) {
      await protokoll(benutzerId, t.id, 'raus', 'fehlgeschlagen', err.message.slice(0, 300));
    }
  }
  return geschrieben;
}

// ---------------------------------------------------------------------
// Rueckweg: Outlook -> STEER.E
// ---------------------------------------------------------------------

/** Ortszeit aus einer Graph-Zeitangabe. Graph liefert ohne Zonensuffix. */
function grafZeit(wert) {
  if (!wert || !wert.dateTime) return null;
  const roh = String(wert.dateTime).replace(/(\.\d+)?Z?$/, '');
  const m = roh.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return { datum: `${m[1]}-${m[2]}-${m[3]}`, stunde: m[4], minute: m[5] };
}

async function rueckweg(benutzerId, { von, bis }) {
  const zustand = await db.one('SELECT delta_link FROM m365_abgleich WHERE benutzer_id=$1', [benutzerId]);

  let pfad = zustand && zustand.delta_link
    ? zustand.delta_link.replace('https://graph.microsoft.com/v1.0', '')
    : `/me/calendarView/delta?startDateTime=${von.toISOString()}&endDateTime=${bis.toISOString()}`;

  let uebernommen = 0;
  let neuerDelta = null;
  let seiten = 0;

  // Graph liefert seitenweise. Die Schleife ist begrenzt: ein kaputter
  // Folgeverweis soll den Hintergrundlauf nicht endlos beschaeftigen.
  while (pfad && seiten < 50) {
    seiten += 1;
    const antwort = await m365.graph(benutzerId, pfad, {
      headers: { Prefer: 'outlook.timezone="Europe/Berlin", odata.maxpagesize=100' },
    });

    for (const ereignis of antwort.value || []) {
      const zuordnung = await db.one(
        `SELECT z.*, t.geaendert_am, t.status, t.datum, t.uhrzeit, t.ort, t.thema
           FROM m365_termin_ereignis z JOIN termine t ON t.id = z.termin_id
          WHERE z.benutzer_id=$1 AND z.ereignis_id=$2`,
        [benutzerId, ereignis.id]
      );

      // Geloescht in Outlook -> hier absagen, nicht loeschen.
      if (ereignis['@removed']) {
        if (zuordnung && zuordnung.status !== 'abgesagt') {
          await db.query(
            "UPDATE termine SET status='abgesagt', abgesagt_am=now() WHERE id=$1",
            [zuordnung.termin_id]
          );
          await db.query('DELETE FROM m365_termin_ereignis WHERE id=$1', [zuordnung.id]);
          await protokoll(benutzerId, zuordnung.termin_id, 'rein', 'abgesagt',
            'Der Termin wurde im Outlook-Kalender gelöscht. Er ist hier als abgesagt vermerkt, nicht entfernt.');
          uebernommen += 1;
        }
        continue;
      }

      // Kein zugehoeriger Termin und keine Kategorie -> fremder Eintrag,
      // geht uns nichts an.
      if (!zuordnung) continue;

      const kategorien = ereignis.categories || [];
      if (kategorien.length && !kategorien.includes(KATEGORIE)) {
        // Die Kategorie wurde im Kalender entfernt: der Anwender will diesen
        // Eintrag offenbar nicht mehr abgeglichen haben. Zuordnung loesen.
        await db.query('DELETE FROM m365_termin_ereignis WHERE id=$1', [zuordnung.id]);
        await db.query('UPDATE termine SET kalender_aus=TRUE WHERE id=$1', [zuordnung.termin_id]);
        await protokoll(benutzerId, zuordnung.termin_id, 'rein', 'entkoppelt',
          'Die Kategorie STEER.E wurde im Kalender entfernt. Der Termin wird nicht mehr abgeglichen. '
          + 'Rückgängig über den Haken „Mit Outlook abgleichen" am Termin.');
        continue;
      }

      // Wer ist juenger?
      const fremdStand = ereignis.lastModifiedDateTime ? new Date(ereignis.lastModifiedDateTime) : null;
      const eigenStand = zuordnung.geaendert_am ? new Date(zuordnung.geaendert_am) : null;
      if (fremdStand && eigenStand && eigenStand > fremdStand) {
        await protokoll(benutzerId, zuordnung.termin_id, 'rein', 'verworfen',
          'In STEER.E wurde später geändert als in Outlook. Der Stand hier bleibt und wird beim nächsten Lauf hinausgeschrieben.');
        continue;
      }

      const beginn = grafZeit(ereignis.start);
      if (!beginn) continue;

      const ganztags = !!ereignis.isAllDay;
      const uhrzeit = ganztags ? null : `${beginn.stunde}:${beginn.minute}`;
      const ort = (ereignis.location && ereignis.location.displayName) || null;

      const gleich = zuordnung.datum && tagText(zuordnung.datum) === beginn.datum
        && (zuordnung.uhrzeit || null) === uhrzeit
        && (zuordnung.ort || null) === (ort || null);
      if (gleich) continue;

      await db.query(
        `UPDATE termine SET datum=$1::date, uhrzeit=COALESCE($2, uhrzeit), ort=COALESCE($3, ort)
          WHERE id=$4`,
        [beginn.datum, uhrzeit, ort, zuordnung.termin_id]
      );
      /*
       * Den Fingerabdruck sofort auf den neuen Stand ziehen. Sonst faende
       * der naechste Hinweg einen Unterschied zum zuletzt Gesendeten und
       * schriebe denselben Inhalt noch einmal nach Outlook — jedes Mal mit
       * einer Aenderungsbenachrichtigung an alle Teilnehmer.
       */
      const frisch = await db.one(
        `SELECT t.*, k.firma, k.adresse, NULL::text AS ap_email, NULL::text AS ap_name
           FROM termine t JOIN kunden k ON k.id = t.kunde_id WHERE t.id = $1`,
        [zuordnung.termin_id]
      );
      await db.query('UPDATE m365_termin_ereignis SET stand_hash=$2, stand_am=now() WHERE id=$1',
        [zuordnung.id, frisch ? abdruck(koerperBauen(frisch, false)) : null]);
      await protokoll(benutzerId, zuordnung.termin_id, 'rein', 'uebernommen',
        `Aus Outlook: ${beginn.datum}${uhrzeit ? ' ' + uhrzeit : ' (ganztägig)'}${ort ? ', ' + ort : ''}`);
      uebernommen += 1;
    }

    if (antwort['@odata.nextLink']) {
      pfad = antwort['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '');
    } else {
      neuerDelta = antwort['@odata.deltaLink'] || null;
      pfad = null;
    }
  }

  if (neuerDelta) {
    await db.query('UPDATE m365_abgleich SET delta_link=$1 WHERE benutzer_id=$2', [neuerDelta, benutzerId]);
  }
  return uebernommen;
}

// ---------------------------------------------------------------------
// Lauf
// ---------------------------------------------------------------------

/** Einen Benutzer abgleichen. Wirft nicht — Fehler landen im Zustand. */
async function fuerBenutzer(benutzerId) {
  await db.query(
    'INSERT INTO m365_abgleich (benutzer_id) VALUES ($1) ON CONFLICT (benutzer_id) DO NOTHING',
    [benutzerId]
  );
  const z = await db.one('SELECT * FROM m365_abgleich WHERE benutzer_id=$1', [benutzerId]);
  if (!z.aktiv) return { aus: true, raus: 0, rein: 0 };

  const f = await fenster();
  let raus = 0; let rein = 0;

  try {
    // Erst zurueck, dann hinaus. Andersherum wuerde der Hinweg eine gerade
    // in Outlook gemachte Aenderung ueberschreiben, bevor sie hier ankommt.
    if (z.richtung !== 'raus') rein = await rueckweg(benutzerId, f);
    if (z.richtung !== 'rein') raus = await hinweg(benutzerId, f);

    await db.query(
      `UPDATE m365_abgleich SET zuletzt_am=now(), letzter_fehler=NULL,
              letzter_lauf=$2, anz_raus=anz_raus+$3, anz_rein=anz_rein+$4
        WHERE benutzer_id=$1`,
      [benutzerId, `${rein} herein, ${raus} hinaus`, raus, rein]
    );
    return { raus, rein };
  } catch (err) {
    // Ein abgelaufener Delta-Verweis ist kein Fehler, sondern eine
    // Aufforderung: Graph verlangt dann einen vollstaendigen Durchlauf.
    if (/resync|deltatoken|SyncStateNotFound/i.test(err.message)) {
      await db.query('UPDATE m365_abgleich SET delta_link=NULL WHERE benutzer_id=$1', [benutzerId]);
    }
    await db.query(
      'UPDATE m365_abgleich SET zuletzt_am=now(), letzter_fehler=$2 WHERE benutzer_id=$1',
      [benutzerId, err.message.slice(0, 300)]
    );
    return { raus, rein, fehler: err.message };
  }
}

/** Alle verbundenen Konten abgleichen — das macht die Automatik. */
async function alle() {
  if (!m365.eingerichtet()) return { konten: 0, raus: 0, rein: 0 };
  const konten = await db.all('SELECT benutzer_id FROM m365_konten');
  let raus = 0; let rein = 0;
  for (const k of konten) {
    const e = await fuerBenutzer(k.benutzer_id);
    raus += e.raus || 0; rein += e.rein || 0;
  }
  return { konten: konten.length, raus, rein };
}

async function zustand(benutzerId) {
  return db.one('SELECT * FROM m365_abgleich WHERE benutzer_id=$1', [benutzerId]);
}

async function letzteVorgaenge(benutzerId, anzahl = 20) {
  return db.all(
    `SELECT p.*, t.thema, k.firma
       FROM m365_abgleich_protokoll p
       LEFT JOIN termine t ON t.id = p.termin_id
       LEFT JOIN kunden k ON k.id = t.kunde_id
      WHERE p.benutzer_id = $1 ORDER BY p.am DESC LIMIT $2`,
    [benutzerId, anzahl]
  );
}

module.exports = {
  KATEGORIE, fuerBenutzer, alle, zustand, letzteVorgaenge,
  zeiten, zeitLesen, endzeitLesen, tagText, abdruck, koerperBauen,
};
