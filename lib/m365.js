'use strict';
/**
 * Microsoft 365 über Graph.
 *
 * Zwei Dinge, die diese Anbindung von der Kalenderdatei-Lösung
 * unterscheidet: Termine landen unmittelbar im Outlook-Kalender, und Mails
 * gehen mit Anhang aus der Anwendung heraus.
 *
 * Grundsätze:
 *
 *  - Die Verbindung gehört einem Benutzer, nicht der Anwendung. Gesendet
 *    wird unter seinem Namen, aus seinem Postfach.
 *  - Es werden nur delegierte Berechtigungen verlangt, keine
 *    anwendungsweiten. Die Anwendung kommt damit ausschliesslich an das
 *    Postfach dessen, der sich angemeldet hat — nicht an das der ganzen
 *    Organisation.
 *  - Ohne die drei Umgebungsvariablen ist die Anbindung schlicht aus. Die
 *    Anwendung laeuft unveraendert weiter, die Kalenderdatei-Knoepfe
 *    bleiben.
 */

const crypto = require('crypto');
const db = require('./db');

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Delegierte Berechtigungen. Bewusst knapp gehalten:
 *   Calendars.ReadWrite  Termine anlegen und aendern
 *   Mail.Send            Mails im Namen des Benutzers senden
 *   User.Read            eigener Name und Adresse, fuer die Anzeige
 *   offline_access       Erneuerungstoken, sonst waere nach einer Stunde Schluss
 * Mail.Read ist NICHT dabei — die Anwendung liest keine Postfaecher.
 */
const BEREICHE = ['offline_access', 'User.Read', 'Calendars.ReadWrite', 'Mail.Send'];

function einstellungen() {
  return {
    kennung: process.env.M365_CLIENT_ID || null,
    geheimnis: process.env.M365_CLIENT_SECRET || null,
    mandant: process.env.M365_TENANT || 'organizations',
  };
}

/** Ist die Anbindung überhaupt eingerichtet? */
function eingerichtet() {
  const e = einstellungen();
  return !!(e.kennung && e.geheimnis);
}

/** Rückgabeadresse aus der Anfrage — muss in Entra exakt so hinterlegt sein. */
function rueckgabeAdresse(req) {
  if (process.env.M365_REDIRECT) return process.env.M365_REDIRECT;
  const protokoll = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${protokoll}://${req.get('host')}/m365/rueckgabe`;
}

function basis() {
  return `https://login.microsoftonline.com/${einstellungen().mandant}/oauth2/v2.0`;
}

// ---------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------

/** Anmeldeadresse bauen und den Zustandswert vormerken. */
async function anmeldeAdresse(req, benutzerId, zurueckZu = '/verwaltung/m365') {
  const zustand = crypto.randomBytes(24).toString('hex');
  await db.query('DELETE FROM m365_anmeldungen WHERE angelegt_am < now() - INTERVAL \'20 minutes\'');
  await db.query(
    'INSERT INTO m365_anmeldungen (zustand, benutzer_id, zurueck_zu) VALUES ($1,$2,$3)',
    [zustand, benutzerId, zurueckZu]
  );
  const p = new URLSearchParams({
    client_id: einstellungen().kennung,
    response_type: 'code',
    redirect_uri: rueckgabeAdresse(req),
    response_mode: 'query',
    scope: BEREICHE.join(' '),
    state: zustand,
    prompt: 'select_account',
  });
  return `${basis()}/authorize?${p.toString()}`;
}

