const CUISINES = [
  ['Italian', /\bitalian\b/i], ['Indian', /\bindian\b/i], ['Japanese', /\bjapanese\b/i],
  ['Chinese', /\bchinese\b/i], ['Thai', /\bthai\b/i], ['French', /\bfrench\b/i],
  ['Spanish', /\bspanish\b/i], ['British', /\bbritish\b/i], ['Mexican', /\bmexican\b/i],
  ['Turkish', /\bturkish\b/i], ['Lebanese', /\blebanese\b/i], ['Greek', /\bgreek\b/i],
  ['Portuguese', /\bportuguese\b/i],
];
function normalized(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-GB')
    .replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}
export function venueCardIntro(query = '') {
  const cuisine = CUISINES.find(([, pattern]) => pattern.test(query))?.[0];
  const kind = /\b(pub|pubs|pint)\b/i.test(query) ? 'pubs'
    : /\b(bars?|cocktails?)\b/i.test(query) ? 'bars'
      : /\b(caf[eé]s?|coffee)\b/i.test(query) ? 'cafés' : 'places';
  const nearby = /\b(near(?:by| me| us| you)?|around (?:me|here)|local)\b/i.test(query);
  return `Here are a few ${cuisine ? cuisine + ' ' : ''}${kind}${nearby ? ' nearby' : ' matching your search'}.`;
}
// Leave factual answers and booking conversations intact. Only remove the prose
// duplication of venue recommendations already delivered as structured cards.
export function venueCardReply(text, venues, query = '') {
  if (!Array.isArray(venues) || !venues.length || typeof text !== 'string') return text;
  if (/\b(?:compare|comparison|difference|why|what time|closing|opening hours|menu|book(?:ing)?|reserv(?:e|ation)|availability|confirm(?:ation)?|cancel|amend)\b/i.test(query))
    return text;
  const names = venues.map(venue => normalized(venue?.name)).filter(name => name.length > 2);
  const body = normalized(text);
  const listed = text.split(/\r?\n/).some(line =>
    /^\s*(?:\d+[.)]|[-*•])\s+/.test(line)
    && names.some(name => normalized(line).includes(name)));
  const repeated = names.filter(name => body.includes(name)).length >= 2;
  return listed || repeated ? venueCardIntro(query) : text;
}
