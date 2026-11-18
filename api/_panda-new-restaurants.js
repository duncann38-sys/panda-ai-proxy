// OpenTable-designated New selections only. This module never scrapes a website,
// refreshes a provider directory, guesses a Google match, or writes rich Places data.
import { randomInt } from 'node:crypto';

export const NEW_RADII_KM = Object.freeze([5, 10, 20, 40]);
export const NEW_PAGE_SIZE = 20;
export const NEW_COLLECTION = 'panda_opentable_new_v1';
const DAY = 86_400_000;
const placeId = value => typeof value === 'string' && /^ChI[\w-]{8,250}$/.test(value);
const instant = value => typeof value === 'number' ? value : Date.parse(value ?? '');
const coordinates = (lat, lng) => Number.isFinite(lat) && Math.abs(lat) <= 90
  && Number.isFinite(lng) && Math.abs(lng) <= 180;

export function openTableSelectionUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['www.opentable.co.uk', 'www.opentable.com', 'opentable.co.uk', 'opentable.com'].includes(url.hostname)
      && /^\/lists\/[^/]+$/.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}

export function newVenueDistance(a, b) {
  const radians = value => value * Math.PI / 180;
  const p = Math.sin(radians(b.lat - a.lat) / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat))
    * Math.sin(radians(b.lng - a.lng) / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, p)));
}

// Fisher–Yates over the FULL eligible pool, not over an already truncated page.
export function shuffleNewPool(values, chooseIndex = randomInt) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const choice = chooseIndex(index + 1);
    if (!Number.isInteger(choice) || choice < 0 || choice > index) throw new Error('Invalid shuffle entropy.');
    [result[index], result[choice]] = [result[choice], result[index]];
  }
  return result;
}

function validSelection(row, now) {
  const checked = instant(row?.verifiedAt);
  const selected = instant(row?.sourceSelectedAt);
  return row?.designation === 'opentable-new' && /^\d{1,12}$/.test(String(row.rid))
    && placeId(row.placeId) && coordinates(row.lat, row.lng)
    && openTableSelectionUrl(row.sourceUrl)
    && checked <= now && checked > now - 30 * DAY
    && selected <= now && selected > now - 366 * DAY;
}

export function selectNewRestaurantPool(rows, centre, now = Date.now()) {
  if (!coordinates(centre?.lat, centre?.lng)) throw new Error('location_required');
  const googleIds = new Set();
  const rids = new Set();
  const result = [];
  for (const row of rows ?? []) {
    if (!validSelection(row, now) || googleIds.has(row.placeId) || rids.has(String(row.rid))) continue;
    const distanceMeters = Math.round(newVenueDistance(centre, row));
    if (distanceMeters > 40_000) continue;
    googleIds.add(row.placeId);
    rids.add(String(row.rid));
    result.push({ ...row, rid: String(row.rid), distanceMeters });
  }
  return result;
}

/** Shared read path for Native New, Panda AI, and opt-in update eligibility.
 * readPool must return a complete, approved generation or a non-ready status.
 * hydrateVenue must check the existing correct-branch binding before Places.
 */
