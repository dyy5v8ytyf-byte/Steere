-- =====================================================================
-- STEER.E Plattform · Migration 004
-- (a) Herkunftsschutz Preiskatalog  (b) Begehungen mit Strompfad und Medien
-- (c) Rechnungen, GoBD-konform      (d) Retainer-Kalkulation und Zeiterfassung
-- =====================================================================

-- ---------------------------------------------------------------------
-- (a) HERKUNFTSSCHUTZ
--
-- Die importierten Standard-LVs und Marktpreise stammen aus Unterlagen der
-- Service4Charger GmbH, Berlin. Auch wenn sie seinerzeit von einem heutigen
-- Mitarbeiter erstellt wurden, liegen die Rechte am Arbeitsergebnis im
-- Regelfall beim damaligen Auftraggeber. Diese Positionen duerfen deshalb
-- NICHT in ein Kundenangebot gelangen.
--
-- Der Schutz liegt hier in der Datenbank und nicht nur in der Oberflaeche:
-- ein Trigger verhindert, dass eine nur interne Position als Angebotsposition
-- verknuepft wird. Damit ist es auch dann unmoeglich, wenn jemand spaeter eine
-- Maske umbaut oder direkt auf der Datenbank arbeitet.
-- ---------------------------------------------------------------------

ALTER TABLE preis_positionen ADD COLUMN IF NOT EXISTS nur_intern BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE preis_positionen ADD COLUMN IF NOT EXISTS herkunft_hinweis TEXT;
ALTER TABLE preis_positionen ADD COLUMN IF NOT EXISTS abgeleitet_von INTEGER REFERENCES preis_positionen(id);

UPDATE preis_positionen
   SET nur_intern = TRUE,
       herkunft_hinweis = 'Aus Unterlagen der Service4Charger GmbH. Nur als interner Vergleichswert verwendbar, nicht für Kundenangebote.'
 WHERE herkunft IN ('standard_tiefbau','standard_elektro','markt')
   AND nur_intern = FALSE;

CREATE OR REPLACE FUNCTION pruefe_position_verwendbar() RETURNS TRIGGER AS $$
DECLARE
  intern BOOLEAN;
BEGIN
  IF NEW.quelle_id IS NULL THEN RETURN NEW; END IF;
  SELECT nur_intern INTO intern FROM preis_positionen WHERE id = NEW.quelle_id;
  IF intern THEN
    RAISE EXCEPTION 'Diese Preisposition ist als nur intern gekennzeichnet und darf nicht in ein Kundenangebot übernommen werden. Bitte über "Als eigene Position übernehmen" eine eigene Position mit eigenem Preis anlegen.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_position_verwendbar ON angebot_positionen;
CREATE TRIGGER trg_position_verwendbar
  BEFORE INSERT OR UPDATE ON angebot_positionen
  FOR EACH ROW EXECUTE FUNCTION pruefe_position_verwendbar();

