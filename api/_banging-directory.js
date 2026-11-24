import { createHash, randomUUID } from 'node:crypto';
import {
  db, sharedStorageFailure, readSharedCache, searchVenueListings,
  getBangingTransitDurations, getWalkingRoute,
} from './_venue-live.js';
import { consumeDailyBudget, recordCostEvent } from './_cost-controls.js';
import { luxuryEvidence } from './_banging-curation.js';

const TTL = 3 * 60 * 60 * 1000;
const BANGING_LIVE_DEADLINE_MS = 4_300;
const BANGING_FALLBACK_RESPONSE_TTL_MS = 5 * 60 * 1000;
const flights = new Map();
const CACHE = 'banging_directory_cache_v1';
const failures = new Map();
const london = { latitude: 51.5074, longitude: -0.1278 };
const BANGING_SEARCH_TERMS = [
  'fine dining restaurants',
  'Michelin restaurants',
  'luxury restaurants',
  'tasting menu restaurants',
  'upscale restaurants',
  'high-end restaurants',
];
const EXCLUDED_CHAINS = /\b(mcdonald'?s|kfc|burger king|subway|domino'?s|pizza hut|pizza express|zizzi|prezzo|ask italian|bella italia|frankie and benny'?s|tgi fridays|wagamama|nando'?s|five guys|taco bell|leon|itsu|greggs|pret a manger|costa coffee|starbucks|caffe nero|shake shack|papa john'?s|yo!? sushi)\b/i;
const CASUAL_OR_NON_RESTAURANT = /\b(fast food|quick service|takeaway|take away|meal takeaway|food court|coffee shop)\b/i;

function error(message, status = 503) { return Object.assign(new Error(message), { status }); }
function meters(a, b) {
  return Math.hypot((a.latitude - b.latitude) * 111320,
    (a.longitude - b.longitude) * 111320 * Math.cos(a.latitude * Math.PI / 180));
}
export function haversineMeters(a, b) {
  if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite)
      || Math.abs(a.latitude) > 90 || Math.abs(b.latitude) > 90
      || Math.abs(a.longitude) > 180 || Math.abs(b.longitude) > 180) return Infinity;
  const radians = value => value * Math.PI / 180;
  const latDelta = radians(b.latitude - a.latitude);
  const lngDelta = radians(b.longitude - a.longitude);
  const arc = Math.sin(latDelta / 2) ** 2
    + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude))
      * Math.sin(lngDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(Math.max(0, 1 - arc)));
}

export function estimateBangingTransitMinutes(origin, venue) {
  const distanceKm = haversineMeters(origin, venue) / 1_000;
  if (!Number.isFinite(distanceKm)) return null;
  // Conservative metro estimate: 15 minutes for access/transfer overhead,
  // then 2.1 minutes per straight-line kilometre. It is explicitly not a live route.
  const estimate = Math.ceil(15 + distanceKm * 2.1);
  return estimate > 0 && estimate < 120 ? estimate : null;
}

function priceLevel(venue) {
  return (String(venue?.price || '').match(/£/g) || []).length;
}

function restaurantCandidate(venue) {
  const type = `${venue?.category || ''} ${venue?.type || ''}`;
  return /restaurant/i.test(type) && !CASUAL_OR_NON_RESTAURANT.test(type)
    && !EXCLUDED_CHAINS.test(String(venue?.name || ''));
}

function dynamicUpscaleCluster(venue, pool) {
  if (!restaurantCandidate(venue) || priceLevel(venue) < 3) return false;
  let neighbours = 0;
  for (const candidate of pool) {
    if (candidate?.id === venue.id || !restaurantCandidate(candidate) || priceLevel(candidate) < 3
        || Number(candidate.rating) < 4.5) continue;
    if (haversineMeters(venue, candidate) <= 1_800) neighbours += 1;
    if (neighbours >= 2) return true;
  }
  return false;
}

function qualifiesBangingCandidate(venue, pool) {
  const rating = Number(venue?.rating);
  const coordinatesValid = Number.isFinite(venue?.latitude) && Math.abs(venue.latitude) <= 90
    && Number.isFinite(venue?.longitude) && Math.abs(venue.longitude) <= 180;
  const editorial = luxuryEvidence(venue);
  const clustered = dynamicUpscaleCluster(venue, pool);
  if (!venue?.id || !venue?.name || !coordinatesValid || rating < 4.5 || rating > 5
      || !restaurantCandidate(venue) || (!editorial && !clustered)) return null;
  return {
    ...venue,
    ...(editorial || {
      luxurySource: 'google_places_upscale_cluster',
      neighborhood: '',
    }),
  };
}

