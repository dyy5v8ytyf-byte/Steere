// Phasen-Workflow, wie vom Nutzer vorgegeben.
// Reihenfolge = Standard-Ablauf; "Wiedervorlage" wird automatisch erreicht,
// wenn ein Kunde in "Kontaktaufnahme" 14 Tage nicht reagiert (siehe cron.js).
const PHASES = [
  'Terminanfrage',
  'Kontaktaufnahme',
  'Wiedervorlage',
  'Projektbesprechung',
  'Angebot',
  'Beauftragung',
  'Terminierung',
  'Umsetzung',
  'Abgeschlossen',
  'Verloren',
];

const PHASE_COLORS = {
  'Terminanfrage': '#e2e8f0',
  'Kontaktaufnahme': '#bfdbfe',
  'Wiedervorlage': '#fde68a',
  'Projektbesprechung': '#c7d2fe',
  'Angebot': '#fbcfe8',
  'Beauftragung': '#a7f3d0',
  'Terminierung': '#99f6e4',
  'Umsetzung': '#86efac',
  'Abgeschlossen': '#4ade80',
  'Verloren': '#fca5a5',
};

// Mitarbeiter-Rollen – Startliste, im UI unter "Mitarbeiter" frei erweiterbar.
const DEFAULT_ROLES = ['Vertrieb', 'Projektmanager', 'Elektriker', 'Tiefbau', 'Admin'];

const BAUSTELLEN_STATUS = ['geplant', 'im_bau', 'beendet'];

module.exports = { PHASES, PHASE_COLORS, DEFAULT_ROLES, BAUSTELLEN_STATUS };