-- ---------------------------------------------------------------------
-- (b) BEGEHUNGEN
--
-- Grundsatz aus der Praxis: Eine Begehung wird immer luekenlos entlang des
-- Strompfades aufgenommen — von der Stelle, an der der Strom ankommt, bis zum
-- letzten Abnehmer (Wallbox oder HPC). Deshalb ist der Pfad kein Freitext,
-- sondern eine geordnete Folge von Abschnitten.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS begehungen (
  id                 SERIAL PRIMARY KEY,
  nummer             TEXT UNIQUE NOT NULL,
  kunde_id           INTEGER REFERENCES kunden(id) ON DELETE SET NULL,
  projekt_id         INTEGER REFERENCES projekte(id) ON DELETE SET NULL,
  objekt             TEXT NOT NULL,
  adresse            TEXT,
  plz                TEXT,
  ort                TEXT,
  geo_lat            NUMERIC(9,6),
  geo_lon            NUMERIC(9,6),
  termin_am          TIMESTAMPTZ,
  durchgefuehrt_am   TIMESTAMPTZ,
  begeher_id         INTEGER REFERENCES benutzer(id),
  begleitung         TEXT,                    -- Ansprechpartner vor Ort
  art                TEXT NOT NULL DEFAULT 'AC',       -- AC | DC | AC+DC
  nutzung            TEXT,                    -- Wohnen | Gewerbe | Parkraum | Logistik | Sonstiges
  status             TEXT NOT NULL DEFAULT 'geplant',  -- geplant | vor Ort | erfasst | freigegeben | in Angebot
  -- Netzanschluss (Beginn des Strompfades)
  netz_vnb           TEXT,
  netz_art           TEXT,                    -- Hausanschluss | Trafostation | Übergabestation | Neuanschluss
  netz_leistung_kw   NUMERIC(10,2),
  netz_reserve_kw    NUMERIC(10,2),
  netz_zaehler       TEXT,
  netz_ort           TEXT,                    -- wo genau sitzt der Anschluss
  netz_bemerkung     TEXT,
  -- Ziel (Ende des Strompfades)
  stellplaetze_gesamt   INTEGER,
  stellplaetze_ausbau   INTEGER,
  ladepunkte_ac         INTEGER,
  ladepunkte_dc         INTEGER,
  leistung_je_lp_kw     NUMERIC(10,2),
  lastmanagement        TEXT,
  -- Bewertung
  variante_empfehlung   TEXT,                 -- Stromschiene | Einzelverkabelung | offen
  variante_begruendung  TEXT,
  foerderung_moeglich   TEXT,                 -- ja | nein | zu prüfen
  foerderung_hinweis    TEXT,
  risiken               TEXT,
  fazit                 TEXT,
  angelegt_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
  geaendert_am       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_begehung_kunde ON begehungen(kunde_id);
CREATE INDEX IF NOT EXISTS idx_begehung_status ON begehungen(status);

-- Der Strompfad: geordnete Abschnitte von der Einspeisung bis zum Ladepunkt.
CREATE TABLE IF NOT EXISTS begehung_abschnitte (
  id             SERIAL PRIMARY KEY,
  begehung_id    INTEGER NOT NULL REFERENCES begehungen(id) ON DELETE CASCADE,
  lfd            INTEGER NOT NULL DEFAULT 1,
  typ            TEXT NOT NULL,              -- siehe einstellung 'begehung_abschnittstypen'
  bezeichnung    TEXT,
  von_ort        TEXT,
  nach_ort       TEXT,
  laenge_m       NUMERIC(10,2),
  verlegeart     TEXT,                       -- Erdreich | Wand | Trasse | Kabelrinne | Bohrung | Bestand
  untergrund     TEXT,                       -- Asphalt | Pflaster | Beton | Erde | Rasen
  querschnitt    TEXT,
  bestand        BOOLEAN NOT NULL DEFAULT FALSE,   -- vorhanden oder neu zu bauen
  hindernisse    TEXT,
  bemerkung      TEXT
);
CREATE INDEX IF NOT EXISTS idx_abschnitt_begehung ON begehung_abschnitte(begehung_id, lfd);

-- Medien: Fotos, Videos, 360-Grad-Aufnahmen. Die Dateien liegen im Object
-- Storage, hier steht nur der Verweis.
CREATE TABLE IF NOT EXISTS begehung_medien (
  id             SERIAL PRIMARY KEY,
  begehung_id    INTEGER NOT NULL REFERENCES begehungen(id) ON DELETE CASCADE,
  abschnitt_id   INTEGER REFERENCES begehung_abschnitte(id) ON DELETE SET NULL,
  art            TEXT NOT NULL DEFAULT 'foto',     -- foto | video | panorama360 | video360 | dokument
  schluessel     TEXT NOT NULL,                    -- Objektschluessel im Storage
  dateiname      TEXT,
  groesse        BIGINT,
  mime           TEXT,
  titel          TEXT,
  aufgenommen_am TIMESTAMPTZ,
  geo_lat        NUMERIC(9,6),
  geo_lon        NUMERIC(9,6),
  hochgeladen_von INTEGER REFERENCES benutzer(id),
  hochgeladen_am TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_medien_begehung ON begehung_medien(begehung_id);

-- Feststellungen mit Mengengeruest: daraus entsteht spaeter das Angebot.
CREATE TABLE IF NOT EXISTS begehung_positionen (
  id             SERIAL PRIMARY KEY,
  begehung_id    INTEGER NOT NULL REFERENCES begehungen(id) ON DELETE CASCADE,
  abschnitt_id   INTEGER REFERENCES begehung_abschnitte(id) ON DELETE SET NULL,
  lfd            INTEGER NOT NULL DEFAULT 1,
  gewerk         TEXT,                        -- Tiefbau | Elektro | Sonstiges
  text           TEXT NOT NULL,
  einheit        TEXT,
  menge          NUMERIC(12,3) NOT NULL DEFAULT 1,
  bemerkung      TEXT
);
CREATE INDEX IF NOT EXISTS idx_bpos_begehung ON begehung_positionen(begehung_id, lfd);

-- ---------------------------------------------------------------------
-- (c) RECHNUNGEN — GoBD-konform
--
-- Kernregeln, die hier technisch durchgesetzt werden:
--   1. Nummernkreis luekenlos und fortlaufend (nummernkreise, Bereich 'RE').
--   2. Eine festgeschriebene Rechnung ist unveraenderlich. Der Trigger
--      verhindert jede Aenderung an Kopf und Positionen.
--   3. Korrektur ausschliesslich durch Storno und Neuausstellung, mit
--      gegenseitigem Verweis.
--   4. Jede Aenderung bis zur Festschreibung steht im Protokoll.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rechnungen (
  id                SERIAL PRIMARY KEY,
  nummer            TEXT UNIQUE NOT NULL,
  art               TEXT NOT NULL DEFAULT 'rechnung',  -- rechnung | storno | gutschrift
  kunde_id          INTEGER NOT NULL REFERENCES kunden(id) ON DELETE RESTRICT,
  projekt_id        INTEGER REFERENCES projekte(id) ON DELETE SET NULL,
  angebot_id        INTEGER REFERENCES angebote(id) ON DELETE SET NULL,
  retainer_id       INTEGER REFERENCES retainer(id) ON DELETE SET NULL,
  storniert_durch   INTEGER REFERENCES rechnungen(id),
  storno_zu         INTEGER REFERENCES rechnungen(id),
  empfaenger        TEXT,
  anrede            TEXT,
  betreff           TEXT,
  einleitung        TEXT,
  hinweise          TEXT,
  leistungszeitraum TEXT,
  datum             DATE NOT NULL DEFAULT CURRENT_DATE,
  faellig_am        DATE,
  zahlungsziel_tage INTEGER NOT NULL DEFAULT 14,
  mwst_satz         NUMERIC(5,2) NOT NULL DEFAULT 19,
  netto             NUMERIC(12,2) NOT NULL DEFAULT 0,
  mwst              NUMERIC(12,2) NOT NULL DEFAULT 0,
  brutto            NUMERIC(12,2) NOT NULL DEFAULT 0,
  bezahlt_am        DATE,
  bezahlt_betrag    NUMERIC(12,2),
  festgeschrieben   BOOLEAN NOT NULL DEFAULT FALSE,
  festgeschrieben_am TIMESTAMPTZ,
  festgeschrieben_von INTEGER REFERENCES benutzer(id),
  pruefsumme        TEXT,
  erstellt_von      INTEGER REFERENCES benutzer(id),
  angelegt_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
  geaendert_am      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rechnung_kunde ON rechnungen(kunde_id);
CREATE INDEX IF NOT EXISTS idx_rechnung_offen ON rechnungen(bezahlt_am) WHERE bezahlt_am IS NULL;

CREATE TABLE IF NOT EXISTS rechnung_positionen (
  id            SERIAL PRIMARY KEY,
  rechnung_id   INTEGER NOT NULL REFERENCES rechnungen(id) ON DELETE CASCADE,
  lfd           INTEGER NOT NULL DEFAULT 1,
  pos           TEXT,
  text          TEXT NOT NULL,
  langtext      TEXT,
  einheit       TEXT,
  menge         NUMERIC(12,3) NOT NULL DEFAULT 1,
  einzelpreis   NUMERIC(12,4) NOT NULL DEFAULT 0,
  gesamtpreis   NUMERIC(12,2) NOT NULL DEFAULT 0,
  ist_titel     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_rpos_rechnung ON rechnung_positionen(rechnung_id, lfd);

CREATE OR REPLACE FUNCTION rechnung_unveraenderlich() RETURNS TRIGGER AS $$
BEGIN
  -- Das Setzen der Festschreibung selbst und die reine Zahlungserfassung
  -- bleiben erlaubt; alles andere ist nach der Festschreibung gesperrt.
  IF OLD.festgeschrieben THEN
    IF NEW.netto IS DISTINCT FROM OLD.netto
       OR NEW.mwst IS DISTINCT FROM OLD.mwst
       OR NEW.brutto IS DISTINCT FROM OLD.brutto
       OR NEW.nummer IS DISTINCT FROM OLD.nummer
       OR NEW.datum IS DISTINCT FROM OLD.datum
       OR NEW.kunde_id IS DISTINCT FROM OLD.kunde_id
       OR NEW.empfaenger IS DISTINCT FROM OLD.empfaenger
       OR NEW.mwst_satz IS DISTINCT FROM OLD.mwst_satz
       OR NEW.festgeschrieben = FALSE THEN
      RAISE EXCEPTION 'Rechnung % ist festgeschrieben und kann nicht mehr geändert werden. Korrektur ausschließlich über Storno und Neuausstellung.', OLD.nummer;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rechnung_unveraenderlich ON rechnungen;
CREATE TRIGGER trg_rechnung_unveraenderlich
  BEFORE UPDATE ON rechnungen
  FOR EACH ROW EXECUTE FUNCTION rechnung_unveraenderlich();

CREATE OR REPLACE FUNCTION rechnungsposition_unveraenderlich() RETURNS TRIGGER AS $$
DECLARE fest BOOLEAN;
BEGIN
  SELECT festgeschrieben INTO fest FROM rechnungen
   WHERE id = COALESCE(NEW.rechnung_id, OLD.rechnung_id);
  IF fest THEN
    RAISE EXCEPTION 'Die Rechnung ist festgeschrieben. Positionen können nicht mehr geändert werden.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rpos_unveraenderlich ON rechnung_positionen;
CREATE TRIGGER trg_rpos_unveraenderlich
  BEFORE INSERT OR UPDATE OR DELETE ON rechnung_positionen
  FOR EACH ROW EXECUTE FUNCTION rechnungsposition_unveraenderlich();

INSERT INTO nummernkreise (bereich, jahr, letzte) VALUES ('RE', 2026, 0), ('BG', 2026, 0)
ON CONFLICT (bereich, jahr) DO NOTHING;

-- ---------------------------------------------------------------------
-- (d) RETAINER-KALKULATION UND ZEITERFASSUNG
-- Grundlage: Leistungsnachweis-Fierax-Retainer-und-mehr.xlsx
-- ---------------------------------------------------------------------

ALTER TABLE retainer ADD COLUMN IF NOT EXISTS stundensatz_extra NUMERIC(10,2) NOT NULL DEFAULT 120;
ALTER TABLE retainer ADD COLUMN IF NOT EXISTS km_satz NUMERIC(10,2) NOT NULL DEFAULT 0.50;
ALTER TABLE retainer ADD COLUMN IF NOT EXISTS start_ort TEXT DEFAULT 'Ahrensburg';
ALTER TABLE retainer ADD COLUMN IF NOT EXISTS laufzeit_monate INTEGER DEFAULT 12;

CREATE TABLE IF NOT EXISTS retainer_bausteine (
  id            SERIAL PRIMARY KEY,
  retainer_id   INTEGER NOT NULL REFERENCES retainer(id) ON DELETE CASCADE,
  baustein      TEXT NOT NULL,
  inhalt        TEXT NOT NULL,
  von_monat     INTEGER,
  bis_monat     INTEGER,
  stunden_plan  NUMERIC(8,2) NOT NULL DEFAULT 0,
  erledigt      BOOLEAN NOT NULL DEFAULT FALSE,
  lfd           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_baustein_retainer ON retainer_bausteine(retainer_id, lfd);

CREATE TABLE IF NOT EXISTS zeiterfassung (
  id             SERIAL PRIMARY KEY,
  retainer_id    INTEGER REFERENCES retainer(id) ON DELETE SET NULL,
  projekt_id     INTEGER REFERENCES projekte(id) ON DELETE SET NULL,
  begehung_id    INTEGER REFERENCES begehungen(id) ON DELETE SET NULL,
  benutzer_id    INTEGER REFERENCES benutzer(id),
  wer            TEXT,
  datum          DATE NOT NULL DEFAULT CURRENT_DATE,
  monat          TEXT NOT NULL,
  von            TEXT,
  bis            TEXT,
  pause_min      INTEGER NOT NULL DEFAULT 0,
  stunden        NUMERIC(8,2) NOT NULL DEFAULT 0,
  taetigkeit     TEXT NOT NULL,
  im_retainer    BOOLEAN NOT NULL DEFAULT TRUE,
  km             NUMERIC(10,2) NOT NULL DEFAULT 0,
  reiseanschrift TEXT,
  abgerechnet    BOOLEAN NOT NULL DEFAULT FALSE,
  rechnung_id    INTEGER REFERENCES rechnungen(id) ON DELETE SET NULL,
  angelegt_am    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zeit_monat ON zeiterfassung(retainer_id, monat);
CREATE INDEX IF NOT EXISTS idx_zeit_offen ON zeiterfassung(abgerechnet) WHERE abgerechnet = FALSE;

-- ---------------------------------------------------------------------
-- Startwerte
-- ---------------------------------------------------------------------
INSERT INTO einstellungen (schluessel, wert, beschreibung) VALUES
  ('begehung_abschnittstypen',
   'Netzanschluss / Übergabe,Zählerplatz / Messung,Hauptverteilung,Steigleitung,Trasse Außenbereich,Trasse Innenbereich,Unterverteilung / Ladeverteiler,Stromschiene,Abgangskasten,Ladepunkt AC (Wallbox),Ladepunkt DC (HPC)',
   'Auswahl für die Abschnitte des Strompfades. Reihenfolge = Vorschlagsreihenfolge in der Begehungsmaske.'),
  ('begehung_pflichtfotos',
   'Netzanschluss / Zählerplatz,Hauptverteilung,geplante Trassenführung,Stellplatzsituation,Zufahrt / Baustellenzugang,Position künftiger Ladepunkt',
   'Fotos, die eine Begehung mindestens enthalten muss, bevor sie freigegeben werden kann.'),
  ('rechnung_zahlungsziel_tage','14','Standard-Zahlungsziel neuer Rechnungen in Tagen.'),
  ('rechnung_fuss','Zahlbar ohne Abzug innerhalb des angegebenen Zahlungsziels. Bitte geben Sie bei der Überweisung die Rechnungsnummer an.',
   'Fußtext unter jeder Rechnung.'),
  ('medien_speicher','r2','Ablage für Fotos und Videos: r2 (Object Storage) oder lokal.'),
  ('preisschutz_hinweis',
   'Positionen aus den eingelesenen Standard-LVs stammen aus Unterlagen der Service4Charger GmbH und sind ausschließlich als interner Vergleichswert nutzbar.',
   'Hinweis, der im Preiskatalog über den nur internen Positionen erscheint.')
ON CONFLICT (schluessel) DO NOTHING;
