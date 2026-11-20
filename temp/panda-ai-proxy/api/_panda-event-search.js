const MAX_GROUNDING_SOURCES = 4;

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

export function groundedEventText(candidate) {
  return (candidate?.content?.parts || [])
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .join('')
    .trim();
}
