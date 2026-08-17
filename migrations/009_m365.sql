-- =====================================================================
-- STEER.E Plattform · Migration 009 — Microsoft 365
--
-- Anbindung an Outlook-Kalender und Postfach über Microsoft Graph.
--
-- Die Verbindung gehört jeweils EINEM Benutzer, nicht der Anwendung:
-- Wer einen Termin schreibt oder eine Mail sendet, tut das unter seinem
-- eigenen Konto und seinem eigenen Namen. Damit gibt es keine anonyme
-- Absenderidentität, und das Protokoll bleibt aussagekräftig.
--
-- Zu den Token: Sie liegen hier im Klartext. Wer Zugriff auf die Datenbank
-- hat, kann damit auf das Postfach zugreifen. Das ist eine bewusste
-- Abwägung — eine Verschlüsselung wäre nur so stark wie der Schlüssel, der
-- daneben in derselben Umgebung liegen müsste. Wirksam schützt hier der
-- Zugriffsschutz der Datenbank, nicht eine Scheinverschlüsselung.
-- Deshalb: DATABASE_URL ist ein Geheimnis, und Sicherungen dieser Tabelle
-- gehören nicht in einen geteilten Ordner.
-- =====================================================================

CREATE TABLE IF NOT EXISTS m365_konten (
  id             SERIAL PRIMARY KEY,
  benutzer_id    INTEGER NOT NULL UNIQUE REFERENCES benutzer(id) ON DELETE CASCADE,
  konto_email    TEXT,
  konto_name     TEXT,
  zugriff_token  TEXT,
  erneuer_token  TEXT,
  laeuft_ab_am   TIMESTAMPTZ,
  bereiche       TEXT,
  verbunden_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
  zuletzt_am     TIMESTAMPTZ,
  letzter_fehler TEXT
);

-- Laufende Anmeldevorgänge. Der Zustandswert schützt gegen untergeschobene
-- Rückmeldungen; abgelaufene Einträge werden beim nächsten Versuch entfernt.
CREATE TABLE IF NOT EXISTS m365_anmeldungen (
  zustand     TEXT PRIMARY KEY,
  benutzer_id INTEGER NOT NULL REFERENCES benutzer(id) ON DELETE CASCADE,
  zurueck_zu  TEXT,
  angelegt_am TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Verknüpfung Termin -> Outlook-Ereignis, damit ein zweiter Klick den
-- Termin aktualisiert statt ihn ein zweites Mal anzulegen.
ALTER TABLE termine    ADD COLUMN IF NOT EXISTS m365_ereignis_id TEXT;
ALTER TABLE termine    ADD COLUMN IF NOT EXISTS m365_stand_am    TIMESTAMPTZ;
ALTER TABLE begehungen ADD COLUMN IF NOT EXISTS m365_ereignis_id TEXT;
ALTER TABLE begehungen ADD COLUMN IF NOT EXISTS m365_stand_am    TIMESTAMPTZ;

-- Versandte Mails festhalten — damit der Schriftverkehr beim Kunden
-- sichtbar wird und nicht nur im Postfach liegt.
CREATE TABLE IF NOT EXISTS m365_nachrichten (
  id           SERIAL PRIMARY KEY,
  kunde_id     INTEGER REFERENCES kunden(id) ON DELETE SET NULL,
  projekt_id   INTEGER REFERENCES projekte(id) ON DELETE SET NULL,
  angebot_id   INTEGER REFERENCES angebote(id) ON DELETE SET NULL,
  richtung     TEXT NOT NULL DEFAULT 'gesendet',
  an           TEXT,
  betreff      TEXT,
  auszug       TEXT,
  anhang_name  TEXT,
  gesendet_von INTEGER REFERENCES benutzer(id),
  gesendet_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
  m365_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_nachricht_kunde ON m365_nachrichten(kunde_id, gesendet_am DESC);
