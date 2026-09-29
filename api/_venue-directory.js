import { createHash, randomUUID } from 'node:crypto';
import { recordCostEvent } from './_cost-controls.js';

export const VENUE_DIRECTORY_COLLECTION = 'venue_area_directory_v1';
export const VENUE_DIRECTORY_TTL_MS = 3 * 60 * 60 * 1000;
export const VENUE_DIRECTORY_STALE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const VENUE_DIRECTORY_MAX_RECORDS = 600;

const CELL_LAT_DEGREES = 0.018;
const SEARCH_RADIUS_METERS = 2_600;
const OVERPASS_TIMEOUT_MS = 7_000;
const LEASE_MS = 30_000;
const RETRY_DELAY_MS = 15 * 60 * 1000;
const REFRESH_WAIT_MS = 11_000;
const REFRESH_POLL_MS = 250;
const MEMORY_CACHE_LIMIT = 250;
function recordDirectoryEvent(event, { areaKey, ...fields } = {}) {
  // Keep area-level hit counts useful without putting reversible coordinates in logs.
  const areaHash = areaKey
    ? createHash('sha256').update(areaKey).digest('hex').slice(0, 12)
    : undefined;
  recordCostEvent(event, { ...fields, areaHash });
}
const ALLOWED_AMENITIES = new Set([
  'bar',
  'cafe',
  'fast_food',
  'nightclub',
  'pub',
  'restaurant',
]);
const ALLOWED_SHOPS = new Set([
  'alcohol', 'bakery', 'books', 'cheese', 'chocolate', 'coffee',
  'convenience', 'deli', 'department_store', 'florist', 'gift',
  'greengrocer', 'supermarket', 'tea', 'wine',
]);
const ALLOWED_TOURISM = new Set([
  'aquarium', 'artwork', 'attraction', 'gallery', 'museum', 'viewpoint', 'zoo',
]);
const CUISINES = new Map([
  ['indian', 'Indian'], ['italian', 'Italian'], ['chinese', 'Chinese'],
  ['spanish', 'Spanish'], ['french', 'French'], ['british', 'British'],
  ['japanese', 'Japanese'], ['sushi', 'Japanese'], ['mexican', 'Mexican'],
  ['turkish', 'Turkish'], ['american', 'American'], ['lebanese', 'Lebanese'],
  ['thai', 'Thai'], ['pizza', 'Pizza'], ['burger', 'Burgers'],
]);

export class VenueDirectoryError extends Error {
  constructor(message, status = 503, code = 'venue_directory_unavailable') {
    super(message);
    this.name = 'VenueDirectoryError';
    this.status = status;
    this.code = code;
  }
}

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

export function venueDirectoryArea(latitude, longitude) {
  if (!validCoordinates(latitude, longitude)) return null;

  const latitudeIndex = Math.floor(latitude / CELL_LAT_DEGREES);
  const latitudeCenter = (latitudeIndex + 0.5) * CELL_LAT_DEGREES;
  const longitudeWidth = CELL_LAT_DEGREES
    / Math.max(0.25, Math.cos(latitudeCenter * Math.PI / 180));
  const longitudeIndex = Math.floor(longitude / longitudeWidth);

  return {
    key: `v1_${latitudeIndex}_${longitudeIndex}`,
    latitude: latitudeCenter,
    longitude: (longitudeIndex + 0.5) * longitudeWidth,
  };
}

function venueAddress(tags) {
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'],
    tags['addr:city'],
    tags['addr:postcode'],
  ].map((part) => String(part || '').trim()).filter(Boolean);
  return [...new Set(parts)].join(', ');
}

