# STEER.E — Sales-, Kunden- und Angebotsplattform

Westphal Wavetec GmbH · Version 3.5 · Nachfolger von „WWtec Salesmanagement v1"

---

## Zuerst lesen: was sich gegenüber v1 geändert hat

Die Vorgängerversion hatte drei Probleme, die alle drei behoben sind.

**1. Daten gingen bei jedem Deployment verloren.** v1 legte die Datenbank als SQLite-Datei
im Container ab (`db/wwtec.sqlite`). Railway ersetzt bei jedem Deployment den kompletten
Container — die Datei war danach weg und die App fiel auf die 46 Seed-Leads zurück.
v2 nutzt PostgreSQL als eigenen Dienst. Der überlebt jedes Deployment.

**2. Es gab keinen Zugriffsschutz.** Wer die Adresse kannte, sah den kompletten
Vertriebsstand. v2 hat Anmeldung, Rollen und ein Änderungsprotokoll.

**3. Die Altdaten lagen im öffentlichen Repository.** `db/seed_data.json` enthält
45 echte Leads mit Klarnamen, Mobilnummern und Gesprächsnotizen. Diese Datei ist jetzt
in `.gitignore` und wird einmalig lokal für den Import gebraucht.
**Das Repository muss auf privat gestellt werden** — das kann nur der Eigentümer.

---

## Vor der ersten Inbetriebnahme

> **Achtung:** Sobald der neue Stand deployt wird, ersetzt Railway den laufenden Container.
> Alles, was seit dem letzten Deployment (12.08.2026) in der alten App erfasst wurde,
> ist danach nicht mehr abrufbar — es lag nur in der SQLite-Datei dieses Containers.
> **Notieren oder abfotografieren Sie diese Einträge vorher.** Alles, was älter ist,
> steckt in `db/seed/altdaten_kunden.json` und wird automatisch übernommen.

---

## Einrichtung auf Railway

Es wird bereits ein Postgres-Dienst im Projekt `Lutyrep` (Environment `production`)
bereitgestellt. Die folgenden Variablen müssen beim Anwendungsdienst gesetzt sein:

| Variable | Wert |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `SESSION_SECRET` | `${{ secret(48) }}` — Railway erzeugt einen Zufallswert |
| `NODE_ENV` | `production` |

Für die Aufnahmen aus der Begehung zusätzlich (optional, aber empfohlen):

| Variable | Wert |
|---|---|
| `R2_ENDPOINT` | Endpunkt des S3-kompatiblen Speichers |
| `R2_BUCKET` | Name des Buckets |
| `R2_ACCESS_KEY_ID` | Zugriffsschlüssel |
| `R2_SECRET_ACCESS_KEY` | Geheimnis |

Fehlen sie, legt die Anwendung die Dateien lokal ab und sagt das in der Oberfläche
auch. Auf Railway überlebt eine lokale Ablage kein Deployment — für den Dauerbetrieb
mit 360°-Videos führt an einem Objektspeicher kein Weg vorbei.

Danach genügt ein Push auf `main`; Railway baut und startet automatisch.
Migrationen laufen beim Start selbst — ein manueller Schritt ist nicht nötig.

### Der erste Start richtet sich selbst ein

Es ist **kein Terminal nötig**. Beim allerersten Start prüft die Anwendung zwei Dinge
und erledigt sie, falls nötig:

1. Ist der Preiskatalog leer, wird er eingelesen (1.792 Positionen, dauert einige Sekunden).
2. Gibt es noch keinen Benutzer, wird der erste Administrator angelegt.

Das **Startpasswort steht dann im Deploy-Log** des Dienstes (Railway → Dienst →
Deployments → aktuelles Deployment → Logs), in einem umrahmten Block:

```
============================================================
  Administrator angelegt
------------------------------------------------------------
  E-Mail:    kontakt@wwtec.de
  Passwort:  Sockel-8853-cb27
============================================================
```

**Es wird nur dieses eine Mal angezeigt.** Beim ersten Anmelden muss es geändert
werden; bis dahin ist jede andere Seite gesperrt.

Name und E-Mail lassen sich über die Variablen `ADMIN_NAME` und `ADMIN_EMAIL`
vorgeben; ohne sie werden „Lutz Niesmann" und `kontakt@wwtec.de` verwendet.

Jeder weitere Start macht nichts davon erneut — es wird nichts überschrieben und
nichts doppelt angelegt. Wer die Schritte lieber von Hand ausführt, kann weiterhin
`npm run import:preise` und `npm run setup "Name" adresse@wwtec.de` benutzen.

**Die 45 Altkunden** kommen danach über die Oberfläche hinein:
*Verwaltung → Altdaten übernehmen* → Datei `seed_data.json` (bzw.
`altdaten_kunden.json` aus dem Übergabepaket) auswählen → Übernehmen.

