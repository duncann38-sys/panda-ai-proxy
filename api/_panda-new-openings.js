const DAY_MS = 86_400_000;
export const NEW_OPENINGS_COLLECTION = 'new_openings_by_city';
export const NEW_OPENINGS_NOTICE_COLLECTION = 'new_openings_notifications';
export const NEW_OPENINGS_REFRESH_COLLECTION = 'new_openings_refresh_state';
export const NEW_OPENINGS_CACHE_MS = 7 * DAY_MS;
export const NEW_OPENINGS_MAX_PAGE_SIZE = 15;
export const NEW_OPENINGS_MAX_MAJOR_CANDIDATES = 40;
export const NEW_OPENINGS_SEARCH_VERSION = 3;
const EMPTY_RETRY_MS = 24 * 60 * 60_000;
const PREMIUM_SIGNAL = /\b(high[ -]end|fine[ -]dining|michelin|chef[ -]led|celebrated chef|renowned chef|critically acclaimed|luxury|upscale|premium|tasting menu|signature dining|cocktail lounge|cocktail bar|wine bar|rooftop bar|destination bar|hotel bar|hotel dining|hotel restaurant|luxury hotel restaurant|destination restaurant|gastropub|upscale pub|high[ -]end pub|destination pub|award[ -]winning (?:chef|restaurant|pub|bar)|exclusive dining|special[ -]occasion dining|world[ -]class|mixology)\b|£{3,4}/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function validCoordinates(lat, lng) {
  return Number.isFinite(Number(lat)) && Math.abs(Number(lat)) <= 90
    && Number.isFinite(Number(lng)) && Math.abs(Number(lng)) <= 180;
}

export function normalizeCitySlug(city, countryCode) {
  const clean = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const cityPart = clean(city);
  const countryPart = clean(countryCode).slice(0, 8);
  return cityPart && countryPart ? cityPart + '-' + countryPart : '';
}

function epoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && Number.isFinite(value._seconds)) return value._seconds * 1000;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function openingDiagnosticText(diagnostics, city) {
  if (diagnostics?.stage === 'grounding') {
    if (diagnostics.jsonArrayFound === false || diagnostics.jsonParseFailed) return 'I found restaurant-opening search results for ' + city + ', but couldn’t extract source-backed opening details yet. I won’t guess.';
    return 'I couldn’t verify dated opening reports for ' + city + ' from the available search sources yet. Try again later.';
  }
  if (diagnostics?.stage === 'places') return 'I found recent opening reports for ' + city + ', but Google Places could not confirm matching venues that meet Panda’s checks. I won’t label ordinary restaurants as new.';
  return 'I couldn’t verify recent high-end openings in ' + city + ' yet. Try again later or name another city.';
}

function mergeOpeningSearchResults(searchResults, { city, country, now, maxCandidates }) {
  const successful = searchResults.filter(result => result?.ok);
  const parsedRounds = successful.map(result => parseGroundedOpeningCandidatesDetailed(result, { city, country, now, max: maxCandidates }));
  const rejectedKeys = ['invalidName','duplicate','invalidDate','missingEvidence','notIndependent','notPremium','noGroundedSource','evidenceNameMismatch'];
  const diagnostics = { version: 3, stage: 'grounding', jsonArrayFound: parsedRounds.some(item => item.diagnostics.jsonArrayFound),
    textChars: parsedRounds.reduce((sum,item) => sum + item.diagnostics.textChars,0),
    groundingChunkCount: parsedRounds.reduce((sum,item) => sum + item.diagnostics.groundingChunkCount,0),
    parsedItems: parsedRounds.reduce((sum,item) => sum + item.diagnostics.parsedItems,0),
    sourceMatchedItems: parsedRounds.reduce((sum,item) => sum + item.diagnostics.sourceMatchedItems,0),
    sourceViaGroundingSupport: parsedRounds.reduce((sum,item) => sum + item.diagnostics.sourceViaGroundingSupport,0),
    sourceViaTitleMatch: parsedRounds.reduce((sum,item) => sum + item.diagnostics.sourceViaTitleMatch,0),
    sourceViaGoogleSearch: parsedRounds.reduce((sum,item) => sum + item.diagnostics.sourceViaGoogleSearch,0),
    acceptedItems: 0, groundingQueryCount: successful.reduce((sum,item) => sum + (Number(item.queryCount)||0),0),
    searchPassCount: searchResults.length, searchPassFailures: searchResults.length - successful.length,
    rejected: Object.fromEntries(rejectedKeys.map(key => [key, parsedRounds.reduce((sum,item) => sum + (item.diagnostics.rejected[key]||0),0)])),
  };
  const candidates = [];
  const seen = new Set();
  for (const round of parsedRounds) for (const candidate of round.candidates) {
    const key = normalizedName(candidate.name);
    if (!key || seen.has(key)) { diagnostics.rejected.duplicate++; continue; }
    seen.add(key); candidates.push(candidate);
    if (candidates.length >= maxCandidates) break;
  }
  diagnostics.acceptedItems = candidates.length;
  return { candidates, diagnostics };
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/$/, '') || '/';
    return url;
  } catch { return null; }
}

