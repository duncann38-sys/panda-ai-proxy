const HOT_DINNERS_FEED_URL = 'https://www.hot-dinners.com/hot-dinners-rss-feed';
const HOT_DINNERS_HOST = 'www.hot-dinners.com';
const FEED_CACHE_MS = 15 * 60 * 1000;
const MAX_CANDIDATE_SEARCHES = 10;
const MAX_OPENING_CARDS = 6;
const MIN_RATING = 4.3;
const MAX_DISTANCE_METERS = 20000;
let cachedFeed = null;

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, decimal) => {
      const code = parseInt(decimal, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function stripMarkup(value) {
  return decodeXml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function atomTag(entry, name) {
  const match = entry.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '\\s*>', 'i'));
  return match ? stripMarkup(match[1]) : '';
}

function atomLink(entry) {
  const links = [...entry.matchAll(/<link\b([^>]*)\/?\s*>/gi)];
  const alternate = links.find((match) => /\brel=["']alternate["']/i.test(match[1])) || links[0];
  if (!alternate) return '';
  const href = alternate[1].match(/\bhref=["']([^"']+)["']/i);
  return href ? decodeXml(href[1]) : '';
}

function isAllowedHotDinnersUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === HOT_DINNERS_HOST;
  } catch {
    return false;
  }
}

function openingArea(text) {
  const areas = ['Nine Elms','Battersea','Clapham','Chelsea','Victoria','Mayfair','Marylebone','Shoreditch','Hackney','Highbury','Islington','Belgravia','Soho','Covent Garden','Notting Hill','Shepherds Bush','Kensington','Fitzrovia','Clerkenwell','Dalston','Spitalfields','Westminster','Southwark','Brixton','Greenwich','Peckham','Hackney Wick'];
  const lower = String(text || '').toLocaleLowerCase('en-GB');
  return areas.find((area) => lower.includes(area.toLocaleLowerCase('en-GB'))) || '';
}

function extractVenueName(title, summary) {
  const titleText = String(title || '').trim();
  const summaryText = String(summary || '');
  const patterns = [
    [/^test\s+driving\s+([^,:|]+?)(?:,|:|$)/i, titleText],
    [/\b([A-Z][\p{L}\d&'’.-]*(?:\s+[A-Z][\p{L}\d&'’.-]*){0,2})\s+(?:has|have)\s+(?:just\s+)?opened\b/iu, summaryText],
    [/^(.+?)\s+(?:has|have)\s+(?:just\s+)?opened\b/i, titleText],
    [/\bwith\s+([A-Z][\p{L}\d&'’.-]*(?:\s+[A-Z][\p{L}\d&'’.-]*){0,2})\s*$/u, titleText],
  ];
  for (const [pattern, text] of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim().replace(/[.!?]+$/, '');
    if (candidate && candidate.length >= 3 && candidate.length <= 64) return candidate;
  }
  return '';
}

function hasFutureOpeningLanguage(text) {
  return /\b(?:getting\s+ready|preparing|planning|plans|planned|set)\s+to\s+(?:open|bring|launch)\b|\bcoming\s+(?:soon|to)\b|\bwill\s+(?:open|launch)\b|\bopening\s+(?:soon|next\s+week|next\s+month)\b|\bpop[- ]?ups?\b/i.test(text);
}

function hasExplicitRecentOpenEvidence(text, now) {
  if (hasFutureOpeningLanguage(text)) return false;
  if (!/\b(?:has|have)\s+(?:just\s+)?opened\b|\bopened\s+its\s+doors\b|\b(?:is|are)\s+now\s+open\b|\bnow\s+open\b/i.test(text)) return false;
  const oldYear = text.match(/\bopened\b[^.!?]{0,90}?\b(?:back\s+in|in)\s+(20\d{2})\b/i);
  if (oldYear && Number(oldYear[1]) < new Date(now).getUTCFullYear()) return false;
  return true;
}

