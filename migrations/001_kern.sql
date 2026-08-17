-- =====================================================================
-- STEER.E Plattform · Migration 001 · Kern
-- Uebernimmt das Datenmodell der Vorgaengerversion (SQLite) nach Postgres
-- und ergaenzt Benutzer, Rollen und Mandantentrennung fuer Partner.
-- =====================================================================

-- ---------- Organisationen (wir selbst + Partnerfirmen) ----------
CREATE TABLE IF NOT EXISTS organisationen (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  kuerzel     TEXT UNIQUE,
  art         TEXT NOT NULL DEFAULT 'partner',   -- intern | partner
  aktiv       BOOLEAN NOT NULL DEFAULT TRUE,
  angelegt_am TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Benutzer ----------
-- rolle: admin  = alles inkl. Verwaltung
--        team   = alles ausser Verwaltung
--        partner= nur freigegebene Projekte der eigenen Organisation
CREATE TABLE IF NOT EXISTS benutzer (
  id               SERIAL PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  rolle            TEXT NOT NULL DEFAULT 'team',
  organisation_id  INTEGER REFERENCES organisationen(id),
  passwort_hash    TEXT NOT NULL,
  passwort_salt    TEXT NOT NULL,
  muss_wechseln    BOOLEAN NOT NULL DEFAULT TRUE,
  aktiv            BOOLEAN NOT NULL DEFAULT TRUE,
  letzter_login    TIMESTAMPTZ,
  fehlversuche     INTEGER NOT NULL DEFAULT 0,
  gesperrt_bis     TIMESTAMPTZ,
  angelegt_am      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT benutzer_rolle_chk CHECK (rolle IN ('admin','team','partner'))
);
CREATE INDEX IF NOT EXISTS idx_benutzer_email ON benutzer(lower(email));

-- ---------- Mitarbeiter (Zuordnung von Aufgaben, unabhaengig vom Login) ----------
CREATE TABLE IF NOT EXISTS mitarbeiter (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL,
  rolle    TEXT NOT NULL DEFAULT 'Vertrieb',
  email    TEXT,
  aktiv    BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------- Kunden ----------
CREATE TABLE IF NOT EXISTS kunden (
  id          SERIAL PRIMARY KEY,
  firma       TEXT NOT NULL,
  branche     TEXT,
  adresse     TEXT,
  website     TEXT,
  quelle      TEXT,
  notiz       TEXT,
  angelegt_am TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kunden_firma ON kunden(lower(firma));

CREATE TABLE IF NOT EXISTS ansprechpartner (
  id        SERIAL PRIMARY KEY,
  kunde_id  INTEGER NOT NULL REFERENCES kunden(id) ON DELETE CASCADE,
  name      TEXT,
  telefon   TEXT,
  email     TEXT,
  rolle     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ap_kunde ON ansprechpartner(kunde_id);

-- ---------- Projekte ----------
CREATE TABLE IF NOT EXISTS projekte (
  id                  SERIAL PRIMARY KEY,
  kunde_id            INTEGER NOT NULL REFERENCES kunden(id) ON DELETE CASCADE,
  nummer              TEXT UNIQUE,
  bezeichnung         TEXT NOT NULL,
  beschreibung        TEXT,
  projektmanager_id   INTEGER REFERENCES mitarbeiter(id),
  phase               TEXT NOT NULL DEFAULT 'Terminanfrage',
  potential           INTEGER,
  gewerk              TEXT,                       -- AC | DC | AC+DC
  angebotssumme       NUMERIC(12,2),
  beauftragte_summe   NUMERIC(12,2),
  rechnungsbetrag     NUMERIC(12,2),
  baustellen_status   TEXT,
  angelegt_am         TIMESTAMPTZ NOT NULL DEFAULT now(),
  letzte_aktivitaet   TIMESTAMPTZ NOT NULL DEFAULT now(),
  wiedervorlage_am    DATE
);
CREATE INDEX IF NOT EXISTS idx_projekte_phase ON projekte(phase);
CREATE INDEX IF NOT EXISTS idx_projekte_kunde ON projekte(kunde_id);

-- Freigabe eines Projekts fuer eine Partnerorganisation.
-- Ohne Eintrag hier sieht ein Partner das Projekt nicht. Das ist die einzige
-- Stelle, an der Partnersichtbarkeit entsteht.
CREATE TABLE IF NOT EXISTS projekt_partner (
  projekt_id       INTEGER NOT NULL REFERENCES projekte(id) ON DELETE CASCADE,
  organisation_id  INTEGER NOT NULL REFERENCES organisationen(id) ON DELETE CASCADE,
  rolle            TEXT NOT NULL DEFAULT 'Nachunternehmer',
  freigegeben_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (projekt_id, organisation_id)
);

-- ---------- Termine ----------
CREATE TABLE IF NOT EXISTS termine (
  id                        SERIAL PRIMARY KEY,
  kunde_id                  INTEGER NOT NULL REFERENCES kunden(id) ON DELETE CASCADE,
  projekt_id                INTEGER REFERENCES projekte(id) ON DELETE CASCADE,
  typ                       TEXT NOT NULL DEFAULT 'Kunde',
  mit_wem                   TEXT,
  datum                     DATE,
  uhrzeit                   TEXT,
  ort                       TEXT,
  thema                     TEXT,
  bestaetigt                TEXT NOT NULL DEFAULT 'offen',
  status                    TEXT NOT NULL DEFAULT 'geplant',
  ergebnis                  TEXT,
  kunde_informiert          BOOLEAN NOT NULL DEFAULT FALSE,
  kunde_informiert_methode  TEXT
);
CREATE INDEX IF NOT EXISTS idx_termine_projekt ON termine(projekt_id);
CREATE INDEX IF NOT EXISTS idx_termine_datum ON termine(datum);

-- ---------- Aufgaben ----------
CREATE TABLE IF NOT EXISTS aufgaben (
  id             SERIAL PRIMARY KEY,
  kunde_id       INTEGER REFERENCES kunden(id) ON DELETE CASCADE,
  projekt_id     INTEGER REFERENCES projekte(id) ON DELETE CASCADE,
  text           TEXT NOT NULL,
  faellig_am     DATE,
  mitarbeiter_id INTEGER REFERENCES mitarbeiter(id),
  erledigt       BOOLEAN NOT NULL DEFAULT FALSE,
  status         TEXT NOT NULL DEFAULT 'offen',
  notiz          TEXT,
  angelegt_am    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aufgaben_projekt ON aufgaben(projekt_id);

-- ---------- Aktivitaeten ----------
CREATE TABLE IF NOT EXISTS aktivitaeten (
  id           SERIAL PRIMARY KEY,
  kunde_id     INTEGER REFERENCES kunden(id) ON DELETE CASCADE,
  projekt_id   INTEGER REFERENCES projekte(id) ON DELETE CASCADE,
  benutzer_id  INTEGER REFERENCES benutzer(id),
  datum        TIMESTAMPTZ NOT NULL DEFAULT now(),
  text         TEXT NOT NULL,
  automatisch  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_akt_projekt ON aktivitaeten(projekt_id);
CREATE INDEX IF NOT EXISTS idx_akt_kunde ON aktivitaeten(kunde_id);

-- ---------- Einstellungen ----------
-- Alles, was ein Administrator im laufenden Betrieb aendern darf, liegt hier
-- als Datensatz - nicht im Code. Aenderungen sind damit reine INSERT/UPDATE
-- und beruehren das Schema nicht.
CREATE TABLE IF NOT EXISTS einstellungen (
  schluessel   TEXT PRIMARY KEY,
  wert         TEXT,
  beschreibung TEXT,
  geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Aenderungsprotokoll ----------
-- Wer hat was wann geaendert. Rein additiv, wird nie geleert.
CREATE TABLE IF NOT EXISTS protokoll (
  id           BIGSERIAL PRIMARY KEY,
  zeitpunkt    TIMESTAMPTZ NOT NULL DEFAULT now(),
  benutzer_id  INTEGER REFERENCES benutzer(id),
  benutzer_txt TEXT,
  aktion       TEXT NOT NULL,
  objekt       TEXT,
  objekt_id    TEXT,
  details      JSONB
);
CREATE INDEX IF NOT EXISTS idx_protokoll_zeit ON protokoll(zeitpunkt DESC);

-- ---------- Startwerte ----------
INSERT INTO einstellungen (schluessel, wert, beschreibung) VALUES
  ('phasen',
   'Terminanfrage,Kontaktaufnahme,Wiedervorlage,Projektbesprechung,Angebot,Beauftragung,Terminierung,Umsetzung,Abgeschlossen,Verloren',
   'Reihenfolge der Projektphasen. Kommagetrennt. Aenderung wirkt sofort, bestehende Projekte behalten ihre Phase.'),
  ('mitarbeiter_rollen','Vertrieb,Projektmanager,Elektriker,Tiefbau,Admin',
   'Auswahlliste fuer Mitarbeiterrollen.'),
  ('wiedervorlage_tage','14',
   'Nach wie vielen Tagen ohne Aktivitaet ein Projekt in Kontaktaufnahme auf Wiedervorlage wandert.'),
  ('marge_tiefbau','30','Zielmarge Tiefbau in Prozent.'),
  ('marge_elektro','30','Zielmarge Elektro auf Material in Prozent.'),
  ('mwst_satz','19','Umsatzsteuersatz in Prozent.'),
  ('angebot_gueltigkeit_tage','30','Bindefrist eines Angebots in Tagen.'),
  ('firma_name','Westphal Wavetec GmbH','Firmierung fuer Angebotskopf.'),
  ('firma_zusatz','STEER.E — PMaaS fuer Ladeinfrastruktur','Zusatzzeile im Angebotskopf.'),
  ('firma_adresse','Kurt-Fischer-Strasse 28a · 22926 Ahrensburg','Anschrift fuer Angebotskopf.'),
  ('firma_kontakt','Tel. +49 (0)40 853321-0 · info@wwtec.de','Kontaktzeile fuer Angebotskopf.'),
  ('firma_register','Registergericht und HRB bitte in der Verwaltung eintragen',
   'Pflichtangabe nach § 35a GmbHG fuer Geschaeftsbriefe und E-Mails.')
ON CONFLICT (schluessel) DO NOTHING;

INSERT INTO organisationen (name, kuerzel, art) VALUES
  ('Westphal Wavetec GmbH','WWTEC','intern')
ON CONFLICT (kuerzel) DO NOTHING;
