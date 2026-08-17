-- =====================================================================
-- STEER.E Plattform · Migration 006 — Lernschleife
--
-- Drei Bausteine, die aufeinander aufbauen:
--
--  (a) PRUEFREGELN   Die Anwendung stellt bei jeder Begehung genau die
--                    Rueckfragen, die spaeter im Angebot fehlen wuerden.
--                    Die Regeln stehen in der Datenbank, nicht im Code —
--                    sie lassen sich ohne Programmierer erweitern.
--
--  (b) ERFAHRUNGEN   Wird ein Angebot beauftragt, merkt sich die Anwendung,
--                    welche Positionen bei diesem Objekttyp tatsaechlich
--                    drin waren. Beim naechsten aehnlichen Objekt schlaegt
--                    sie genau diese vor. Das ist kein Modell, das sich
--                    selbst trainiert, sondern eine Haeufigkeitsstatistik
--                    aus den eigenen Auftraegen — nachvollziehbar und
--                    jederzeit einsehbar.
--
--  (c) STUECKLISTE   Aus Trassenlaengen, Stellplaetzen und Ladepunkten
--                    faellt eine Materialliste. Die Umrechnungsfaktoren
--                    sind Regeln, keine fest verdrahteten Zahlen.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (a) Pruefregeln
--
-- pruefart legt fest, WIE geprueft wird. Bewusst eine feste Auswahl statt
-- freier Ausdruecke: eine Regel darf eine Frage stellen, aber niemals
-- beliebigen Code ausfuehren.
--   feld_fehlt        parameter = Spaltenname in begehungen
--   medium_fehlt      parameter = Titel der Pflichtaufnahme
--   abschnitt_fehlt   parameter = Abschnittstyp
--   trasse_null       keine Trassenlaenge erfasst
--   zahl_kleiner      parameter = Spalte, vergleich = Grenze
--   text_zu_kurz      parameter = Spalte, vergleich = Mindestlaenge
--   keine_position    keine Feststellung erfasst
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pruefregeln (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  pruefart      TEXT NOT NULL,
  parameter     TEXT,
  vergleich     NUMERIC,
  frage         TEXT NOT NULL,
  warum         TEXT,
  streng        BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE blockiert die Freigabe
  gilt_fuer_art TEXT,                             -- AC | DC | NULL (immer)
  reihenfolge   INTEGER NOT NULL DEFAULT 100,
  aktiv         BOOLEAN NOT NULL DEFAULT TRUE,
  angelegt_am   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_regel_aktiv ON pruefregeln(aktiv, reihenfolge);

-- Antworten auf die Rueckfragen. Eine beantwortete Frage kommt nicht wieder.
CREATE TABLE IF NOT EXISTS begehung_antworten (
  id           SERIAL PRIMARY KEY,
  begehung_id  INTEGER NOT NULL REFERENCES begehungen(id) ON DELETE CASCADE,
  regel_id     INTEGER REFERENCES pruefregeln(id) ON DELETE CASCADE,
  antwort      TEXT,
  erledigt     BOOLEAN NOT NULL DEFAULT TRUE,
  von          INTEGER REFERENCES benutzer(id),
  am           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_antwort_eindeutig ON begehung_antworten(begehung_id, regel_id);

-- ---------------------------------------------------------------------
-- (b) Erfahrungen
--
-- merkmal beschreibt den Objekttyp, z. B. 'art:AC' oder
-- 'art:AC|nutzung:tiefgarage'. gesamt zaehlt, wie oft ein Objekt dieses
-- Typs beauftragt wurde; treffer, wie oft diese Position dabei war.
-- Der Quotient ist die Aussage: "bei 7 von 8 vergleichbaren Objekten".
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erfahrungen (
  id           SERIAL PRIMARY KEY,
  merkmal      TEXT NOT NULL,
  text         TEXT NOT NULL,
  einheit      TEXT,
  treffer      INTEGER NOT NULL DEFAULT 0,
  zuletzt_am   TIMESTAMPTZ,
  beispiel     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_erfahrung_eindeutig ON erfahrungen(merkmal, md5(text));
CREATE INDEX IF NOT EXISTS idx_erfahrung_merkmal ON erfahrungen(merkmal, treffer DESC);

-- Wie oft ein Merkmal ueberhaupt vorkam — der Nenner.
CREATE TABLE IF NOT EXISTS merkmal_zaehler (
  merkmal   TEXT PRIMARY KEY,
  gesamt    INTEGER NOT NULL DEFAULT 0,
  zuletzt_am TIMESTAMPTZ
);

-- Damit dieselbe Auswertung nicht zweimal zaehlt.
ALTER TABLE angebote ADD COLUMN IF NOT EXISTS gelernt_am TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- (c) Stuecklistenregeln
--
-- bezug legt fest, WORAUS die Menge kommt:
--   fest | trassenlaenge | stellplaetze_gesamt | stellplaetze_ausbau
--   ladepunkte_ac | ladepunkte_dc | abschnitt_typ
-- menge = bezugswert * faktor, danach Verschnittzuschlag, dann aufrunden
-- (bei Stueckzahlen) bzw. auf volle Meter.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stueckliste_regeln (
  id             SERIAL PRIMARY KEY,
  gruppe         TEXT NOT NULL DEFAULT 'Elektro',
  artikel        TEXT NOT NULL,
  beschreibung   TEXT,
  einheit        TEXT NOT NULL DEFAULT 'Stk.',
  bezug          TEXT NOT NULL DEFAULT 'fest',
  parameter      TEXT,                      -- bei bezug = abschnitt_typ
  faktor         NUMERIC(12,4) NOT NULL DEFAULT 1,
  verschnitt_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  aufrunden      BOOLEAN NOT NULL DEFAULT TRUE,
  gilt_fuer_art  TEXT,
  reihenfolge    INTEGER NOT NULL DEFAULT 100,
  aktiv          BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_slregel ON stueckliste_regeln(aktiv, reihenfolge);

-- =====================================================================
-- Startregeln
-- =====================================================================

INSERT INTO pruefregeln (name, pruefart, parameter, vergleich, frage, warum, streng, gilt_fuer_art, reihenfolge)
SELECT * FROM (VALUES
  ('Netzanschlussart', 'feld_fehlt', 'netz_art', NULL,
   'Wie ist der Netzanschluss ausgeführt — Hausanschluss, Trafostation oder eigene Übergabe?',
   'Ohne diese Angabe lässt sich weder das Messkonzept noch die Übergabestation kalkulieren. Der Strompfad beginnt hier.',
   TRUE, NULL, 10),

  ('Anschlussleistung', 'feld_fehlt', 'netz_leistung_kw', NULL,
   'Welche Anschlussleistung steht am Übergabepunkt zur Verfügung (kW)?',
   'Die Leistung entscheidet darüber, ob überhaupt ohne Netzverstärkung gebaut werden kann. Nachträglich ist das der teuerste Punkt.',
   TRUE, NULL, 20),

  ('Freie Reserve', 'feld_fehlt', 'netz_reserve_kw', NULL,
   'Wie viel Leistung ist davon tatsächlich frei — also nach Abzug des Bestandsverbrauchs?',
   'Die Anschlussleistung allein sagt nichts. Erst die freie Reserve bestimmt, wie viele Ladepunkte gleichzeitig laden können.',
   FALSE, NULL, 30),

  ('Zählerplatz', 'feld_fehlt', 'netz_zaehler', NULL,
   'In welchem Zustand ist der Zählerplatz, und ist Platz für eine zusätzliche Messung?',
   'Ein Zählerplatzumbau taucht sonst erst auf der Baustelle auf und ist ein klassischer Nachtrag.',
   FALSE, NULL, 40),

  ('Foto Netzanschluss', 'medium_fehlt', 'Netzanschluss', NULL,
   'Es fehlt die Aufnahme des Netzanschlusses.',
   'Ein Begehungsbericht ohne Bild vom Anschlusspunkt ist eine Behauptung. Der Kunde und der VNB verlassen sich darauf.',
   TRUE, NULL, 50),

  ('Foto Zählerplatz', 'medium_fehlt', 'Zählerplatz', NULL,
   'Es fehlt die Aufnahme des Zählerplatzes.',
   'Der Zustand des Zählerplatzes entscheidet über Umbau ja oder nein — im Streitfall zählt das Bild.',
   FALSE, NULL, 60),

  ('Trassenlänge', 'trasse_null', NULL, NULL,
   'Kein Abschnitt hat eine Länge. Wie lang ist die Trasse vom Anschluss bis zum letzten Ladepunkt?',
   'Die Trassenlänge ist die mengenbestimmende Größe für Kabel, Stromschiene und Tiefbau. Ohne sie wird jedes Angebot geraten.',
   TRUE, NULL, 70),

  ('Verlegeart erfasst', 'abschnitt_fehlt', 'Netzanschluss / Übergabe', NULL,
   'Der Abschnitt „Netzanschluss / Übergabe" fehlt im Strompfad.',
   'Der Pfad muss lückenlos sein — von dort, wo der Strom ankommt, bis zum Abnehmer. Eine Lücke im Pfad ist eine Lücke im Angebot.',
   FALSE, NULL, 80),

  ('Ladepunkt erfasst', 'abschnitt_fehlt', 'Ladepunkt AC (Wallbox)', NULL,
   'Der Abschnitt „Ladepunkt AC (Wallbox)" fehlt.',
   'Das Ende des Strompfades gehört genauso aufgenommen wie der Anfang.',
   FALSE, 'AC', 90),

  ('Ladepunkt DC erfasst', 'abschnitt_fehlt', 'Ladepunkt DC (HPC)', NULL,
   'Der Abschnitt „Ladepunkt DC (HPC)" fehlt.',
   'Das Ende des Strompfades gehört genauso aufgenommen wie der Anfang.',
   FALSE, 'DC', 90),

  ('Stellplatzzahl', 'feld_fehlt', 'stellplaetze_gesamt', NULL,
   'Wie viele Stellplätze hat das Objekt insgesamt?',
   'Die Gesamtzahl ist die Grundlage für Fördermittelprüfung und für die Frage, wie weit vorgerüstet wird.',
   FALSE, NULL, 100),

  ('Ausbaustufe', 'feld_fehlt', 'stellplaetze_ausbau', NULL,
   'Wie viele Stellplätze sollen jetzt vorgerüstet werden?',
   'Vorrüstung und tatsächliche Ladepunkte sind zwei verschiedene Mengen. Sie werden im Angebot getrennt ausgewiesen.',
   FALSE, NULL, 110),

  ('Lastmanagement', 'feld_fehlt', 'lastmanagement', NULL,
   'Ist ein Lastmanagement vorgesehen, und wenn ja, statisch oder dynamisch?',
   'Ohne Lastmanagement bestimmt die Summe aller Ladepunkte die Anschlussleistung — meist der Punkt, an dem ein Projekt kippt.',
   FALSE, NULL, 120),

  ('Empfehlung begründet', 'text_zu_kurz', 'variante_begruendung', 40,
   'Warum diese Variante und nicht die andere?',
   'Der Satz, der die Empfehlung begründet, ist im Kundengespräch der wichtigste des ganzen Berichts.',
   FALSE, NULL, 130),

  ('Risiken benannt', 'text_zu_kurz', 'risiken', 20,
   'Welche Risiken sind vor Ort erkennbar — Brandabschnitte, Fremdleitungen, Deckenhöhe, Zufahrt?',
   'Benannte Risiken sind kalkulierbar. Unbenannte werden zu Nachträgen und kosten Vertrauen.',
   FALSE, NULL, 140),

  ('Feststellungen', 'keine_position', NULL, NULL,
   'Es ist keine einzige Feststellung mit Menge erfasst.',
   'Aus den Feststellungen entsteht das Mengengerüst des Angebots. Ohne sie bleibt nur die Vorlage.',
   FALSE, NULL, 150),

  ('Fazit', 'text_zu_kurz', 'fazit', 30,
   'Wie lautet das Fazit in zwei, drei Sätzen?',
   'Das Fazit ist der Teil des Berichts, den der Entscheider tatsächlich liest.',
   FALSE, NULL, 160)
) AS x(name, pruefart, parameter, vergleich, frage, warum, streng, gilt_fuer_art, reihenfolge)
WHERE NOT EXISTS (SELECT 1 FROM pruefregeln);

-- ---------- Stuecklistenregeln ----------
INSERT INTO stueckliste_regeln (gruppe, artikel, beschreibung, einheit, bezug, parameter, faktor, verschnitt_pct, aufrunden, gilt_fuer_art, reihenfolge)
SELECT * FROM (VALUES
  ('Elektro','Stromschiene inkl. Verbinder','Zentrale Schiene entlang der Trasse','m','trassenlaenge',NULL,1.00::numeric,5.00::numeric,TRUE,'AC',10),
  ('Elektro','Befestigungsmaterial Stromschiene','Deckenabhängung, Dübel, Schienenhalter','Satz','trassenlaenge',NULL,0.5000::numeric,0::numeric,TRUE,'AC',20),
  ('Elektro','Abgangskasten','Vorrüstung je Stellplatz','Stk.','stellplaetze_ausbau',NULL,1.00::numeric,0::numeric,TRUE,'AC',30),
  ('Elektro','Wallbox AC','Ladepunkt inkl. Halterung','Stk.','ladepunkte_ac',NULL,1.00::numeric,0::numeric,TRUE,'AC',40),
  ('Elektro','Zuleitung Wallbox 5x6 mm²','Anschlussleitung Abgangskasten zur Wallbox','m','ladepunkte_ac',NULL,6.00::numeric,10.00::numeric,TRUE,'AC',50),
  ('Elektro','Leitungsschutzschalter je Ladepunkt','C-Charakteristik, 3-polig','Stk.','ladepunkte_ac',NULL,1.00::numeric,0::numeric,TRUE,'AC',60),
  ('Elektro','FI-Schutzschalter Typ A EV','je Ladepunkt, sofern nicht im Gerät','Stk.','ladepunkte_ac',NULL,1.00::numeric,0::numeric,TRUE,'AC',70),
  ('Elektro','Unterverteilung Ladeinfrastruktur','Schrank inkl. Bestückung','Stk.','fest',NULL,1.00::numeric,0::numeric,TRUE,NULL,80),
  ('Elektro','Lastmanagement-Controller','inkl. Stromwandler und Messung','Stk.','fest',NULL,1.00::numeric,0::numeric,TRUE,NULL,90),
  ('Elektro','Zuleitung Hauptverteilung zur UV','NYY-J, Querschnitt nach Berechnung','m','trassenlaenge',NULL,1.00::numeric,10.00::numeric,TRUE,NULL,100),
  ('Elektro','Kabeltrasse / Rinne','Innenbereich, verzinkt','m','trassenlaenge',NULL,1.00::numeric,5.00::numeric,TRUE,NULL,110),
  ('Elektro','Brandschottung','je Durchbruch Brandabschnitt','Stk.','fest',NULL,2.00::numeric,0::numeric,TRUE,NULL,120),

  ('Tiefbau','Kabelgraben Aushub und Verfüllung','Regelgraben nach LV','m','trassenlaenge',NULL,1.00::numeric,0::numeric,TRUE,'DC',130),
  ('Tiefbau','Leerrohr DN110','inkl. Zugdraht','m','trassenlaenge',NULL,1.00::numeric,5.00::numeric,TRUE,'DC',140),
  ('Tiefbau','Kabelsand / Bettung','0-2 mm','t','trassenlaenge',NULL,0.2000::numeric,0::numeric,TRUE,'DC',150),
  ('Tiefbau','Trassenwarnband','rot, mit Aufdruck','m','trassenlaenge',NULL,1.00::numeric,5.00::numeric,TRUE,'DC',160),
  ('Tiefbau','Fundament Ladesäule','inkl. Einführung und Erdung','Stk.','ladepunkte_dc',NULL,1.00::numeric,0::numeric,TRUE,'DC',170),
  ('Tiefbau','Oberflächenwiederherstellung','Asphalt oder Pflaster nach Bestand','m²','trassenlaenge',NULL,0.8000::numeric,0::numeric,TRUE,'DC',180),

  ('Elektro','DC-Ladeeinheit','Schnellladeeinheit inkl. Kabel','Stk.','ladepunkte_dc',NULL,1.00::numeric,0::numeric,TRUE,'DC',190),
  ('Elektro','Übergabestation / Trafofeld','inkl. Schutz- und Wandlermessung','Stk.','fest',NULL,1.00::numeric,0::numeric,TRUE,'DC',200),
  ('Elektro','Mittelspannungskabel','NA2XS(F)2Y, Länge nach Trasse','m','trassenlaenge',NULL,1.00::numeric,10.00::numeric,TRUE,'DC',210),

  ('Dokumentation','Prüfprotokoll DGUV V3','je Ladepunkt','Stk.','ladepunkte_ac',NULL,1.00::numeric,0::numeric,TRUE,NULL,220),
  ('Dokumentation','Beschilderung und Kennzeichnung','Stellplatzmarkierung, Hinweisschilder','Stk.','stellplaetze_ausbau',NULL,1.00::numeric,0::numeric,TRUE,NULL,230)
) AS x(gruppe, artikel, beschreibung, einheit, bezug, parameter, faktor, verschnitt_pct, aufrunden, gilt_fuer_art, reihenfolge)
WHERE NOT EXISTS (SELECT 1 FROM stueckliste_regeln);