function parseAtomEntries(xml) {
  return [...String(xml || '').matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
}

export function isNewOpeningRequest(text) {
  return /\b(?:new\s+restaurants?|new\s+openings?|new\s+and\s+buzzing|new\s*&\s*buzzing|recently\s+opened)\b/i.test(String(text || ''));
}

export function parseHotDinnersOpenings(xml, options = {}) {
  const now = Number(options.now ?? Date.now());
  const windowDays = Number(options.windowDays ?? 90);
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const entry of parseAtomEntries(xml)) {
    const title = atomTag(entry, 'title');
    const summary = atomTag(entry, 'summary');
    const published = atomTag(entry, 'published');
    const publishedMs = Date.parse(published);
    const url = atomLink(entry);
    const evidenceText = (title + ' ' + summary).trim();
    if (!title || !Number.isFinite(publishedMs) || publishedMs < cutoff || publishedMs > now + 24 * 60 * 60 * 1000) continue;
    if (!isAllowedHotDinnersUrl(url) || !hasExplicitRecentOpenEvidence(evidenceText, now)) continue;
    const venueName = extractVenueName(title, summary);
    if (!venueName) continue;
    const area = openingArea(title + ' ' + summary);
    candidates.push({ venueName, sourceName: 'Hot Dinners', sourceUrl: url, sourceTitle: title, publishedAt: new Date(publishedMs).toISOString(), area, searchQuery: [venueName, area, 'London'].filter(Boolean).join(' ') });
  }
  const unique = new Map();
  for (const candidate of candidates) {
    const key = candidate.venueName.toLocaleLowerCase('en-GB');
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()].sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
}

function normalizedVenueName(value) {
  return String(value || '').normalize('NFKD').toLocaleLowerCase('en-GB')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:the|a|an|restaurant|bar|pub|cafe|café|london)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function matchesOpeningVenueName(candidateName, venueName) {
  const candidate = normalizedVenueName(candidateName);
  const venue = normalizedVenueName(venueName);
  if (!candidate || !venue) return false;
  if (candidate === venue || candidate.includes(venue) || venue.includes(candidate)) return true;
  const tokens = candidate.split(' ').filter((token) => token.length > 2);
  return tokens.length >= 2 && tokens.every((token) => venue.split(' ').includes(token));
}

function isEligibleGoogleVenue(candidate, venue) {
  if (!venue?.id || !venue?.name || !matchesOpeningVenueName(candidate.venueName, venue.name)) return false;
  const photoCount = Number(venue.photoCount);
  const rating = Number(venue.rating);
  if (!venue.photoName || !Number.isFinite(photoCount) || photoCount < 1 || !Number.isFinite(rating) || rating < MIN_RATING) return false;
  if (venue.businessStatus && venue.businessStatus !== 'OPERATIONAL') return false;
  if (Number.isFinite(Number(venue.distanceMeters)) && Number(venue.distanceMeters) > MAX_DISTANCE_METERS) return false;
  return true;
}

function safeSeenIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.slice(-120).filter((value) => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/\s/.test(value)))];
}

