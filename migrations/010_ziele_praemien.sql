-- =====================================================================
-- STEER.E Plattform · Migration 010 — Ziele, Prämien, Forecast
--
-- Soll-Werte gehoeren in die Datenbank, nicht in eine Tabelle im Kopf des
-- Geschaeftsfuehrers. Erst dann laesst sich eine Abweichung berechnen, die
-- jeder nachrechnen kann.
--
-- Grundsatz wie ueberall in dieser Anwendung: Der Ist-Wert wird NIE
-- gespeichert, sondern immer aus den Belegen gerechnet — aus
-- festgeschriebenen Rechnungen und beauftragten Angeboten. Eine
-- gespeicherte Ist-Zahl waere binnen einer Woche falsch und niemand
-- wuesste, warum.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Ziele
--
-- benutzer_id NULL bedeutet: Ziel des Unternehmens, nicht einer Person.
-- periode: 'monat' (nr 1-12) | 'quartal' (nr 1-4) | 'jahr' (nr 0)
-- art:     'umsatz'          = festgeschriebene Rechnungen
--          'auftragseingang' = beauftragte Angebote
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ziele (
  id           SERIAL PRIMARY KEY,
  jahr         INTEGER NOT NULL,
  periode      TEXT NOT NULL DEFAULT 'monat',
  periode_nr   INTEGER NOT NULL DEFAULT 0,
  art          TEXT NOT NULL DEFAULT 'umsatz',
  benutzer_id  INTEGER REFERENCES benutzer(id) ON DELETE CASCADE,
  wert         NUMERIC(14,2) NOT NULL DEFAULT 0,
  hinweis      TEXT,
  angelegt_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
  geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ein Ziel je Kombination. COALESCE, weil NULL in einem UNIQUE-Index
-- sonst beliebig oft vorkommen darf und die Firmenziele doppelt entstuenden.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ziel_eindeutig
  ON ziele (jahr, periode, periode_nr, art, COALESCE(benutzer_id, 0));

-- ---------------------------------------------------------------------
-- Prämien
--
-- Bewusst schlicht und erklaerbar gehalten. Eine Praemienregel, die
-- niemand nachrechnen kann, erzeugt Streit statt Antrieb:
--
--   erreicht = ist / ziel
--   unter der Schwelle          -> keine Praemie
--   ab der Schwelle             -> praemie_voll x erreicht, gedeckelt
--
-- Beispiel: Ziel 100.000, Praemie 5.000, Schwelle 80 %, Deckel 120 %.
-- Bei 95.000 Umsatz sind das 95 % -> 4.750 EUR. Bei 130.000 greift der
-- Deckel bei 120 % -> 6.000 EUR.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS praemien (
  id           SERIAL PRIMARY KEY,
  benutzer_id  INTEGER NOT NULL REFERENCES benutzer(id) ON DELETE CASCADE,
  jahr         INTEGER NOT NULL,
  periode      TEXT NOT NULL DEFAULT 'quartal',
  periode_nr   INTEGER NOT NULL DEFAULT 0,
  art          TEXT NOT NULL DEFAULT 'umsatz',
  ziel_wert    NUMERIC(14,2) NOT NULL DEFAULT 0,
  praemie_voll NUMERIC(12,2) NOT NULL DEFAULT 0,
  schwelle_pct NUMERIC(6,2) NOT NULL DEFAULT 80,
  deckel_pct   NUMERIC(6,2) NOT NULL DEFAULT 120,
  hinweis      TEXT,
  angelegt_am  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_praemie_eindeutig
  ON praemien (benutzer_id, jahr, periode, periode_nr, art);

-- ---------------------------------------------------------------------
-- Gewichtung der Pipeline für die Hochrechnung
--
-- Ein versendetes Angebot ist kein Umsatz. Wie viel davon erfahrungsgemaess
-- kommt, ist eine Annahme — und Annahmen gehoeren sichtbar in die
-- Einstellungen, nicht versteckt in eine Formel.
-- ---------------------------------------------------------------------
INSERT INTO einstellungen (schluessel, wert, beschreibung) VALUES
  ('forecast_gewicht_versendet', '40',
   'Wie viel Prozent der versendeten Angebote in der Hochrechnung als künftiger Umsatz angesetzt werden.'),
  ('forecast_gewicht_beauftragt', '95',
   'Wie viel Prozent der beauftragten, noch nicht berechneten Angebote in der Hochrechnung angesetzt werden.')
ON CONFLICT (schluessel) DO NOTHING;