function sourceMatches(candidateUrl, chunks, context = {}) {
  const sourceChunks = chunks || [];
  const candidate = normalizedUrl(candidateUrl);
  const isDirectSource = url => url && !/(^|\.)google\./i.test(url.hostname) && url.hostname !== 'google.com';
  const result = (chunk, matchType) => {
    const uri = normalizedUrl(chunk?.web?.uri);
    if (!uri || !isDirectSource(uri)) return null;
    return { url: chunk.web.uri, title: String(chunk.web.title || uri.hostname).slice(0, 140), domain: uri.hostname, matchType };
  };
  if (candidate && isDirectSource(candidate)) {
    for (const chunk of sourceChunks) {
      const uri = normalizedUrl(chunk?.web?.uri);
      if (uri && isDirectSource(uri) && candidate.hostname === uri.hostname && candidate.pathname === uri.pathname) return result(chunk, 'exact');
    }
  }
  const name = safeText(context.name, 140);
  const openingDate = safeText(context.openingDate, 10);
  const evidence = safeText(context.evidence, 700);
  const nameKey = normalizedName(name);
  const supportIndices = new Set();
  for (const support of context.groundingSupports || []) {
    const segment = safeText(support?.segment?.text, 3000);
    const segmentKey = normalizedName(segment);
    const hasName = nameKey.length >= 3 && segmentKey.includes(nameKey);
    const hasOpeningEvidence = /\b(open|opened|opening|launch|launched|began|debut|welcomed its first guests)\b/i.test(segment)
      || (openingDate && segment.includes(openingDate))
      || (evidence && segmentKey.includes(normalizedName(evidence).slice(0, 50)));
    if (!hasName || !hasOpeningEvidence) continue;
    for (const index of support?.groundingChunkIndices || []) if (Number.isInteger(index) && index >= 0) supportIndices.add(index);
  }
  for (const index of supportIndices) {
    const match = result(sourceChunks[index], 'grounding_support');
    if (match) return match;
  }
  const tokens = nameKey.split(' ').filter(token => token.length > 2 && !['the','new','restaurant','restaurants','hotel','london'].includes(token));
  if (tokens.length) {
    for (const chunk of sourceChunks) {
      const uri = normalizedUrl(chunk?.web?.uri);
      if (!uri || !isDirectSource(uri)) continue;
      const titleKey = normalizedName(chunk?.web?.title || '');
      const matched = tokens.filter(token => titleKey.includes(token)).length;
      if (matched >= Math.min(2, tokens.length)) return result(chunk, 'title_match');
    }
  }
  const queryAvailable = Array.isArray(context.groundingQueries) && context.groundingQueries.some(query => typeof query === 'string' && query.trim());
  if (queryAvailable && name && context.city) {
    const query = '"' + name + '" restaurant opened ' + (openingDate || '') + ' ' + context.city + ' ' + (context.country || '');
    const url = 'https://www.google.com/search?q=' + encodeURIComponent(query.trim().replace(/\s+/g, ' '));
    return { url, title: 'Google Search results · verify opening', domain: 'google.com', matchType: 'google_search' };
  }
  return null;
}

function safeText(value, max = 500) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function isRecentIsoDay(value, now) {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const parsed = Date.parse(value + 'T12:00:00Z');
  return Number.isFinite(parsed) && parsed <= now && parsed >= now - 60 * DAY_MS;
}

