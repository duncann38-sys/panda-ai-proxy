const MAX_GROUNDING_SOURCES = 6;

const EVENT_AREA_PHRASE = /\b(?:in|near|around|at|to)\s+([\p{L}\p{M}\d][\p{L}\p{M}\d'’.-]*(?:[\s-]+[\p{L}\p{M}\d][\p{L}\p{M}\d'’.-]*){0,3}(?:,\s*[\p{L}\p{M}][\p{L}\p{M}.'’-]*)?)/giu;
const EVENT_TIME_MARKER = /\b(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening|week|weekend|month|year)|next\s+(?:week|weekend|month|year)|coming\s+(?:week|weekend)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const NON_LOCATION_EVENT_TERMS = /^(?:(?:the\s+)?(?:concerts?|gigs?|live\s+music|live\s+shows?|shows?|performances?|artists?|bands?|tour|stage|theatres?|theaters?|venues?)|me|here|there|nearby|local(?:ly)?)$/i;

export function extractEventArea(text) {
  const candidates = [];
  for (const match of String(text || '').matchAll(EVENT_AREA_PHRASE)) {
    let candidate = match[1].trim();
    const timeMarker = candidate.search(EVENT_TIME_MARKER);
    if (timeMarker >= 0) candidate = candidate.slice(0, timeMarker);
    candidate = candidate
      .replace(/\b(?:for|at|in|on|near|around|to)\s*$/i, '')
      .replace(/[,\s.?!]+$/g, '')
      .trim();
    if (!candidate || NON_LOCATION_EVENT_TERMS.test(candidate)) continue;
    candidates.push(candidate);
  }
  return candidates.at(-1) || '';
}

export function groundingQueryCount(candidate) {
  const queries = candidate?.groundingMetadata?.webSearchQueries;
  return Array.isArray(queries)
    ? queries.filter(query => typeof query === 'string' && query.trim()).length
    : 0;
}

export function groundingSources(candidate) {
  const chunks = candidate?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set();
  const sources = [];
  for (const chunk of chunks) {
    const web = chunk?.web;
    if (typeof web?.uri !== 'string') continue;
    try {
      const parsed = new URL(web.uri);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.hostname === 'localhost') continue;
      if (/^(?:www\.)?google\.[a-z.]+$/i.test(parsed.hostname) && parsed.pathname.startsWith('/search')) continue;
      const url = parsed.toString();
      if (seen.has(url)) continue;
      seen.add(url);
      const title = String(web.title || parsed.hostname).replace(/\s+/g, ' ').trim().slice(0, 140);
      sources.push({
        title: title || parsed.hostname,
        url,
        domain: parsed.hostname.replace(/^www\./i, '').slice(0, 120),
      });
      if (sources.length >= MAX_GROUNDING_SOURCES) break;
    } catch {
      // Ignore malformed or non-web grounding chunks.
    }
  }
  return sources;
}

export function groundingSearchLinks(candidate) {
  const queries = candidate?.groundingMetadata?.webSearchQueries;
  if (!Array.isArray(queries)) return [];
  const seen = new Set();
  const links = [];
  for (const value of queries) {
    if (typeof value !== 'string') continue;
    const query = value.replace(/\s+/g, ' ').trim().slice(0, 180);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    links.push({
      title: `Google search: ${query}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      domain: 'google.com',
    });
    if (links.length >= MAX_GROUNDING_SOURCES) break;
  }
  return links;
}

export function groundedEventText(candidate) {
  return (candidate?.content?.parts || [])
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .join('')
    .trim();
}
