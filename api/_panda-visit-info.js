const decode = text => text.replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ')
  .replace(/&pound;|&#163;/gi, '£').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
export function officialVisitInfo(html, sourceUrl) {
  const source = new URL(sourceUrl);
  const host = source.hostname.replace(/^www\./, '');
  const plain = decode(String(html).replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:p|div|li|h[1-6]|section)>/gi, '\n').replace(/<[^>]*>/g, ' '));
  const facts = plain.split('\n').map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length < 240
      && /\b(?:general admission|standard admission|adult admission|admission prices?|admission fee|entry fee|entry prices?|free entry|free admission|(?:entry|admission) is free|no (?:entry|admission) fee)\b/i.test(line)
      && !/\b(?:children|child|members|under \d|caf[eé]|restaurant|shop|selected|except|after|before|weekends?|sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|until|events?|exhibitions?|tours?|workshops?|students?|concessions?|residents?|sessions?|open day|purchase|voucher|discount|competition|prize|not)\b|\bno free\b|\bfor\s+(?!(?:all|everyone|everybody)\b)/i.test(line));
  const fact = facts.find(line => /\bfree (?:entry|admission)\b|\b(?:entry|admission)\s+(?:is\s+)?free\b|\bno (?:entry|admission) fee\b/i.test(line))
    || facts.find(line => /(?:£|€|\$)\s*\d/.test(line));
  let ticketsUrl = null, diningUrl = null;
  for (const match of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decode(match[1]), source);
      const linkedHost = url.hostname.replace(/^www\./, '');
      if (!/^https?:$/.test(url.protocol) || url.username || url.password
        || !(linkedHost === host || linkedHost.endsWith('.' + host))) continue;
      const text = decode(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (/\b(?:exhibitions?|events?|members?|donat|gift|private|christmas)\b/i.test(text + ' ' + url.pathname)) continue;
      if (!ticketsUrl && !/\bshop\b/i.test(text + ' ' + url.pathname)
        && /\b(?:admission|book (?:your |a )?visit|(?:book|buy|get) tickets?|book (?:a )?free entry ticket|general tickets?)\b/i.test(text))
        ticketsUrl = url.href;
      if (!diningUrl && /\b(?:food (?:and|&)\s*drink|eat (?:and|&)\s*drink|caf[eé]s?(?: and restaurants)?|restaurants?|dining)\b/i.test(text))
        diningUrl = url.href;
    } catch { /* Ignore malformed official anchors. */ }
  }
  return {
    sourceUrl: source.href, ticketsUrl, diningUrl,
    admission: fact ? { kind: /\bfree\b|\bno (?:entry|admission) fee\b/i.test(fact) && !/(?:£|€|\$)\s*\d/.test(fact) ? 'free' : 'priced', text: fact } : null,
  };
}