function publicWebsite(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function normalizeOsmVenue(element) {
  if (!element || !['node', 'way', 'relation'].includes(element.type)) return null;
  const id = Number(element.id);
  const tags = element.tags && typeof element.tags === 'object' ? element.tags : {};
  const amenity = String(tags.amenity || '').toLowerCase();
  const shop = String(tags.shop || '').toLowerCase();
  const tourism = String(tags.tourism || '').toLowerCase();
  const name = typeof tags.name === 'string' ? tags.name.trim() : '';
  const latitude = Number(element.lat ?? element.center?.lat);
  const longitude = Number(element.lon ?? element.center?.lon);

  if (!Number.isSafeInteger(id) || id < 1 || !name
      || !(ALLOWED_AMENITIES.has(amenity) || ALLOWED_SHOPS.has(shop) || ALLOWED_TOURISM.has(tourism))
      || !validCoordinates(latitude, longitude)) {
    return null;
  }

  const osmType = element.type;
  const osmId = String(id);
  const sourceUrl = `https://www.openstreetmap.org/${osmType}/${osmId}`;
  const isHospitality = ALLOWED_AMENITIES.has(amenity);
  const isShop = !isHospitality && ALLOWED_SHOPS.has(shop);
  const tag = isHospitality ? amenity : isShop ? shop : tourism;
  const type = tag.replace(/_/g, ' ');
  const categories = isShop ? ['Shops'] : isHospitality ? [] : ['Places of Interest'];
  if (isHospitality) {
    const cuisines = String(tags.cuisine || '').toLowerCase().split(/[;,]/);
    for (const cuisine of cuisines) {
      const category = CUISINES.get(cuisine.trim());
      if (category) categories.push(category);
    }
  }

  return {
    id: `osm:${osmType}:${osmId}`,
    name,
    type,
    primaryType: isShop ? 'store' : isHospitality ? (amenity === 'nightclub' ? 'night_club' : amenity) : 'tourist_attraction',
    types: isShop ? ['store'] : isHospitality ? [amenity === 'nightclub' ? 'night_club' : amenity] : ['tourist_attraction'],
    categories: [...new Set(categories)],
    address: venueAddress(tags),
    lat: latitude,
    lng: longitude,
    website: publicWebsite(tags.website),
    phone: typeof tags.phone === 'string' ? tags.phone : '',
    source: 'OpenStreetMap',
    sourceLicense: 'ODbL-1.0',
    sourceUrl,
    attribution: '© OpenStreetMap contributors',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
  };
}

export function normalizeOsmVenues(elements) {
  const venues = new Map();
  for (const element of Array.isArray(elements) ? elements : []) {
    const venue = normalizeOsmVenue(element);
    if (venue) venues.set(venue.id, venue);
    if (venues.size >= VENUE_DIRECTORY_MAX_RECORDS) break;
  }
  return [...venues.values()];
}

async function fetchAreaFromOverpass(area, fetchImpl, timeoutMs, radius = SEARCH_RADIUS_METERS) {
  if (typeof fetchImpl !== 'function') {
    throw new VenueDirectoryError('OpenStreetMap directory fetch is unavailable.');
  }

  const query = [
    '[out:json][timeout:10];',
    '(',
    `nwr["amenity"~"^(bar|cafe|fast_food|nightclub|pub|restaurant)$"](around:${radius},${area.latitude},${area.longitude});`,
    `nwr["shop"~"^(alcohol|bakery|books|cheese|chocolate|coffee|convenience|deli|department_store|florist|gift|greengrocer|supermarket|tea|wine)$"](around:${radius},${area.latitude},${area.longitude});`,
    `nwr["tourism"~"^(aquarium|artwork|attraction|gallery|museum|viewpoint|zoo)$"](around:${radius},${area.latitude},${area.longitude});`,
    ');',
    `out center tags ${VENUE_DIRECTORY_MAX_RECORDS + 1};`,
  ].join('');
  const startedAt = Date.now();
  recordDirectoryEvent('venue_directory_provider_call', { areaKey: area.key, source: 'openstreetmap' });

  let response;
  try {
    response = await fetchImpl('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json',
        'User-Agent': 'Panda venue directory (OpenStreetMap data)',
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    recordDirectoryEvent('venue_directory_provider_failure', {
      areaKey: area.key,
      source: 'openstreetmap',
      durationMs: Date.now() - startedAt,
    });
    throw new VenueDirectoryError(
      error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'OpenStreetMap venue search timed out.'
        : 'OpenStreetMap venue search is unavailable.',
    );
  }

  if (!response?.ok) {
    recordDirectoryEvent('venue_directory_provider_failure', {
      areaKey: area.key,
      source: 'openstreetmap',
      status: response?.status || 502,
      durationMs: Date.now() - startedAt,
    });
    throw new VenueDirectoryError('OpenStreetMap venue search is unavailable.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new VenueDirectoryError('OpenStreetMap returned an invalid venue directory response.');
  }
  if (!Array.isArray(payload?.elements)) {
    throw new VenueDirectoryError('OpenStreetMap returned an invalid venue directory response.');
  }

  const venues = normalizeOsmVenues(payload.elements);
  recordDirectoryEvent('venue_directory_provider_success', {
    areaKey: area.key,
    source: 'openstreetmap',
    records: venues.length,
    truncated: payload.elements.length > VENUE_DIRECTORY_MAX_RECORDS,
    durationMs: Date.now() - startedAt,
  });
  return {
    venues,
    truncated: payload.elements.length > VENUE_DIRECTORY_MAX_RECORDS,
  };
}

function validStoredDirectory(data, now, { allowStale = false } = {}) {
  if (!data || !Array.isArray(data.venues) || !Number.isFinite(Number(data.updatedAt))) return null;
  const ageMs = now - Number(data.updatedAt);
  if (ageMs < 0) return null;
  if (!allowStale && ageMs >= VENUE_DIRECTORY_TTL_MS) return null;
  if (allowStale && ageMs >= VENUE_DIRECTORY_STALE_MAX_AGE_MS) return null;
  return {
    venues: data.venues,
    updatedAt: Number(data.updatedAt),
    stale: ageMs >= VENUE_DIRECTORY_TTL_MS,
    truncated: data.truncated === true,
  };
}

function distanceMeters(latitude, longitude, venue) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLatitude = radians(venue.lat - latitude);
  const dLongitude = radians(venue.lng - longitude);
  const arc = Math.sin(dLatitude / 2) ** 2
    + Math.cos(radians(latitude)) * Math.cos(radians(venue.lat))
      * Math.sin(dLongitude / 2) ** 2;
  return Math.round(12_742_000 * Math.asin(Math.sqrt(Math.min(1, arc))));
}

function publicResult(entry, area, latitude, longitude) {
  const directoryVenues = entry.venues.map((venue) => ({
    ...venue,
    distanceMeters: distanceMeters(latitude, longitude, venue),
  })).sort((a, b) => a.distanceMeters - b.distanceMeters);
  return {
    directoryVenues: directoryVenues.slice(0, 200),
    directory: {
      source: 'OpenStreetMap',
      sourceLicense: 'ODbL-1.0',
      attribution: '© OpenStreetMap contributors',
      attributionUrl: 'https://www.openstreetmap.org/copyright',
      areaKey: area.key,
      updatedAt: entry.updatedAt,
      stale: entry.stale,
      truncated: entry.truncated,
      totalCount: directoryVenues.length,
    },
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createVenueDirectoryLoader({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  ownerId = randomUUID,
  sleep = defaultSleep,
  timeoutMs = OVERPASS_TIMEOUT_MS,
  waitMs = REFRESH_WAIT_MS,
  pollMs = REFRESH_POLL_MS,
} = {}) {
  const memory = new Map();
  const inFlight = new Map();

  function cacheInMemory(areaKey, entry) {
    memory.delete(areaKey);
    memory.set(areaKey, entry);
    while (memory.size > MEMORY_CACHE_LIMIT) {
      memory.delete(memory.keys().next().value);
    }
  }

  async function readDocument(ref) {
    try {
      const snapshot = await ref.get();
      return snapshot?.exists ? snapshot.data() : null;
    } catch {
      return null;
    }
  }

  async function waitForOwner(ref, area, staleEntry, latitude, longitude) {
    const stopAt = now() + waitMs;
    while (now() < stopAt) {
      await sleep(Math.min(pollMs, Math.max(1, stopAt - now())));
      const data = await readDocument(ref);
      const fresh = validStoredDirectory(data, now());
      if (fresh) {
        cacheInMemory(area.key, fresh);
        recordDirectoryEvent('venue_directory_cache_hit', { layer: 'firestore_after_wait', areaKey: area.key });
        return publicResult(fresh, area, latitude, longitude);
      }
    }
    const lastData = await readDocument(ref);
    const stale = validStoredDirectory(lastData, now(), { allowStale: true }) || staleEntry;
    if (stale) {
      recordDirectoryEvent('venue_directory_stale_fallback', { layer: 'firestore_wait', areaKey: area.key });
      return publicResult({ ...stale, stale: true }, area, latitude, longitude);
    }
    throw new VenueDirectoryError('Venue directory refresh is already in progress. Please retry shortly.');
  }

  async function load(store, latitude, longitude) {
    const area = venueDirectoryArea(latitude, longitude);
    if (!area) throw new VenueDirectoryError('Valid latitude and longitude are required.', 400, 'location_required');
    if (!store || typeof store.runTransaction !== 'function') {
      throw new VenueDirectoryError('Shared venue directory storage is not configured.');
    }

    const local = validStoredDirectory(memory.get(area.key), now());
    if (local) {
      cacheInMemory(area.key, local);
      recordDirectoryEvent('venue_directory_cache_hit', { layer: 'memory', areaKey: area.key });
      return publicResult(local, area, latitude, longitude);
    }
    if (inFlight.has(area.key)) {
      const pending = await inFlight.get(area.key);
      return {
        ...pending,
        directoryVenues: pending.directoryVenues.map((venue) => ({
          ...venue,
          distanceMeters: distanceMeters(latitude, longitude, venue),
        })).sort((a, b) => a.distanceMeters - b.distanceMeters),
      };
    }

    const request = (async () => {
      const ref = store.collection(VENUE_DIRECTORY_COLLECTION).doc(area.key);
      const owner = ownerId();
      let staleEntry = validStoredDirectory(memory.get(area.key), now(), { allowStale: true });
      let outcome;

      try {
        outcome = await store.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(ref);
          const data = snapshot?.exists ? snapshot.data() : null;
          const fresh = validStoredDirectory(data, now());
          if (fresh) return { kind: 'fresh', entry: fresh };

          const stale = validStoredDirectory(data, now(), { allowStale: true });
          const leaseUntil = Number(data?.leaseUntil || 0);
          if (stale) staleEntry = stale;
           if (Number(data?.retryAfter || 0) > now()) return { kind: 'cooldown', stale: stale || staleEntry };
          if (leaseUntil > now()) return { kind: 'waiting', stale: stale || staleEntry };

          transaction.set(ref, { leaseOwner: owner, leaseUntil: now() + LEASE_MS }, { merge: true });
          return { kind: 'leader', stale: stale || staleEntry };
        });
      } catch {
        const memoryStale = staleEntry
          || validStoredDirectory(memory.get(area.key), now(), { allowStale: true });
        if (memoryStale) {
          recordDirectoryEvent('venue_directory_stale_fallback', { layer: 'memory', areaKey: area.key });
          return publicResult({ ...memoryStale, stale: true }, area, latitude, longitude);
        }
        throw new VenueDirectoryError('Shared venue directory storage is unavailable.');
      }

      if (outcome.kind === 'fresh') {
        cacheInMemory(area.key, outcome.entry);
        recordDirectoryEvent('venue_directory_cache_hit', { layer: 'firestore', areaKey: area.key });
        return publicResult(outcome.entry, area, latitude, longitude);
      }
      if (outcome.kind === 'waiting') {
        if (outcome.stale) {
          recordDirectoryEvent('venue_directory_stale_fallback', { layer: 'firestore_refresh_in_progress', areaKey: area.key });
          return publicResult({ ...outcome.stale, stale: true }, area, latitude, longitude);
        }
        return waitForOwner(ref, area, outcome.stale, latitude, longitude);
      }
      if (outcome.kind === 'cooldown') {
        if (outcome.stale) return publicResult({ ...outcome.stale, stale: true }, area, latitude, longitude);
        throw new VenueDirectoryError('Venue directory is temporarily unavailable. Please retry later.');
      }

      try {
        let fetched = await fetchAreaFromOverpass(area, fetchImpl, timeoutMs);
        // Sparse areas should still have a chance to show real nearby places.
        if (!fetched.venues.length) fetched = await fetchAreaFromOverpass(area, fetchImpl, timeoutMs, 8_000);
        const entry = {
          venues: fetched.venues,
          updatedAt: now(),
          stale: false,
          truncated: fetched.truncated,
        };
        const published = await store.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(ref);
          const data = snapshot?.exists ? snapshot.data() : null;
          if (data?.leaseOwner === owner) {
            transaction.set(ref, {
              venues: entry.venues,
              updatedAt: entry.updatedAt,
              truncated: entry.truncated,
              leaseOwner: null,
              leaseUntil: 0,
              retryAfter: 0,
            });
            return true;
          }
          return false;
        });
        if (!published) {
          const winning = validStoredDirectory(await readDocument(ref), now());
          if (winning) {
            cacheInMemory(area.key, winning);
            return publicResult(winning, area, latitude, longitude);
          }
          throw new VenueDirectoryError('Venue directory refresh was superseded. Please retry shortly.');
        }
        cacheInMemory(area.key, entry);
        return publicResult(entry, area, latitude, longitude);
      } catch (error) {
        try {
          await store.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(ref);
            const data = snapshot?.exists ? snapshot.data() : null;
            if (data?.leaseOwner === owner) {
              transaction.set(ref, {
                leaseOwner: null,
                leaseUntil: 0,
                retryAfter: now() + RETRY_DELAY_MS,
              }, { merge: true });
            }
          });
        } catch {
          // Keep the lease bounded: another instance may retry after it expires.
        }
        const stale = staleEntry
          || validStoredDirectory(memory.get(area.key), now(), { allowStale: true });
        if (stale) {
          cacheInMemory(area.key, stale);
          recordDirectoryEvent('venue_directory_stale_fallback', { layer: 'firestore', areaKey: area.key });
          return publicResult({ ...stale, stale: true }, area, latitude, longitude);
        }
        throw error instanceof VenueDirectoryError
          ? error
          : new VenueDirectoryError('Venue directory refresh failed.');
      }
    })();

    inFlight.set(area.key, request);
    try {
      return await request;
    } finally {
      inFlight.delete(area.key);
    }
  }

  return { load };
}

const sharedVenueDirectoryLoader = createVenueDirectoryLoader();

export async function loadSharedVenueDirectory(store, latitude, longitude) {
  return sharedVenueDirectoryLoader.load(store, latitude, longitude);
}