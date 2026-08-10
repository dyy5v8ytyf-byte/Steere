// Einfache Erkennung wiederkehrender Projektbeschreibungen ("Wiederholungen merken"),
// ohne externe Bibliotheken: Wort-Überlappung (Jaccard) auf Beschreibungstexten.
const STOPWORDS = new Set(['und', 'oder', 'der', 'die', 'das', 'für', 'mit', 'ein', 'eine', 'einen', 'den', 'dem', 'im', 'am', 'als', 'auf', 'von', 'zu', 'ist', 'sind', 'nicht', 'auch', 'sich']);

function tokenize(text) {
  if (!text) return new Set();
  return new Set(
    text.toLowerCase()
      .replace(/[^a-zäöüß0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Gibt eine Liste ähnlicher Projekte zurück (id, bezeichnung, firma, score), Schwelle 0.3
function findSimilarProjects(db, projectId, beschreibung) {
  const tokens = tokenize(beschreibung);
  if (!tokens.size) return [];
  const others = db.prepare(`
    SELECT p.id, p.bezeichnung, p.beschreibung, c.id as customer_id, c.firma
    FROM projects p JOIN customers c ON c.id = p.customer_id
    WHERE p.id != ? AND p.beschreibung IS NOT NULL AND p.beschreibung != ''
  `).all(projectId);

  const results = [];
  for (const o of others) {
    const score = jaccard(tokens, tokenize(o.beschreibung));
    if (score >= 0.3) results.push({ id: o.id, bezeichnung: o.bezeichnung, firma: o.firma, customer_id: o.customer_id, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5);
}

module.exports = { findSimilarProjects };
