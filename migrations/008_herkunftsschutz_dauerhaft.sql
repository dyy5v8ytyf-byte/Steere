-- =====================================================================
-- STEER.E Plattform · Migration 008
--
-- KORREKTUR EINES ERNSTEN FEHLERS.
--
-- Migration 004 hat die eingelesenen Fremdpositionen (Standard-LVs und
-- Marktpreise aus Unterlagen der Service4Charger GmbH) mit einem einmaligen
-- UPDATE als "nur intern" gekennzeichnet. Das funktionierte genau dann, wenn
-- die Preise zum Zeitpunkt der Migration bereits in der Datenbank lagen.
--
-- Bei einer frischen Installation ist die Reihenfolge umgekehrt: erst laufen
-- die Migrationen, danach wird der Katalog importiert. Das UPDATE aus 004
-- lief dann ins Leere — und alle 1.792 Fremdpositionen standen mit
-- nur_intern = FALSE in der Datenbank. Der Schutztrigger greift zwar, aber
-- er fragt genau dieses Feld ab. Damit waeren die Positionen ohne jede
-- Warnung in Kundenangebote uebernehmbar gewesen.
--
-- Die Kennzeichnung darf nicht davon abhaengen, wann etwas importiert wurde.
-- Deshalb setzt sie ab jetzt ein Trigger beim Schreiben — fuer jede Zeile,
-- heute und bei jedem kuenftigen Import.
-- =====================================================================

CREATE OR REPLACE FUNCTION setze_herkunftsschutz() RETURNS TRIGGER AS $$
BEGIN
  -- Fremde Kalkulationsgrundlage ist grundsaetzlich nur intern verwendbar.
  -- Eigene Positionen bleiben unberuehrt; sie sind der einzige Weg in ein
  -- Kundenangebot.
  IF NEW.herkunft IN ('standard_tiefbau', 'standard_elektro', 'markt') THEN
    NEW.nur_intern := TRUE;
    IF NEW.herkunft_hinweis IS NULL THEN
      NEW.herkunft_hinweis :=
        'Eingelesene Fremdunterlage (Service4Charger GmbH). Nur als Struktur- und Vergleichsgrundlage verwendbar, nicht als Preis im Kundenangebot.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_herkunftsschutz ON preis_positionen;
CREATE TRIGGER trg_herkunftsschutz
  BEFORE INSERT OR UPDATE OF herkunft, nur_intern ON preis_positionen
  FOR EACH ROW EXECUTE FUNCTION setze_herkunftsschutz();

-- Bestand nachziehen, falls eine Installation bereits mit der Luecke lief.
UPDATE preis_positionen
   SET nur_intern = TRUE
 WHERE herkunft IN ('standard_tiefbau', 'standard_elektro', 'markt')
   AND nur_intern = FALSE;