function rotate(values, rotation) {
  if (!values.length) return [];
  const offset = ((Math.trunc(Number(rotation) || 0) % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export function rotateOpeningResults(venues, seenIds = [], rotation = 0, limit = MAX_OPENING_CARDS) {
  const unique = [...new Map((venues || []).filter((venue) => venue?.id).map((venue) => [venue.id, venue])).values()];
  const seen = new Set(safeSeenIds(seenIds));
  const unseen = unique.filter((venue) => !seen.has(venue.id));
  if (!unseen.length) return rotate(unique, rotation).slice(0, limit);
  const preferred = rotate(unseen, rotation).slice(0, limit);
  if (preferred.length >= limit) return preferred;
  const previouslySeen = rotate(unique.filter((venue) => seen.has(venue.id)), rotation);
  return [...preferred, ...previouslySeen].slice(0, limit);
}

async function fetchOpeningFeed(fetchImpl, now) {
  if (cachedFeed && now - cachedFeed.fetchedAt < FEED_CACHE_MS) return cachedFeed.xml;
  const requestOptions = { headers: { Accept: 'application/atom+xml, application/xml;q=0.9' } };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') requestOptions.signal = AbortSignal.timeout(5000);
  const response = await fetchImpl(HOT_DINNERS_FEED_URL, requestOptions);
  if (!response?.ok) throw new Error('opening_source_unavailable');
  const xml = await response.text();
  if (!xml || !/<entry\b/i.test(xml)) throw new Error('opening_source_invalid');
  cachedFeed = { xml, fetchedAt: now };
  return xml;
}

export function clearOpeningFeedCache() { cachedFeed = null; }

export async function findRecentOpeningVenues(options) {
  const now = Number(options.now ?? Date.now());
  const fetchImpl = options.fetchImpl;
  const searchCandidate = options.searchCandidate;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rotationInput = Number(options.rotation);
  const rotation = Number.isSafeInteger(rotationInput) && rotationInput >= 0 ? Math.min(rotationInput, 1000000) : 0;
  const seenIds = safeSeenIds(options.seenPlaceIds);
  let xml;
  try { xml = await fetchOpeningFeed(fetchImpl, now); }
  catch { return { newOpeningsSearch: true, sourceStatus: 'unavailable', venues: [], text: 'I can’t check the new-opening source right now, so I won’t guess. Please try again shortly.' }; }
  const candidates = parseHotDinnersOpenings(xml, { now, windowDays: 90 }).slice(0, MAX_CANDIDATE_SEARCHES);
  const matchedByCandidate = new Array(candidates.length);
  let quotaBlocked = false;
  let nextIndex = 0;
  let lastSearchStart = 0;
  let startQueue = Promise.resolve();
  const reserveSearchStart = () => {
    const slot = startQueue.then(async () => {
      const waitMs = lastSearchStart ? Math.max(0, 100 - (Date.now() - lastSearchStart)) : 0;
      if (waitMs) await sleep(waitMs);
      lastSearchStart = Date.now();
    });
    startQueue = slot.catch(() => undefined);
    return slot;
  };
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const candidate = candidates[index];
      await reserveSearchStart();
      try {
        const result = await searchCandidate(candidate.searchQuery, candidate);
        if (result?.providerFailed && Number(result.providerStatus) === 429) quotaBlocked = true;
        const venueResults = Array.isArray(result) ? result : (result?.venues || []);
        const venue = venueResults.find((item) => isEligibleGoogleVenue(candidate, item));
        if (venue) matchedByCandidate[index] = { ...venue, openingSourceName: candidate.sourceName, openingSourceUrl: candidate.sourceUrl, openingReportedAt: candidate.publishedAt };
      } catch { /* A single failed Google lookup must not hide other source-verified openings. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, () => worker()));
  const matched = [...new Map(matchedByCandidate.filter(Boolean).map((venue) => [venue.id, venue])).values()];
  const venues = rotateOpeningResults(matched, seenIds, rotation, MAX_OPENING_CARDS);
  if (quotaBlocked && !venues.length) return { newOpeningsSearch: true, sourceStatus: 'places_rate_limited', venues: [], text: 'Google has temporarily rate-limited venue checks. The dated opening reports are intact; please try again shortly.' };
  const text = venues.length
    ? 'Here are recent London openings reported by Hot Dinners in the last 90 days, matched to live Google listings rated 4.3 or higher. Tap a source line to read the report.'
    : 'I couldn’t verify any 4.3+ recent openings near you from a dated Hot Dinners report in the last 90 days. I won’t pad this with ordinary nearby restaurants.';
  return { newOpeningsSearch: true, sourceStatus: venues.length ? 'verified_matches' : 'no_verified_matches', openingWindowDays: 90, venues, text };
}