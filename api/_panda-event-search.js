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

export function buildLiveShowSearchInstruction(area, source = 'device') {
  const destination = String(area || 'the user’s local area').slice(0, 120);
  return [
    `LIVE PERFORMANCE SEARCH: Use Google Search grounding for the artist named in the conversation. Search area: ${destination}.`,
    source === 'explicit'
      ? 'The user named this destination; search that place, not the device location.'
      : 'The user did not name another destination; prioritize the city/region derived from device location. Do not return unrelated global tour dates.',
    'For a named performer, lead with the most recent confirmed performance you can verify (date, venue and city), then the next confirmed upcoming performance in the requested area. If none is announced, say so plainly and provide a clickable source link to the artist’s verified official website or official tour page.',
    'If the artist name is ambiguous, especially a first name alone such as “Bruce”, ask one short clarification instead of guessing the person.',
    'For ticket-cost questions, give a current source-backed price or range, currency, and whether fees are included when the source states it. If no verified price is published, say “ticket price not published or verified”; never estimate or claim availability.',
    'Use only facts supported by the Google grounding sources. Prefer the artist’s official site, venue pages, and authorized ticket sellers; cross-check dates and prices when possible. The app renders up to six clickable source links. Never type or invent raw URLs, prices, fees, or event details.',
    'If search returns no citable pages, do not give an uncited date or price. Do not substitute generic Google search-result cards for an artist website. Do not return venue recommendations for a performance question.',
    'Keep the response warm, concise and useful. One relevant emoji such as 🎟️ may add warmth, but keep dates and prices easy to scan. Panda can share event links but cannot purchase tickets.',
  ].join('\n');
}

export function buildOfficialArtistWebsiteFallbackInstruction(area, artistName = '') {
  const artist = String(artistName || 'the named performer').slice(0, 120);
  return [
    `OFFICIAL ARTIST WEBSITE LOOKUP: Use Google Search grounding to find the first-party official website or official tour page for ${artist}. Search the exact performer name plus “official website”; area context: ${String(area || 'the user’s local area').slice(0, 120)}.`,
    'If the performer name is ambiguous, ask one short clarification instead of guessing.',
    'Return only a grounded source whose page title clearly identifies the artist’s official site or whose domain matches the artist name. Do not write a URL in the reply text; the app displays grounded links as clickable source cards. Do not return search results, fan pages, news articles, venues, social networks, or ticket resellers as substitutes.',
    'Do not state performance dates, ticket prices, or availability during this fallback lookup. If no official page is verified, say so plainly and do not invent a URL.',
  ].join('\n');
}