Diesen Weg gibt es, weil die Datei Klarnamen, Mobilnummern und Gesprächsnotizen
enthält und deshalb bewusst **nicht im Repository liegt**. Auch dieser Vorgang ist
wiederholbar — vorhandene Kunden werden übersprungen, nie überschrieben.

---

## Lokal starten

```bash
cp .env.example .env      # DATABASE_URL und SESSION_SECRET eintragen
npm install
npm run migrate
npm run import:preise
npm run import:altdaten
npm run setup "Ihr Name" ihre@adresse.de
npm start                 # http://localhost:3000
```

Benötigt Node 22 und einen erreichbaren PostgreSQL-Server.

---

## Rollen

| Rolle | Sieht |
|---|---|
| `admin` | Alles, einschließlich Verwaltung, Protokoll und Sicherung |
| `team` | Alles außer Verwaltung |
| `partner` | **Ausschließlich** Projekte, die seiner Organisation ausdrücklich freigegeben wurden, plus den eigenen Retainer |

Die Partnertrennung ist nicht kosmetisch: Der gesamte CRM-Bereich ist für Partner
serverseitig gesperrt (HTTP 403), und der Partnerbereich lädt fremde Kundendaten
gar nicht erst. Ein Partner sieht ein Projekt genau dann, wenn dafür ein Eintrag in
`projekt_partner` existiert — anzulegen im Kundendetail unter „Partnerfreigabe".

---

## Änderungen am laufenden System, ohne Datenverlust

Das war die ausdrückliche Anforderung. So ist sie umgesetzt:

**Was ein Administrator im Programm ändern kann**, ohne dass jemand Code anfasst:
Projektphasen, Mitarbeiterrollen, Margen, Umsatzsteuersatz, Firmenangaben für den
Angebotskopf, Benutzer und Rollen, Partnerorganisationen, Retainer-Konditionen,
Preispositionen und **eigene Felder** in den Erfassungsmasken.
Das alles sind Datensätze — keine Änderung an der Datenbankstruktur.

**Eigene Felder** legen bewusst keine Datenbankspalten an. Ein neues Feld anzulegen,
umzubenennen oder zu deaktivieren kann deshalb keine vorhandenen Daten beschädigen.
Ein deaktiviertes Feld verschwindet aus der Maske, seine Werte bleiben gespeichert.

**Strukturänderungen** laufen ausschließlich über nummerierte Dateien in `migrations/`:

* Jede Datei wird genau einmal angewendet, in einer eigenen Transaktion — sie geht
  ganz durch oder gar nicht.
* Angewandte Migrationen werden mit Prüfsumme vermerkt. Wird eine nachträglich
  verändert, warnt der Start laut und führt sie **nicht** erneut aus.
* Korrekturen gehören in eine neue Datei, nie in eine bereits angewandte.
* Es gibt in diesem Code keinen Pfad, der Tabellen oder Spalten löscht.

**Nichts wird gelöscht.** Nicht mehr benötigte Preispositionen, Benutzer,
Organisationen und Felder werden deaktiviert. Kunden, Projekte, Angebote und das
Änderungsprotokoll haben überhaupt keine Löschfunktion.

**Sicherung** unter *Verwaltung → Sicherung herunterladen*: der komplette Datenbestand
als JSON, ohne Passwort-Hashes. Ein Klick, jederzeit. Vor größeren Änderungen sinnvoll.

**Änderungsprotokoll** unter *Verwaltung → Änderungsprotokoll*: wer wann was geändert hat.

---

## Preiskatalog und Angebote

> **Herkunft.** Die eingelesenen Standard-LVs und Marktpreise stammen aus Unterlagen
> der **Service4Charger GmbH**. Sie sind ausnahmslos als *nur intern* gekennzeichnet
> und lassen sich nicht in ein Kundenangebot ziehen — das setzt die Datenbank per
> Trigger durch, nicht die Oberfläche. Wer eine solche Position braucht, übernimmt sie
> über „Als eigene Position übernehmen": Text und Einheit werden kopiert, **der Preis
> nicht**. Er muss bewusst gesetzt werden. Genau darin liegt die Trennung zur fremden
> Kalkulationsgrundlage.

Der Katalog stammt aus `Angebotsmatrix_S4C.xlsx`:

| Herkunft | Positionen | Quelle |
|---|---:|---|
| Standard-LV Tiefbau | 94 | `Preise_StandardLVTiefbau_aktuell.xlsx` |
| Standard-LV Elektro | 1.299 | `Einkaufspreise_StandardLVElektro.xlsx` |
| Marktpreise | 399 | 18 reale Altangebote (Techem/BLB, UTA, APCOA, Goldbeck, Duwensee u. a.) |