function rankedBangingPool(pool) {
  const candidates = pool.filter(venue =>
    venue && Number(venue.rating) >= 4.5 && Number(venue.rating) <= 5
    && restaurantCandidate(venue) && Number.isFinite(venue.latitude)
    && Number.isFinite(venue.longitude) && priceLevel(venue) >= 3);
  return pool.flatMap(venue => {
    const qualified = qualifiesBangingCandidate(venue, candidates);
    return qualified ? [qualified] : [];
  });
}

// Fail closed if shared storage is unavailable: never turn every phone into
// an independent paid-search caller. A transaction coalesces cold requests
// across Vercel instances, not just inside one process.
export async function refresh(key, loader, ttl = TTL, { signal } = {}) {
  if (signal?.aborted) throw error('Banging lookup cancelled.');
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
        if (signal?.aborted) throw error('Banging lookup cancelled.');
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
      if (signal?.aborted) throw error('Banging lookup cancelled.');
      const value = await loader(signal);
      if (signal?.aborted) throw error('Banging lookup cancelled.');
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

async function directory(origin, signal) {
  const isLondon = meters(origin, london) <= 150_000;
  const centre = isLondon ? london : {
    latitude: Math.round(origin.latitude * 10) / 10,
    longitude: Math.round(origin.longitude * 10) / 10,
  };
  const key = isLondon ? 'luxury-london-v2' : `luxury-area-v2:${centre.latitude}:${centre.longitude}`;
  return refresh(key, async liveSignal => {
    const queries = BANGING_SEARCH_TERMS.map(term => isLondon
      ? `${term} in London`
      : `${term} near ${centre.latitude}, ${centre.longitude}`);
    // Query broad metro zones from the user's origin; price/review density,
    // not a fixed list of neighbourhood names, identifies upscale clusters.
    const attempts = await Promise.allSettled(queries.map(async query => {
      if (liveSignal?.aborted) throw error('Banging lookup cancelled.');
      await withBudget('places');
      recordCostEvent('banging_directory_search', { area: key });
      return searchVenueListings(query, centre, {
        ttlMs: TTL,
        signal: liveSignal,
        timeoutMs: BANGING_LIVE_DEADLINE_MS,
        biasRadiusMeters: 45_000,
      });
    }));
    const pool = attempts.flatMap(result => result.status === 'fulfilled' && Array.isArray(result.value)
      ? result.value : []);
    const found = new Map();
    for (const venue of rankedBangingPool(pool)) {
      found.set(venue.id, venue);
    }
    if (!found.size) {
      if (liveSignal?.aborted) throw error('Banging Google lookup timed out.');
      const failed = attempts.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      throw error('No verified high-end restaurants are available for this area yet.', 404);
    }
    return [...found.values()].sort((a, b) => Number(b.rating) - Number(a.rating) ||
      Number(b.ratingCount) - Number(a.ratingCount)).slice(0, 90);
  }, TTL, { signal });
}

function areaDirectoryKeys(origin, wide = false) {
  const latitude = Math.round(origin.latitude * 10) / 10;
  const longitude = Math.round(origin.longitude * 10) / 10;
  const offsets = wide ? [-3, -2, -1, 0, 1, 2, 3] : [-1, 0, 1];
  const keys = new Set();
  for (const latOffset of offsets) {
    for (const lngOffset of offsets) {
      const lat = Math.round((latitude + latOffset / 10) * 10) / 10;
      const lng = Math.round((longitude + lngOffset / 10) * 10) / 10;
      keys.add(`luxury-area-v2:${lat}:${lng}`);
      keys.add(`luxury-area-v1:${lat}:${lng}`);
    }
  }
  return [...keys];
}

async function readStoredDirectory(origin, { wide = false } = {}) {
  const isLondon = meters(origin, london) <= 150_000;
  const keys = isLondon
    ? ['luxury-london-v2', 'luxury-london-v1']
    : areaDirectoryKeys(origin, wide);
  const entries = await Promise.all(keys.map(key => readSharedCache(CACHE, key, TTL)));
  const candidates = new Map();
  let expiresAt = Date.now() + BANGING_FALLBACK_RESPONSE_TTL_MS;
  for (const entry of entries) {
    if (!entry || !Array.isArray(entry.value)) continue;
    expiresAt = Math.min(expiresAt, entry.ts + TTL);
    for (const venue of entry.value) {
      if (venue?.id && !candidates.has(venue.id)) candidates.set(venue.id, venue);
    }
  }
  const values = [...candidates.values()];
  return {
    venues: rankedBangingPool(values),
    expiresAt,
  };
}

function estimatedFallbackBody(origin, stored, premiumIds = []) {
  const results = stored.venues.flatMap(venue => {
    const minutes = estimateBangingTransitMinutes(origin, venue);
    return minutes === null ? [] : [{
      ...venue,
      bangingFallback: true,
      bangingFallbackSource: 'storage',
      bangingTransitEstimated: true,
      bangingTransitMinutes: minutes,
      bangingVerifiedAt: undefined,
    }];
  }).sort((a, b) => Number(b.rating) - Number(a.rating)
    || Number(b.ratingCount) - Number(a.ratingCount))
    .slice(0, premiumIds.length ? 40 : 50);
  return {
    results,
    premiumJourneys: {},
    premiumVerification: { requested: premiumIds.length, verified: 0 },
    complete: results.length >= (premiumIds.length ? 40 : 50),
    expiresAt: Math.min(stored.expiresAt, Date.now() + BANGING_FALLBACK_RESPONSE_TTL_MS),
    travelMode: 'estimated',
    maxMinutes: 120,
    fallbackReason: results.length ? 'google_unavailable_using_stored_venues' : 'google_unavailable_no_stored_venues',
  };
}

async function activePlacements(signal) {
  return refresh('active-placements-v1', async () => {
    const response = await fetch('https://panda-partners-api.vercel.app/api/public/sponsored-venues',
      { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(BANGING_LIVE_DEADLINE_MS)])
        : AbortSignal.timeout(BANGING_LIVE_DEADLINE_MS) });
    if (!response.ok) throw error('Current Premium placements are unavailable.');
    const body = await response.json();
    return (body.venues || []).filter(venue => ['banging', 'discovery'].includes(venue.tier) &&
      /^[A-Za-z0-9_-]{8,256}$/.test(venue.place_id));
  }, 5 * 60 * 1000, { signal });
}

