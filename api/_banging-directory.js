import { createHash, randomUUID } from 'node:crypto';
import {
  db, sharedStorageFailure, readSharedCache, searchVenueListings, getVenueProfile,
  getBangingTransitDurations, getWalkingRoute,
} from './_venue-live.js';
import { consumeDailyBudget, recordCostEvent } from './_cost-controls.js';
import { luxuryEvidence, qualifiesLuxuryResult } from './_banging-curation.js';

const TTL = 3 * 60 * 60 * 1000;
const flights = new Map();
const CACHE = 'banging_directory_cache_v1';
const failures = new Map();
const london = { latitude: 51.5074, longitude: -0.1278 };
const districts = ['Mayfair', 'Knightsbridge', 'Belgravia', 'Chelsea', 'Marylebone',
  'Notting Hill', 'Soho and Fitzrovia', 'City of London and Shoreditch', 'Covent Garden and Southwark',
  'St James and Westminster', 'Bloomsbury and Clerkenwell', 'Fulham and Wandsworth',
  'Richmond and Chiswick', 'Kensington'];

function error(message, status = 503) { return Object.assign(new Error(message), { status }); }
function meters(a, b) {
  return Math.hypot((a.latitude - b.latitude) * 111320,
    (a.longitude - b.longitude) * 111320 * Math.cos(a.latitude * Math.PI / 180));
}

// Fail closed if shared storage is unavailable: never turn every phone into
// an independent paid-search caller. A transaction coalesces cold requests
// across Vercel instances, not just inside one process.
export async function refresh(key, loader, ttl = TTL) {
  const stored = await readSharedCache(CACHE, key, ttl);
  if (stored) return { value: stored.value, ts: stored.ts };
  const failed = failures.get(key);
  if (failed && failed.until > Date.now()) throw failed.error;
  if (flights.has(key)) return flights.get(key);
  const request = (async () => {
    const store = db();
    if (!store) throw error(`Shared venue storage is unavailable (${sharedStorageFailure()}). Please check Vercel Production configuration.`);
    const id = createHash('sha256').update(key).digest('base64url');
    const ref = store.collection(CACHE).doc(id);
    const lease = store.collection('banging_refresh_locks_v1').doc(id);
    const owner = randomUUID();
    const ownsLease = await store.runTransaction(async transaction => {
      const current = await transaction.get(lease);
      if (Number(current.data()?.until || 0) > Date.now()) return false;
      transaction.set(lease, { owner, until: Date.now() + 90_000 });
      return true;
    });
    if (!ownsLease) {
      for (let i = 0; i < 35; i++) {
        await new Promise(resolve => setTimeout(resolve, 700));
        const ready = await readSharedCache(CACHE, key, ttl);
        if (ready) return ready;
      }
      throw error('Banging is refreshing this area. Please try again shortly.');
    }
    try {
      // Another instance may have completed between the first read and lease.
      const ready = await readSharedCache(CACHE, key, ttl);
      if (ready) return ready;
      const value = await loader();
      const ts = Date.now();
      await ref.set({ ts, value }); // Must succeed before advertising a shared result.
      return { value, ts };
    } finally {
      await store.runTransaction(async transaction => {
        const current = await transaction.get(lease);
        if (current.data()?.owner === owner) transaction.delete(lease);
      }).catch(() => {});
    }
  })().catch(cause => {
    failures.set(key, { until: Date.now() + 60_000, error: cause });
    throw cause;
  }).finally(() => flights.delete(key));
  flights.set(key, request);
  return request;
}

export async function withBudget(kind, amount = 1) {
  // Retain the existing shared Places counter. Matrix elements have their
  // own optional daily cap because one request can bill many destinations.
  const store = db();
  if (kind === 'places') {
    const limit = process.env.PANDA_PLACES_DAILY_LIMIT || process.env.PANDA_PLACES_DAILY_REQUEST_LIMIT;
    const result = await consumeDailyBudget(store, 'places', limit);
    if (!result.allowed) throw error('Panda’s daily venue-search allowance has been reached.', 429);
  } else {
    const configured = Number(process.env.PANDA_BANGING_DAILY_ROUTE_ELEMENTS);
    if (Number.isFinite(configured) && configured > 0) {
      const ref = store.collection('panda_banging_budgets_v1').doc(new Date().toISOString().slice(0, 10));
      const allowed = await store.runTransaction(async transaction => {
        const current = Number((await transaction.get(ref)).data()?.elements || 0);
        if (current + amount > configured) return false;
        transaction.set(ref, { elements: current + amount, updatedAt: Date.now() });
        return true;
      });
      if (!allowed) throw error('Panda’s daily Banging travel allowance has been reached.', 429);
    }
  }
}

