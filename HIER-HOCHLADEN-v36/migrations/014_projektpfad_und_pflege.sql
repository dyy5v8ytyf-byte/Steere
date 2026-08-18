-- =====================================================================
-- 014  Projektpfad, Pflegbarkeit, Ampel
--
-- Sammelmigration fuer eine Reihe von Luecken, die im Alltag aufgefallen
-- sind. Gemeinsamer Nenner: Angelegtes liess sich nicht mehr aendern, und
-- Zusammengehoerendes war nicht verbunden.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (a) ANSPRECHPARTNER PFLEGBAR
-- Bisher gab es nur ein Anlegen. Ein Tippfehler in einer Telefonnummer
-- blieb fuer immer stehen. Geloescht wird nicht — deaktiviert: Ein
-- Ansprechpartner haengt an Terminen und Gespraechsnotizen der
-- Vergangenheit, und die sollen lesbar bleiben.
-- ---------------------------------------------------------------------
ALTER TABLE ansprechpartner ADD COLUMN IF NOT EXISTS aktiv        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ansprechpartner ADD COLUMN IF NOT EXISTS position     TEXT;
ALTER TABLE ansprechpartner ADD COLUMN IF NOT EXISTS mobil        TEXT;
ALTER TABLE ansprechpartner ADD COLUMN IF NOT EXISTS bemerkung    TEXT;
ALTER TABLE ansprechpartner ADD COLUMN IF NOT EXISTS angelegt_am  TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE ansprechpartner ADD COLUMN IF NOT EXISTS geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------
-- (b) MITARBEITER ALS RICHTIGE STAMMDATEN
-- Ohne gepflegte Mitarbeiter laesst sich weder eine Aufgabe zuweisen noch
-- ein Projektmanager benennen. Die Tabelle gab es, aber ohne die Felder,
-- die man dafuer braucht.
-- ---------------------------------------------------------------------
ALTER TABLE mitarbeiter ADD COLUMN IF NOT EXISTS telefon      TEXT;
ALTER TABLE mitarbeiter ADD COLUMN IF NOT EXISTS mobil        TEXT;
ALTER TABLE mitarbeiter ADD COLUMN IF NOT EXISTS funktion     TEXT;
ALTER TABLE mitarbeiter ADD COLUMN IF NOT EXISTS kuerzel      TEXT;
ALTER TABLE mitarbeiter ADD COLUMN IF NOT EXISTS eintritt_am  DATE;
ALTER TABLE mitarbeiter ADD COLUMN IF NOT EXISTS bemerkung    TEXT;
-- Verbindung zum Anmeldekonto: Wer sich anmeldet, ist derselbe Mensch wie
-- der, dem Aufgaben zugewiesen werden. Ohne diese Bruecke fuehrt man zwei
-- Personallisten nebeneinander.
ALTER TABLE mitarbeiter ADD COLUMN IF NOT EXISTS benutzer_id  INTEGER REFERENCES benutzer(id) ON DELETE SET NULL;
ALTER TABLE mitarbeiter ADD COLUMN IF NOT EXISTS angelegt_am  TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS idx_mitarbeiter_benutzer
  ON mitarbeiter(benutzer_id) WHERE benutzer_id IS NOT NULL;

-- Vorhandene Anmeldekonten einmalig als Mitarbeiter uebernehmen, sofern
-- es noch keinen gleichnamigen Eintrag gibt. Damit ist die Liste nicht
-- leer, ohne dass jemand erfunden wird.
INSERT INTO mitarbeiter (name, rolle, email, benutzer_id, aktiv)
SELECT b.name, 'Vertrieb', b.email, b.id, b.aktiv
  FROM benutzer b
 WHERE b.rolle <> 'partner'
   AND NOT EXISTS (SELECT 1 FROM mitarbeiter m WHERE lower(m.name) = lower(b.name))
   AND NOT EXISTS (SELECT 1 FROM mitarbeiter m WHERE m.benutzer_id = b.id);

-- Bereits vorhandene Mitarbeiter mit gleichem Namen mit dem Konto verbinden.
UPDATE mitarbeiter m SET benutzer_id = b.id
  FROM benutzer b
 WHERE m.benutzer_id IS NULL AND b.rolle <> 'partner'
   AND lower(m.name) = lower(b.name)
   AND NOT EXISTS (SELECT 1 FROM mitarbeiter x WHERE x.benutzer_id = b.id);

-- ---------------------------------------------------------------------
-- (c) TERMINE: AMPEL UND AENDERBARKEIT
-- Ein eingetragener Termin liess sich nicht mehr verschieben, und
-- durchgefuehrte waren von ausstehenden nicht zu unterscheiden.
--
-- Der Zustand wird NICHT allein aus dem Datum abgeleitet: Ein Termin, der
-- gestern war, kann stattgefunden haben oder ausgefallen sein. Das ist ein
-- Unterschied, den nur ein Mensch kennt. Abgeleitet wird nur "ueberfaellig"
-- — also vorbei und immer noch nicht bestaetigt.
-- ---------------------------------------------------------------------
ALTER TABLE termine ADD COLUMN IF NOT EXISTS durchgefuehrt_am TIMESTAMPTZ;
ALTER TABLE termine ADD COLUMN IF NOT EXISTS begehung_id      INTEGER REFERENCES begehungen(id) ON DELETE SET NULL;
ALTER TABLE termine ADD COLUMN IF NOT EXISTS angelegt_am      TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_termine_begehung ON termine(begehung_id);