export function premiumPlacements(ids, placements) {
  const allowed = new Set(placements.filter(item => item.tier === 'banging').map(item => item.place_id));
  return [...new Set(ids)].filter(id => allowed.has(id)).map(id => ({ id }));
}

export function withinTransitLimit(minutes, accessMinutes = 0) {
  return Number.isFinite(minutes) && minutes > 0 && Number.isFinite(accessMinutes) &&
    accessMinutes >= 0 && minutes + accessMinutes <= 120;
}

async function getVerifiedBangingDirectory(origin, premiumIds, signal) {
  const anchor = {
    latitude: Math.round(origin.latitude * 50) / 50,
    longitude: Math.round(origin.longitude * 50) / 50,
  };
  const [curated, feed] = await Promise.all([directory(origin, signal), activePlacements(signal)]);
  const premium = premiumPlacements(premiumIds, feed.value);
  const paidIds = new Set(feed.value.map(item => item.place_id));
  const organic = curated.value.filter(venue => !paidIds.has(venue.id));
  const prove = (candidates, role) => refresh(
    `transit-v1:${role === 'premium' ? 'premium-place-id-v1' : role}:${anchor.latitude}:${anchor.longitude}:${candidates.map(item => item.id).sort().join(',')}`,
    async () => {
    const durations = {};
    for (let offset = 0; offset < candidates.length; offset += 50) {
      const chunk = candidates.slice(offset, offset + 50);
      await withBudget('routes', chunk.length);
      const times = await getBangingTransitDurations(anchor, chunk.map(venue => role === 'premium'
        ? { placeId: venue.id } : { latitude: venue.latitude, longitude: venue.longitude }), {
          signal,
          timeoutMs: BANGING_LIVE_DEADLINE_MS,
        });
      for (let index = 0; index < chunk.length; index++) {
        const venue = chunk[index];
        let minutes = times[index];
        // A venue at the boarding location may have no transit leg at all.
        // Only a real, verified short walking route can admit this case.
        if (minutes === null && (role === 'premium' || meters(anchor, venue) <= 250)) {
          if (role === 'premium') await withBudget('routes', 1);
          const walking = await getWalkingRoute(anchor, role === 'premium'
            ? { placeId: venue.id } : { latitude: venue.latitude, longitude: venue.longitude }, {
              signal,
              timeoutMs: BANGING_LIVE_DEADLINE_MS,
            }).catch(cause => {
              if (role !== 'premium' || cause?.status === 429) throw cause;
              console.warn('[Panda Banging] A Premium walking proof was unavailable', cause?.status || 'provider_error');
              return null;
            });
          // Without a transit leg, retain only an actual short boarding-location
          // walk, never a guessed distance or an arbitrary two-hour walk.
          minutes = walking && (role !== 'premium' || walking.distanceMeters <= 250)
            ? walking.durationMinutes : null;
        }
        durations[venue.id] = minutes;
      }
    }
    return durations;
  }, TTL, { signal });
  // A new paid cohort must not repeat the whole organic route matrix.
  const [proof, paidProof] = await Promise.all([prove(organic, 'organic'), prove(premium, 'premium')]);
  // Verify access to the shared anchor too; straight-line radius is not a
  // public transport proof. Cache this inexpensive access leg across visits.
  const access = await refresh(`access-v1:${origin.latitude.toFixed(4)}:${origin.longitude.toFixed(4)}`, async () => {
    if (meters(origin, anchor) < 15) return { durationMinutes: 1 };
    const route = await getWalkingRoute(origin, anchor, { signal, timeoutMs: BANGING_LIVE_DEADLINE_MS });
    if (!route) throw error('Could not verify public transport access from your location.');
    return { durationMinutes: route.durationMinutes };
  }, TTL, { signal });
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
    premiumVerification: {
      requested: premium.length,
      verified: premium.filter(venue => eligible(venue, paidProof)).length,
    },
    complete: results.length >= (premiumIds.length ? 40 : 50),
    expiresAt: bangingVerifiedAt + TTL,
    travelMode: 'transit', maxMinutes: 120,
  };
}