export function parseGroundedOpeningCandidatesDetailed(response, { city, country, now = Date.now(), max = NEW_OPENINGS_MAX_MAJOR_CANDIDATES } = {}) {
  const raw = safeText(response?.text, 60_000);
  const match = raw.match(/\[[\s\S]*\]/);
  const chunks = response?.groundingMetadata?.groundingChunks || [];
  const diagnostics = { version: 3, stage: 'grounding', jsonArrayFound: Boolean(match), textChars: raw.length,
    groundingChunkCount: chunks.length, parsedItems: 0, sourceMatchedItems: 0, sourceViaGroundingSupport: 0, sourceViaTitleMatch: 0, sourceViaGoogleSearch: 0, acceptedItems: 0,
    rejected: { invalidName: 0, duplicate: 0, invalidDate: 0, missingEvidence: 0,
      notIndependent: 0, notPremium: 0, noGroundedSource: 0, evidenceNameMismatch: 0 } };
  if (!match) return { candidates: [], diagnostics };
  let values;
  try { values = JSON.parse(match[0]); } catch { diagnostics.jsonParseFailed = true; return { candidates: [], diagnostics }; }
  if (!Array.isArray(values)) return { candidates: [], diagnostics };
  diagnostics.parsedItems = values.length;
  const seen = new Set();
  const accepted = [];
  for (const item of values) {
    if (!item || typeof item !== 'object') { diagnostics.rejected.invalidName++; continue; }
    const name = safeText(item.name, 140);
    const openingDate = safeText(item.openingDate, 10);
    const evidence = safeText(item.openingEvidence, 700);
    const positioning = safeText(item.positioningEvidence, 500);
    const independentVenue = item.independentVenue === true;
    const independenceEvidence = safeText(item.independenceEvidence, 500);
    const editorialNote = safeText(item.editorialNote, 320);
    const cuisine = safeText(item.cuisine, 100);
    const venueType = safeText(item.venueType, 60);
    const url = safeText(item.sourceUrl, 1200);
    const key = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!name || key.length < 3) { diagnostics.rejected.invalidName++; continue; }
    if (seen.has(key)) { diagnostics.rejected.duplicate++; continue; }
    if (!isRecentIsoDay(openingDate, now)) { diagnostics.rejected.invalidDate++; continue; }
    if (!evidence || !positioning || !editorialNote) { diagnostics.rejected.missingEvidence++; continue; }
    if (!independentVenue || !independenceEvidence) { diagnostics.rejected.notIndependent++; continue; }
    if (!PREMIUM_SIGNAL.test(positioning + ' ' + evidence + ' ' + editorialNote)) { diagnostics.rejected.notPremium++; continue; }
    const source = sourceMatches(url, chunks, { name, openingDate, evidence, city, country, groundingSupports: response?.groundingMetadata?.groundingSupports, groundingQueries: response?.groundingMetadata?.webSearchQueries || response?.groundingQueries || [] });
    if (!source) { diagnostics.rejected.noGroundedSource++; continue; }
    diagnostics.sourceMatchedItems++;
    if (source.matchType === 'grounding_support') diagnostics.sourceViaGroundingSupport++;
    if (source.matchType === 'title_match') diagnostics.sourceViaTitleMatch++;
    if (source.matchType === 'google_search') diagnostics.sourceViaGoogleSearch++; 
    if (!evidence.toLowerCase().includes(name.toLowerCase().split(' ')[0])) { diagnostics.rejected.evidenceNameMismatch++; continue; }
    seen.add(key);
    accepted.push({ name, openingDate, openingEvidence: evidence, positioningEvidence: positioning,
      editorialNote, cuisine, venueType, independentVenue, independenceEvidence, sourceUrl: source.url, sourceName: source.title, sourceType: source.matchType,
      city: safeText(city, 100), country: safeText(country, 100) });
    if (accepted.length >= Math.min(NEW_OPENINGS_MAX_MAJOR_CANDIDATES, Math.max(1, max))) break;
  }
  diagnostics.acceptedItems = accepted.length;
  return { candidates: accepted, diagnostics };
}

export function parseGroundedOpeningCandidates(response, options = {}) {
  return parseGroundedOpeningCandidatesDetailed(response, options).candidates;
}