export function extractArtistName(text) {
  const value = String(text || '');
  const match = value.match(/\b(?:when|where)\s+(?:is|are|did|will|does|has|have)\s+(.+?)\s+(?:last\s+)?(?:perform(?:ing)?|play(?:ing)?|appear(?:ing)?|take\s+the\s+stage|tour(?:ing)?|in\s+concert)\b/i);
  if (!match) return '';
  const artist = match[1]
    .replace(/\b(?:the|next|last|soon|again|tonight|tomorrow)\b/gi, ' ')
    .replace(/^[\s"'“”]+|[\s"'“”?.!,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:artist|performer|band|singer|musician)$/i.test(artist) ? '' : artist.slice(0, 120);
}

export function isArtistClarification(text) {
  const value = String(text || '');
  return /\b(?:which\s+(?:artist|performer|band|singer|musician|one)|which\s+\w+\s+do you mean|who\s+(?:do you mean|are you referring to)|do you mean|could you clarify|please clarify|full name)\b/i.test(value);
}

export function isVerifiedOfficialArtistSource(source, artistName = '') {
  const title = String(source?.title || '').trim();
  if (!title) return false;
  if (/(?:ultimateclassicrock|concertful|ticketmaster|livenation|songkick|setlist\.fm|bandsintown|wikipedia|instagram|facebook|twitter|x\.com|tiktok|youtube|linktr\.ee)/i.test(title)) return false;
  const artistTokens = String(artistName || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3 && !/^(?:the|and|band|artist|singer|musician)$/.test(token));
  const normalizedTitle = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (!artistTokens.length || !artistTokens.every(token => normalizedTitle.includes(token))) return false;
  return /\bofficial\b/i.test(title)
    || /^(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(title);
}

export function extractArtistWebsiteCandidate(text, artistName = '') {
  const artistTokens = String(artistName || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3 && !/^(?:the|and|band|artist|singer|musician)$/.test(token));
  if (!artistTokens.length) return '';
  const blocked = /(?:ultimateclassicrock|concertful|ticketmaster|livenation|songkick|setlist\.fm|bandsintown|wikipedia|instagram|facebook|twitter|x\.com|tiktok|youtube|linktr\.ee)/i;
  const hosts = String(text || '').match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/gi) || [];
  for (const host of hosts) {
    if (blocked.test(host)) continue;
    const normalizedHost = host
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
    if (artistTokens.every(token => normalizedHost.includes(token))) return host.toLowerCase();
  }
  return '';
}

export function buildOfficialArtistCandidateVerificationInstruction(area, artistName, candidateHost) {
  return [
    `FIRST-PARTY SITE VERIFICATION: Use Google Search grounding to verify the official website for ${String(artistName || 'the named performer').slice(0, 120)}. Candidate domain to check: ${String(candidateHost || 'none supplied').slice(0, 160)}.`,
    'Search the performer name and candidate domain together. Confirm from grounded evidence that the domain is the artist’s own official website or official tour page; a matching name alone is not proof.',
    `Area context: ${String(area || 'the user’s local area').slice(0, 120)}. If the candidate cannot be verified, search independently for the official first-party artist site.`,
    'Return only a grounded source whose page title clearly identifies the artist’s official site or whose domain matches the artist name. Do not return articles, fan pages, venues, social networks or ticket sellers.',
    'Do not state performance dates, ticket prices or availability, and do not type raw URLs in reply text. If no official source is verified, say so plainly.',
  ].join('\n');
}

export function shouldSearchOfficialArtistSite(text) {
  const value = String(text || '');
  if (isArtistClarification(value)) return false;
  return /https?:\/\/\S+/i.test(value)
    || /\b(?:no|none|not|without|hasn['’]?t|haven['’]?t)\b.{0,80}\b(?:confirmed|upcoming|announced|performances?|shows?|dates?|tour)\b/i.test(value)
    || /\bno\s+(?:concerts?|gigs?|events?)\b/i.test(value);
}

export function stripRawUrls(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]\(\s*(?:https?:\/\/[^)]*)?\s*\)/gi, '$1')
    .replace(/https?:\/\/[^\s<>()]+/gi, '')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|info|biz|co\.uk|org\.uk|ac\.uk|com\.au|co\.nz|it|de|fr|es|se|no|dk|fi|nl|be|ie|ca|us)\b/gi, '')
    .replace(/:\s+(?=[\u{1F000}-\u{1FAFF}])/gu, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\b(?:at|via|here|the link is)\s*(?=$|[.,;!?])/i, '')
    .trim();
}

export function isFlightPriceQuestion(text) {
  return /\b(?:flight|flights|fly|airfare|airline fares?)\b/i.test(String(text || ''));
}

export function extractFlightRoute(text) {
  const match = String(text || '').match(
    /\bfrom\s+([\p{L}\p{M}\d][\p{L}\p{M}\d'’.-]*(?:[\s-]+[\p{L}\p{M}\d][\p{L}\p{M}\d'’.-]*){0,3})\s+(?:to|→)\s+([\p{L}\p{M}\d][\p{L}\p{M}\d'’.-]*(?:[\s-]+[\p{L}\p{M}\d][\p{L}\p{M}\d'’.-]*){0,3})(?=\s+\b(?:on|for|next|this|in|with|including|leaving|departing)\b|[?.!,]|$)/iu,
  );
  if (!match) return '';
  const destination = match[2]
    .replace(/\s+\b(?:on|for|next|this|in|with|including|leaving|departing)\b[\s\S]*$/i, '')
    .trim();
  return `${match[1].trim()} to ${destination}`;
}

export function extractPriceSearchArea(text) {
  const candidates = [];
  const stop = /\b(?:with|without|including|excluding|for|on|next|this|today|tomorrow|in|at|and)\b/i;
  for (const match of String(text || '').matchAll(/\b(?:in|near|around)\s+([^\n?.!,;]+)/giu)) {
    let candidate = match[1].trim();
    const stopAt = candidate.search(stop);
    if (stopAt >= 0) candidate = candidate.slice(0, stopAt);
    candidate = candidate.replace(/[,\s.?!]+$/g, '').trim();
    if (!candidate || /^(?:a|an|this|that|my|your|the menu|the bottle)$/i.test(candidate)) continue;
    candidates.push(candidate);
  }
  return candidates.at(-1) || '';
}

