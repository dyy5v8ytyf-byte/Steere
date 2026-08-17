-- =====================================================================
-- STEER.E Plattform · Migration 005
-- (a) Angebotsvorlagen: Textrahmen und Standard-Positionsblöcke
-- (b) Textbausteine: ein Speicher, der mit der Nutzung wächst
--
-- Zweck: Aus einer Begehung soll kein Mengengerüst fallen, sondern ein
-- fertig formuliertes Angebot. Die Mengen kommen aus der Begehung, die
-- Sprache aus der Vorlage. Preise bleiben davon unberührt — sie werden
-- bewusst gesetzt und nie aus einer fremden Kalkulation übernommen.
-- =====================================================================

CREATE TABLE IF NOT EXISTS angebot_vorlagen (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  art               TEXT NOT NULL DEFAULT 'allgemein',  -- AC | DC | Begehung | allgemein
  beschreibung      TEXT,
  anrede            TEXT,
  einleitung        TEXT,
  vorbemerkungen    TEXT,
  hinweise          TEXT,
  schlusstext       TEXT,
  gueltigkeit_tage  INTEGER NOT NULL DEFAULT 30,
  ist_standard      BOOLEAN NOT NULL DEFAULT FALSE,
  aktiv             BOOLEAN NOT NULL DEFAULT TRUE,
  angelegt_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
  geaendert_am      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Positionsblöcke einer Vorlage.
-- menge_quelle steuert, woher die Menge beim Erzeugen kommt:
--   fest                 -> menge_fest wird übernommen
--   stellplaetze_gesamt  -> aus der Begehung
--   stellplaetze_ausbau  -> aus der Begehung
--   ladepunkte_ac / _dc  -> aus der Begehung
--   trassenlaenge        -> Summe der Abschnittslängen der Begehung
--   offen                -> Menge bleibt 0 und muss gesetzt werden
CREATE TABLE IF NOT EXISTS vorlage_positionen (
  id            SERIAL PRIMARY KEY,
  vorlage_id    INTEGER NOT NULL REFERENCES angebot_vorlagen(id) ON DELETE CASCADE,
  lfd           INTEGER NOT NULL DEFAULT 1,
  ist_titel     BOOLEAN NOT NULL DEFAULT FALSE,
  pos           TEXT,
  text          TEXT NOT NULL,
  langtext      TEXT,
  einheit       TEXT,
  menge_quelle  TEXT NOT NULL DEFAULT 'fest',
  menge_fest    NUMERIC(12,3) NOT NULL DEFAULT 1,
  einzelpreis   NUMERIC(12,4) NOT NULL DEFAULT 0,
  nur_bei_art   TEXT,                       -- Block nur bei AC oder nur bei DC
  hinweis       TEXT
);
CREATE INDEX IF NOT EXISTS idx_vpos_vorlage ON vorlage_positionen(vorlage_id, lfd);

-- ---------------------------------------------------------------------
-- (b) Textbausteine — der Speicher, der mit der Nutzung wächst.
-- Vorbild ist der "Memory" aus eurer Reparaturverwaltung: was einmal
-- getippt wurde, steht beim nächsten Mal zur Auswahl.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS textbausteine (
  id            SERIAL PRIMARY KEY,
  kategorie     TEXT NOT NULL,   -- einleitung | vorbemerkung | hinweis | schluss
                                 -- position | langtext | feststellung | risiko | fazit
  text          TEXT NOT NULL,
  verwendet     INTEGER NOT NULL DEFAULT 0,
  zuletzt_am    TIMESTAMPTZ,
  angelegt_von  INTEGER REFERENCES benutzer(id),
  angelegt_am   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baustein_eindeutig ON textbausteine(kategorie, md5(text));
CREATE INDEX IF NOT EXISTS idx_baustein_haeufig ON textbausteine(kategorie, verwendet DESC);

ALTER TABLE angebote ADD COLUMN IF NOT EXISTS vorlage_id INTEGER REFERENCES angebot_vorlagen(id);
ALTER TABLE angebote ADD COLUMN IF NOT EXISTS begehung_id INTEGER REFERENCES begehungen(id) ON DELETE SET NULL;
ALTER TABLE angebote ADD COLUMN IF NOT EXISTS vorbemerkungen TEXT;
ALTER TABLE angebote ADD COLUMN IF NOT EXISTS schlusstext TEXT;

-- ---------------------------------------------------------------------
-- Startvorlagen
--
-- Die Vorlage "Begehung und Planung" ist wörtlich aus dem eigenen Angebot
-- AN-2026-0144 (Techem, Österweide Heide) abgeleitet — eigene Formulierung
-- auf eigenem Briefpapier, damit unbedenklich als Standard verwendbar.
-- ---------------------------------------------------------------------

INSERT INTO angebot_vorlagen (name, art, beschreibung, einleitung, vorbemerkungen, hinweise, schlusstext, ist_standard)
SELECT 'Begehung und Planung', 'Begehung',
  'Vor-Ort-Begehung mit Protokoll, Installationskonzept und verbindlicher Angebotserstellung. Der übliche erste Schritt.',
  'vielen Dank für Ihre Anfrage. Für das oben genannte Bauvorhaben unterbreiten wir Ihnen folgendes Angebot:',
  'Die Begehung ist der erste Schritt jedes Projekts. Sie erfasst den Strompfad vollständig — von der Stelle, an der der Strom ankommt, bis zum künftigen Ladepunkt — und schafft damit die Grundlage für ein belastbares Angebot ohne spätere Nachträge.',
  'Alle Preise verstehen sich in Euro, zzgl. der gesetzlichen Mehrwertsteuer. Zahlungsziel 14 Tage netto.

Dieses Angebot ist freibleibend und für die Dauer von 30 Tagen ab Angebotsdatum gültig.

Sämtliche angebotenen Leistungen stehen unter dem Vorbehalt der technischen Umsetzbarkeit vor Ort sowie der Freigabe durch den zuständigen Verteilnetzbetreiber (VNB). Sollten sich im Zuge der Begehung bauliche oder technische Gegebenheiten zeigen, die eine Umsetzung in der angebotenen Form nicht zulassen, behalten wir uns eine entsprechende Anpassung von Leistung und Preis nach vorheriger Abstimmung mit Ihnen vor.',
  'Wir freuen uns auf Ihren Auftrag.', TRUE
WHERE NOT EXISTS (SELECT 1 FROM angebot_vorlagen WHERE name = 'Begehung und Planung');

INSERT INTO vorlage_positionen (vorlage_id, lfd, text, langtext, einheit, menge_quelle, menge_fest)
SELECT v.id, 1,
  'Vorbegehung, Begehungsprotokoll, Installationskonzept, verbindliche Angebotserstellung',
  'Vor-Ort-Begehung des Standortes, Aufmaß und Realisierungsberatung, Erstellung Begehungsprotokoll, Ausarbeitung Installationskonzept, verbindliche Angebotserstellung, netzbetreiberkonform (VNB).',
  'psch', 'fest', 1
  FROM angebot_vorlagen v WHERE v.name = 'Begehung und Planung'
   AND NOT EXISTS (SELECT 1 FROM vorlage_positionen p WHERE p.vorlage_id = v.id);

-- ---------- AC · Vorrüstung Stromschiene ----------
INSERT INTO angebot_vorlagen (name, art, beschreibung, einleitung, vorbemerkungen, hinweise, schlusstext)
SELECT 'AC — Vorrüstung Stromschiene', 'AC',
  'Zentrale Stromschiene mit Vorrüstung aller Stellplätze; Ladepunkte je Platz nachrüstbar.',
  'vielen Dank für Ihre Anfrage. Auf Grundlage unserer Vor-Ort-Begehung unterbreiten wir Ihnen folgendes Angebot:',
  'Grundgedanke der angebotenen Lösung: Statt jeden Stellplatz einzeln zu verkabeln, rüstet eine zentrale Stromschiene die gesamte Ebene vor. Ladepunkte werden später je Platz über einen Abgangskasten nachgerüstet — ohne erneute Genehmigung und ohne den Bestand ein zweites Mal zu öffnen.

Die Mengen dieses Angebots beruhen auf der durchgeführten Begehung. Änderungen der baulichen Gegebenheiten oder der Stellplatzzahl wirken sich entsprechend aus.',
  'Alle Preise verstehen sich in Euro, zzgl. der gesetzlichen Mehrwertsteuer. Zahlungsziel 14 Tage netto.

Dieses Angebot ist freibleibend und für die Dauer von 30 Tagen ab Angebotsdatum gültig.

Sämtliche angebotenen Leistungen stehen unter dem Vorbehalt der Freigabe durch den zuständigen Verteilnetzbetreiber (VNB). Die angegebene Anschlussleistung beruht auf den bei der Begehung verfügbaren Auskünften und ersetzt keine verbindliche Netzauskunft.

Fördermittel sind nicht Bestandteil dieses Angebots. Ob und in welcher Höhe eine Förderung erlangt werden kann, prüfen wir je Objekt gesondert; maßgeblich sind die jeweils gültigen Richtlinien. Ein Förderantrag ist vor Beauftragung zu stellen.',
  'Gern stimmen wir den Ablauf und die Bauzeit in einem gemeinsamen Termin ab. Wir freuen uns auf Ihren Auftrag.'
WHERE NOT EXISTS (SELECT 1 FROM angebot_vorlagen WHERE name = 'AC — Vorrüstung Stromschiene');

INSERT INTO vorlage_positionen (vorlage_id, lfd, ist_titel, text, langtext, einheit, menge_quelle, menge_fest, hinweis)
SELECT v.id, x.lfd, x.titel, x.text, x.langtext, x.einheit, x.quelle, x.fest, x.hinweis
  FROM angebot_vorlagen v,
  (VALUES
    (1, TRUE,  'Projektsteuerung und Planung', NULL, NULL, 'fest', 1::numeric, NULL),
    (2, FALSE, 'Projektsteuerung, Ausführungsplanung, Nachunternehmer-Koordination',
        'Steuerung beider Gewerke, Erstellung und Prüfung der Leistungsverzeichnisse, Vergabebegleitung, Bauüberwachung, Abnahme und Inbetriebnahme.',
        'psch', 'fest', 1::numeric, 'Preis je Objekt kalkulieren'),
    (3, FALSE, 'Netzanschlussverfahren und Abstimmung mit dem Verteilnetzbetreiber',
        'Anmeldung, Abstimmung des technischen Anschlusskonzepts, Begleitung bis zur Freigabe.',
        'psch', 'fest', 1::numeric, NULL),
    (4, TRUE,  'Elektroinstallation', NULL, NULL, 'fest', 1::numeric, NULL),
    (5, FALSE, 'Stromschiene inklusive Befestigung und Einspeisung',
        'Lieferung und Montage der zentralen Stromschiene entlang der geplanten Trasse, inklusive Befestigungsmaterial, Einspeisung und Endabschluss.',
        'm', 'trassenlaenge', 0::numeric, 'Menge aus der Begehung'),
    (6, FALSE, 'Abgangskasten je vorgerüstetem Stellplatz',
        'Vorrüstung des Stellplatzes durch Abgangskasten an der Stromschiene, anschlussfertig für die spätere Wallbox.',
        'Stk.', 'stellplaetze_ausbau', 0::numeric, 'Menge aus der Begehung'),
    (7, FALSE, 'Unterverteilung mit Lastmanagement und Messeinrichtung',
        'Aufbau der Ladeverteilung inklusive Schutzeinrichtungen, dynamischem Lastmanagement und Messkonzept.',
        'Stk.', 'fest', 1::numeric, NULL),
    (8, FALSE, 'Ladepunkt AC — Lieferung, Montage, Anschluss',
        'Lieferung und Montage der Wallbox, elektrischer Anschluss, Konfiguration und Anbindung an das Lastmanagement.',
        'Stk.', 'ladepunkte_ac', 0::numeric, 'Menge aus der Begehung'),
    (9, TRUE,  'Inbetriebnahme und Dokumentation', NULL, NULL, 'fest', 1::numeric, NULL),
    (10, FALSE,'Prüfung, Inbetriebnahme und Backend-Anbindung',
        'Prüfung nach DGUV V3, Inbetriebnahme je Ladepunkt, Anbindung an das Backend (OCPP), Übergabe der Dokumentation.',
        'psch', 'fest', 1::numeric, NULL)
  ) AS x(lfd, titel, text, langtext, einheit, quelle, fest, hinweis)
 WHERE v.name = 'AC — Vorrüstung Stromschiene'
   AND NOT EXISTS (SELECT 1 FROM vorlage_positionen p WHERE p.vorlage_id = v.id);

-- ---------- DC · Schnellladestandort ----------
INSERT INTO angebot_vorlagen (name, art, beschreibung, einleitung, vorbemerkungen, hinweise, schlusstext)
SELECT 'DC — Schnellladestandort', 'DC',
  'Tiefbau und Elektro aus einer Steuerung, mit getrennten Leistungsverzeichnissen und einem Terminplan.',
  'vielen Dank für Ihre Anfrage. Auf Grundlage unserer Vor-Ort-Begehung unterbreiten wir Ihnen folgendes Angebot:',
  'Bei einem DC-Standort greifen Tiefbau und Elektro ineinander. Genau an dieser Schnittstelle entstehen erfahrungsgemäß Bauzeitverzug und Nachträge. Wir steuern deshalb beide Gewerke aus einer Hand — mit getrennten Leistungsverzeichnissen, aber einem Terminplan und einer Schnittstellenverantwortung.',
  'Alle Preise verstehen sich in Euro, zzgl. der gesetzlichen Mehrwertsteuer. Zahlungsziel 14 Tage netto.

Dieses Angebot ist freibleibend und für die Dauer von 30 Tagen ab Angebotsdatum gültig.

Sämtliche Leistungen stehen unter dem Vorbehalt der Freigabe durch den zuständigen Verteilnetzbetreiber sowie der erforderlichen Genehmigungen für Aufgrabung und Wiederherstellung. Bodenverhältnisse, Altlasten und nicht dokumentierte Fremdleitungen sind nicht Bestandteil der Kalkulation und werden nach Aufwand abgerechnet.',
  'Gern stimmen wir Bauablauf und Sperrzeiten in einem gemeinsamen Termin ab. Wir freuen uns auf Ihren Auftrag.'
WHERE NOT EXISTS (SELECT 1 FROM angebot_vorlagen WHERE name = 'DC — Schnellladestandort');

INSERT INTO vorlage_positionen (vorlage_id, lfd, ist_titel, text, langtext, einheit, menge_quelle, menge_fest, hinweis)
SELECT v.id, x.lfd, x.titel, x.text, x.langtext, x.einheit, x.quelle, x.fest, x.hinweis
  FROM angebot_vorlagen v,
  (VALUES
    (1, TRUE,  'Projektsteuerung und Planung', NULL, NULL, 'fest', 1::numeric, NULL),
    (2, FALSE, 'Projektsteuerung, Schnittstellenverantwortung Tiefbau und Elektro',
        'Ein Terminplan für beide Gewerke, Koordination der Übergabepunkte, Bauüberwachung, Abnahme und Inbetriebnahme.',
        'psch', 'fest', 1::numeric, 'Preis je Objekt kalkulieren'),
    (3, FALSE, 'Netzanschlussverfahren, Abstimmung Verteilnetzbetreiber, Messkonzept',
        'Anmeldung, technische Anschlusslösung, Wandlermessung, Begleitung bis zur Freigabe.',
        'psch', 'fest', 1::numeric, NULL),
    (4, TRUE,  'Tiefbau', NULL, NULL, 'fest', 1::numeric, NULL),
    (5, FALSE, 'Kabelgraben inklusive Aushub, Leerrohr, Verfüllung und Wiederherstellung',
        'Herstellung der Trasse nach Leistungsverzeichnis Tiefbau, Verlegung Leerrohr, lagenweise Verfüllung und Wiederherstellung der Oberfläche.',
        'm', 'trassenlaenge', 0::numeric, 'Menge aus der Begehung'),
    (6, FALSE, 'Fundament für Ladesäule inklusive Einführung',
        'Herstellung des Fundaments je Ladepunkt einschließlich Kabeleinführung und Erdung.',
        'Stk.', 'ladepunkte_dc', 0::numeric, 'Menge aus der Begehung'),
    (7, TRUE,  'Elektro', NULL, NULL, 'fest', 1::numeric, NULL),
    (8, FALSE, 'Übergabestation, Schutz- und Messkonzept',
        'Aufbau der Übergabe einschließlich Schutzeinrichtungen und Wandlermessung.',
        'Stk.', 'fest', 1::numeric, NULL),
    (9, FALSE, 'DC-Ladepunkt — Lieferung, Montage, Anschluss',
        'Lieferung und Montage der Schnellladeeinheit, elektrischer Anschluss, Konfiguration, Lastmanagement.',
        'Stk.', 'ladepunkte_dc', 0::numeric, 'Menge aus der Begehung'),
    (10, TRUE, 'Inbetriebnahme und Dokumentation', NULL, NULL, 'fest', 1::numeric, NULL),
    (11, FALSE,'Prüfung, Inbetriebnahme und Backend-Anbindung',
        'Prüfung nach DGUV V3, Inbetriebnahme, Anbindung an das Backend (OCPP), Übergabe der Dokumentation.',
        'psch', 'fest', 1::numeric, NULL)
  ) AS x(lfd, titel, text, langtext, einheit, quelle, fest, hinweis)
 WHERE v.name = 'DC — Schnellladestandort'
   AND NOT EXISTS (SELECT 1 FROM vorlage_positionen p WHERE p.vorlage_id = v.id);

-- Startbausteine aus den vorhandenen Texten.
INSERT INTO textbausteine (kategorie, text) VALUES
  ('einleitung','vielen Dank für Ihre Anfrage. Für das oben genannte Bauvorhaben unterbreiten wir Ihnen folgendes Angebot:'),
  ('einleitung','vielen Dank für Ihre Anfrage. Auf Grundlage unserer Vor-Ort-Begehung unterbreiten wir Ihnen folgendes Angebot:'),
  ('einleitung','vielen Dank für das gute Gespräch. Wie besprochen erhalten Sie nachstehend unser Angebot:'),
  ('schluss','Wir freuen uns auf Ihren Auftrag.'),
  ('schluss','Gern stimmen wir den Ablauf und die Bauzeit in einem gemeinsamen Termin ab. Wir freuen uns auf Ihren Auftrag.'),
  ('hinweis','Alle Preise verstehen sich in Euro, zzgl. der gesetzlichen Mehrwertsteuer. Zahlungsziel 14 Tage netto.'),
  ('hinweis','Dieses Angebot ist freibleibend und für die Dauer von 30 Tagen ab Angebotsdatum gültig.'),
  ('hinweis','Sämtliche angebotenen Leistungen stehen unter dem Vorbehalt der technischen Umsetzbarkeit vor Ort sowie der Freigabe durch den zuständigen Verteilnetzbetreiber (VNB).'),
  ('hinweis','Fördermittel sind nicht Bestandteil dieses Angebots. Ein Förderantrag ist vor Beauftragung zu stellen.'),
  ('risiko','Anschlussleistung am Bestandsanschluss nicht ausreichend — Netzverstärkung durch den VNB erforderlich.'),
  ('risiko','Brandabschnitte queren die geplante Trasse; Schottung und Nachweis erforderlich.'),
  ('risiko','Nicht dokumentierte Fremdleitungen im Trassenbereich.'),
  ('risiko','Deckenhöhe und Rettungswege begrenzen die Trassenführung.'),
  ('feststellung','Bestandstrasse vorhanden und nutzbar.'),
  ('feststellung','Zählerplatz muss umgebaut werden, Wandlermessung erforderlich.'),
  ('feststellung','Zufahrt für Baustellenfahrzeuge eingeschränkt.')
ON CONFLICT DO NOTHING;