Ein Angebot entsteht durch Auswahl aus dem Katalog oder durch freie Positionen.
Die Summen werden **immer** aus den Positionen neu gerechnet und nie aus dem Formular
übernommen — eine Gesamtsumme kann nicht stillschweigend von den Positionen abweichen.

Der Nummernkreis ist auf `AN-2026-0144` vorbelegt; das nächste Angebot wird
`AN-2026-0145`, damit keine Nummer doppelt vergeben wird.

Status **Versendet** schreibt die Nettosumme als Angebotssumme ins Projekt,
Status **Beauftragt** als beauftragte Summe. Kein Doppelpflegen.

> Die Preise spiegeln den Stand der eingelesenen Dokumente, nicht die tagesaktuelle
> Marktlage. Vor Versand eines Angebots gegen aktuelle Einkaufspreise prüfen.

---

## Begehungen — von der Einspeisung bis zum Ladepunkt

Eine Begehung wird immer entlang des **Strompfades** aufgenommen: von der Stelle, an
der der Strom ankommt, bis zum letzten Abnehmer. Beim Anlegen werden die
Standardabschnitte deshalb bereits vorbelegt, statt ein leeres Formular hinzustellen.
Wer etwas nicht braucht, entfernt es; wer etwas vergisst, sieht die Lücke.

Erfasst werden je Abschnitt: Von/Nach, Länge, Verlegeart, Untergrund, Bestand,
Hindernisse. Dazu Netzanschluss (Art, Anschlussleistung, freie Reserve, Zählerplatz),
Stellplatz- und Ladepunktzahlen sowie Empfehlung, Risiken und Fazit.

**Aufnahmen** — Foto, 360°-Panorama, Video und 360°-Video — werden direkt vom Gerät
hochgeladen. Die Datei geht dabei **nicht durch den Anwendungsserver**: Der Browser
holt sich eine Hochladeadresse und lädt direkt in den Objektspeicher. Das ist der
Grund, warum ein 1,5-GB-Video funktioniert, ohne die App zu blockieren.

| Art | Grenze |
|---|---:|
| Foto | 25 MB |
| 360°-Panorama | 60 MB |
| Video | 500 MB |
| 360°-Video | 1,5 GB |
| Dokument | 40 MB |

Die 360°-Aufnahmen sind **kameraunabhängig**: erwartet wird das equirectangulare
Format, das Insta360, Ricoh Theta und GoPro Max gleichermaßen ausgeben. Es ist keine
bestimmte Kamera nötig und keine Herstellersoftware.

Ohne die vier Variablen `R2_*` (bzw. S3-kompatibel) läuft die Ablage automatisch auf
dem lokalen Datenträger weiter. Der Wechsel auf Objektspeicher braucht keinen
Codeeingriff, nur die Variablen.

---

## Rückfragen, Stückliste, Erfahrungswerte

Drei Dinge, die aufeinander aufbauen und dafür sorgen, dass die Angebote mit jeder
Begehung besser werden — ohne dass jemand ein Modell trainiert.

### 1. Rückfragen (Verwaltung → Regeln)

Die Anwendung prüft jede Begehung gegen einen Regelsatz und stellt genau die Fragen,
deren Antwort später im Angebot gebraucht wird — mit einem Satz dazu, **warum** sie
gebraucht wird. Als **streng** markierte Regeln blockieren die Freigabe.

Eine Frage verschwindet auf zwei Wegen: Das Feld wird gefüllt, oder es gibt einen
Grund, warum sie hier nicht gilt. Dieser Grund wird festgehalten, nicht weggeklickt.

Die Regeln stehen in der Datenbank, nicht im Code. Sie lassen sich abends nach einer
Baustelle ergänzen, ohne Entwickler und ohne neue Version. Eine Regel darf eine Frage
stellen — niemals beliebigen Code ausführen; die Prüfarten sind eine feste Auswahl.

### 2. Stückliste (Begehung → Stückliste)

Aus Trassenlänge, Stellplätzen und Ladepunkten fällt eine Materialliste.
Menge = Bezugswert × Faktor, danach Verschnittzuschlag, danach aufrunden.
**Die Rechnung steht bei jeder Zeile dabei** — „62,4 m Trasse + 5 % Verschnitt,
aufgerundet" ist nachprüfbar, „66 m" allein nicht. Die Faktoren sind Datensätze und
in der Verwaltung änderbar. Ausgewählte Zeilen lassen sich als Feststellungen in die
Begehung übernehmen.

### 3. Erfahrungswerte (Verwaltung → Erfahrungswerte)

Wird ein Angebot, das aus einer Begehung stammt, auf **Beauftragt** gesetzt, zählt die
Anwendung für den Objekttyp mit, welche Positionen darin standen. Bei der nächsten
vergleichbaren Begehung nennt sie diese Positionen — mit der Zahl dahinter:
„Bei 7 von 8 vergleichbaren Objekten war diese Position dabei."

