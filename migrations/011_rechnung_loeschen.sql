-- ---------------------------------------------------------------------
-- 011  Rechnungsentwuerfe loeschen — und festgeschriebene endgueltig nicht
--
-- Ausgangslage: Es gab ueberhaupt keine Loeschfunktion fuer Rechnungen.
-- Ein versehentlich angelegter Entwurf blieb fuer immer in der Liste stehen.
-- Gleichzeitig fehlte der Datenbank ein DELETE-Schutz: Die Trigger deckten
-- UPDATE ab, nicht DELETE. Eine festgeschriebene Rechnung liess sich per
-- direktem SQL also loeschen — genau das, was die Festschreibung verhindern
-- soll.
--
-- Beides wird hier zusammen geloest, denn es ist dieselbe Frage: Was darf weg
-- und was nicht. Entwuerfe duerfen weg. Festgeschriebenes nie — dort ist das
-- Storno der einzige Weg.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rechnung_nicht_loeschbar() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.festgeschrieben THEN
    RAISE EXCEPTION 'Rechnung % ist festgeschrieben und kann nicht geloescht werden. Korrektur ausschliesslich ueber Storno.', OLD.nummer;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rechnung_nicht_loeschbar ON rechnungen;
CREATE TRIGGER trg_rechnung_nicht_loeschbar
  BEFORE DELETE ON rechnungen
  FOR EACH ROW EXECUTE FUNCTION rechnung_nicht_loeschbar();

-- Hinweis zur Reihenfolge: Der Trigger auf rechnung_positionen prueft die
-- Festschreibung der zugehoerigen Rechnung. Beim Loeschen eines Entwurfs
-- raeumt ON DELETE CASCADE die Positionen ab; da der Entwurf nicht
-- festgeschrieben ist, laesst der Positionstrigger das durch. Fuer eine
-- festgeschriebene Rechnung greift schon der Trigger oben, bevor das Cascade
-- ueberhaupt anlaeuft.
