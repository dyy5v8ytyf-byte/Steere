'use strict';
/**
 * Diagramme als SVG, serverseitig erzeugt.
 *
 * Keine Diagrammbibliothek und kein CDN: Die Grafiken sollen im Ausdruck
 * stehen, ohne Netz funktionieren und nicht davon abhaengen, dass ein
 * fremdes Skript geladen wird. SVG kann das alles von Haus aus.
 *
 * Gestaltungsregeln, die hier durchgehalten werden:
 *  - Farbe kommt zuletzt und traegt nie allein die Aussage. Jede Serie hat
 *    zusaetzlich Beschriftung, Vorzeichen oder Position.
 *  - Soll ist keine zweite Balkenfarbe, sondern ein Marker. Zwei aehnlich
 *    helle Balken nebeneinander sind schwerer zu lesen als ein Balken mit
 *    einer Zielmarke — und rot/gruen faellt bei Rotgruenschwaeche aus.
 *  - Die Abweichung nutzt Blau/Orange statt Gruen/Rot: Gruen und Rot sind
 *    fuer etwa jeden zwoelften Mann nicht unterscheidbar. Richtung des
 *    Balkens und Vorzeichen der Zahl tragen die Aussage ohnehin.
 *  - Zu jedem Diagramm gibt es die Zahlen auch als Tabelle.
 */

const EUR = new Intl.NumberFormat('de-DE', {
  style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
});

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function kurz(v) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  if (a >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + ' Mio';
  if (a >= 1000) return Math.round(n / 1000) + 'k';
  return String(Math.round(n));
}

/** Runde Enden nur am Datenende, nicht an der Grundlinie. */
function balkenPfad(x, y, b, hoehe, r = 4, nachOben = true) {
  const rr = Math.min(r, b / 2, Math.abs(hoehe));
  if (Math.abs(hoehe) < 0.7) return '';
  if (nachOben) {
    return `M${x},${y + hoehe} L${x},${y + rr} Q${x},${y} ${x + rr},${y}`
      + ` L${x + b - rr},${y} Q${x + b},${y} ${x + b},${y + rr} L${x + b},${y + hoehe} Z`;
  }
  const u = y + hoehe;
  return `M${x},${y} L${x},${u - rr} Q${x},${u} ${x + rr},${u}`
    + ` L${x + b - rr},${u} Q${x + b},${u} ${x + b},${u - rr} L${x + b},${y} Z`;
}

/**
 * Soll/Ist je Periode.
 * Ist als Balken, Soll als Zielmarke darueber — das ist die Bulletform.
 * Perioden nach dem heutigen Monat werden blasser gezeichnet: Ein Monat,
 * der noch nicht gelaufen ist, ist kein Rueckstand.
 */
