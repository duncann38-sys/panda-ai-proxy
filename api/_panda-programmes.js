// Free, public official programmes; no Places-derived performance dates or invented shows.
const SOURCES = [
  { url: 'https://officiallondontheatre.com/theatre-tickets/', kind: 'theatre', productions: true, paths: /^\/show\// },
  { url: 'https://officiallondontheatre.com/london-musicals/', kind: 'musicals', productions: true, paths: /^\/show\// },
  { url: 'https://www.southbankcentre.co.uk/whats-on/', kind: 'concerts', paths: /^\/whats-on\/[^/]+\/?$/ },
  { url: 'https://www.barbican.org.uk/whats-on', kind: 'concerts', paths: /^\/whats-on\/\d{4}\/event\// },
];
const HOSTS = new Set(SOURCES.flatMap(source => {
  const host = new URL(source.url).hostname.replace(/^www\./, '');
  return [host, `www.${host}`];
}));
// Additional official venue domains used by directly cited production fixtures/links.
HOSTS.add('www.nationaltheatre.org.uk');
HOSTS.add('nationaltheatre.org.uk');
const cache = new Map();
const pending = new Map();
const MAX_BYTES = 700_000;

export function programmeDate(text, timeZone = 'Europe/London', now = new Date()) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone }).format(now); }
  catch { timeZone = 'Europe/London'; }
  const date = new Date(now);
  if (/\btomorrow\b/i.test(text)) date.setUTCDate(date.getUTCDate() + 1);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = key => parts.find(part => part.type === key).value;
  return { iso: `${value('year')}-${value('month')}-${value('day')}`, timeZone, label: new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(date) };
}

function clean(value, max = 180) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
    const point = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
    return point > 0 && point <= 0x10FFFF && !(point >= 0xD800 && point <= 0xDFFF) ? String.fromCodePoint(point) : '';
  }).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

export function extractProgrammeEvents(html, sourceUrl, date, { productions = false, kind } = {}) {
  const events = [];
  let visited = 0;
  function visit(value) {
    if (++visited > 5000 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const types = [value['@type']].flat().filter(Boolean);
    const matchesConcert = kind !== 'concerts' || types.includes('MusicEvent') || /\b(?:music|concert|classical|jazz|orchestral)\b/i.test(String(value.genre || ''));
    if (matchesConcert && types.some(type => /^(?:Event|TheaterEvent|MusicEvent|DanceEvent|ComedyEvent)$/.test(type)) && typeof value.startDate === 'string') {
      const start = value.startDate;
      let day = start.slice(0, 10), time = '';
      if (/T/.test(start)) {
        const parsed = new Date(start);
        if (!Number.isFinite(parsed.getTime()) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(start)) return;
        day = programmeDate('', date.timeZone, parsed).iso;
        time = new Intl.DateTimeFormat('en-GB', { timeZone: date.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(parsed);
      }
      const end = typeof value.endDate === 'string' ? value.endDate.slice(0, 10) : '';
      const runMatches = productions && /^\d{4}-\d{2}-\d{2}$/.test(day) && /^\d{4}-\d{2}-\d{2}$/.test(end) && day <= date.iso && end >= date.iso;
      const longRun = end && end !== day && (!/T/.test(start) || !Number.isFinite(Date.parse(value.endDate)) || Date.parse(value.endDate) - Date.parse(start) > 12 * 60 * 60 * 1000);
      // Show-run dates are inspiration, never evidence of a specific performance/time.
      if ((runMatches || (!productions && day === date.iso && !longRun)) && !/cancel|postpon|reschedul/i.test(String(value.eventStatus || ''))) {
        let url;
        try { url = new URL(typeof value.url === 'string' ? value.url : sourceUrl, sourceUrl); } catch { return; }
        const name = clean(value.name);
        if (name && url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.username && !url.password) {
          const venue = clean(value.location?.name);
          events.push({ name, venue: /^https?:\/\//i.test(venue) ? '' : venue, date: productions ? date.iso : day, time: productions ? '' : time, url: url.href, source: sourceUrl,
            evidence: productions ? 'official_running_production' : 'official_dated_programme',
            ...(productions ? { runStart: day, runEnd: end } : {}),
          });
        }
      }
    }
    for (const key of ['@graph', 'itemListElement', 'item', 'event', 'events', 'subEvent', 'subEvents']) {
      if (value[key]) visit(value[key]);
    }
  }
  for (const match of String(html).slice(0, MAX_BYTES).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(match[1])) continue;
    try { visit(JSON.parse(match[2])); } catch { /* Ignore malformed structured data. */ }
  }
  return [...new Map(events.map(event => [`${event.name}|${event.date}|${event.time}`, event])).values()];
}

async function officialPage(url, fetchImpl) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname) || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetchImpl(parsed.href, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'text/html', 'User-Agent': 'PandaProgrammeCheck/1.0' } });
    if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) return '';
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); return ''; }
    const reader = response.body.getReader();
    const chunks = []; let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) { await reader.cancel(); return ''; }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  } catch { return ''; } finally { clearTimeout(timer); }
}

export async function officialProgrammes({ text, context = {}, location, intent, area }, { fetchImpl = fetch, now = new Date() } = {}) {
  const date = programmeDate(text, context?.timeZone, now);
  const empty = { events: [], productions: [], dateLabel: date.label };
  // Do not offer London shows for a different city or an unverified named area.
  const londonRequested = /^london(?:,\s*(?:uk|united kingdom))?$/i.test((area || '').trim());
  const nearLondon = location && location.lat >= 51.25 && location.lat <= 51.75 && location.lng >= -0.55 && location.lng <= 0.35;
  if (!londonRequested && (area || !nearLondon)) return empty;
  const key = `${date.iso}|${date.timeZone}|${intent.kind}`;
  if (cache.get(key)?.expires > now.getTime()) return cache.get(key).result;
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    const sources = SOURCES.filter(source => intent.kind === 'concerts' ? source.kind === 'concerts' : source.kind === (intent.kind === 'musicals' ? 'musicals' : 'theatre'));
    const groups = await Promise.all(sources.map(async source => {
      const html = await officialPage(source.url, fetchImpl);
      const direct = extractProgrammeEvents(html, source.url, date, source);
      if (direct.length) return direct;
      const links = [];
      for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
        try {
          const url = new URL(match[1].replace(/&amp;/g, '&'), source.url);
          if (HOSTS.has(url.hostname) && url.hostname.replace(/^www\./, '') === new URL(source.url).hostname.replace(/^www\./, '') && source.paths.test(url.pathname) && !links.includes(url.href)) links.push(url.href);
        } catch { /* Ignore malformed links. */ }
        if (links.length >= 2) break;
      }
      const pages = await Promise.all(links.map(async url => extractProgrammeEvents(await officialPage(url, fetchImpl), url, date, source)));
      return [...direct, ...pages.flat()];
    }));
    const found = [...new Map(groups.flat().map(event => [`${event.name}|${event.date}|${event.time}`, event])).values()];
    const events = found.filter(event => event.evidence === 'official_dated_programme').slice(0, 6);
    const productions = found.filter(event => event.evidence === 'official_running_production').slice(0, 6);
    const result = { events, productions, dateLabel: date.label };
    if (cache.size >= 24) cache.delete(cache.keys().next().value);
    cache.set(key, { expires: now.getTime() + 10 * 60 * 1000, result });
    return result;
  })();
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}