async function tokenHolen(koerper) {
  const antwort = await fetch(`${basis()}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(koerper).toString(),
  });
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok) {
    const grund = daten.error_description || daten.error || `HTTP ${antwort.status}`;
    throw new Error(String(grund).split('\n')[0].slice(0, 300));
  }
  return daten;
}

/** Rückmeldung von Microsoft verarbeiten und das Konto speichern. */
async function rueckgabeVerarbeiten(req, code, zustand) {
  const vorgang = await db.one('SELECT * FROM m365_anmeldungen WHERE zustand = $1', [zustand]);
  if (!vorgang) throw new Error('Der Anmeldevorgang ist unbekannt oder abgelaufen. Bitte erneut verbinden.');
  await db.query('DELETE FROM m365_anmeldungen WHERE zustand = $1', [zustand]);

  const e = einstellungen();
  const t = await tokenHolen({
    client_id: e.kennung, client_secret: e.geheimnis,
    grant_type: 'authorization_code', code,
    redirect_uri: rueckgabeAdresse(req), scope: BEREICHE.join(' '),
  });

  // Wer ist das? Der Name steht spaeter als Absender in der Anzeige.
  let wer = {};
  try {
    const a = await fetch(`${GRAPH}/me`, { headers: { authorization: `Bearer ${t.access_token}` } });
    if (a.ok) wer = await a.json();
  } catch (x) { /* Anzeige ist nebensaechlich, die Verbindung zaehlt */ }

  await db.query(
    `INSERT INTO m365_konten (benutzer_id, konto_email, konto_name, zugriff_token, erneuer_token,
                              laeuft_ab_am, bereiche, verbunden_am, letzter_fehler)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval, $7, now(), NULL)
     ON CONFLICT (benutzer_id) DO UPDATE SET
       konto_email = EXCLUDED.konto_email, konto_name = EXCLUDED.konto_name,
       zugriff_token = EXCLUDED.zugriff_token, erneuer_token = EXCLUDED.erneuer_token,
       laeuft_ab_am = EXCLUDED.laeuft_ab_am, bereiche = EXCLUDED.bereiche,
       verbunden_am = now(), letzter_fehler = NULL`,
    [vorgang.benutzer_id, wer.mail || wer.userPrincipalName || null, wer.displayName || null,
     t.access_token, t.refresh_token || null, String(t.expires_in || 3600), BEREICHE.join(' ')]
  );

  return { benutzerId: vorgang.benutzer_id, zurueckZu: vorgang.zurueck_zu || '/verwaltung/m365' };
}

/** Gültiges Zugriffstoken, notfalls erneuert. */
async function token(benutzerId) {
  const k = await db.one('SELECT * FROM m365_konten WHERE benutzer_id = $1', [benutzerId]);
  if (!k) return null;

  // Eine Minute Puffer: ein Token, das waehrend des Aufrufs ablaeuft, ist wertlos.
  const frisch = k.laeuft_ab_am && new Date(k.laeuft_ab_am).getTime() - 60000 > Date.now();
  if (frisch && k.zugriff_token) return k.zugriff_token;
  if (!k.erneuer_token) return null;

  const e = einstellungen();
  try {
    const t = await tokenHolen({
      client_id: e.kennung, client_secret: e.geheimnis,
      grant_type: 'refresh_token', refresh_token: k.erneuer_token, scope: BEREICHE.join(' '),
    });
    await db.query(
      `UPDATE m365_konten SET zugriff_token = $1, erneuer_token = COALESCE($2, erneuer_token),
              laeuft_ab_am = now() + ($3 || ' seconds')::interval, letzter_fehler = NULL
        WHERE benutzer_id = $4`,
      [t.access_token, t.refresh_token || null, String(t.expires_in || 3600), benutzerId]
    );
    return t.access_token;
  } catch (err) {
    // Ein abgelaufenes Erneuerungstoken ist kein Programmfehler, sondern
    // ein Zustand: der Benutzer muss sich neu verbinden. Also festhalten
    // statt die aufrufende Stelle mit einem Absturz zu belasten.
    await db.query('UPDATE m365_konten SET letzter_fehler = $1 WHERE benutzer_id = $2',
      [err.message, benutzerId]);
    return null;
  }
}

async function konto(benutzerId) {
  return db.one(
    `SELECT benutzer_id, konto_email, konto_name, verbunden_am, zuletzt_am, letzter_fehler,
            (laeuft_ab_am > now()) AS token_gueltig
       FROM m365_konten WHERE benutzer_id = $1`, [benutzerId]
  );
}

async function trennen(benutzerId) {
  await db.query('DELETE FROM m365_konten WHERE benutzer_id = $1', [benutzerId]);
}

// ---------------------------------------------------------------------
// Graph-Aufrufe
// ---------------------------------------------------------------------

async function graph(benutzerId, pfad, optionen = {}) {
  const t = await token(benutzerId);
  if (!t) {
    const err = new Error('Keine gültige Verbindung zu Microsoft 365. Bitte in der Verwaltung neu verbinden.');
    err.nichtVerbunden = true;
    throw err;
  }
  const antwort = await fetch(GRAPH + pfad, {
    ...optionen,
    headers: {
      authorization: `Bearer ${t}`,
      'content-type': 'application/json',
      ...(optionen.headers || {}),
    },
  });
  await db.query('UPDATE m365_konten SET zuletzt_am = now() WHERE benutzer_id = $1', [benutzerId]);

  if (antwort.status === 204) return {};
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok) {
    const m = (daten.error && daten.error.message) || `HTTP ${antwort.status}`;
    throw new Error(String(m).slice(0, 300));
  }
  return daten;
}

/**
 * Termin in den Kalender schreiben oder aktualisieren.
 * Zeiten werden als Ortszeit mit Zeitzone uebergeben — Graph rechnet um.
 */
async function terminSchreiben(benutzerId, {
  ereignisId, titel, beginn, ende, ganztags, ort, beschreibung, teilnehmer = [],
}) {
  const koerper = {
    subject: titel || 'Termin',
    body: { contentType: 'text', content: beschreibung || '' },
    start: ganztags
      ? { dateTime: `${beginn}T00:00:00`, timeZone: 'Europe/Berlin' }
      : { dateTime: beginn, timeZone: 'Europe/Berlin' },
    end: ganztags
      ? { dateTime: `${ende}T00:00:00`, timeZone: 'Europe/Berlin' }
      : { dateTime: ende, timeZone: 'Europe/Berlin' },
    isAllDay: !!ganztags,
    location: ort ? { displayName: ort } : undefined,
    attendees: teilnehmer.filter((t) => t && t.email).map((t) => ({
      emailAddress: { address: t.email, name: t.name || t.email },
      type: 'required',
    })),
  };

  if (ereignisId) {
    try {
      return await graph(benutzerId, `/me/events/${encodeURIComponent(ereignisId)}`,
        { method: 'PATCH', body: JSON.stringify(koerper) });
    } catch (e) {
      // Im Kalender geloescht: dann neu anlegen statt zu scheitern.
      if (!/not found|ErrorItemNotFound/i.test(e.message)) throw e;
    }
  }
  return graph(benutzerId, '/me/events', { method: 'POST', body: JSON.stringify(koerper) });
}

/** Grenze für Anhänge im einfachen Versand — darüber verlangt Graph eine Sitzung. */
const ANHANG_GRENZE = 3 * 1024 * 1024;

/**
 * Mail senden. Der Anhang kommt als Base64 aus dem Browser; die Anwendung
 * erzeugt selbst kein PDF — dafuer braeuchte es einen Renderer im Container,
 * und der waere fuer diesen einen Zweck zu teuer erkauft.
 */
async function mailSenden(benutzerId, { an, kopie, betreff, text, anhang }) {
  const empfaenger = String(an || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  if (!empfaenger.length) throw new Error('Ohne Empfänger keine Mail.');

  const nachricht = {
    subject: betreff || '(ohne Betreff)',
    body: { contentType: 'text', content: text || '' },
    toRecipients: empfaenger.map((a) => ({ emailAddress: { address: a } })),
  };
  if (kopie) {
    nachricht.ccRecipients = String(kopie).split(/[;,]/).map((x) => x.trim()).filter(Boolean)
      .map((a) => ({ emailAddress: { address: a } }));
  }
  if (anhang && anhang.inhalt) {
    const roh = Buffer.from(anhang.inhalt, 'base64');
    if (roh.length > ANHANG_GRENZE) {
      throw new Error(`Der Anhang ist ${(roh.length / 1024 / 1024).toFixed(1)} MB groß. `
        + `Über ${(ANHANG_GRENZE / 1024 / 1024).toFixed(0)} MB nimmt dieser Weg ihn nicht an — `
        + 'bitte das PDF verkleinern oder die Mail aus Outlook heraus senden.');
    }
    nachricht.attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: anhang.name || 'Anhang.pdf',
      contentType: anhang.typ || 'application/pdf',
      contentBytes: anhang.inhalt,
    }];
  }

  await graph(benutzerId, '/me/sendMail', {
    method: 'POST',
    body: JSON.stringify({ message: nachricht, saveToSentItems: true }),
  });
  return { an: empfaenger.join(', '), betreff: nachricht.subject };
}

module.exports = {
  BEREICHE, eingerichtet, einstellungen, rueckgabeAdresse,
  anmeldeAdresse, rueckgabeVerarbeiten, token, konto, trennen,
  graph, terminSchreiben, mailSenden, ANHANG_GRENZE,
};
