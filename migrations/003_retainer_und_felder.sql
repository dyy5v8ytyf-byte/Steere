-- =====================================================================
-- STEER.E Plattform · Migration 003
-- (a) Retainer- und Stundenerfassung, Grundlage des Monatsberichts
-- (b) Eigene Felder: Administratoren erweitern Erfassungsmasken ohne Code
-- (c) Andockstelle fuer den KI-Projektassistenten (vorbereitet, inaktiv)
-- =====================================================================

-- ---------- (a) Retainer ----------
CREATE TABLE IF NOT EXISTS retainer (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisationen(id) ON DELETE CASCADE,
  bezeichnung      TEXT NOT NULL,
  stunden_monat    NUMERIC(8,2) NOT NULL DEFAULT 80,
  entgelt_netto    NUMERIC(12,2) NOT NULL DEFAULT 0,
  start_am         DATE,
  ende_am          DATE,
  aktiv            BOOLEAN NOT NULL DEFAULT TRUE,
  hinweis          TEXT
);

-- Einzelne Leistungsbloecke wie in Monatsbericht Pos. 01-06.
CREATE TABLE IF NOT EXISTS leistungen (
  id            SERIAL PRIMARY KEY,
  retainer_id   INTEGER REFERENCES retainer(id) ON DELETE CASCADE,
  projekt_id    INTEGER REFERENCES projekte(id) ON DELETE SET NULL,
  benutzer_id   INTEGER REFERENCES benutzer(id),
  datum         DATE NOT NULL DEFAULT CURRENT_DATE,
  monat         TEXT NOT NULL,               -- Format 2026-06, fuer die Monatsauswertung
  titel         TEXT NOT NULL,
  beschreibung  TEXT,
  status        TEXT NOT NULL DEFAULT 'laufend',
  stunden       NUMERIC(8,2) NOT NULL DEFAULT 0,
  angelegt_am   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leistungen_monat ON leistungen(retainer_id, monat);

-- ---------- (b) Eigene Felder ----------
-- Ein Administrator legt hier zusaetzliche Felder an (z. B. "Netzbetreiber",
-- "Anzahl Stellplaetze"). Werte landen in feld_werte. Es wird dafuer NIE eine
-- Spalte angelegt oder geloescht - deshalb kann diese Funktion keine
-- bestehenden Daten beschaedigen.
CREATE TABLE IF NOT EXISTS felder (
  id           SERIAL PRIMARY KEY,
  bereich      TEXT NOT NULL,                -- kunde | projekt | angebot
  schluessel   TEXT NOT NULL,
  bezeichnung  TEXT NOT NULL,
  typ          TEXT NOT NULL DEFAULT 'text', -- text | zahl | datum | auswahl | ja_nein
  optionen     TEXT,                         -- bei typ=auswahl: kommagetrennt
  pflicht      BOOLEAN NOT NULL DEFAULT FALSE,
  reihenfolge  INTEGER NOT NULL DEFAULT 100,
  aktiv        BOOLEAN NOT NULL DEFAULT TRUE,
  angelegt_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bereich, schluessel)
);

CREATE TABLE IF NOT EXISTS feld_werte (
  feld_id    INTEGER NOT NULL REFERENCES felder(id) ON DELETE CASCADE,
  objekt_id  INTEGER NOT NULL,
  wert       TEXT,
  PRIMARY KEY (feld_id, objekt_id)
);

-- ---------- (c) KI-Andockstelle ----------
-- Bewusst vorbereitet, aber ohne aktiven Aufruf. Sobald ein Anthropic-Schluessel
-- als Variable ANTHROPIC_API_KEY hinterlegt und ki_aktiv auf 1 gesetzt wird,
-- schreibt der Assistent seine Vorschlaege hier hinein. Vorschlaege sind
-- Vorschlaege: sie aendern nichts, bis ein Mensch sie uebernimmt.
CREATE TABLE IF NOT EXISTS ki_vorschlaege (
  id            BIGSERIAL PRIMARY KEY,
  erstellt_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
  bereich       TEXT NOT NULL,               -- projekt | angebot | wiedervorlage
  objekt_id     INTEGER,
  anlass        TEXT,
  vorschlag     TEXT NOT NULL,
  modell        TEXT,
  status        TEXT NOT NULL DEFAULT 'offen',  -- offen | uebernommen | verworfen
  bearbeitet_von INTEGER REFERENCES benutzer(id),
  bearbeitet_am TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ki_status ON ki_vorschlaege(status, erstellt_am DESC);

INSERT INTO einstellungen (schluessel, wert, beschreibung) VALUES
  ('ki_aktiv','0','Projektassistent ein (1) oder aus (0). Erfordert die Variable ANTHROPIC_API_KEY.'),
  ('ki_modell','claude-sonnet-4-5','Modell fuer den Projektassistenten.'),
  ('ki_hinweis','Vorschlaege des Assistenten werden nie automatisch uebernommen.',
   'Text, der im Assistenzbereich angezeigt wird.')
ON CONFLICT (schluessel) DO NOTHING;