function sollIst({ titel, punkte, bisIndex = null, hoehe = 220, id = 'd1' }) {
  const links = 52; const rechts = 12; const oben = 16; const unten = 30;
  const breite = 720;
  const iw = breite - links - rechts;
  const ih = hoehe - oben - unten;
  const max = Math.max(1, ...punkte.map((p) => Math.max(p.ist || 0, p.soll || 0)));
  const skala = (v) => ih - (v / max) * ih;
  const proSpalte = iw / punkte.length;
  const b = Math.max(6, Math.min(38, proSpalte - 10));

  let s = `<svg viewBox="0 0 ${breite} ${hoehe}" class="dia" role="img" `
    + `aria-labelledby="${id}-t"><title id="${id}-t">${esc(titel)}</title>`;

  // Grundlinien, zurueckhaltend
  for (let i = 0; i <= 4; i += 1) {
    const y = oben + (ih / 4) * i;
    const wert = max - (max / 4) * i;
    s += `<line x1="${links}" y1="${y}" x2="${breite - rechts}" y2="${y}" class="dia-raster"/>`;
    s += `<text x="${links - 8}" y="${y + 4}" class="dia-achse" text-anchor="end">${kurz(wert)}</text>`;
  }

  punkte.forEach((p, i) => {
    const x = links + proSpalte * i + (proSpalte - b) / 2;
    const kuenftig = bisIndex != null && i >= bisIndex;
    const yIst = oben + skala(p.ist || 0);
    const hIst = ih - skala(p.ist || 0);

    if (hIst > 0.7) {
      s += `<path d="${balkenPfad(x, yIst, b, hIst)}" class="dia-ist${kuenftig ? ' kuenftig' : ''}">`
        + `<title>${esc(p.name)}: Ist ${EUR.format(p.ist || 0)}`
        + (p.soll ? `, Ziel ${EUR.format(p.soll)}` : '') + `</title></path>`;
    }
    // Zielmarke
    if (p.soll > 0) {
      const yS = oben + skala(p.soll);
      s += `<line x1="${x - 3}" y1="${yS}" x2="${x + b + 3}" y2="${yS}" class="dia-ziel">`
        + `<title>${esc(p.name)}: Ziel ${EUR.format(p.soll)}</title></line>`;
    }
    s += `<text x="${x + b / 2}" y="${hoehe - 10}" class="dia-achse" text-anchor="middle">${esc(p.name)}</text>`;
  });

  return s + '</svg>';
}

/**
 * Abweichung zum Ziel als beidseitiger Balken um eine Nulllinie.
 * Richtung und Vorzeichen tragen die Aussage; die Farbe bestaetigt sie nur.
 */
function abweichung({ titel, punkte, hoehe = 200, id = 'd2' }) {
  const links = 52; const rechts = 46; const oben = 14; const unten = 26;
  const breite = 720;
  const iw = breite - links - rechts;
  const ih = hoehe - oben - unten;
  const max = Math.max(1, ...punkte.map((p) => Math.abs(p.wert || 0)));
  const mitte = oben + ih / 2;
  const proSpalte = iw / punkte.length;
  const b = Math.max(6, Math.min(38, proSpalte - 10));

  /*
   * Die Zahl steht ausserhalb des Balkens, also braucht sie dort Platz.
   * Ohne diese Rinne rutscht die Beschriftung des laengsten Balkens genau
   * auf die Monatsbeschriftung darunter — im Ausdruck steht dann "−24k"
   * quer ueber "Aug". Der Balken darf deshalb nur bis `halb` reichen, nicht
   * bis zur Mitte der Flaeche.
   */
  const rinne = 16;
  const halb = Math.max(8, ih / 2 - rinne);

  let s = `<svg viewBox="0 0 ${breite} ${hoehe}" class="dia" role="img" `
    + `aria-labelledby="${id}-t"><title id="${id}-t">${esc(titel)}</title>`;
  s += `<line x1="${links}" y1="${mitte}" x2="${breite - rechts}" y2="${mitte}" class="dia-null"/>`;
  s += `<text x="${links - 8}" y="${mitte - halb + 4}" class="dia-achse" text-anchor="end">+${kurz(max)}</text>`;
  s += `<text x="${links - 8}" y="${mitte + halb + 4}" class="dia-achse" text-anchor="end">−${kurz(max)}</text>`;

  punkte.forEach((p, i) => {
    const w = p.wert || 0;
    const x = links + proSpalte * i + (proSpalte - b) / 2;
    const laenge = (Math.abs(w) / max) * halb;
    const ueber = w >= 0;
    const y = ueber ? mitte - laenge : mitte;

    if (laenge > 0.7) {
      s += `<path d="${balkenPfad(x, y, b, laenge, 4, ueber)}" class="${ueber ? 'dia-ueber' : 'dia-unter'}">`
        + `<title>${esc(p.name)}: ${w >= 0 ? '+' : '−'}${EUR.format(Math.abs(w))} zum Ziel</title></path>`;
    }
    if (!p.leer) {
      s += `<text x="${x + b / 2}" y="${ueber ? y - 5 : y + laenge + 12}" `
        + `class="dia-wert" text-anchor="middle">${w >= 0 ? '+' : '−'}${kurz(Math.abs(w))}</text>`;
    }
    s += `<text x="${x + b / 2}" y="${hoehe - 8}" class="dia-achse" text-anchor="middle">${esc(p.name)}</text>`;
  });

  return s + '</svg>';
}

