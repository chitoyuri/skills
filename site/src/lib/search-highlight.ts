export function splitSearchMatches(value: string, terms: string[]) {
  const matches = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (matches.length === 0) {
    return [{ text: value, matched: false }];
  }

  const pattern = new RegExp(matches.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
  const parts = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (cursor < start) parts.push({ text: value.slice(cursor, start), matched: false });
    parts.push({ text: match[0], matched: true });
    cursor = start + match[0].length;
  }
  if (cursor < value.length || parts.length === 0) {
    parts.push({ text: value.slice(cursor), matched: false });
  }
  return parts;
}
