-- =====================================================================
-- 012  Kalenderabgleich in beide Richtungen
--
-- Bisher gab es nur den Hinweg: ein Knopf schrieb den Termin nach Outlook.
-- Wurde er dort verschoben oder abgesagt, erfuhr STEER.E davon nichts —
-- und damit stimmte genau die Information nicht mehr, wegen der man in die
-- Anwendung schaut.
--
-- ZWEI ENTSCHEIDUNGEN, die man kennen sollte:
--
-- 1. Es wird NICHT der ganze Outlook-Kalender eingesaugt. Zurueck kommen nur
--    Ereignisse, die aus STEER.E stammen — erkennbar an der Kategorie
--    "STEER.E" und der Zuordnung in m365_termin_ereignis. Der Zahnarzttermin
--    des Anwenders hat in einer Vertriebsdatenbank nichts verloren, und das
--    laesst sich spaeter nicht mehr sauber trennen.
--
-- 2. Die Zuordnung liegt in einer eigenen Tabelle statt in einer Spalte an
--    termine. Grund: Jeder Benutzer verbindet sein eigenes Postfach. Bei
--    einer einzelnen Spalte wuerde der zweite Benutzer die Ereigniskennung
--    des ersten ueberschreiben und dessen Termin im Kalender verwaisen
--    lassen. Die alten Spalten termine.m365_ereignis_id bleiben bestehen und
--    werden weiter mitgeschrieben, damit vorhandene Verknuepfungen nicht
--    verloren gehen.
-- =====================================================================

-- ---------- Zuordnung Termin <-> Outlook-Ereignis, je Benutzer ----------
CREATE TABLE IF NOT EXISTS m365_termin_ereignis (
  id          SERIAL PRIMARY KEY,
  termin_id   INTEGER NOT NULL REFERENCES termine(id) ON DELETE CASCADE,
  benutzer_id INTEGER NOT NULL REFERENCES benutzer(id) ON DELETE CASCADE,
  ereignis_id TEXT NOT NULL,
  etag        TEXT,
  -- Fingerabdruck des zuletzt gesendeten Inhalts. Damit wird nur dann
  -- geschrieben, wenn sich wirklich etwas geaendert hat — sonst erzeugte
  -- jeder Lauf eine Aenderungsbenachrichtigung bei allen Teilnehmern.
  stand_hash  TEXT,
  stand_am    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_m365_te_paar ON m365_termin_ereignis(termin_id, benutzer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_m365_te_ereignis ON m365_termin_ereignis(benutzer_id, ereignis_id);

-- ---------- Zustand des Abgleichs je Benutzer ----------
CREATE TABLE IF NOT EXISTS m365_abgleich (
  benutzer_id    INTEGER PRIMARY KEY REFERENCES benutzer(id) ON DELETE CASCADE,
  aktiv          BOOLEAN NOT NULL DEFAULT TRUE,
  -- 'beide' | 'raus' | 'rein' — wer nur veroeffentlichen will, stellt 'raus'.
  richtung       TEXT NOT NULL DEFAULT 'beide',
  delta_link     TEXT,
  zuletzt_am     TIMESTAMPTZ,
  letzter_lauf   TEXT,
  letzter_fehler TEXT,
  anz_raus       INTEGER NOT NULL DEFAULT 0,
  anz_rein       INTEGER NOT NULL DEFAULT 0
);

-- ---------- Termine: Aenderungszeitpunkt und Absage ----------
-- Ohne einen verlaesslichen Aenderungszeitpunkt laesst sich bei einem
-- Konflikt nicht entscheiden, welche Seite juenger ist. Der Trigger setzt
-- ihn bei jeder Aenderung selbst; auf die Disziplin der aufrufenden Stelle
-- ist dabei kein Verlass.
ALTER TABLE termine ADD COLUMN IF NOT EXISTS geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE termine ADD COLUMN IF NOT EXISTS abgesagt_am  TIMESTAMPTZ;
ALTER TABLE termine ADD COLUMN IF NOT EXISTS ende_uhrzeit TEXT;

-- Entfernt jemand im Kalender die Kategorie "STEER.E", ist das eine Ansage:
-- diesen Termin bitte nicht mehr abgleichen. Ohne diese Spalte wuerde der
-- naechste Hinweg ihn sofort neu anlegen — der Anwender kaeme gegen die
-- Automatik nicht an.
ALTER TABLE termine ADD COLUMN IF NOT EXISTS kalender_aus BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION termin_geaendert() RETURNS TRIGGER AS $$
BEGIN
  NEW.geaendert_am := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_termin_geaendert ON termine;
CREATE TRIGGER trg_termin_geaendert
  BEFORE UPDATE ON termine
  FOR EACH ROW EXECUTE FUNCTION termin_geaendert();

CREATE INDEX IF NOT EXISTS idx_termine_geaendert ON termine(geaendert_am);

-- ---------- Protokoll des Abgleichs ----------
-- Wenn ein Termin auf einmal anders aussieht, muss nachvollziehbar sein,
-- woher die Aenderung kam. Sonst steht am Ende Aussage gegen Aussage.
CREATE TABLE IF NOT EXISTS m365_abgleich_protokoll (
  id          SERIAL PRIMARY KEY,
  benutzer_id INTEGER REFERENCES benutzer(id) ON DELETE SET NULL,
  termin_id   INTEGER REFERENCES termine(id) ON DELETE SET NULL,
  richtung    TEXT NOT NULL,
  vorgang     TEXT NOT NULL,
  hinweis     TEXT,
  am          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_abgleich_prot ON m365_abgleich_protokoll(am DESC);

INSERT INTO einstellungen (schluessel, wert, beschreibung) VALUES
  ('kalender_abgleich_minuten', '15', 'Abstand des automatischen Kalenderabgleichs in Minuten'),
  ('kalender_fenster_tage_zurueck', '30', 'Wie weit der Abgleich in die Vergangenheit schaut'),
  ('kalender_fenster_tage_voraus', '365', 'Wie weit der Abgleich in die Zukunft schaut')
ON CONFLICT (schluessel) DO NOTHING;