function waitAtMost(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function mergeVerifiedAndStored(verified, stored, premiumIds) {
  const target = premiumIds.length ? 40 : 50;
  const seen = new Set();
  const results = [...(verified?.results || []), ...(stored?.results || [])].filter(venue => {
    if (!venue?.id || seen.has(venue.id)) return false;
    seen.add(venue.id);
    return true;
  }).slice(0, target);
  return {
    ...(verified || {}),
    results,
    premiumJourneys: verified?.premiumJourneys || {},
    premiumVerification: verified?.premiumVerification || {
      requested: premiumIds.length,
      verified: 0,
    },
    complete: results.length >= target,
    expiresAt: Math.min(
      verified?.expiresAt || Date.now() + BANGING_FALLBACK_RESPONSE_TTL_MS,
      stored?.expiresAt || Date.now() + BANGING_FALLBACK_RESPONSE_TTL_MS,
    ),
    travelMode: stored?.results?.length ? 'transit_or_estimated' : verified?.travelMode || 'transit',
    maxMinutes: 120,
    ...(stored?.results?.length
      ? { fallbackReason: 'google_unavailable_using_stored_venues' }
      : {}),
  };
}

export async function getBangingDirectory(origin, premiumIds = [], { timeoutMs = BANGING_LIVE_DEADLINE_MS } = {}) {
  const safePremiumIds = [...new Set(premiumIds)].slice(0, 10);
  const storedCurrentPromise = readStoredDirectory(origin);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(error('Banging live lookup exceeded its short deadline.'));
    }, timeoutMs);
  });
  try {
    const verified = await Promise.race([
      getVerifiedBangingDirectory(origin, safePremiumIds, controller.signal),
      deadline,
    ]);
    const target = safePremiumIds.length ? 40 : 50;
    if (verified.results.length >= target) return verified;
    let current = await waitAtMost(storedCurrentPromise, 250);
    let estimated = current
      ? estimatedFallbackBody(origin, current, safePremiumIds)
      : null;
    if ((!estimated?.results?.length || verified.results.length + estimated.results.length < target)
        && meters(origin, london) > 150_000) {
      const wider = await waitAtMost(readStoredDirectory(origin, { wide: true }), 350);
      if (wider) {
        const widerEstimate = estimatedFallbackBody(origin, wider, safePremiumIds);
        if ((widerEstimate.results?.length || 0) > (estimated?.results?.length || 0)) {
          current = wider;
          estimated = widerEstimate;
        }
      }
    }
    if (!estimated?.results?.length) {
      return {
        ...verified,
        fallbackReason: verified.results.length
          ? 'verified_results_below_target'
          : 'google_unavailable_no_stored_venues',
      };
    }
    return mergeVerifiedAndStored(verified, estimated, safePremiumIds);
  } catch (cause) {
    let current = await waitAtMost(storedCurrentPromise, 250);
    let fallback = current
      ? estimatedFallbackBody(origin, current, safePremiumIds)
      : null;
    const target = safePremiumIds.length ? 40 : 50;
    if ((fallback?.results?.length || 0) < target && meters(origin, london) > 150_000) {
      const widerPromise = readStoredDirectory(origin, { wide: true });
      const wider = await waitAtMost(widerPromise, 350);
      if (wider) {
        const widerFallback = estimatedFallbackBody(origin, wider, safePremiumIds);
        if ((widerFallback.results?.length || 0) > (fallback?.results?.length || 0)) {
          current = wider;
          fallback = widerFallback;
        }
      }
    }
    if (fallback?.results?.length) return fallback;
    return {
      results: [],
      premiumJourneys: {},
      premiumVerification: { requested: safePremiumIds.length, verified: 0 },
      complete: false,
      expiresAt: Date.now() + 30_000,
      travelMode: 'estimated',
      maxMinutes: 120,
      fallbackReason: cause?.name === 'AbortError' || controller.signal.aborted
        ? 'google_unavailable_no_stored_venues'
        : 'google_error_no_stored_venues',
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
