'use strict';
/**
 * Schutz fuer numerische Kennungen in Adressen.
 *
 * Express wendet app.param() NICHT auf Router an, die per app.use eingehaengt
 * werden - deshalb muss jeder Router die Pruefung selbst installieren.
 * Ohne sie landet ein "abc" aus der Adresszeile als NaN in einer SQL-Abfrage
 * und erzeugt eine 500er-Seite statt einer verstaendlichen Meldung.
 */

function nichtGefunden(res) {
  return res.status(404).render('fehler', {
    titel: 'Nicht gefunden',
    text: 'Diese Adresse enthält keine gültige Kennung. Vermutlich ein alter oder abgeschnittener Link.',
  });
}

/** Installiert die Pruefung fuer alle uebergebenen Parameternamen. */
function schuetze(router, namen = ['id', 'pid']) {
  for (const name of namen) {
    router.param(name, (req, res, next, wert) => {
      if (!/^[1-9]\d{0,9}$/.test(String(wert))) return nichtGefunden(res);
      next();
    });
  }
  return router;
}

module.exports = { schuetze, nichtGefunden };
