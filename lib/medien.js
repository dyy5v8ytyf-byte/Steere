'use strict';
/**
 * Ablage für Fotos, Videos und 360-Grad-Aufnahmen.
 *
 * Zwei Betriebsarten, damit die Anwendung auch ohne eingerichteten Object
 * Storage sofort läuft:
 *
 *   r2     — Cloudflare R2 (S3-kompatibel). Der Browser lädt mit einer
 *            vorsignierten Adresse DIREKT zum Speicher hoch. Ein 400-MB-
 *            Rundgang läuft damit nie durch den Anwendungsserver, was sonst
 *            der sichere Weg in einen Zeitüberlauf wäre.
 *   lokal  — Ablage im Verzeichnis MEDIEN_DIR (auf Railway ein Volume).
 *            Für den Anfang und für kleine Objekte ausreichend.
 *
 * Umschaltung über die Einstellung 'medien_speicher'. Erkennt die Anwendung
 * keine R2-Zugangsdaten, fällt sie automatisch auf 'lokal' zurück und sagt es
 * im Protokoll — sie tut nicht so, als sei alles in Ordnung.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const R2 = {
  konto: process.env.R2_ACCOUNT_ID,
  schluessel: process.env.R2_ACCESS_KEY_ID,
  geheim: process.env.R2_SECRET_ACCESS_KEY,
  eimer: process.env.R2_BUCKET,
  oeffentlich: process.env.R2_PUBLIC_BASE_URL || null,
};

const MEDIEN_DIR = process.env.MEDIEN_DIR
  || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'daten'), 'medien');

let s3 = null;
let presign = null;
let r2Bereit = false;

function initR2() {
  if (s3 !== null) return r2Bereit;
  if (!R2.konto || !R2.schluessel || !R2.geheim || !R2.eimer) {
    console.warn('[STEER.E] Object Storage nicht konfiguriert — Medien werden lokal abgelegt.');
    console.warn('           Benötigt: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET');
    s3 = false;
    return false;
  }
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    presign = require('@aws-sdk/s3-request-presigner').getSignedUrl;
    s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${R2.konto}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2.schluessel, secretAccessKey: R2.geheim },
    });
    r2Bereit = true;
    console.log('[STEER.E] Object Storage aktiv (R2, Eimer: ' + R2.eimer + ').');
    return true;
  } catch (e) {
    console.error('[STEER.E] Object Storage konnte nicht gestartet werden:', e.message);
    s3 = false;
    return false;
  }
}

function aktiveArt() {
  return initR2() ? 'r2' : 'lokal';
}

/** Ein Schlüssel je Begehung und Datei, ohne Sonderzeichen und ohne Kollision. */
function schluesselBauen(begehungId, dateiname) {
  const endung = (path.extname(dateiname || '') || '').toLowerCase().slice(0, 8) || '.bin';
  const zufall = crypto.randomBytes(8).toString('hex');
  const stempel = new Date().toISOString().slice(0, 10);
  return `begehungen/${begehungId}/${stempel}-${zufall}${endung}`;
}

/** Adresse, an die der Browser die Datei direkt hochlädt. */
async function hochladeAdresse(schluessel, mime) {
  if (aktiveArt() === 'r2') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const url = await presign(
      s3,
      new PutObjectCommand({ Bucket: R2.eimer, Key: schluessel, ContentType: mime || 'application/octet-stream' }),
      { expiresIn: 900 }
    );
    return { art: 'r2', url, methode: 'PUT' };
  }
  return { art: 'lokal', url: `/begehungen/medien/lokal/${encodeURIComponent(schluessel)}`, methode: 'PUT' };
}

/** Adresse zum Anzeigen. Bei R2 kurzlebig signiert, damit nichts öffentlich liegt. */
async function abrufAdresse(schluessel, minuten = 60) {
  if (aktiveArt() === 'r2') {
    if (R2.oeffentlich) return `${R2.oeffentlich.replace(/\/$/, '')}/${schluessel}`;
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    return presign(s3, new GetObjectCommand({ Bucket: R2.eimer, Key: schluessel }), { expiresIn: minuten * 60 });
  }
  return `/begehungen/medien/lokal/${encodeURIComponent(schluessel)}`;
}

async function loeschen(schluessel) {
  if (aktiveArt() === 'r2') {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: R2.eimer, Key: schluessel }));
    return true;
  }
  const ziel = lokalerPfad(schluessel);
  if (ziel && fs.existsSync(ziel)) { fs.unlinkSync(ziel); return true; }
  return false;
}

/** Lokaler Pfad — mit Schutz gegen Ausbrüche aus dem Medienverzeichnis. */
function lokalerPfad(schluessel) {
  const sauber = String(schluessel).replace(/\\/g, '/');
  const ziel = path.resolve(MEDIEN_DIR, sauber);
  const wurzel = path.resolve(MEDIEN_DIR);
  if (!ziel.startsWith(wurzel + path.sep) && ziel !== wurzel) return null;
  return ziel;
}

function lokalSchreibenVorbereiten(schluessel) {
  const ziel = lokalerPfad(schluessel);
  if (!ziel) throw new Error('Ungültiger Ablageort.');
  fs.mkdirSync(path.dirname(ziel), { recursive: true });
  return ziel;
}

const ERLAUBT = {
  foto: ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'],
  panorama360: ['image/jpeg', 'image/png'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  video360: ['video/mp4', 'video/webm'],
  dokument: ['application/pdf'],
};

function mimeErlaubt(art, mime) {
  const liste = ERLAUBT[art];
  if (!liste) return false;
  return liste.includes(String(mime || '').toLowerCase());
}

/** Obergrenzen je Art, damit ein versehentlicher Rohdaten-Upload nicht die Kosten sprengt. */
const MAX_MB = { foto: 25, panorama360: 60, video: 500, video360: 1500, dokument: 40 };

module.exports = {
  aktiveArt, schluesselBauen, hochladeAdresse, abrufAdresse, loeschen,
  lokalerPfad, lokalSchreibenVorbereiten, mimeErlaubt, MAX_MB, MEDIEN_DIR, ERLAUBT,
};