export function buildPriceSearchInstruction(area, source = 'device', travel = false) {
  const market = String(area || 'the user’s local area').slice(0, 120);
  return [
    `LIVE PRICE SEARCH: Use Google Search grounding for current, source-backed prices. Market or route context: ${market}.`,
    source === 'explicit'
      ? 'The user named this city, country or route; use it rather than the device location.'
      : 'The user did not name another market; use their device city/region for local retail and dining prices.',
    travel
      ? 'For flights, use the origin and destination in the user’s message. If the destination is named but no origin is given, use the device city as the origin when available; otherwise ask. If travel dates are missing, give a clearly labelled current indicative average or range from Google sources and state that dates are unspecified. State one-way or return only when verified; do not imply the fare is bookable or guaranteed.'
      : 'Cover any product or service price the user asks about, not only restaurants or travel. For a restaurant meal, use current official menu prices where available. If asked for a meal with and without wine, show food-only and food plus one glass of wine as separate per-person totals, state the assumed dishes and glass size, and include service charge only when a source confirms it. For a bottle or retail product, specify size and market; assume a standard 750 ml bottle only when the user has not specified a size. For a vehicle or other product commonly bought new and used, give separate new and used price ranges when current sources support both; state the model/trim, age, mileage or condition assumptions that materially affect the used range.',
    'Give an exact price only when a current source lists it. Otherwise provide a Google-grounded indicative range or average only when the search results support it; label it as an estimate and say when it was checked. Include currency, taxes, delivery, baggage and fees when known, and clearly say when these are excluded or unknown.',
    'Never invent prices, menus, fares, stock, ticket availability or fees. If reliable price sources are missing, say the price could not be verified instead of guessing.',
    'Prefer official manufacturers, retailers, current menus, airlines, airports and authorized sellers; use reputable comparison sites for market-wide ranges. The app renders up to six clickable Google-grounded source links, labelled with their publisher; do not type raw URLs or generic Google search links into the answer.',
    'Use one or two relevant emojis naturally (for example 🍾, 🍽️ or ✈️) when they make the answer warmer; keep the figures and assumptions clear.',
  ].join('\n');
}

export function buildPriceSourceFallbackInstruction(area, travel = false) {
  return [
    `TARGETED PRICE SOURCE RECHECK: Run one focused Google Search grounded recheck for the exact product, meal or route in the user’s latest question. Market/route: ${String(area || 'the user’s local area').slice(0, 120)}.`,
    travel
      ? 'Search current airline or reputable fare-comparison pages for the exact route. State the date assumptions and one-way/return basis only when verified.'
      : 'For a named brand without a product variant, use a clearly stated standard/popular variant as an assumption. For a car or product with a meaningful used market, search new and used prices separately and include both only when cited pages support them; for dining, use the named restaurant’s current menu. Prefer manufacturer, dealer, retailer or restaurant pages that show current prices.',
    'Give an exact price only when a current page supports it. Give a range only when multiple current source prices support the range. State currency, product size, date checked and material exclusions such as fees, service, tax or delivery when known.',
    'The app displays Google-grounded source pages as clickable cards. Do not write raw URLs or Google search links in the reply. If no citable price page is found, say that the price could not be verified and do not guess.',
    'Use one or two relevant emojis naturally only if they fit the answer.',
  ].join('\n');
}

export function buildFeelGoodNewsSearchInstruction(area = '', source = 'global') {
  const region = String(area || 'reputable international sources').slice(0, 120);
  return [
    `LIVE FEEL-GOOD NEWS SEARCH: Use Google Search grounding to find one or two recent, verifiable positive news stories. Reader region/source context: ${region}.`,
    source === 'device'
      ? 'Prefer credible stories relevant to the user’s current region when available; otherwise use reliable international sources.'
      : 'Use the region or source context explicitly requested by the user.',
    'Give each story a short, accurate headline-style description, publisher and publication date when verified. Explain the positive detail without exaggerating or implying a broader outcome than the source supports.',
    'Prefer established newsrooms, public-interest organisations and primary sources. Exclude tragedies, sensationalism, unverified social posts and generic search-result pages.',
    'The app renders Google-grounded source pages as clickable publisher cards. Do not type raw URLs or invent facts, dates or links. If no recent positive story can be verified, say so plainly.',
    'Use one fitting emoji naturally, not a chain of emojis.',
  ].join('\n');
}

export function groundedEventText(candidate) {
  return (candidate?.content?.parts || [])
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .join('')
    .trim();
}