export function createNewRestaurantFeed({
  readPool, hydrateVenue, chooseIndex = randomInt, now = Date.now, maxLookups = 40,
}) {
  return async ({ location, excludedPlaceIds = [] } = {}) => {
    if (!coordinates(location?.lat, location?.lng)) {
      return { status: 'location_required', venues: [], newOpeningsSearch: true,
        text: 'Which area shall we look in? Allow location access to see OpenTable’s New selection near you.' };
    }
    const source = await readPool();
    if (source?.status !== 'ready' || !Array.isArray(source.rows)) {
      return { status: source?.status || 'source_unavailable', venues: [], newOpeningsSearch: true,
        text: 'OpenTable’s verified New selection isn’t connected for this area yet. I won’t substitute ordinary restaurants.' };
    }
    const pool = selectNewRestaurantPool(source.rows, location, now());
    const excluded = new Set(excludedPlaceIds.filter(placeId).slice(-500));
    // Prior displayed IDs affect a "more" turn only, never a fresh visit.
    const candidates = pool.filter(row => !excluded.has(row.placeId));
    const checked = new Map();
    let lookups = 0;
    for (const radiusKm of NEW_RADII_KM) {
      const inside = shuffleNewPool(candidates.filter(row => row.distanceMeters <= radiusKm * 1000), chooseIndex);
      const accepted = [];
      for (const row of inside) {
        if (!checked.has(row.placeId)) {
          if (lookups >= maxLookups) {
            return { status: 'limited', venues: [], newOpeningsSearch: true, radiusKm,
              text: 'I couldn’t finish verifying the New selection within this request’s safety limit. Please refresh shortly.',
              eligiblePoolSize: pool.length };
          }
          lookups++;
          // A provider failure is NOT proof of an ineligible restaurant.
          const venue = await hydrateVenue(row);
          checked.set(row.placeId, venue ?? null);
        }
        const venue = checked.get(row.placeId);
        if (!venue || venue.id !== row.placeId || !venue.photoName || Number(venue.photoCount) < 1) continue;
        accepted.push({
          ...venue, distanceMeters: row.distanceMeters,
          openingDesignation: 'opentable-new', openingSourceName: 'OpenTable',
          openingSourceUrl: row.sourceUrl,
          openingReportedAt: new Date(instant(row.verifiedAt)).toISOString(),
          openTableRid: row.rid,
        });
        if (accepted.length === NEW_PAGE_SIZE) break;
      }
      if (accepted.length === NEW_PAGE_SIZE || radiusKm === 40) {
        return { status: 'ready', venues: accepted, newOpeningsSearch: true, radiusKm,
          expanded: radiusKm > 5, exhausted: accepted.length < NEW_PAGE_SIZE,
          eligiblePoolSize: pool.length, sourceGeneration: source.generation,
          text: accepted.length
            ? `Here ${accepted.length === 1 ? 'is one' : `are ${accepted.length}`} from OpenTable’s New selection within ${radiusKm} km. These are OpenTable’s picks, matched to the right Google venue.${radiusKm > 5 ? ' I’ve widened the search beyond 5 km.' : ''}`
            : excluded.size && pool.length
              ? 'I’ve shown you all the verified OpenTable New matches available within 40 km in this chat. I won’t repeat them or pad the list.'
              : 'No verified OpenTable New matches were available within 40 km. I won’t pad the list with ordinary restaurants.' };
      }
    }
  };
}

// Administration must populate a new approved generation explicitly. There is
// deliberately no public write endpoint or automatic upstream import.
export function createFirestoreNewPool(store, now = Date.now) {
  let cached = null;
  let expires = 0;
  return async () => {
    if (cached && expires > now()) return cached;
    const root = store.collection(NEW_COLLECTION).doc('catalog');
    const snapshot = await root.get();
    const manifest = snapshot.exists ? snapshot.data() : null;
    const approved = manifest?.status === 'approved'
      && ['opentable-api', 'opentable-approved-editorial'].includes(manifest.sourceType)
      && typeof manifest.approvalReference === 'string' && manifest.approvalReference.trim()
      && /^[A-Za-z0-9_-]{1,100}$/.test(manifest.generation ?? '')
      && instant(manifest.expiresAt) > now();
    if (!approved) return { status: 'source_not_ready' };
    const rows = await root.collection('generations').doc(manifest.generation).collection('restaurants').get();
    // Never silently use a partial generation or truncate it to 20.
    if (!Number.isSafeInteger(manifest.count) || manifest.count !== rows.size) {
      return { status: 'source_incomplete' };
    }
    cached = { status: 'ready', generation: manifest.generation, rows: rows.docs.map(doc => doc.data()) };
    expires = Math.min(now() + 300_000, instant(manifest.expiresAt));
    return cached;
  };
}
