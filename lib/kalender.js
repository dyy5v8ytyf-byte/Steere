'use strict';
/**
 * Kalendereintraege und vorbereitete E-Mails.
 *
 * Bewusst ohne Anbindung an Microsoft: Die Anwendung erzeugt eine
 * Kalenderdatei (.ics) und einen mailto-Verweis, den Outlook oeffnet. Das
 * kostet keine App-Registrierung, keine Anmeldung, keine Freigabe durch
 * einen Administrator und keinen Eintrag ins Verarbeitungsverzeichnis —
 * es verlaesst die Anwendung nichts, was der Anwender nicht selbst
 * abschickt.
 *
 * Der Preis dafuer ist Ehrlichkeit ueber die Grenze: Es ist eine
 * Einbahnstrasse. Was im Outlook-Kalender steht, sieht die Anwendung nicht,
 * und ein Anhang laesst sich so nicht mitgeben.
 */

const h = require('./helfer');

// ---------------------------------------------------------------------
// Uhrzeit aus einem Textfeld
// ---------------------------------------------------------------------

/**
 * Die Uhrzeit steht als Freitext in der Datenbank, weil im Alltag alles
 * moegliche eingetippt wird. Erkannt wird, was sich sicher erkennen laesst;
 * alles andere wird ein Ganztagestermin. Lieber ein Termin ohne Uhrzeit als
 * einer zur falschen Stunde.
 */