async function directory(origin) {
  const isLondon = meters(origin, london) <= 150_000;
  const centre = isLondon ? london : {
    latitude: Math.round(origin.latitude * 10) / 10,
    longitude: Math.round(origin.longitude * 10) / 10,
  };
  const key = isLondon ? 'luxury-london-v1' : `luxury-area-v1:${centre.latitude}:${centre.longitude}`;
  return refresh(key, async () => {
    const queries = isLondon
      ? [...districts.map(area => `Michelin starred fine dining restaurants in ${area}, London`),
        'luxury hotel cocktail bars in London']
      : ['fine dining restaurants', 'luxury fine dining restaurants',
        'fine dining tasting menu restaurants'].map(term => `${term} near ${centre.latitude}, ${centre.longitude}`);
    const found = new Map();
    // At most fifteen bounded searches per shared three-hour London refresh,
    // two at a time. No gallery-image fetches or per-card full-detail fan-out.
    for (let offset = 0; offset < queries.length; offset += 2) {
      await Promise.all(queries.slice(offset, offset + 2).map(async query => {
        await withBudget('places');
        recordCostEvent('banging_directory_search', { area: key });
        const results = await searchVenueListings(query, centre, { ttlMs: TTL });
        for (const venue of results) if (qualifiesLuxuryResult(venue)) {
          found.set(venue.id, { ...venue, ...luxuryEvidence(venue) });
        }
      }));
    }
    if (!found.size) throw error('No verified luxury venues are available for this area yet.', 404);
    return [...found.values()].sort((a, b) => Number(b.rating) - Number(a.rating) ||
      Number(b.ratingCount) - Number(a.ratingCount)).slice(0, 90);
  });
}

async function activePlacements() {
  return refresh('active-placements-v1', async () => {
    const response = await fetch('https://panda-partners-api.vercel.app/api/public/sponsored-venues',
      { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw error('Current Premium placements are unavailable.');
    const body = await response.json();
    return (body.venues || []).filter(venue => ['banging', 'discovery'].includes(venue.tier) &&
      /^[A-Za-z0-9_-]{8,256}$/.test(venue.place_id));
  }, 5 * 60 * 1000);
}

async function premiumProfiles(ids, placements) {
  const allowed = new Set(placements.filter(item => item.tier === 'banging').map(item => item.place_id));
  const selected = ids.filter(id => allowed.has(id));
  const result = [];
  for (let offset = 0; offset < selected.length; offset += 3) {
    await Promise.all(selected.slice(offset, offset + 3).map(async id => {
      const stored = await refresh(`premium-profile-v1:${id}`, () => getVenueProfile(id));
      const venue = stored.value;
      if (Number.isFinite(venue?.latitude) && Number.isFinite(venue?.longitude)) result.push(venue);
    }));
  }
  return result;
}

export function withinTransitLimit(minutes, accessMinutes = 0) {
  return Number.isFinite(minutes) && minutes > 0 && Number.isFinite(accessMinutes) &&
    accessMinutes >= 0 && minutes + accessMinutes <= 120;
}

export async function getBangingDirectory(origin, premiumIds = []) {
  const anchor = {
    latitude: Math.round(origin.latitude * 50) / 50,
    longitude: Math.round(origin.longitude * 50) / 50,
  };
  const [curated, feed] = await Promise.all([directory(origin), activePlacements()]);
  const premium = await premiumProfiles(premiumIds, feed.value);
  const paidIds = new Set(feed.value.map(item => item.place_id));
  const organic = curated.value.filter(venue => !paidIds.has(venue.id));
  const prove = (candidates, role) => refresh(
    `transit-v1:${role}:${anchor.latitude}:${anchor.longitude}:${candidates.map(item => item.id).sort().join(',')}`,
    async () => {
    const durations = {};
    for (let offset = 0; offset < candidates.length; offset += 50) {
      const chunk = candidates.slice(offset, offset + 50);
      await withBudget('routes', chunk.length);
      const times = await getBangingTransitDurations(anchor, chunk.map(venue => ({
        latitude: venue.latitude, longitude: venue.longitude,
      })));
      for (let index = 0; index < chunk.length; index++) {
        const venue = chunk[index];
        let minutes = times[index];
        // A venue at the boarding location may have no transit leg at all.
        // Only a real, verified short walking route can admit this case.
        if (minutes === null && meters(anchor, venue) <= 250) {
          const walking = await getWalkingRoute(anchor, { latitude: venue.latitude, longitude: venue.longitude });
          minutes = walking?.durationMinutes ?? null;
        }
        durations[venue.id] = minutes;
      }
    }
    return durations;
  });
  // A new paid cohort must not repeat the whole organic route matrix.
  const [proof, paidProof] = await Promise.all([prove(organic, 'organic'), prove(premium, 'premium')]);
  // Verify access to the shared anchor too; straight-line radius is not a
  // public transport proof. Cache this inexpensive access leg across visits.
  const access = await refresh(`access-v1:${origin.latitude.toFixed(4)}:${origin.longitude.toFixed(4)}`, async () => {
    if (meters(origin, anchor) < 15) return { durationMinutes: 1 };
    const route = await getWalkingRoute(origin, anchor);
    if (!route) throw error('Could not verify public transport access from your location.');
    return { durationMinutes: route.durationMinutes };
  });
  const eligible = (venue, verified) => withinTransitLimit(verified.value[venue.id], access.value.durationMinutes);
  const journey = (venue, verified) => ({
    bangingTransitMinutes: verified.value[venue.id] + access.value.durationMinutes,
    bangingVerifiedAt: Math.min(curated.ts, verified.ts, access.ts),
  });
  const results = organic.filter(venue => eligible(venue, proof)).map(venue => ({ ...venue, ...journey(venue, proof) }));
  const bangingVerifiedAt = Math.min(curated.ts, proof.ts, paidProof.ts, access.ts);
  return {
    results,
    premiumJourneys: Object.fromEntries(premium.filter(venue => eligible(venue, paidProof)).map(venue => [venue.id, journey(venue, paidProof)])),
    complete: results.length >= 40,
    expiresAt: bangingVerifiedAt + TTL,
    travelMode: 'transit', maxMinutes: 120,
  };
}