/**
 * Anteile als Ring.
 * Ein Ring statt Vollkreis, weil die Mitte die Gesamtsumme tragen kann —
 * die Zahl, die sonst niemand aus den Segmenten ablesen kann. Zwischen den
 * Segmenten bleibt eine Luecke in Flaechenfarbe, damit sie sich auch ohne
 * Farbunterscheidung trennen.
 */
function ring({ titel, punkte, groesse = 260, id = 'd3' }) {
  const summe = punkte.reduce((s, p) => s + (p.wert || 0), 0);
  const r = groesse / 2 - 10;
  const dicke = 38;
  const cx = groesse / 2; const cy = groesse / 2;

  let s = `<svg viewBox="0 0 ${groesse} ${groesse}" class="dia dia-ring" role="img" `
    + `aria-labelledby="${id}-t"><title id="${id}-t">${esc(titel)}</title>`;

  if (summe <= 0) {
    s += `<circle cx="${cx}" cy="${cy}" r="${r - dicke / 2}" class="dia-leer"/>`;
    s += `<text x="${cx}" y="${cy + 5}" class="dia-achse" text-anchor="middle">keine Daten</text>`;
    return s + '</svg>';
  }

  let winkel = -Math.PI / 2;
  const luecke = 0.018; // Trennung in Flaechenfarbe, wirkt ohne Farbe
  punkte.forEach((p, i) => {
    const anteil = (p.wert || 0) / summe;
    const spanne = anteil * Math.PI * 2 - luecke;
    if (spanne <= 0) return;
    const a1 = winkel + luecke / 2;
    const a2 = a1 + spanne;
    const rr = r - dicke / 2;
    const x1 = cx + Math.cos(a1) * rr; const y1 = cy + Math.sin(a1) * rr;
    const x2 = cx + Math.cos(a2) * rr; const y2 = cy + Math.sin(a2) * rr;
    const gross = spanne > Math.PI ? 1 : 0;
    s += `<path d="M${x1},${y1} A${rr},${rr} 0 ${gross} 1 ${x2},${y2}" `
      + `class="dia-seg dia-s${(i % 5) + 1}" stroke-width="${dicke}" fill="none">`
      + `<title>${esc(p.name)}: ${EUR.format(p.wert)} (${(anteil * 100).toFixed(1).replace('.', ',')} %)</title></path>`;
    winkel += anteil * Math.PI * 2;
  });

  s += `<text x="${cx}" y="${cy - 2}" class="dia-mitte" text-anchor="middle">${kurz(summe)} €</text>`;
  s += `<text x="${cx}" y="${cy + 16}" class="dia-achse" text-anchor="middle">gesamt</text>`;
  return s + '</svg>';
}