function zeitLesen(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  // 14:00 / 14.00 / 14:00-16:00 / 9 Uhr / 09h30
  const m = s.match(/(\d{1,2})\s*(?::|\.|h|Uhr)?\s*(\d{2})?/i);
  if (!m) return null;
  const stunde = Number(m[1]);
  const minute = m[2] == null ? 0 : Number(m[2]);
  if (!Number.isInteger(stunde) || stunde < 0 || stunde > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  // "halb zehn" und ähnliches wird bewusst nicht geraten.
  return { stunde, minute };
}

/** Endzeit aus einem Bereich wie "14:00-16:30", sonst null. */
function endzeitLesen(text) {
  const s = String(text || '');
  const m = s.match(/(?:bis|-|–|—)\s*(\d{1,2})\s*(?::|\.|h|Uhr)?\s*(\d{2})?/i);
  if (!m) return null;
  const stunde = Number(m[1]);
  const minute = m[2] == null ? 0 : Number(m[2]);
  if (stunde < 0 || stunde > 23 || minute < 0 || minute > 59) return null;
  return { stunde, minute };
}

// ---------------------------------------------------------------------
// ICS-Bausteine
// ---------------------------------------------------------------------

function zwei(n) { return String(n).padStart(2, '0'); }

/** Datum als YYYYMMDD, aus Date oder ISO-Zeichenkette. */
function tag(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}${zwei(x.getMonth() + 1)}${zwei(x.getDate())}`;
}

/** Ortszeit ohne Zeitzonenangabe — gilt zusammen mit TZID Europe/Berlin. */
function ortszeit(d, stunde, minute) {
  return `${tag(d)}T${zwei(stunde)}${zwei(minute)}00`;
}

/** Zeitstempel in UTC fuer DTSTAMP. */
function jetztUtc() {
  const n = new Date();
  return `${n.getUTCFullYear()}${zwei(n.getUTCMonth() + 1)}${zwei(n.getUTCDate())}`
    + `T${zwei(n.getUTCHours())}${zwei(n.getUTCMinutes())}${zwei(n.getUTCSeconds())}Z`;
}

/** Text nach RFC 5545 maskieren. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Zeilen auf 75 Oktette umbrechen. Outlook ist da nachsichtig, andere
 * Kalender sind es nicht — und eine Datei, die nur in Outlook funktioniert,
 * waere genau die Abhaengigkeit, die wir vermeiden wollen.
 */
function falten(zeile) {
  const roh = Buffer.from(zeile, 'utf8');
  if (roh.length <= 75) return zeile;
  const teile = [];
  let start = 0;
  while (start < roh.length) {
    let ende = Math.min(start + (start === 0 ? 75 : 74), roh.length);
    // Nicht mitten in ein Mehrbyte-Zeichen schneiden.
    while (ende > start && ende < roh.length && (roh[ende] & 0xc0) === 0x80) ende -= 1;
    teile.push((start === 0 ? '' : ' ') + roh.slice(start, ende).toString('utf8'));
    start = ende;
  }
  return teile.join('\r\n');
}

/**
 * Die Zeitzonendefinition wird mitgeliefert, damit ein Termin auch dann
 * richtig steht, wenn der Kalender Europe/Berlin nicht selbst kennt.
 */
const ZEITZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/**
 * Eine Kalenderdatei bauen.
 *
 * @param {object} e
 *   kennung      stabile Kennung, damit eine erneute Datei denselben Termin
 *                aktualisiert statt einen zweiten anzulegen
 *   datum        Date oder ISO-Zeichenkette
 *   uhrzeit      Freitext, z. B. "14:00" oder "14:00-16:00"
 *   dauerMin     Vorgabedauer, wenn keine Endzeit erkennbar ist
 *   titel, ort, beschreibung
 *   einladung    true = METHOD:REQUEST mit Teilnehmern
 *   organisator  { name, email }
 *   teilnehmer   [{ name, email }]
 */
function datei(e) {
  const stand = Number.isInteger(e.stand) ? e.stand : 0;
  const zeit = zeitLesen(e.uhrzeit);
  const ende = endzeitLesen(e.uhrzeit);
  const dauer = Number(e.dauerMin) > 0 ? Number(e.dauerMin) : 60;

  const zeilen = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Westphal Wavetec//STEER.E//DE',
    'CALSCALE:GREGORIAN',
    `METHOD:${e.einladung ? 'REQUEST' : 'PUBLISH'}`,
    ...ZEITZONE,
    'BEGIN:VEVENT',
    `UID:${e.kennung}`,
    `DTSTAMP:${jetztUtc()}`,
    `SEQUENCE:${stand}`,
  ];

  if (zeit) {
    const d = e.datum instanceof Date ? e.datum : new Date(e.datum);
    const bis = new Date(d);
    if (ende) {
      bis.setHours(ende.stunde, ende.minute, 0, 0);
    } else {
      bis.setHours(zeit.stunde, zeit.minute + dauer, 0, 0);
    }
    zeilen.push(`DTSTART;TZID=Europe/Berlin:${ortszeit(d, zeit.stunde, zeit.minute)}`);
    zeilen.push(`DTEND;TZID=Europe/Berlin:${ortszeit(bis, bis.getHours(), bis.getMinutes())}`);
  } else {
    // Ganztags: DTEND ist der Folgetag, so verlangt es der Standard.
    const d = e.datum instanceof Date ? e.datum : new Date(e.datum);
    const naechster = new Date(d);
    naechster.setDate(naechster.getDate() + 1);
    zeilen.push(`DTSTART;VALUE=DATE:${tag(d)}`);
    zeilen.push(`DTEND;VALUE=DATE:${tag(naechster)}`);
  }

  zeilen.push(`SUMMARY:${esc(e.titel || 'Termin')}`);
  if (e.ort) zeilen.push(`LOCATION:${esc(e.ort)}`);
  if (e.beschreibung) zeilen.push(`DESCRIPTION:${esc(e.beschreibung)}`);

  if (e.organisator && e.organisator.email) {
    zeilen.push(`ORGANIZER;CN=${esc(e.organisator.name || e.organisator.email)}:mailto:${e.organisator.email}`);
  }
  for (const t of e.teilnehmer || []) {
    if (!t.email) continue;
    zeilen.push(
      `ATTENDEE;CN=${esc(t.name || t.email)};ROLE=REQ-PARTICIPANT;`
      + `PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${t.email}`
    );
  }

  zeilen.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR');
  return zeilen.map(falten).join('\r\n') + '\r\n';
}

/** Dateiname ohne Sonderzeichen, die Windows nicht mag. */
function dateiname(text) {
  return String(text || 'Termin')
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/\s+/g, '_').slice(0, 60) + '.ics';
}

// ---------------------------------------------------------------------
// Vorbereitete E-Mail
// ---------------------------------------------------------------------

/**
 * mailto-Verweis bauen.
 *
 * Die Laenge ist begrenzt: Outlook unter Windows schneidet oberhalb von
 * etwa 2.000 Zeichen ab, und zwar ohne Warnung. Deshalb wird der Text
 * gekuerzt, statt eine halbe Mail zu erzeugen.
 */
const MAILTO_GRENZE = 1900;

function mailto({ an, kopie, betreff, text }) {
  const teile = [];
  if (betreff) teile.push('subject=' + encodeURIComponent(betreff));
  if (kopie) teile.push('cc=' + encodeURIComponent(kopie));

  let koerper = String(text || '');
  const rest = MAILTO_GRENZE - encodeURIComponent(an || '').length
    - teile.join('&').length - 20;
  while (encodeURIComponent(koerper).length > rest && koerper.length > 40) {
    koerper = koerper.slice(0, Math.floor(koerper.length * 0.9));
  }
  if (koerper !== text) koerper = koerper.replace(/\s+\S*$/, '') + '\n\n[…]';
  if (koerper) teile.push('body=' + encodeURIComponent(koerper));

  return `mailto:${encodeURIComponent(an || '').replace(/%40/g, '@')}`
    + (teile.length ? '?' + teile.join('&') : '');
}

/** Anrede aus einem Ansprechpartner, sonst allgemein. */
function anrede(ap) {
  if (!ap) return 'Sehr geehrte Damen und Herren,';
  const name = h.txt(ap.name);
  if (!name) return 'Sehr geehrte Damen und Herren,';
  const anr = String(ap.anrede || '').toLowerCase();
  const nachname = name.split(/\s+/).slice(-1)[0];
  if (anr.startsWith('herr')) return `Sehr geehrter Herr ${nachname},`;
  if (anr.startsWith('frau')) return `Sehr geehrte Frau ${nachname},`;
  return `Sehr geehrte Damen und Herren,`;
}

/** Signatur aus den Firmeneinstellungen. */
function signatur(benutzer, e) {
  return [
    '',
    'Mit freundlichen Grüßen',
    '',
    benutzer && benutzer.name ? benutzer.name : '',
    'STEER.E — Ladeinfrastruktur',
    e && e.firma_name ? e.firma_name : 'Westphal Wavetec GmbH',
    e && e.firma_kontakt ? e.firma_kontakt : '',
  ].filter((z) => z !== null).join('\n');
}

module.exports = {
  zeitLesen, endzeitLesen, datei, dateiname, mailto, anrede, signatur, MAILTO_GRENZE,
};
