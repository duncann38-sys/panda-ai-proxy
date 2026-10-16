import { createHash } from 'node:crypto';

// These are Pro search fields. Photo references do not fetch image bytes.
// No rating, hours, price, reviews, contact or Atmosphere fields on this path.
export const DISCOVERY_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.primaryType', 'places.types', 'places.photos.name',
  'places.photos.authorAttributions', 'nextPageToken',
].join(',');
export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
// This records an operator's verified agreement; it does not create permission.
// Keep this false until Google has approved the fields, cross-user reuse and
// physical retention/cleanup behaviour in writing.
export function sharedDiscoveryCacheApproved(env = {}) {
  return env.PANDA_GOOGLE_SHARED_DISCOVERY_CACHE_APPROVED === 'true'
    && typeof env.PANDA_GOOGLE_SHARED_DISCOVERY_CACHE_APPROVAL_REFERENCE === 'string'
    && env.PANDA_GOOGLE_SHARED_DISCOVERY_CACHE_APPROVAL_REFERENCE.trim().length > 0;
}
const SEARCHES = 'discovery_cover_searches_v1';
const VENUES = 'discovery_cover_venues_v1';

export function distanceMeters(a, b) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export function discoveryRequest(body) {
  const lat = Number(body.location?.lat), lng = Number(body.location?.lng);
  if (body.location?.lat == null || body.location?.lng == null
      || !Number.isFinite(lat) || !Number.isFinite(lng)
      || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw Object.assign(new Error('A valid discovery location is required.'), { status: 400 });
  }
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (query.length < 2 || query.length > 160 || Array.isArray(body.queries)) {
    throw Object.assign(new Error('Use one discovery query per request.'), { status: 400 });
  }
  const radius = Number(body.radius_meters ?? (body.expansionRingKm ? Number(body.expansionRingKm) * 1000 + 1500 : 6000));
  if (!Number.isFinite(radius) || radius < 100 || radius > 25000) {
    throw Object.assign(new Error('Invalid discovery radius.'), { status: 400 });
  }
  const pageToken = typeof body.pageToken === 'string' ? body.pageToken : '';
  if (pageToken.length > 2000) throw Object.assign(new Error('Invalid page token.'), { status: 400 });
  return { lat, lng, query, radius, pageToken };
}

export function discoveryKey(request) {
  return createHash('sha256').update(JSON.stringify([
    'cover-v1', request.query.toLowerCase(),
    request.lat.toFixed(3), request.lng.toFixed(3), request.radius, request.pageToken,
  ])).digest('hex');
}

export function coverVenue(place) {
  const photo = place.photos?.[0];
  if (!place.id || !place.displayName?.text || !Number.isFinite(place.location?.latitude)
      || !Number.isFinite(place.location?.longitude)) return null;
  return {
    id: place.id, name: place.displayName.text,
    address: place.formattedAddress || '', fullAddress: place.formattedAddress || '',
    lat: place.location.latitude, lng: place.location.longitude,
    type: String(place.primaryType || 'venue').replaceAll('_', ' '),
    primaryType: place.primaryType || '', types: place.types || [],
    photoName: photo?.name || '', photoCount: photo?.name ? 1 : 0,
    photoAttribution: (photo?.authorAttributions || []).map(a => a.displayName).filter(Boolean).join(' · '),
    sourceAttribution: 'Google Maps', detailsDeferred: true,
  };
}

