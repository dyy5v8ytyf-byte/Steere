#!/bin/bash
# WWtec Salesmanagement – einfach doppelklicken zum Starten (macOS).
cd "$(dirname "$0")"

# Node kann je nach Installationsart (nodejs.org-Installer, Homebrew, nvm) an
# unterschiedlichen Orten liegen, die ein Doppelklick-Terminal nicht immer im
# PATH hat. Wir hängen die üblichen Orte defensiv an, bevor wir prüfen.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/opt/node/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js wurde nicht gefunden (auch nicht an den üblichen Installationsorten)."
  echo ""
  echo "Falls du es gerade erst installiert hast: bitte diesen Mac einmal neu starten"
  echo "(oder zumindest ab- und wieder anmelden) und start.command erneut doppelklicken -"
  echo "frisch installierte Programme sind in einem schon offenen Terminal manchmal noch nicht sichtbar."
  echo ""
  echo "Falls noch nicht installiert: https://nodejs.org (LTS-Version) installieren."
  echo ""
  echo "Zur Fehlersuche - aktueller Suchpfad (PATH):"
  echo "$PATH"
  read -p "Enter zum Schließen..." _
  exit 1
fi

echo "Node.js gefunden: $(command -v node) ($(node -v))"

if [ ! -d node_modules ] || [ ! -d node_modules/express ]; then
  echo "Einmalige Einrichtung läuft (kann 1-2 Minuten dauern, Internetverbindung nötig) ..."
  npm install --no-fund --no-audit
  if [ $? -ne 0 ]; then
    echo ""
    echo "Die Einrichtung ist fehlgeschlagen. Bitte die Fehlermeldung oben kopieren und schicken."
    read -p "Enter zum Schließen..." _
    exit 1
  fi
fi

echo ""
echo "Starte WWtec Salesmanagement ..."
echo "Dieses Fenster offen lassen, solange das Programm läuft."
echo "Zum Beenden: dieses Fenster schließen oder Strg+C drücken."
echo ""

( sleep 2 && open "http://localhost:3000" ) &
node server.js
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo ""
  echo "Das Programm wurde mit einem Fehler beendet (Code $STATUS)."
  echo "Bitte die Meldungen oben kopieren und schicken."
  read -p "Enter zum Schließen..." _
fi