Das ist **keine künstliche Intelligenz, sondern eine Strichliste**. Sie schlägt erst
ab zwei vergleichbaren Aufträgen und ab 50 % Häufigkeit etwas vor, jeder Wert ist
einzeln einsehbar und einzeln löschbar. Nur beauftragte Angebote zählen — ein Entwurf
sagt nichts darüber aus, was tatsächlich gekauft wird.

Alle drei Teile sind **rein intern**. Im Begehungsbericht und im Angebot taucht davon
nichts auf.

---

## Angebotsvorlagen und Textbausteine

Eine Vorlage ist der Textrahmen eines Angebots (Einleitung, Vorbemerkungen, Hinweise,
Schlusssatz) plus ein Positionsgerüst. Beim Überführen einer Begehung entsteht damit
ein **fertig formuliertes Angebot statt einer Mengenliste**.

Die Mengen kommen, wo hinterlegt, aus der Begehung: Trassenlänge, Stellplätze im
Ausbau, Ladepunkte AC/DC. Die Preise kommen **nicht** aus der Vorlage, wenn dort
keiner steht — eine Vorlage vereinheitlicht die Sprache, sie ersetzt nicht die
Kalkulation.

Drei Vorlagen sind eingerichtet: *Begehung und Planung* (wörtlich aus dem eigenen
Angebot AN-2026-0144 abgeleitet), *AC — Vorrüstung Stromschiene*, *DC —
Schnellladestandort*.

**Textbausteine** sind der Speicher, der mit der Nutzung wächst: Was einmal getippt
wurde, steht beim nächsten Mal in einem Auswahlfeld — häufig Benutztes oben. Das
betrifft Einleitungen, Vorbemerkungen, Hinweise, Schlusssätze, Positionstexte,
Feststellungen, Risiken und Fazits.

---

## Auf dem Telefon

Die Begehung wird vor Ort erfasst, nicht am Schreibtisch. Die Erfassungsmasken sind am
Rechner als Tabelle gebaut, auf dem Telefon werden daraus umrandete Blöcke
untereinander — jeder Abschnitt sichtbar getrennt. Eingabefelder sind mindestens 44 px
hoch und 16 px groß; letzteres verhindert, dass iOS beim Antippen hineinzoomt.
Der Standort lässt sich mit einem Knopf vom Gerät übernehmen, die Kamera direkt
öffnen.

---

## Outlook: Termine und Mails

Bewusst **ohne** Anbindung an Microsoft. Die Anwendung erzeugt eine
Kalenderdatei und einen vorbereiteten Mailverweis; Outlook öffnet beides.
Das kostet keine App-Registrierung, keine Anmeldung, keine Freigabe durch
einen Administrator und keinen Eintrag ins Verarbeitungsverzeichnis — es
verlässt die Anwendung nichts, was der Anwender nicht selbst abschickt.

| Knopf | Wo | Was passiert |
|---|---|---|
| **Kalender** | Termine, Begehung | Lädt eine `.ics`-Datei. Outlook trägt den Termin beim Öffnen in den eigenen Kalender ein. |
| **Einladung** | Termine | Dieselbe Datei als Terminanfrage (`METHOD:REQUEST`) mit dem Ansprechpartner als Teilnehmer. Outlook öffnet sie zum Versenden. |
| **Mail** | Termine, Kunde, Angebot | Öffnet Outlook mit Empfänger, Betreff und fertigem Text. |

Die Uhrzeit steht als Freitext in der Datenbank, weil im Alltag alles
Mögliche getippt wird. Erkannt wird `14:00`, `14.30`, `9 Uhr`, `08h30` und
Zeiträume wie `14:00-16:30` (daraus entsteht die Dauer). Was sich nicht
sicher lesen lässt — etwa „nachmittags" — wird ein **Ganztagestermin**.
Lieber ein Termin ohne Uhrzeit als einer zur falschen Stunde.
Zeitzone Europe/Berlin wird in der Datei mitgeliefert, inklusive Sommerzeit.

### Echte Anbindung an Microsoft 365

Ist sie eingerichtet, kommen zu den Dateien echte Knöpfe hinzu: **In Outlook**
schreibt den Termin unmittelbar in den Kalender (ein zweiter Klick aktualisiert
ihn, statt einen zweiten anzulegen), **+ einladen** nimmt den Ansprechpartner als
Teilnehmer auf, und ein Angebot lässt sich mit PDF-Anhang direkt versenden.
Versendete Mails erscheinen beim Kunden in den Aktivitäten und unter dem Angebot.

### Kalenderabgleich in beide Richtungen (3.5)

Bis 3.4 gab es nur den Hinweg: ein Knopf schrieb den Termin nach Outlook. Wurde er
dort verschoben oder abgesagt, erfuhr STEER.E davon nichts — und damit stimmte genau
die Information nicht mehr, wegen der man in die Anwendung schaut.