-- ---------------------------------------------------------------------
-- (d) AUFGABEN: ERLEDIGTES BLEIBT SICHTBAR, UND HAENGT AM VORGANG
-- Eine erledigte Aufgabe verschwand aus der Liste und aus dem Kundenprofil.
-- Damit war nicht mehr nachvollziehbar, was jemand getan hat.
-- ---------------------------------------------------------------------
ALTER TABLE aufgaben ADD COLUMN IF NOT EXISTS erledigt_am  TIMESTAMPTZ;
ALTER TABLE aufgaben ADD COLUMN IF NOT EXISTS erledigt_von INTEGER REFERENCES benutzer(id) ON DELETE SET NULL;
ALTER TABLE aufgaben ADD COLUMN IF NOT EXISTS begehung_id  INTEGER REFERENCES begehungen(id) ON DELETE SET NULL;
ALTER TABLE aufgaben ADD COLUMN IF NOT EXISTS angebot_id   INTEGER REFERENCES angebote(id) ON DELETE SET NULL;
ALTER TABLE aufgaben ADD COLUMN IF NOT EXISTS termin_id    INTEGER REFERENCES termine(id) ON DELETE SET NULL;

-- Bereits erledigte Aufgaben bekommen einen Zeitpunkt, damit die Anzeige
-- nicht mit leeren Feldern anfaengt. Das Anlegedatum ist die ehrlichste
-- verfuegbare Naeherung — es wird als solche gekennzeichnet.
UPDATE aufgaben SET erledigt_am = angelegt_am
 WHERE erledigt = TRUE AND erledigt_am IS NULL;

-- ---------------------------------------------------------------------
-- (e) ANGEBOTE: LOESCHEN UND ZURUECKZIEHEN
-- Ein Entwurf, der aus Versehen entstand, blieb ewig in der Liste. Ein
-- versendetes Angebot dagegen ist hinausgegangen — das wird nicht
-- geloescht, sondern zurueckgezogen, mit Grund.
-- ---------------------------------------------------------------------
ALTER TABLE angebote ADD COLUMN IF NOT EXISTS zurueckgezogen_am    TIMESTAMPTZ;
ALTER TABLE angebote ADD COLUMN IF NOT EXISTS zurueckgezogen_grund TEXT;

-- ---------------------------------------------------------------------
-- (f) PROJEKTPFAD
-- Begehung, Angebot, Termin und Aufgabe zeigen bereits auf ein Projekt.
-- Was fehlte, war die Pflicht dazu und ein Weg, aus einer Begehung ein
-- Projekt zu machen. Begehungen SIND Projekte — eine Begehung ohne
-- Projekt ist ein Vorgang ohne Akte.
-- ---------------------------------------------------------------------
ALTER TABLE projekte ADD COLUMN IF NOT EXISTS aus_begehung_id INTEGER REFERENCES begehungen(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projekte_begehung ON projekte(aus_begehung_id);
CREATE INDEX IF NOT EXISTS idx_begehungen_projekt ON begehungen(projekt_id);
CREATE INDEX IF NOT EXISTS idx_angebote_begehung ON angebote(begehung_id);
CREATE INDEX IF NOT EXISTS idx_aufgaben_kunde ON aufgaben(kunde_id);

-- ---------------------------------------------------------------------
-- (g) STORNO GLEICHT DIE RECHNUNG AUS
-- Eine stornierte Rechnung stand weiter unter den offenen Posten. Fachlich
-- falsch: Sie ist durch die Gutschrift ausgeglichen, nicht offen. Bezahlt
-- ist sie aber auch nicht — deshalb ein eigenes Feld statt eines
-- vorgetaeuschten Zahlungseingangs.
-- ---------------------------------------------------------------------
ALTER TABLE rechnungen ADD COLUMN IF NOT EXISTS ausgeglichen_am TIMESTAMPTZ;

-- Bereits stornierte Rechnungen und die zugehoerigen Gutschriften
-- rueckwirkend als ausgeglichen kennzeichnen.
UPDATE rechnungen SET ausgeglichen_am = now()
 WHERE ausgeglichen_am IS NULL AND storniert_durch IS NOT NULL;
UPDATE rechnungen SET ausgeglichen_am = now()
 WHERE ausgeglichen_am IS NULL AND art = 'storno';

CREATE INDEX IF NOT EXISTS idx_rechnungen_offen
  ON rechnungen(faellig_am) WHERE bezahlt_am IS NULL AND ausgeglichen_am IS NULL;