/** Waagerechter Fortschritt gegen ein Ziel, mit Schwelle und Deckel. */
function messlatte({ ist, ziel, schwelle = null, deckel = null, breite = 420, id = 'd4' }) {
  const hoehe = 34;
  const max = Math.max(ziel * (deckel ? deckel / 100 : 1.2), ist, 1);
  const x = (v) => (v / max) * breite;

  let s = `<svg viewBox="0 0 ${breite} ${hoehe}" class="dia dia-latte" role="img" `
    + `aria-labelledby="${id}-t"><title id="${id}-t">Erreichung gegen Ziel</title>`;
  s += `<rect x="0" y="10" width="${breite}" height="14" rx="7" class="dia-bahn"/>`;
  const b = Math.max(0, x(ist));
  if (b > 1) s += `<rect x="0" y="10" width="${b}" height="14" rx="7" class="dia-ist"><title>Ist ${EUR.format(ist)}</title></rect>`;
  if (ziel > 0) {
    s += `<line x1="${x(ziel)}" y1="4" x2="${x(ziel)}" y2="30" class="dia-ziel"><title>Ziel ${EUR.format(ziel)}</title></line>`;
    s += `<text x="${Math.min(x(ziel) + 4, breite - 30)}" y="9" class="dia-achse">Ziel</text>`;
  }
  if (schwelle) {
    const xs = x(ziel * schwelle / 100);
    s += `<line x1="${xs}" y1="8" x2="${xs}" y2="26" class="dia-schwelle"><title>Schwelle ${schwelle} %</title></line>`;
  }
  return s + '</svg>';
}

/**
 * Flacher Verlauf fuer eine Kennzahlkachel.
 *
 * Bewusst ohne Achsen, Raster und Zahlen: Eine Sparkline beantwortet genau
 * eine Frage — "geht es hoch oder runter" — und jede zusaetzliche Linie
 * macht sie in dieser Groesse unleserlich. Der letzte Punkt ist markiert,
 * damit klar ist, wo "jetzt" liegt.
 *
 * `bis` schneidet den Verlauf am laufenden Monat ab. Ein Verlauf, der auf
 * null zulaeuft, weil die restlichen Monate noch nicht gelaufen sind, sieht
 * aus wie ein Einbruch — und genau so wuerde er auch gelesen.
 */
function spark({ werte, bis = null, breite = 240, hoehe = 34, id = 's1' }) {
  const reihe = (bis != null ? werte.slice(0, Math.max(1, bis)) : werte).map((v) => Number(v) || 0);
  if (reihe.length < 2) {
    return `<svg viewBox="0 0 ${breite} ${hoehe}" class="dia" role="img" aria-label="zu wenig Daten"></svg>`;
  }

  const rand = 3;
  const max = Math.max(...reihe, 1);
  const min = Math.min(...reihe, 0);
  const spanne = max - min || 1;
  const x = (i) => rand + (i / (reihe.length - 1)) * (breite - rand * 2);
  const y = (v) => hoehe - rand - ((v - min) / spanne) * (hoehe - rand * 2);

  const punkte = reihe.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const linie = `M${punkte.join(' L')}`;
  const flaeche = `${linie} L${x(reihe.length - 1).toFixed(1)},${hoehe - rand} L${x(0).toFixed(1)},${hoehe - rand} Z`;
  const letzterX = x(reihe.length - 1);
  const letzterY = y(reihe[reihe.length - 1]);

  return `<svg viewBox="0 0 ${breite} ${hoehe}" preserveAspectRatio="none" class="dia" role="img" `
    + `aria-labelledby="${id}-t"><title id="${id}-t">Verlauf über ${reihe.length} Monate, `
    + `zuletzt ${EUR.format(reihe[reihe.length - 1])}</title>`
    + `<path d="${flaeche}" class="spark-flaeche"/>`
    + `<path d="${linie}" class="spark-linie" vector-effect="non-scaling-stroke"/>`
    // Ein Kreis waere hier falsch: Die Flaeche wird in der Breite gestreckt
    // (preserveAspectRatio="none"), ein Kreis daraus ein Ei. Ein senkrechter
    // Strich uebersteht die Streckung unveraendert und sagt dasselbe —
    // "hier ist jetzt".
    + `<line x1="${letzterX.toFixed(1)}" y1="${(letzterY - 4).toFixed(1)}" `
    + `x2="${letzterX.toFixed(1)}" y2="${(letzterY + 4).toFixed(1)}" `
    + `class="spark-linie" vector-effect="non-scaling-stroke"/>`
    + '</svg>';
}

module.exports = { sollIst, abweichung, ring, messlatte, spark, kurz, esc };