Unter *Verwaltung → Kalenderabgleich mit Outlook* läuft der Abgleich jetzt in beide
Richtungen, automatisch alle 15 Minuten (einstellbar) und auf Knopfdruck.

**Was zurückkommt — und was nicht.** Hinaus geht jeder Termin mit Datum im Zeitfenster
(Vorgabe: 30 Tage zurück, 365 voraus). Zurück kommen **ausschließlich Termine aus
STEER.E**, erkennbar an der Kategorie `STEER.E` im Kalender. Der übrige Kalender bleibt
außen vor. Das ist keine Bequemlichkeit: Ein Postfach enthält Arzttermine und Privates,
und was einmal in einer Vertriebsdatenbank steht, die gesichert, exportiert und von
Kollegen eingesehen wird, lässt sich später nicht mehr sauber heraustrennen. Einen
Schalter dafür gibt es nicht.

**Bei einem Konflikt gewinnt die jüngere Änderung** — `termine.geaendert_am` gegen
`lastModifiedDateTime` aus Graph. Die unterlegene Fassung geht nicht still verloren,
sie steht im Verlauf auf derselben Seite.

**Eine Absage in Outlook löscht hier nichts.** Der Termin wird auf „abgesagt" gesetzt
und der Zeitpunkt festgehalten. Löschen bleibt eine Entscheidung des Anwenders.

**Die Kategorie entfernen heißt: nicht mehr abgleichen.** Nimmt jemand im Kalender die
Kategorie `STEER.E` weg, koppelt sich der Termin ab und wird auch nicht neu angelegt.
Zurücknehmen lässt sich das auf derselben Seite.

Geschrieben wird nur, wenn sich wirklich etwas geändert hat — dafür merkt sich die
Zuordnung einen Fingerabdruck des zuletzt Gesendeten. Sonst bekäme jeder Teilnehmer
bei jedem Lauf eine Änderungsbenachrichtigung.

### Planner und Teams (3.5)

Unter *Verwaltung → Planner und Teams*: Aufgaben werden als Planner-Aufgaben
gespiegelt, und ausgewählte Ereignisse melden sich in einem Teams-Kanal.

**Planner ist ein Spiegel, kein zweiter Speicher.** Führend bleibt die Aufgabe in
STEER.E. Was in Planner abgehakt wird, kommt zurück; alles andere geht von hier nach
dort. Zwei Systeme, die beide führen wollen, enden in widersprüchlichen Listen — genau
dem Zustand, den diese Plattform ablösen soll.

**Meldungen gehen genau einmal hinaus.** Derselbe Anlass zum selben Vorgang wird nicht
wiederholt, auch nicht nach einem Neustart. Welche Anlässe gemeldet werden, ist
einzeln schaltbar; die Vorgabe ist sparsam. Ein Kanal, der alles meldet, wird nach zwei
Wochen nicht mehr gelesen.

> **Diese beiden Bereiche brauchen mehr Rechte.** Zusätzlich zu Kalender und Mail:
> `Tasks.ReadWrite`, `Group.Read.All`, `Team.ReadBasic.All`, `ChannelMessage.Send`.
> **Group.Read.All stuft Microsoft in den meisten Mandanten als zustimmungspflichtig
> ein** — ohne Administrator geht es dort nicht. Bekommen Sie die Zustimmung nicht,
> setzen Sie die Variable `M365_PLANNER=aus`: Dann verbindet sich STEER.E nur mit dem
> kleinen Rechtesatz, und Kalender und Mail laufen unverändert weiter. Ein einziger
> großer Rechteblock würde bei einer verweigerten Zustimmung auch das Funktionierende
> mitreißen.


Einrichtung unter *Verwaltung → Microsoft 365*; die Klickanleitung steht dort auf
der Seite. Nötig sind drei Variablen:

| Variable | Wert |
|---|---|
| `M365_CLIENT_ID` | Anwendungs-ID aus der Entra-Registrierung |
| `M365_CLIENT_SECRET` | geheimer Clientschlüssel |
| `M365_TENANT` | Verzeichnis-ID, oder `organizations` |

Entscheidungen, die dabei bewusst so getroffen sind:

* **Die Verbindung gehört einem Benutzer, nicht der Anwendung.** Termine entstehen
  in seinem Kalender, Mails gehen aus seinem Postfach und unter seinem Namen. Es
  gibt keine anonyme Absenderidentität, und das Protokoll bleibt aussagekräftig.
* **Nur delegierte Berechtigungen**, und nur vier: `offline_access`, `User.Read`,
  `Calendars.ReadWrite`, `Mail.Send`. **`Mail.Read` ist nicht dabei** — die
  Anwendung liest keine Postfächer. Damit kommt sie ausschließlich an das Konto
  dessen, der sich angemeldet hat, nie an das der Organisation.