export function buildNewOpeningSearchPrompt({ city, country, focus = '', now = Date.now(), maxCandidates = 15 } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const cap = Math.max(1, Math.min(NEW_OPENINGS_MAX_MAJOR_CANDIDATES, Number(maxCandidates) || 15));
  const major = /^(london|new york|paris|tokyo|dubai|los angeles|singapore|hong kong)$/i.test(String(city || '').trim());
  const districts = String(focus || '').trim()
    ? ' Search specifically within these neighborhoods: ' + String(focus).slice(0, 500) + '. Do not substitute openings elsewhere in the city.'
    : /^london$/i.test(String(city || '').trim())
      ? ' Search London districts including Mayfair, Soho, Marylebone, Chelsea, Knightsbridge, Fitzrovia, Shoreditch, Covent Garden, City of London, Notting Hill, Kensington and Battersea.' : '';
  return 'Use Google Search grounding to identify up to ' + cap + ' distinct high-end restaurant, pub, hotel restaurant, cocktail bar, wine bar or bar openings in ' + city + ', ' + country + ' that actually opened to the public in the last 60 days as of ' + today + '.'
    + ' Search several complementary angles, including “new restaurants ' + city + '”, “recently opened restaurants ' + city + ' ' + today.slice(0, 4) + '”, and “new independent high-end restaurant openings ' + city + '”.'
    + ' Include high-end independent restaurants, gastropubs and pubs, hotel restaurants, cocktail bars, wine bars, rooftop bars and destination lounges. Include a hotel restaurant when it is a distinct single venue, even if the hotel group has multiple properties; exclude restaurant/pub/bar chains and multi-location dining brands. Exclude cafes, casual fast food, announced or future venues, and places with no dated opening evidence.'
    + districts
    + ' Return only a JSON array. Each object must have name, openingDate (YYYY-MM-DD), openingEvidence (short factual statement including the opening date and venue name), positioningEvidence (a source-backed phrase explaining the high-end positioning, using explicit evidence such as high-end, Michelin, fine dining, a celebrated chef, a tasting menu, luxury-hotel dining, or premium pricing where the source supports it), independentVenue (true for a one-off restaurant/pub/bar or a distinct hotel restaurant, false for a restaurant/pub/bar chain), independenceEvidence (source-backed evidence it is a one-off venue or distinct hotel restaurant), editorialNote (one concise sentence), cuisine, venueType (restaurant, pub, gastropub, hotel restaurant, cocktail bar, wine bar, rooftop bar or similar), and sourceUrl (exact publisher HTTPS URL from a Google Search grounding chunk when available; otherwise leave empty). Do not invent dates, sources or venues; Panda may provide a clearly labeled Google Search verification link. If fewer than ' + cap + ' are verifiable, return fewer.'
    + (major ? ' Prioritize well-documented openings across the city rather than one neighborhood.' : ' Return no more than 15 candidates for this regional city or town.');
}

export function openingPlaceIsEligible(place) {
  if (!place || place.businessStatus !== 'OPERATIONAL' || typeof place.id !== 'string' || !/^ChI[\w-]{8,250}$/.test(place.id)) return false;
  const types = [place.primaryType, place.primaryTypeDisplayName?.text].filter(Boolean).join(' ').toLowerCase();
  if (/\b(cafe|coffee shop|coffee_shop|bakery|fast food|fast_food|food court|food_court|sandwich shop|sandwich_shop)\b/.test(types)) return false;
  const rating = Number(place.rating);
  const reviewCount = Number(place.userRatingCount || 0);
  if (Number.isFinite(rating) && rating < 4.1) return false;
  if (Number.isFinite(reviewCount) && reviewCount > 90) return false;
  const level = String(place.priceLevel || '').toUpperCase();
  if (['PRICE_LEVEL_FREE', 'PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_MODERATE'].includes(level)) return false;
  return validCoordinates(Number(place.location?.latitude), Number(place.location?.longitude));
}

function distanceMeters(a, b) {
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, x))));
}

