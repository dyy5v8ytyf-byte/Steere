-- =====================================================================
-- 015  Phase "Begehung" in die Projektphasen aufnehmen
--
-- Migration 014 legt zu jeder Begehung ein Projekt an und setzt dessen
-- Phase auf "Begehung". Diese Phase stand aber nicht in der Einstellung
-- `phasen` — das Projekt waere damit auf der Pipeline-Tafel in keiner
-- Spalte gelandet und praktisch unsichtbar gewesen.
--
-- Warum eine eigene Datei und keine Korrektur in 014: Eine angewandte
-- Migration wird nie wieder angefasst. Wer 014 bereits eingespielt hat,
-- bekaeme sonst eine geaenderte Pruefsumme gemeldet und die Korrektur
-- trotzdem nicht — das ist die Regel, die diese Anwendung sich selbst
-- gegeben hat, und sie gilt auch fuer eigene Fehler.
--
-- Eingeordnet wird "Begehung" zwischen Projektbesprechung und Angebot:
-- Da findet sie im Ablauf statt — nach dem ersten Gespraech, vor dem
-- Angebot, das auf ihren Ergebnissen beruht.
-- =====================================================================

UPDATE einstellungen
   SET wert = replace(wert, 'Projektbesprechung,Angebot', 'Projektbesprechung,Begehung,Angebot')
 WHERE schluessel = 'phasen'
   AND wert LIKE '%Projektbesprechung,Angebot%'
   AND wert NOT LIKE '%Begehung%';

-- Falls die Phasenliste zwischenzeitlich angepasst wurde und das Muster
-- oben nicht greift: "Begehung" hinten anhaengen, damit die Phase in
-- jedem Fall existiert. Die Reihenfolge laesst sich in der Verwaltung
-- jederzeit aendern.
UPDATE einstellungen
   SET wert = wert || ',Begehung'
 WHERE schluessel = 'phasen'
   AND wert NOT LIKE '%Begehung%';
