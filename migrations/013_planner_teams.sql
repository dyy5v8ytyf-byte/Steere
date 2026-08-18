-- =====================================================================
-- 013  Microsoft Planner und Teams
--
-- Aufgaben aus STEER.E werden zu Planner-Aufgaben, und wichtige Ereignisse
-- melden sich in einem Teams-Kanal.
--
-- ZUSAETZLICHE BERECHTIGUNGEN NOETIG. Bis 3.4 kam die Anwendung mit
-- Calendars.ReadWrite, Mail.Send und User.Read aus. Planner und Teams
-- verlangen mehr:
--
--   Tasks.ReadWrite          Planner-Aufgaben lesen und schreiben
--   Group.Read.All           die Plaene der eigenen Gruppen finden
--   ChannelMessage.Send      in einen Kanal schreiben
--   Team.ReadBasic.All       die eigenen Teams auflisten
--
-- Group.Read.All verlangt in den meisten Mandanten die Zustimmung eines
-- Administrators. Das ist kein Versehen der Anwendung, sondern Microsofts
-- Einstufung. Wer das nicht erteilen will, laesst Planner und Teams aus —
-- alles andere laeuft unveraendert weiter.
--
-- Es bleibt bei delegierten Berechtigungen. Die Anwendung sieht nur, was
-- der angemeldete Benutzer selbst sieht.
-- =====================================================================

-- Welcher Plan, welcher Eimer, welches Team, welcher Kanal — je Benutzer,
-- weil jeder sein eigenes Konto verbindet.
CREATE TABLE IF NOT EXISTS m365_ziele (
  benutzer_id   INTEGER PRIMARY KEY REFERENCES benutzer(id) ON DELETE CASCADE,
  gruppe_id     TEXT,
  gruppe_name   TEXT,
  plan_id       TEXT,
  plan_name     TEXT,
  eimer_id      TEXT,
  eimer_name    TEXT,
  team_id       TEXT,
  team_name     TEXT,
  kanal_id      TEXT,
  kanal_name    TEXT,
  -- Was soll ueberhaupt gemeldet werden. Ohne diese Schalter wuerde der
  -- Kanal zugeschuettet und niemand liest ihn mehr.
  melde_angebot     BOOLEAN NOT NULL DEFAULT TRUE,
  melde_auftrag     BOOLEAN NOT NULL DEFAULT TRUE,
  melde_begehung    BOOLEAN NOT NULL DEFAULT FALSE,
  melde_rechnung    BOOLEAN NOT NULL DEFAULT FALSE,
  aufgaben_spiegeln BOOLEAN NOT NULL DEFAULT FALSE,
  geaendert_am  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Zuordnung Aufgabe <-> Planner-Aufgabe. Gleiche Ueberlegung wie beim
-- Kalender: je Benutzer, sonst ueberschreibt der zweite den ersten.
CREATE TABLE IF NOT EXISTS m365_aufgabe_planner (
  id          SERIAL PRIMARY KEY,
  aufgabe_id  INTEGER NOT NULL REFERENCES aufgaben(id) ON DELETE CASCADE,
  benutzer_id INTEGER NOT NULL REFERENCES benutzer(id) ON DELETE CASCADE,
  planner_id  TEXT NOT NULL,
  etag        TEXT,
  stand_hash  TEXT,
  stand_am    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_m365_ap_paar ON m365_aufgabe_planner(aufgabe_id, benutzer_id);

-- Gesendete Kanalmeldungen. Verhindert, dass dasselbe Ereignis nach einem
-- Neustart ein zweites Mal gemeldet wird.
CREATE TABLE IF NOT EXISTS m365_meldungen (
  id          SERIAL PRIMARY KEY,
  benutzer_id INTEGER REFERENCES benutzer(id) ON DELETE SET NULL,
  anlass      TEXT NOT NULL,
  bezug_art   TEXT NOT NULL,
  bezug_id    INTEGER NOT NULL,
  text        TEXT,
  gesendet_am TIMESTAMPTZ NOT NULL DEFAULT now(),
  fehler      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meldung_einmal
  ON m365_meldungen(anlass, bezug_art, bezug_id) WHERE fehler IS NULL;

ALTER TABLE aufgaben ADD COLUMN IF NOT EXISTS planner_aus BOOLEAN NOT NULL DEFAULT FALSE;