function normalizedName(value) { return safeText(value, 160).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim(); }
export function openingPlaceMatchScore(place, candidate) {
  const a = normalizedName(candidate.name), b = normalizedName(place.displayName?.text || place.name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const at = new Set(a.split(' ').filter(x => x.length > 2));
  const bt = new Set(b.split(' ').filter(x => x.length > 2));
  const intersection = [...at].filter(x => bt.has(x)).length;
  return at.size > 0 ? intersection / at.size : 0;
}

export function findOpeningPlaceMatch(places, candidate, city) {
  const eligible = (places || []).filter(place => openingPlaceIsEligible(place)
    && validCoordinates(Number(place.location?.latitude), Number(place.location?.longitude))
    && distanceMeters({ lat: city.lat, lng: city.lng }, { lat: Number(place.location.latitude), lng: Number(place.location.longitude) }) <= 80_000);
  eligible.sort((a, b) => openingPlaceMatchScore(b, candidate) - openingPlaceMatchScore(a, candidate));
  return eligible.length && openingPlaceMatchScore(eligible[0], candidate) >= 0.65 ? eligible[0] : null;
}

function placePrice(level) {
  return ({ PRICE_LEVEL_INEXPENSIVE: '£', PRICE_LEVEL_MODERATE: '££', PRICE_LEVEL_EXPENSIVE: '£££', PRICE_LEVEL_VERY_EXPENSIVE: '££££' })[String(level || '').toUpperCase()] || '';
}

function normalizeVerifiedVenue(place, candidate, cityInfo, now) {
  const photos = Array.isArray(place.photos) ? place.photos.slice(0, 5) : [];
  const photoNames = photos.map(photo => ({
    name: safeText(photo.name, 500),
    attribution: (photo.authorAttributions || []).map(item => safeText(item.displayName, 120)).filter(Boolean).join(', '),
  })).filter(photo => photo.name);
  const first = photoNames[0];
  const location = place.location || {};
  const openingSource = candidate.sourceType === 'google_search'
    ? (() => { try { const url = new URL(candidate.sourceUrl); return url.protocol === 'https:' && url.hostname === 'www.google.com' && url.pathname === '/search' && url.searchParams.has('q') ? { url: url.toString(), title: candidate.sourceName, domain: 'google.com' } : null; } catch { return null; } })()
    : sourceMatches(candidate.sourceUrl, [{ web: { uri: candidate.sourceUrl, title: candidate.sourceName } }]);
  return {
    id: place.id,
    name: safeText(place.displayName?.text || place.name, 140),
    address: safeText(place.formattedAddress, 240),
    fullAddress: safeText(place.formattedAddress, 240),
    type: candidate.venueType || candidate.cuisine || place.primaryTypeDisplayName?.text || place.primaryType || 'Restaurant',
    lat: Number(location.latitude), lng: Number(location.longitude),
    rating: Number.isFinite(Number(place.rating)) ? Number(place.rating) : null,
    ratingCount: Number(place.userRatingCount || 0),
    price: placePrice(place.priceLevel), priceLevel: place.priceLevel || null,
    openNow: place.currentOpeningHours?.openNow === true,
    todayHours: Array.isArray(place.regularOpeningHours?.weekdayDescriptions) ? place.regularOpeningHours.weekdayDescriptions.join(' · ') : '',
    website: safeText(place.websiteUri, 800), mapsUri: safeText(place.googleMapsUri, 800),
    phone: '', photoName: first?.name || '', photoCount: photoNames.length,
    photoAttribution: first?.attribution || '', photoNames,
    photoAttributions: photoNames.map(photo => photo.attribution).filter(Boolean),
    openingDesignation: candidate.sourceType === 'google_search' ? 'panda-search-reported-new' : 'panda-verified-new',
    openingSourceType: candidate.sourceType === 'google_search' ? 'google_search' : 'publisher',
    openingSourceName: openingSource?.title || candidate.sourceName,
    openingSourceUrl: candidate.sourceUrl, openingReportedAt: new Date(now).toISOString(),
    openingDate: candidate.openingDate, openingEvidence: candidate.openingEvidence,
    positioningEvidence: candidate.positioningEvidence, editorialNote: candidate.editorialNote,
    city: cityInfo.city, country: cityInfo.country, citySlug: cityInfo.slug,
    isNewOpening: true, badge: 'New Opening',
  };
}

function validCity(city) {
  return city && typeof city.city === 'string' && city.city.trim()
    && typeof city.country === 'string' && city.country.trim()
    && typeof city.countryCode === 'string' && city.countryCode.trim()
    && validCoordinates(Number(city.lat), Number(city.lng));
}

async function readDocument(store, collection, slug) {
  try {
    const snap = await store.collection(collection).doc(slug).get();
    return snap.exists ? snap.data() || null : null;
  } catch { return null; }
}

export function createNewOpeningsFeed({
  store, reverseGeocode, searchGrounded, hydratePlace, now = Date.now,
}) {
  const inFlight = new Map();
  async function cityInfo(location) {
    if (!validCoordinates(Number(location?.lat), Number(location?.lng))) return null;
    const result = await reverseGeocode({ lat: Number(location.lat), lng: Number(location.lng) });
    if (!result || !result.city || !result.country || !result.countryCode) return null;
    const slug = normalizeCitySlug(result.city, result.countryCode);
    if (!slug || !validCoordinates(Number(result.lat), Number(result.lng))) return null;
    return { ...result, city: safeText(result.city, 100), country: safeText(result.country, 100), countryCode: safeText(result.countryCode, 8).toLowerCase(), lat: Number(result.lat), lng: Number(result.lng), slug };
  }
  async function loadPool(city) {
    if (!store) return { status: 'storage_unavailable', venues: [] };
    const old = await readDocument(store, NEW_OPENINGS_COLLECTION, city.slug);
    const oldUpdatedAt = epoch(old?.updatedAt);
    if (Array.isArray(old?.venues) && old.venues.length > 0 && old.searchVersion === NEW_OPENINGS_SEARCH_VERSION && now() - oldUpdatedAt < NEW_OPENINGS_CACHE_MS) {
      return { status: 'ready', venues: old.venues, updatedAt: oldUpdatedAt, newlyAddedPlaceIds: [], cached: true, diagnostics: old.diagnostics };
    }
    const emptyState = await readDocument(store, NEW_OPENINGS_REFRESH_COLLECTION, city.slug);
    if (emptyState?.diagnostics?.version === 3 && epoch(emptyState?.lastEmptyAt) && now() - epoch(emptyState.lastEmptyAt) < EMPTY_RETRY_MS) {
      return { status: 'no_results', venues: [], updatedAt: epoch(emptyState.lastEmptyAt), newlyAddedPlaceIds: [], cached: true,
        diagnostics: emptyState.diagnostics, text: openingDiagnosticText(emptyState.diagnostics, city.city) };
    }
    if (inFlight.has(city.slug)) return inFlight.get(city.slug);
    const task = (async () => {
      const major = /^(london|new york|paris|tokyo|dubai|los angeles|singapore|hong kong)$/i.test(city.city);
      const maxCandidates = major ? NEW_OPENINGS_MAX_MAJOR_CANDIDATES : 15;
      const london = /^london$/i.test(city.city);
      const searchPlans = london ? [
        'Central London areas normally associated with the highest-priority inner zones: Mayfair, Soho, Covent Garden, Fitzrovia, Marylebone, Holborn, Bloomsbury, City of London and South Bank. Search these first; do not output fare-zone labels.',
        'Additional London areas in the next priority ring, including Hammersmith, Stratford, Canary Wharf, Acton, Ealing, Wimbledon and Greenwich. Search only after the central-area pass; do not output fare-zone labels.',
        'Further outer-London areas through the wider priority catchment. Search only after the inner-area passes; include verified venue addresses and do not output fare-zone labels.',
      ] : [''];
      const searchResults = [];
      const firstPlan = searchPlans[0];
      searchResults.push(await searchGrounded({ city: city.city, country: city.country, center: { lat: city.lat, lng: city.lng }, maxCandidates: london ? 20 : maxCandidates, focus: firstPlan }));
      const firstParsed = searchResults[0]?.ok
        ? parseGroundedOpeningCandidatesDetailed(searchResults[0], { city: city.city, country: city.country, now: now(), max: london ? 20 : maxCandidates })
        : null;
      if (searchPlans.length > 1 && (!firstParsed || firstParsed.candidates.length < maxCandidates)) {
        const supplemental = await Promise.all(searchPlans.slice(1).map(focus => searchGrounded({ city: city.city, country: city.country,
          center: { lat: city.lat, lng: city.lng }, maxCandidates: 20, focus })));
        searchResults.push(...supplemental);
      }
      if (!searchResults.some(result => result?.ok)) {
        const budgetExceeded = searchResults.some(result => result?.budgetExceeded);
        return { status: budgetExceeded ? 'monthly_limit' : 'search_unavailable', venues: [], newlyAddedPlaceIds: [],
          diagnostics: { version: 3, stage: 'grounding', reason: budgetExceeded ? 'monthly_limit' : 'search_unavailable',
            searchPassCount: searchResults.length, searchPassFailures: searchResults.length } };
      }
      const parsed = mergeOpeningSearchResults(searchResults, { city: city.city, country: city.country, now: now(), maxCandidates });
      const candidates = parsed.candidates;
      const diagnostics = { ...parsed.diagnostics,
        placeLookupCount: 0, placeLookupFailures: 0, placeIneligibleResults: 0, placeNameMismatches: 0, placeMatches: 0 };
      if (!candidates.length) {
        const updatedAt = now();
        try { await store.collection(NEW_OPENINGS_REFRESH_COLLECTION).doc(city.slug).set({ lastEmptyAt: updatedAt, city: city.city, country: city.country, diagnostics }, { merge: true }); } catch {}
        return { status: 'no_results', venues: [], newlyAddedPlaceIds: [], updatedAt, diagnostics, text: openingDiagnosticText(diagnostics, city.city) };
      }
      const verified = [];
      const seenIds = new Set();
      let hydrationFailures = 0;
      for (let i = 0; i < candidates.length && verified.length < maxCandidates; i += 5) {
        const batch = candidates.slice(i, i + 5);
        diagnostics.placeLookupCount += batch.length;
        const settled = await Promise.allSettled(batch.map(candidate => hydratePlace(candidate, city)));
        for (let j = 0; j < settled.length; j++) {
          const item = settled[j];
          if (item.status === 'rejected') { hydrationFailures++; diagnostics.placeLookupFailures++; continue; }
          if (!item.value) { diagnostics.placeNameMismatches++; continue; }
          const hydrated = item.value;
          const candidate = batch[j];
          const places = Array.isArray(hydrated) ? hydrated : [hydrated];
          if (!places.some(openingPlaceIsEligible)) diagnostics.placeIneligibleResults++;
          const place = findOpeningPlaceMatch(places, candidate, city);
          if (!place) { diagnostics.placeNameMismatches++; continue; }
          if (seenIds.has(place.id)) continue;
          seenIds.add(place.id);
          diagnostics.placeMatches++;
          verified.push(normalizeVerifiedVenue(place, candidate, city, now()));
        }
      }
      if (!verified.length) {
        diagnostics.stage = 'places';
        if (hydrationFailures > 0 && hydrationFailures === candidates.length) return { status: 'verification_unavailable', venues: [], newlyAddedPlaceIds: [], diagnostics,
          text: 'I found recent opening reports for ' + city.city + ', but live venue verification is temporarily unavailable. Please try again shortly.' };
        const updatedAt = now();
        try { await store.collection(NEW_OPENINGS_REFRESH_COLLECTION).doc(city.slug).set({ lastEmptyAt: updatedAt, city: city.city, country: city.country, diagnostics }, { merge: true }); } catch {}
        return { status: 'no_results', venues: [], newlyAddedPlaceIds: [], updatedAt, diagnostics, text: openingDiagnosticText(diagnostics, city.city) };
      }
      const oldIds = new Set((Array.isArray(old?.venues) ? old.venues : []).map(venue => venue?.id).filter(Boolean));
      const newlyAddedPlaceIds = verified.map(venue => venue.id).filter(id => !oldIds.has(id));
      const updatedAt = now();
      diagnostics.stage = 'complete';
      const document = { city: city.city, country: city.country, countryCode: city.countryCode,
        citySlug: city.slug, center: { lat: city.lat, lng: city.lng }, updatedAt, searchVersion: NEW_OPENINGS_SEARCH_VERSION,
        venues: verified.slice(0, NEW_OPENINGS_MAX_MAJOR_CANDIDATES), newlyAddedPlaceIds, diagnostics };
      await store.collection(NEW_OPENINGS_COLLECTION).doc(city.slug).set(document);
      if (newlyAddedPlaceIds.length) {
        const hasSearchOnlySource = verified.some(venue => venue.openingDesignation === 'panda-search-reported-new');
        const notification = { title: newlyAddedPlaceIds.length + ' new high-end openings in ' + city.city,
          subtitle: hasSearchOnlySource ? 'Recent Google Search reports · check linked results' : 'Recently opened and source-verified', venueIds: newlyAddedPlaceIds.slice(0, 15), city: city.city,
          slug: city.slug, read: false, seenInChat: false, createdAt: updatedAt };
        try { await store.collection(NEW_OPENINGS_NOTICE_COLLECTION).doc(city.slug).set(notification, { merge: true }); } catch {}
      }
      try { await store.collection(NEW_OPENINGS_REFRESH_COLLECTION).doc(city.slug).delete(); } catch {}
      return { status: 'ready', venues: document.venues, updatedAt, newlyAddedPlaceIds, cached: false, diagnostics };
    })();
    inFlight.set(city.slug, task);
    try { return await task; } finally { if (inFlight.get(city.slug) === task) inFlight.delete(city.slug); }
  }
  return async function newOpenings({ location, offset = 0, limit = 15, excludedPlaceIds = [] } = {}) {
    if (!validCoordinates(Number(location?.lat), Number(location?.lng))) {
      return { status: 'location_required', newOpeningsSearch: true, venues: [], text: 'Allow Panda to use your location, or tell me the city you want to explore.' };
    }
    if (!store) return { status: 'storage_unavailable', newOpeningsSearch: true, venues: [], text: 'Panda can’t verify new openings right now. Please try again shortly.' };
    const city = await cityInfo(location);
    if (!city) return { status: 'city_unavailable', newOpeningsSearch: true, venues: [], text: 'I couldn’t identify the city reliably. Try a city name or a nearby town.' };
    const pool = await loadPool(city);
    const pageSize = Math.max(1, Math.min(NEW_OPENINGS_MAX_PAGE_SIZE, Number.parseInt(String(limit), 10) || 15));
    if (pool.status !== 'ready' || !Array.isArray(pool.venues) || !pool.venues.length) {
      const defaultText = pool.status === 'monthly_limit'
        ? 'Panda has reached this month’s live-search allowance, so I won’t guess about new openings.'
        : pool.status === 'search_unavailable' || pool.status === 'storage_unavailable' || pool.status === 'verification_unavailable'
          ? 'I couldn’t verify new openings just now, so I won’t guess. Please try again shortly.'
          : 'I couldn’t verify any recent high-end openings in ' + city.city + ' yet. Try again later or name another city.';
      const text = typeof pool.text === 'string' ? pool.text : defaultText;
      return { status: pool.status, newOpeningsSearch: true, city: city.city, country: city.country,
        citySlug: city.slug, venues: [], totalCount: 0, offset: 0, limit: pageSize,
        nextOffset: 0, hasMore: false, newlyAddedPlaceIds: [], text, diagnostics: pool.diagnostics };
    }
    const excluded = new Set((Array.isArray(excludedPlaceIds) ? excludedPlaceIds : []).filter(id => typeof id === 'string').slice(-500));
    let available = pool.venues.filter(venue => !excluded.has(venue.id));
    let wrapped = false;
    if (!available.length && excluded.size) { available = pool.venues; wrapped = true; }
    const requestedOffset = excluded.size ? 0 : Math.max(0, Number.parseInt(String(offset), 10) || 0);
    const pageOffset = requestedOffset >= available.length ? 0 : requestedOffset;
    const page = available.slice(pageOffset, pageOffset + pageSize).map(venue => ({
      ...venue, distanceMeters: distanceMeters({ lat: Number(location.lat), lng: Number(location.lng) }, { lat: Number(venue.lat), lng: Number(venue.lng) }),
    }));
    const nextOffset = pageOffset + page.length >= available.length ? 0 : pageOffset + page.length;
    const more = nextOffset > 0;
    const searchOnlyCount = page.filter(venue => venue.openingDesignation === 'panda-search-reported-new').length;
    const text = page.length
      ? (searchOnlyCount === page.length
        ? 'I found ' + page.length + ' recent high-end opening reports in ' + city.city + '. Google Places confirms these venues are operating; each card opens Google Search results so you can check the reported opening date.'
        : searchOnlyCount > 0
          ? 'I found ' + page.length + ' recent high-end openings in ' + city.city + '. Google Places confirms the venues are operating; cards link to publisher reports or clearly labeled Google results for checking opening dates.'
          : 'Here are ' + page.length + ' recently opened high-end venues in ' + city.city + ', ' + city.country + '. Google Places confirms they are operating, and each card links to the dated publisher report.')
        + (more ? ' Tap “Next 15” for more.' : '') + (wrapped ? ' You’ve seen the previous set, so this starts a fresh rotation.' : '')
      : 'I’ve shown all matches that passed Panda’s checks for ' + city.city + ' in this search. I won’t repeat them.';
    return { status: 'ready', newOpeningsSearch: true, city: city.city, country: city.country,
      citySlug: city.slug, venues: page, totalCount: pool.venues.length,
      offset: pageOffset, limit: pageSize, nextOffset, hasMore: more,
      newlyAddedPlaceIds: pool.newlyAddedPlaceIds || [], cached: pool.cached === true,
      updatedAt: pool.updatedAt || null, text, diagnostics: pool.diagnostics };
  };
}