* **Kein PDF-Renderer im Container.** Das Angebot wird aus der Druckansicht als
  PDF gesichert und beim Versand ausgewählt; der Browser liest es und schickt es
  mit. Ein Renderer nur für diesen Zweck wäre zu teuer erkauft. Grenze 3 MB.
* **Ohne die Variablen ist die Anbindung schlicht aus.** Die Anwendung läuft
  unverändert, die Kalenderdateien bleiben.

Die Zugangstoken liegen in der Datenbank im Klartext. Eine Verschlüsselung wäre
nur so stark wie der Schlüssel, der daneben in derselben Umgebung liegen müsste;
wirksam schützt hier der Zugriffsschutz der Datenbank. `DATABASE_URL` ist damit
ein Geheimnis, und Sicherungen gehören entsprechend behandelt. Der geheime
Clientschlüssel läuft ab — das Datum notieren, sonst bricht die Verbindung
unangekündigt ab.

---

## Stammdaten übernehmen

*Verwaltung → Stammdaten übernehmen* liest eine vorbereitete JSON-Datei mit
Partnerorganisationen und Retainern samt Aufbauplan, Kunden, Projekten, Angeboten
mit Positionen und geplanten Begehungen. Wiederholbar: Vorhandenes wird
übersprungen und nie überschrieben; was in der Anwendung geändert wurde, bleibt.

Diesen Weg gibt es, weil von außen kein Zugriff auf die Datenbank besteht.
Angebotssummen werden dabei **immer aus den Positionen gerechnet**, nie aus der
Datei übernommen.

> **Nur eigene Vorgänge.** Über diesen Weg gehören ausschließlich Angebote,
> Rechnungen und Verträge der Westphal Wavetec GmbH bzw. STEER.E in die
> Plattform. Unterlagen aus früheren Tätigkeiten für Dritte — insbesondere
> Angebote und Kalkulationen der Service4Charger GmbH — gehören dort nicht
> hinein, auch nicht als Historie.

---

### Wo die Grenze liegt

Es ist eine Einbahnstraße, und das bleibt es ohne echte Anbindung:

* Was im Outlook-Kalender steht, sieht die Anwendung **nicht**.
* Ein **Anhang** lässt sich so nicht mitgeben. Für ein Angebot heißt das:
  erst Druckansicht öffnen und als PDF sichern, dann *Per Mail* drücken und
  das PDF in Outlook anhängen. Der Ablauf steht als Hinweis über dem Angebot.
* Der Schriftverkehr mit einem Kunden **erscheint nicht** in der Plattform.
* `mailto` ist längenbegrenzt (Outlook schneidet oberhalb von etwa 2.000
  Zeichen kommentarlos ab). Die Anwendung kürzt deshalb selbst und setzt
  `[…]` ans Ende, statt eine halbe Mail zu erzeugen.

Diese Grenzen gelten für den Datei-Weg. Mit eingerichteter Microsoft-Anbindung
(siehe oben) fallen sie weg — dann schreibt die Anwendung direkt in den Kalender
und versendet Mails mit Anhang. Was auch dann bleibt: Die Anwendung liest keine
Postfächer; im Kunden erscheint nur, was aus ihr heraus versendet wurde.

---

## Forecast — Soll, Ist, Abweichung

*Forecast* zeigt Monat, Quartal und Jahr gegen die hinterlegten Ziele, dazu
Mitarbeiterziele und den daraus errechneten Prämienstand.

**Der Ist-Wert wird nie gespeichert, sondern immer aus den Belegen gerechnet:**
Umsatz aus festgeschriebenen Rechnungen (Stornos negativ), Auftragseingang aus
beauftragten Angeboten. Eine gespeicherte Ist-Zahl wäre binnen einer Woche
falsch, und niemand wüsste, warum.

**Ziele** unter *Forecast → Ziele und Prämien*. Feineres schlägt gröberes: Ein
Monatsziel gilt; ein Quartalsziel wird nur auf die Monate ohne eigenes Ziel
verteilt, ein Jahresziel entsprechend auf die verbleibenden.

**Prämien** werden gerechnet, nicht eingetragen: Erreichung = Ist ÷ Ziel; unter
der Schwelle nichts, ab der Schwelle Prämie × Erreichung, begrenzt auf den
Deckel. Der Rechenweg steht daneben — eine Prämie, die niemand nachrechnen
kann, erzeugt Streit statt Antrieb.

**Die Hochrechnung sagt, woraus sie besteht:** Erreichtes plus gewichtete
Pipeline. Die Gewichte stehen als `forecast_gewicht_versendet` und
`forecast_gewicht_beauftragt` in den Einstellungen, nicht versteckt in einer
Formel — es sind Schätzwerte, bis ihr aus den eigenen Zahlen Besseres wisst.