function located(venues, request) {
  return venues.filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lng))
    .map(v => ({ ...v, distanceMeters: Math.round(distanceMeters(request, v)) }))
    .filter(v => v.distanceMeters <= request.radius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

function fresh(timestamp, now) {
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp < DISCOVERY_TTL_MS;
}

// Separate from partner records: Google refreshes must never overwrite billing,
// paid placement, owner-supplied content or enrollment documents.
export function createDiscoveryService({
  store, apiKey, consumeBudget, fetchImpl = fetch, now = Date.now, warn = console.warn,
  persistFullContent = false, indexIdentities, readIndex, loadFallback,
}) {
  const pending = new Map();
  const memory = new Map();
  const limit = Math.max(1, Number.parseInt(process.env.PANDA_DAILY_PLACES_LIMIT || '500', 10) || 500);

  async function localFallback(request, reason) {
    if (!persistFullContent) {
      let baseline = {};
      try { baseline = loadFallback ? await loadFallback(request) : {}; }
      catch { warn('Independent local fallback unavailable.'); }
      return {
        ...baseline, venues: [], nextPageToken: null, cached: true,
        quotaExceeded: reason === 'quota', dataMode: baseline.directoryVenues?.length ? 'cached' : 'unavailable',
        fallbackReason: reason,
      };
    }
    const candidates = new Map();
    for (const entry of memory.values()) {
      if (fresh(entry.ts, now())) {
        for (const venue of entry.venues) candidates.set(venue.id, { ...venue, cachedAt: entry.ts });
      }
    }
    if (store) {
      try {
        // Latitude bounds plus an exact distance check also handles the dateline.
        // No unrelated neighborhood is substituted when this location is empty.
        const delta = request.radius / 111000;
        const snapshot = await store.collection(VENUES)
          .where('lat', '>=', Math.max(-90, request.lat - delta))
          .where('lat', '<=', Math.min(90, request.lat + delta))
          .limit(300).get();
        for (const doc of snapshot.docs) {
          const data = doc.data();
          if (fresh(data.last_updated, now())) {
            candidates.set(doc.id, { ...data.venue, cachedAt: data.last_updated });
          }
        }
      } catch { warn('Discovery local fallback storage unavailable.'); }
    }
    const venues = located([...candidates.values()], request);
    // Filter category fallbacks rather than silently substituting unrelated venues.
    const terms = request.query.toLowerCase().replace(/\b(near me|nearby|restaurants?|venues?|in)\b/g, ' ').trim().split(/\s+/).filter(Boolean);
    const matches = terms.length ? venues.filter(v => {
      const text = `${v.name} ${v.type} ${(v.types || []).join(' ')} ${v.address}`.toLowerCase().replaceAll('_', ' ');
      return terms.every(term => text.includes(term.replace(/s$/, '')));
    }) : venues;
    return { venues: matches, nextPageToken: null, cached: true, quotaExceeded: reason === 'quota',
      dataMode: matches.length ? 'cached' : 'unavailable', fallbackReason: reason };
  }

  async function run(request) {
    const key = discoveryKey(request);
    let indexedNearbyCount = 0;
    if (readIndex && store) {
      try { indexedNearbyCount = (await readIndex(request)).length; }
      catch { warn('Local identity index unavailable; live discovery remains available.'); }
    }
    let saved = persistFullContent ? memory.get(key) : null;
    if (persistFullContent && !saved && store) {
      try {
        const doc = await store.collection(SEARCHES).doc(key).get();
        if (doc.exists) saved = doc.data();
      } catch { warn('Discovery search cache unavailable.'); }
    }
    if (saved && fresh(saved.ts, now()) && Array.isArray(saved.venues)) {
      memory.set(key, saved);
      return { venues: located(saved.venues, request), nextPageToken: saved.nextPageToken || null, cached: true, dataMode: 'cached' };
    }
    // Fail closed for paid misses if a distributed counter cannot be enforced.
    if (!store || !apiKey) return localFallback(request, 'storage_or_provider_unavailable');
    const budget = await consumeBudget(store, 'places', limit);
    if (!budget.allowed) {
      warn(`Google discovery request budget reached (${budget.current}/${budget.limit}). Activating local fallback.`);
      return localFallback(request, 'quota');
    }
    if (budget.shared !== true) return localFallback(request, 'budget_storage_unavailable');
    let data;
    try {
      const response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': DISCOVERY_FIELDS },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          textQuery: request.query, pageSize: 20,
          rankPreference: 'DISTANCE', languageCode: 'en-GB',
          locationBias: { circle: { center: { latitude: request.lat, longitude: request.lng }, radius: request.radius } },
          ...(request.pageToken ? { pageToken: request.pageToken } : {}),
        }),
      });
      data = await response.json();
      if (!response.ok || data.error) {
        const quota = response.status === 429 || data.error?.status === 'RESOURCE_EXHAUSTED' || data.error?.code === 429;
        warn(quota ? 'Google Places quota exhausted. Activating local fallback.' : 'Google discovery provider unavailable.');
        return localFallback(request, quota ? 'quota' : 'provider_unavailable');
      }
    } catch { return localFallback(request, 'provider_unavailable'); }
    if (!Array.isArray(data.places) && data.places != null) return localFallback(request, 'provider_unavailable');
    const venues = located((data.places || []).map(coverVenue).filter(Boolean), request);
    if (!persistFullContent) {
      try { if (indexIdentities) await indexIdentities(venues); }
      catch { warn('Live discovery served, but identity indexing failed.'); }
      return {
        venues, nextPageToken: data.nextPageToken || null, cached: false,
        dataMode: 'google', indexedNearbyCount,
      };
    }
    const ts = now();
    const entry = { ts, venues, nextPageToken: data.nextPageToken || null };
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > 200) memory.delete(memory.keys().next().value);
    try {
      const batch = store.batch();
      batch.set(store.collection(SEARCHES).doc(key), { ...entry, expiresAt: new Date(ts + DISCOVERY_TTL_MS) });
      for (const venue of venues) {
        batch.set(store.collection(VENUES).doc(venue.id), {
          venue, lat: venue.lat, lng: venue.lng, last_updated: ts,
          expiresAt: new Date(ts + DISCOVERY_TTL_MS),
        }, { merge: true });
      }
      await batch.commit();
    } catch { warn('Discovery results served, but shared cache write failed.'); }
    return { venues, nextPageToken: entry.nextPageToken, cached: false, dataMode: 'google' };
  }

  const search = async body => {
    if (Array.isArray(body.queries)) {
      if (!body.queries.length || body.queries.length > 14) {
        throw Object.assign(new Error('Choose between one and fourteen discovery queries.'), { status: 400 });
      }
      const queries = [...new Set(body.queries)];
      // Validate every input before allowing any paid request.
      queries.forEach(query => discoveryRequest({ ...body, queries: undefined, query }));
      const results = new Array(queries.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, queries.length) }, async () => {
        while (next < queries.length) {
          const index = next++;
          results[index] = await search({ ...body, queries: undefined, query: queries[index] });
        }
      }));
      const venues = new Map();
      const directoryVenues = new Map();
      results.forEach((result, index) => {
        for (const venue of result.venues) {
          const existing = venues.get(venue.id);
          venues.set(venue.id, { ...venue, sourceQueries: [...new Set([...(existing?.sourceQueries || []), queries[index]])] });
        }
        for (const venue of result.directoryVenues || []) directoryVenues.set(venue.id, venue);
      });
      return { venues: [...venues.values()], batched: true, nextPageToken: null,
        directoryVenues: [...directoryVenues.values()],
        directory: results.find(result => result.directory)?.directory,
        quotaExceeded: results.some(result => result.quotaExceeded),
        dataMode: new Set(results.map(result => result.dataMode)).size === 1
          ? results[0].dataMode : 'mixed' };
    }
    const request = discoveryRequest(body), key = discoveryKey(request);
    if (pending.has(key)) return pending.get(key);
    const promise = run(request);
    pending.set(key, promise);
    try { return await promise; } finally { pending.delete(key); }
  };
  return search;
}
