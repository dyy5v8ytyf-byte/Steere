-- =====================================================================
-- STEER.E Plattform · Migration 007
--
-- Korrektur an Migration 006.
--
-- Dort waren zwei Regeln vom Typ "medium_fehlt" mit den Titeln
-- "Netzanschluss" und "Zählerplatz" eingetragen. Die Pflichtaufnahmen
-- stehen aber als Liste in den Einstellungen, und dort heisst der erste
-- Eintrag "Netzanschluss / Zählerplatz". Die beiden Regeln konnten damit
-- nie erfuellt werden — eine strenge Regel, die niemand erfuellen kann,
-- blockiert die Freigabe dauerhaft.
--
-- Statt die Titel doppelt zu pflegen, gibt es jetzt eine Regel vom Typ
-- "pflichtfoto_fehlt". Sie liest die Liste aus den Einstellungen. Wer dort
-- eine Pflichtaufnahme ergaenzt, aendert damit auch die Freigabebedingung —
-- an einer Stelle statt an zweien.
-- =====================================================================

DELETE FROM pruefregeln
 WHERE pruefart = 'medium_fehlt'
   AND parameter IN ('Netzanschluss', 'Zählerplatz');

INSERT INTO pruefregeln (name, pruefart, parameter, frage, warum, streng, reihenfolge)
SELECT 'Pflichtaufnahmen', 'pflichtfoto_fehlt', NULL,
  'Es fehlen Pflichtaufnahmen.',
  'Ein Begehungsbericht ohne Bild ist eine Behauptung. Welche Aufnahmen Pflicht sind, steht in den Einstellungen unter „begehung_pflichtfotos" und lässt sich dort ändern.',
  TRUE, 55
WHERE NOT EXISTS (SELECT 1 FROM pruefregeln WHERE pruefart = 'pflichtfoto_fehlt');