### Zur Darstellung

Die Diagramme entstehen serverseitig als SVG. Keine Diagrammbibliothek, kein
CDN: Sie sollen im Ausdruck stehen, ohne Netz funktionieren und nicht davon
abhängen, dass ein fremdes Skript lädt.

Drei Entscheidungen, die bewusst gegen die Gewohnheit gehen:

* **Das Ziel ist eine Marke über dem Balken, kein zweiter Balken daneben.** Zwei
  ähnlich helle Balken nebeneinander sind schwerer zu vergleichen als ein Balken
  gegen eine Linie.
* **Die Abweichung nutzt Blau und Orange, nicht Grün und Rot.** Grün gegen Rot
  ist für etwa jeden zwölften Mann nicht unterscheidbar; beide Varianten wurden
  gegen die Simulation für Rotgrünschwäche geprüft und fielen durch. Richtung
  des Balkens und Vorzeichen der Zahl tragen die Aussage ohnehin.
* **Monate, die noch nicht gelaufen sind, stehen blass und ohne Abweichung.**
  Ein offener Monat ist kein Rückstand.

Alle Diagrammfarben sind gegen beide Modi geprüft: Helligkeitsband,
Farbsättigung, Trennschärfe bei Farbfehlsichtigkeit und Kontrast zur Fläche.
Zu jedem Diagramm gibt es dieselben Zahlen als Tabelle.

---

## Rechnungen (GoBD)

Eine Rechnung ist bis zur **Festschreibung** änderbar und danach nicht mehr — das ist
keine Frage der Oberfläche, sondern in der Datenbank per Trigger durchgesetzt. Eine
festgeschriebene Rechnung lässt sich auch mit direktem Datenbankzugriff nicht mehr
ändern; die Korrektur läuft ausschließlich über eine Stornorechnung.

Der Nummernkreis ist lückenlos, und zu jeder festgeschriebenen Rechnung wird eine
SHA-256-Prüfsumme über ihren Inhalt gespeichert.

**Korrektur in 3.4 — das Storno war vorher nicht ausführbar.** Der Stornobeleg wurde
angelegt und im selben Zug festgeschrieben, und erst danach sollten seine Positionen
hineingeschrieben werden. Genau das verbietet der Schutztrigger. Jeder Stornoversuch
brach deshalb ab; auf der Oberfläche erschien eine Fehlerseite. Die Rechnungsnummer
war zu diesem Zeitpunkt schon gezogen und fiel nicht mit zurück — jeder Versuch hat
also eine Nummer verbraucht und eine Lücke hinterlassen.

Drei Dinge sind daran geändert:

1. Der Stornobeleg entsteht als Entwurf, bekommt seine Positionen und wird erst
   danach festgeschrieben — mit eigener Prüfsumme, nach derselben Regel wie eine
   normale Rechnung.
2. Die Rechnungsnummer wird innerhalb derselben Transaktion gezogen. Bricht der
   Vorgang ab, fällt die Nummer zurück. Das gilt jetzt auch für die Festschreibung.
3. Die Positionen des Stornos werden 1:1 übernommen statt negiert. Der Kopf trug
   ohnehin den positiven Betrag; die Umkehrung passiert überall über die Belegart.
   Vorher widersprach der gedruckte Stornobeleg sich selbst: negative Zeilen, positiver
   Gutschriftbetrag. Zusätzlich nimmt das Storno den Umsatz jetzt wieder aus dem
   Projekt heraus.

