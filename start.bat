@echo off
REM WWtec Salesmanagement - einfach doppelklicken zum Starten (Windows).
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js wurde nicht gefunden.
  echo Bitte zuerst die LTS-Version von https://nodejs.org installieren,
  echo dann dieses Fenster schliessen und start.bat erneut doppelklicken.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Einmalige Einrichtung laeuft ^(kann 1-2 Minuten dauern, Internetverbindung noetig^) ...
  call npm install --no-fund --no-audit
  if %errorlevel% neq 0 (
    echo.
    echo Die Einrichtung ist fehlgeschlagen. Bitte Fehlermeldung oben pruefen.
    pause
    exit /b 1
  )
)

echo.
echo Starte WWtec Salesmanagement ...
echo Dieses Fenster offen lassen, solange das Programm laeuft.
echo.

start "" http://localhost:3000
node server.js
pause
