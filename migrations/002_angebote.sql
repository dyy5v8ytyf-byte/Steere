-- =====================================================================
-- STEER.E Plattform · Migration 002 · Preiskatalog und Angebote
-- Quelle der Preise: Angebotsmatrix_S4C.xlsx (Standard-LV Tiefbau/Elektro
-- sowie 428 Marktpreise aus 18 realen Altangeboten).
-- =====================================================================

-- ---------- Preiskatalog ----------
-- herkunft: standard_tiefbau | standard_elektro | markt | eigen
CREATE TABLE IF NOT EXISTS preis_positionen (
  id            SERIAL PRIMARY KEY,
  herkunft      TEXT NOT NULL,
  gewerk        TEXT NOT NULL,               -- Tiefbau | Elektro | Sonstiges
  pos           TEXT,                        -- Positionsnummer im Standard-LV
  kategorie     TEXT,
  text          TEXT NOT NULL,
  einheit       TEXT,
  stoffe_ek     NUMERIC(12,4),
  loehne        NUMERIC(12,4),
  vk_aktuell    NUMERIC(12,4),
  vk_ziel       NUMERIC(12,4),
  markt_min     NUMERIC(12,4),
  markt_median  NUMERIC(12,4),
  markt_max     NUMERIC(12,4),
  belege        INTEGER,
  quelle        TEXT,
  aktiv         BOOLEAN NOT NULL DEFAULT TRUE,
  angelegt_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
  geaendert_am  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_preis_gewerk ON preis_positionen(gewerk);
CREATE INDEX IF NOT EXISTS idx_preis_pos ON preis_positionen(pos);
CREATE INDEX IF NOT EXISTS idx_preis_suche ON preis_positionen USING GIN (to_tsvector('german', coalesce(text,'')));
CREATE UNIQUE INDEX IF NOT EXISTS idx_preis_eindeutig ON preis_positionen(herkunft, coalesce(pos,''), md5(text));

-- ---------- Angebote ----------
CREATE TABLE IF NOT EXISTS angebote (
  id                SERIAL PRIMARY KEY,
  nummer            TEXT UNIQUE NOT NULL,
  kunde_id          INTEGER NOT NULL REFERENCES kunden(id) ON DELETE RESTRICT,
  projekt_id        INTEGER REFERENCES projekte(id) ON DELETE SET NULL,
  empfaenger        TEXT,                    -- Anschriftenblock, mehrzeilig
  anrede            TEXT,
  bauvorhaben       TEXT,
  gewerk            TEXT,
  einleitung        TEXT,
  hinweise          TEXT,
  status            TEXT NOT NULL DEFAULT 'Entwurf',   -- Entwurf|Versendet|Beauftragt|Abgelehnt|Storniert
  datum             DATE NOT NULL DEFAULT CURRENT_DATE,
  gueltig_bis       DATE,
  mwst_satz         NUMERIC(5,2) NOT NULL DEFAULT 19,
  netto             NUMERIC(12,2) NOT NULL DEFAULT 0,
  mwst              NUMERIC(12,2) NOT NULL DEFAULT 0,
  brutto            NUMERIC(12,2) NOT NULL DEFAULT 0,
  erstellt_von      INTEGER REFERENCES benutzer(id),
  angelegt_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
  geaendert_am      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_angebote_kunde ON angebote(kunde_id);
CREATE INDEX IF NOT EXISTS idx_angebote_status ON angebote(status);

CREATE TABLE IF NOT EXISTS angebot_positionen (
  id            SERIAL PRIMARY KEY,
  angebot_id    INTEGER NOT NULL REFERENCES angebote(id) ON DELETE CASCADE,
  lfd           INTEGER NOT NULL DEFAULT 1,
  quelle_id     INTEGER REFERENCES preis_positionen(id) ON DELETE SET NULL,
  pos           TEXT,
  text          TEXT NOT NULL,
  langtext      TEXT,
  einheit       TEXT,
  menge         NUMERIC(12,3) NOT NULL DEFAULT 1,
  einzelpreis   NUMERIC(12,4) NOT NULL DEFAULT 0,
  gesamtpreis   NUMERIC(12,2) NOT NULL DEFAULT 0,
  ist_titel     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_angpos_angebot ON angebot_positionen(angebot_id, lfd);

-- Nummernkreis. Aktuelles Jahr + laufende Nummer, wie AN-2026-0144.
CREATE TABLE IF NOT EXISTS nummernkreise (
  bereich   TEXT NOT NULL,
  jahr      INTEGER NOT NULL,
  letzte    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bereich, jahr)
);

-- Bestehende Angebotsnummern reichen bis AN-2026-0144. Damit die Plattform
-- nicht bei 1 anfaengt und Nummern doppelt vergibt, wird hier vorbelegt.
INSERT INTO nummernkreise (bereich, jahr, letzte) VALUES ('AN', 2026, 144)
ON CONFLICT (bereich, jahr) DO NOTHING;