**Was das für bereits verbrauchte Nummern bedeutet.** Die Lücken lassen sich nicht
rückwirkend schließen — vergebene Nummern sind vergeben. Für eine Prüfung genügt es,
sie zu erklären: Datum, Nummer und Grund („technisch fehlgeschlagener Stornoversuch")
gehören in die Verfahrensdokumentation. Welche Nummern betroffen sind, steht unter
*Verwaltung → Protokoll* und ergibt sich aus dem Sprung in der Rechnungsliste.

### Rechnungen löschen (3.5)

Es gab überhaupt keine Löschfunktion — ein versehentlich angelegter Entwurf blieb für
immer in der Liste stehen. Gleichzeitig fehlte der Datenbank ein DELETE-Schutz: Die
Trigger deckten UPDATE ab, nicht DELETE. Eine festgeschriebene Rechnung ließ sich per
direktem SQL also löschen — genau das, was die Festschreibung verhindern soll.

Seit 3.5 gilt beides:

* **Entwürfe lassen sich löschen**, mit Rückfrage und Eintrag im Änderungsprotokoll.
* **Festgeschriebene Rechnungen nicht** — weder über die Oberfläche noch über SQL.
  Der Trigger `rechnung_nicht_loeschbar` weist es ab. Der Weg zurück heißt Storno.

---

## Retainer und Monatsnachweis

Unter *Verwaltung → Organisationen & Retainer* wird eine Partnerorganisation
(z. B. FiERAX GmbH) mit Kontingent und Entgelt hinterlegt. Im Partnerbereich werden
Leistungen je Monat erfasst; daraus erzeugt *Monatsnachweis* das Dokument, das bisher
von Hand in Word gepflegt wurde — inklusive Mehrleistung, abrechnungsrelevanter
Leistung und implizitem Stundensatz.

---

## Projektassistent (vorbereitet, nicht aktiv)

Datenbankablage, Oberfläche und Schalter sind vorhanden; es fehlt nur der API-Schlüssel.
Solange `ki_aktiv` auf `0` steht, entstehen keine Kosten. Details unter
*Verwaltung → Projektassistent*.

Ein Vorschlag des Assistenten ändert grundsätzlich nichts von selbst — er liegt in der
Ablage, bis ein Mensch ihn übernimmt oder verwirft.

**Vor dem Einschalten:** Der Assistent sendet Projektdaten an einen externen Dienst.
Das ist eine Auftragsverarbeitung und gehört ins Verarbeitungsverzeichnis.

---

## Offene Punkte, die nur intern geklärt werden können

1. **Handelsregister.** Der Monatsbericht nennt „HRB 27186 HL" (Amtsgericht Lübeck),
   das Term Sheet „HRB [Nr.] AG Hamburg". Eines von beiden ist falsch. Die richtige
   Angabe gehört unter *Verwaltung → Einstellungen → `firma_register`* — sie erscheint
   im Angebotsfuß und im Monatsnachweis und ist nach § 35a GmbHG Pflicht.
2. **Repository auf privat stellen.** Solange es öffentlich ist, sind die Altdaten
   für jeden abrufbar.
3. **Datenschutz.** Die Plattform verarbeitet personenbezogene Daten von Kunden und
   Ansprechpartnern. Verarbeitungsverzeichnis und Löschkonzept fehlen noch.

---

## Aufbau

```
server.js                 Express-Server, Sitzungen, Routen
lib/db.js                 Postgres-Verbindung und Migrationslauf
lib/auth.js               Anmeldung, Passwörter (scrypt), Rollen
lib/helfer.js             Formatierung, Einstellungen, Zahlen-Parser
lib/kennungen.js          Schutz gegen ungültige IDs in Adressen
lib/medien.js             Objektspeicher (S3/R2) mit lokalem Rückfall
lib/kennzahlen.js         Finanzkennzahlen für Übersicht und Finanzen
lib/vorlagen.js           Angebotsvorlagen, Mengenherkunft, Textbausteine
lib/lernen.js             Rückfragen, Stückliste, Erfahrungswerte
lib/erststart.js          Selbsteinrichtung beim allerersten Start
lib/kalender.js           Kalenderdateien (.ics) und vorbereitete Mails
lib/m365.js               Microsoft Graph: Anmeldung, Kalender, Mailversand
lib/stammdaten.js         Übernahme von Verträgen, Vorgängen und Angeboten
lib/forecast.js           Soll/Ist, Abweichung, Hochrechnung, Prämien
lib/diagramm.js           Diagramme als SVG, ohne Fremdbibliothek
lib/automatik.js          Wiedervorlage- und Informationsautomatik (täglich 06:00)
lib/altdaten.js           Übernahme der Altkunden, wiederholbar
migrations/               Nummerierte Schemadateien, additiv, nie löschend
  001_kern                Kunden, Projekte, Benutzer, Protokoll
  002_angebote            Angebote und Positionen
  003_retainer_und_felder Retainer, eigene Felder
  004_begehung_...        Begehungen, Medien, Rechnungen, Kalkulation
  005_vorlagen_...        Angebotsvorlagen, Textbausteine
  006_lernschleife        Prüfregeln, Erfahrungen, Stücklistenregeln
  007_pflichtfotos_regel  Korrektur an 006
  008_herkunftsschutz_... Herkunftsschutz per Trigger statt Einmal-Update
  009_m365                Microsoft-Konten, Ereignis-Verknüpfung, Nachrichten
  010_ziele_praemien      Ziele, Prämienregeln, Forecast-Gewichte
routes/                   anmeldung · crm · angebote · preise · begehungen ·
                          rechnungen · kalkulator · finanzen · vorlagen ·
                          partner · verwaltung
views/                    EJS-Vorlagen
public/steere.css         Oberfläche, Hell- und Dunkelmodus, Telefonansicht
scripts/                  migrate · setup · import_preise · import_altdaten
db/seed/                  Preisdaten als JSON (Altdaten nicht im Repository)
```

Keine Build-Schritte, keine nativen Abhängigkeiten — es gibt beim Deployment nichts,
was kompiliert werden müsste und dabei scheitern kann.
