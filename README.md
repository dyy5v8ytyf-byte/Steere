# WWtec Salesmanagement – Workflow-Grundgerüst v1

Kleines, eigenständiges Web-Programm (Node.js + SQLite) für die Steuerung von
Ladeinfrastruktur-Projekten: Kunden, Ansprechpartner, mögliche Projekte, Termine,
ToDos und Mitarbeiter – mit dem vorgegebenen Phasen-Workflow.

## Was v1 abdeckt

- **Datenmodell**: Kunde → Ansprechpartner (mehrere), Projekt(e), Termine, ToDos, Aktivitäten-Log
- **Mitarbeiter**: frei erweiterbare Rollen (Vertrieb, Projektmanager, Elektriker, Tiefbau, ...)
- **Phasen-Workflow**: Terminanfrage → Kontaktaufnahme → Wiedervorlage → Projektbesprechung →
  Angebot → Beauftragung → Terminierung → Umsetzung → Abgeschlossen / Verloren
- **Automatik (täglich 06:00, oder manuell über den Button im Dashboard)**:
  - Projekte, die 14 Tage in "Kontaktaufnahme" ohne neue Aktivität stehen, wandern automatisch
    auf "Wiedervorlage" (inkl. Log-Eintrag).
  - Bestätigte Elektriker-/Tiefbau-Termine ohne informierten Kunden erzeugen automatisch ein
    ToDo "Kunde informieren".
- **Terminierung Elektriker/Tiefbau**: pro Termin Typ wählbar (Kunde/Elektriker/Tiefbau),
  Bestätigung Ja/Nein/offen, danach "Kunde informiert"-Haken.
- **Soll/Ist-Grundgerüst**: Angebotssumme, beauftragte Summe, Rechnungsbetrag je Projekt
  (Dashboard summiert bereits; Forecast/Monatsvergleich ist der nächste Ausbauschritt).
- **Wiederholungs-Erkennung**: neue/bestehende Projektbeschreibungen werden auf Textähnlichkeit
  mit allen anderen Projekten geprüft (Wort-Überlappung) und als Hinweis angezeigt.
- **Altdaten**: Die 46 Leads aus `WWtec Kunden 5.xlsx` sind beim ersten Start automatisch importiert.

## Bewusst NICHT in v1 enthalten (nächste Ausbaustufen)

- **Steere/STEER.E-Anbindung** (Leistungsverzeichnisse, Preise automatisch abfragen/übernehmen) –
  dafür wird eine Schnittstellenbeschreibung zu Steere benötigt, die noch fehlt.
- **Angebote/Auftragsbestätigungen als PDF automatisch erzeugen** – aktuell nur Beträge/Status erfassen.
- **Automatischer Mailversand** (Kundenbenachrichtigung, Subunternehmer-Terminanfragen) –
  aktuell werden Aktionen im Programm erfasst, aber keine E-Mails verschickt.
- **Power-BI-artiges Dashboard** mit Forecast, Monatsvergleich (Vormonat/Folgemonat),
  Baustellen-Anzahl nach Status – Basisdaten (Soll/Ist, Baustellen-Status) sind vorbereitet,
  die Auswertungsseite selbst kommt im nächsten Schritt.
- **Login/Benutzerverwaltung** – aktuell ohne Zugriffsschutz, für den internen Test gedacht.

## Lokal starten

```bash
npm install
npm start
# läuft auf http://localhost:3000
```

Beim allerersten Start wird die SQLite-Datenbank angelegt und automatisch mit den
46 Alt-Leads aus der Excel befüllt (Datei `db/seed_data.json`).

## Online stellen (Railway)

Diese App ist bereit für ein Deployment auf Railway (oder jeden anderen Node-Hoster):
kein Build-Schritt nötig, `npm start` startet den Server, Port kommt aus `process.env.PORT`.

Railway deployt aus einem GitHub-Repository. Sobald ein Repo verbunden ist, kann das
Deployment direkt automatisiert angestoßen werden.

**Hinweis SQLite bei Hosting:** SQLite legt die Datenbank als Datei ab (`db/wwtec.sqlite`).
Auf Railway braucht das einen persistenten Volume-Mount, sonst gehen die Daten bei jedem
Redeploy verloren. Alternative für den produktiven Einsatz: auf Postgres umstellen
(Railway bietet das als Plugin) – für v1 bewusst SQLite gewählt, um schnell startklar zu sein.

## Struktur

```
server.js          Express-Server, alle Routen
constants.js        Phasen, Farben, Standard-Mitarbeiterrollen
cron.js              14-Tage-Wiedervorlage- und "Kunde informieren"-Automatik
lib/similar.js       Wiederholungs-Erkennung (Textähnlichkeit)
db/schema.sql         Tabellen
db/db.js              SQLite-Verbindung + Schema-Init
db/seed.js             Import der Alt-Excel-Daten (einmalig bei leerer DB)
views/                 EJS-Templates
public/style.css       Styling
```
