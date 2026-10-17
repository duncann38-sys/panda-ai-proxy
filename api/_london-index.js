import { randomUUID } from 'node:crypto';
import { LONDON_CLUSTERS, LONDON_SEED_PLAN, LONDON_SEED_TASKS } from '../constants/london_clusters.js';

export const ID_COLLECTION = 'panda_london_place_ids_v1';
export const LOCATION_COLLECTION = 'panda_london_place_locations_v1';
export const JOB_COLLECTION = 'panda_london_seed_jobs_v1';
// Expire before the 30-day coordinate allowance; physical TTL cleanup is async.
export const LOCATION_TTL_MS = 29 * 24 * 60 * 60 * 1000;
export const INDEX_FIELDS = 'places.id,places.location,places.photos.name,nextPageToken';

export function providerQuotaInfo(error, retryAfter) {
  const metadata = (error?.details || []).map(detail => detail?.metadata || {})
    .find(item => item.quota_limit || item.quota_unit || item.quota_metric) || {};
  const safe = value => typeof value === 'string' && /^[\w./{}: -]{1,160}$/.test(value) ? value : null;
  const unit = safe(metadata.quota_unit);
  const limit = safe(metadata.quota_limit);
  const description = `${unit || ''} ${limit || ''}`.toLowerCase();
  const period = /minute|\/min(?:\/|$)|permin/.test(description) ? 'minute'
    : /day|\/d(?:\/|$)/.test(description) ? 'day' : 'unknown';
  const retrySeconds = Number(retryAfter);
  return {
    period, metric: safe(metadata.quota_metric), limit, unit,
    limitValue: safe(metadata.quota_limit_value),
    retryAfterSeconds: period === 'minute'
      ? Math.max(65, Math.min(180, Number.isFinite(retrySeconds) ? retrySeconds : 65)) : null,
  };
}

export async function indexedVenueBaseline(store, placeId, now = Date.now()) {
  const [identity, position, partner] = await Promise.all([
    store.collection(ID_COLLECTION).doc(placeId).get(),
    store.collection(LOCATION_COLLECTION).doc(placeId).get(),
    store.collection('partner_venues').doc(placeId).get(),
  ]);
  if (!identity.exists && !partner.exists) return null;
  const owner = partner.data() || {};
  const location = position.data() || {};
  const expiry = location.expiresAt?.toMillis?.() ?? new Date(location.expiresAt).getTime();
  const tier = owner.active === true && ['banging', 'discovery'].includes(owner.tier) ? owner.tier : null;
  return {
    id: placeId, name: owner.name || '', address: owner.address || '',
    ...(expiry > now ? { latitude: location.lat, longitude: location.lng } : {}),
    openNow: null, todayHours: null, photoNames: [],
    ...(tier ? { partnerTier: tier } : {}),
    limited: true, dataMode: 'independent_baseline',
    availabilityMessage: 'Live details are temporarily unavailable. Opening hours have not been confirmed.',
  };
}

export async function nearbyPlaceIdentities(store, { lat, lng, radius }, now = Date.now()) {
  const delta = radius / 111000;
  const snapshot = await store.collection(LOCATION_COLLECTION)
    .where('lat', '>=', Math.max(-90, lat - delta))
    .where('lat', '<=', Math.min(90, lat + delta)).limit(300).get();
  return snapshot.docs.flatMap(doc => {
    const item = doc.data();
    const expiry = item.expiresAt?.toMillis?.() ?? new Date(item.expiresAt).getTime();
    const rad = degrees => degrees * Math.PI / 180;
    const a = Math.sin(rad(item.lat - lat) / 2) ** 2
      + Math.cos(rad(lat)) * Math.cos(rad(item.lat)) * Math.sin(rad(item.lng - lng) / 2) ** 2;
    const distance = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    return expiry > now && Number.isFinite(distance) && distance <= radius
      ? [{ place_id: item.place_id, lat: item.lat, lng: item.lng, distanceMeters: Math.round(distance) }] : [];
  }).sort((a, b) => a.distanceMeters - b.distanceMeters);
}

const toRadians = degrees => degrees * Math.PI / 180;
function distanceMeters(aLat, aLng, bLat, bLng) {
  const dLat = toRadians(bLat - aLat), dLng = toRadians(bLng - aLng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}
function encodePageCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decodePageCursor(value) {
  if (!value || typeof value !== 'string' || value.length > 12_000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads a small, category-tagged page from the permitted Place ID index.
 * Only IDs and expiring coordinates are read from Firestore; Google fields
 * are hydrated by the API route for this page and are never written back.
 */
export async function nearbySeededPlacePage(store, {
  lat, lng, radius = 6000, category = 'All', cursor = null, pageSize = 6,
}, now = Date.now()) {
  if (!store || !Number.isFinite(lat) || !Number.isFinite(lng)
    || !Number.isFinite(radius) || radius < 500 || radius > 20_000
    || typeof category !== 'string' || !category.trim() || category.length > 64) {
    throw new TypeError('A valid location, radius, and category are required.');
  }
  const size = Math.max(1, Math.min(8, Math.floor(pageSize) || 6));
  const roundedOrigin = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const decoded = decodePageCursor(cursor);
  const state = decoded?.category === category && decoded?.origin === roundedOrigin
    ? decoded
    : { clusterIndex: 0, pending: [] };
  const nearbyClusters = LONDON_CLUSTERS
    .map(cluster => ({ ...cluster, centerDistance: distanceMeters(lat, lng, cluster.lat, cluster.lng) }))
    .filter(cluster => cluster.centerDistance <= radius + 3000)
    .sort((a, b) => a.centerDistance - b.centerDistance);
  let clusterIndex = Math.max(0, Math.min(nearbyClusters.length, Number(state.clusterIndex) || 0));
  const found = Array.isArray(state.pending)
    ? state.pending.filter(item => typeof item?.place_id === 'string'
      && Number.isFinite(item.lat) && Number.isFinite(item.lng))
    : [];
  const seen = new Set(found.map(item => item.place_id));

  // Pull from the nearest cluster contexts until there is enough to return
  // a useful page plus a small look-ahead for distance ordering.
  while (found.length < size * 2 && clusterIndex < nearbyClusters.length) {
    const cluster = nearbyClusters[clusterIndex++];
    const context = `${cluster.name}/${category}`;
    const snapshot = await store.collection(ID_COLLECTION)
      .where('searchContexts', 'array-contains', context).limit(20).get();
    const positions = await Promise.all(snapshot.docs.map(async identityDoc => {
      const identity = identityDoc.data();
      if (identity.seed_plan !== LONDON_SEED_PLAN || seen.has(identityDoc.id)) return null;
      const positionDoc = await store.collection(LOCATION_COLLECTION).doc(identityDoc.id).get();
      if (!positionDoc.exists) return null;
      const position = positionDoc.data();
      const expiry = position.expiresAt?.toMillis?.() ?? new Date(position.expiresAt).getTime();
      if (!Number.isFinite(expiry) || expiry <= now
        || !Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return null;
      const distance = distanceMeters(lat, lng, position.lat, position.lng);
      if (!Number.isFinite(distance) || distance > radius) return null;
      return {
        place_id: identityDoc.id, lat: position.lat, lng: position.lng,
        distanceMeters: Math.round(distance),
        primary_photo_path: identity.primary_photo_path
          || `/api/partner/venues/${encodeURIComponent(identityDoc.id)}/photos/0/image`,
      };
    }));
    for (const position of positions) {
      if (!position || seen.has(position.place_id)) continue;
      seen.add(position.place_id);
      found.push(position);
    }
  }

  found.sort((a, b) => a.distanceMeters - b.distanceMeters);
  const identities = found.slice(0, size);
  const pending = found.slice(size);
  const hasMore = pending.length > 0 || clusterIndex < nearbyClusters.length;
  return {
    identities,
    nextCursor: hasMore ? encodePageCursor({
      category, origin: roundedOrigin, clusterIndex, pending,
    }) : null,
    indexExhausted: !hasMore,
  };
}

// This is an identity index, not a persistent copy of Google venue content.
// In particular it never owns partner tiers or stores names/photos/hours.
export async function indexPlaceIdentities(store, places, {
  now = Date.now(), context = 'live_discovery',
  arrayUnion = (...items) => items,
  requirePhoto = false,
  seedPlan = '',
} = {}) {
  const valid = (Array.isArray(places) ? places : []).filter(place => {
    const lat = place.location?.latitude ?? place.lat;
    const lng = place.location?.longitude ?? place.lng;
    return typeof place.id === 'string' && /^[\w-]{1,256}$/.test(place.id)
      && Number.isFinite(lat) && Math.abs(lat) <= 90
      && Number.isFinite(lng) && Math.abs(lng) <= 180
      && (!requirePhoto || place.photos?.some(photo =>
        typeof photo.name === 'string' && photo.name.startsWith(`places/${place.id}/photos/`)));
  });
  // Stay below Firestore's 500-write batch maximum.
  for (let offset = 0; offset < valid.length; offset += 200) {
    const batch = store.batch();
    for (const place of valid.slice(offset, offset + 200)) {
      batch.set(store.collection(ID_COLLECTION).doc(place.id), {
        place_id: place.id, last_indexed: new Date(now),
        searchContexts: arrayUnion(context), source: 'google_place_id',
        ...(requirePhoto ? { primary_photo_path: `/api/partner/venues/${place.id}/photos/0/image` } : {}),
        ...(seedPlan ? { seed_plan: seedPlan } : {}),
      }, { merge: true });
      batch.set(store.collection(LOCATION_COLLECTION).doc(place.id), {
        place_id: place.id,
        lat: place.location?.latitude ?? place.lat,
        lng: place.location?.longitude ?? place.lng,
        last_indexed: new Date(now), expiresAt: new Date(now + LOCATION_TTL_MS),
      }, { merge: true });
    }
    await batch.commit();
  }
  return valid.length;
}

export function londonClock(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return { hour: Number(parts.hour), weekday: parts.weekday, week: date.toISOString().slice(0, 10) };
}

export function createLondonSeeder({
  store, apiKey, consumeBudget, fetchImpl = fetch, now = Date.now,
  arrayUnion, tasks = LONDON_SEED_TASKS, pagesPerQuery = 1,
  paceMs = 3000, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  dailyRequestLimit, customerReserve, planId = '', indexPlanId = planId, requirePhoto = false,
}) {
  const pageLimit = Math.max(1, Math.min(3, Math.floor(pagesPerQuery) || 1));
  return async ({ manual = false, maxRequests = 4 } = {}) => {
    if (!store || !apiKey) return { status: 'not_configured' };
    const clock = londonClock(new Date(now()));
    if (!manual && clock.hour !== 3 && clock.hour !== 9) return { status: 'outside_schedule_window' };
    const previousWeek = new Date(Date.parse(`${clock.week}T00:00:00Z`) - 7 * 86400000)
      .toISOString().slice(0, 10);
    const key = week => planId ? `${week}_${planId}` : week;
    const previous = await store.collection(JOB_COLLECTION).doc(key(previousWeek)).get();
    const week = previous.exists && previous.data()?.status !== 'complete' ? previousWeek : clock.week;
    const ref = store.collection(JOB_COLLECTION).doc(key(week));
    const owner = randomUUID();
    const lease = await store.runTransaction(async transaction => {
      const doc = await transaction.get(ref);
      const previous = doc.data() || {};
      if (previous.status === 'complete') return { skip: 'complete', ...previous };
      // Only Sunday starts a new scheduled round; subsequent daily runs resume.
      if (!manual && !doc.exists && clock.weekday !== 'Sun') return { skip: 'nothing_to_resume' };
      if (Number(previous.leaseUntil || 0) > now()) return { skip: 'busy' };
      const state = {
        taskIndex: 0, page: 0, pageToken: '', indexed: 0, requests: 0,
        ...previous, owner, leaseUntil: now() + 90000, status: 'running', week,
        pauseReason: null, quota: null,
        planId, categoryCoverage: previous.categoryCoverage || {},
      };
      transaction.set(ref, state, { merge: true });
      return state;
    });
    if (lease.skip) return { ...lease, status: lease.skip, owner: undefined, week: lease.week || week };
    const state = { ...lease };
    // A previous deeper run may already have sampled this query's first page.
    if (state.page >= pageLimit) {
      state.taskIndex++;
      state.page = 0;
      state.pageToken = '';
    }
    let requests = 0;
    let failure = null;
    try {
      while (state.taskIndex < tasks.length && requests < Math.min(4, Math.max(1, maxRequests))) {
        const dailyLimit = dailyRequestLimit ? dailyRequestLimit() :
          Math.max(1, Number.parseInt(process.env.PANDA_DAILY_PLACES_LIMIT || '500', 10) || 500);
        const reserve = Math.max(0, Math.min(dailyLimit,
          Number.parseInt(process.env.PANDA_SEED_CUSTOMER_RESERVE ||
            String(customerReserve ?? Math.floor(dailyLimit / 2)), 10) || 0));
        // Background indexing must not consume all interactive discovery headroom.
        if (dailyLimit <= reserve) {
          failure = 'quota_paused'; state.pauseReason = 'customer_reserve'; break;
        }
        const allowance = await consumeBudget(store, 'places', dailyLimit - reserve);
        if (!allowance.allowed || allowance.shared !== true) {
          failure = !allowance.allowed ? 'quota_paused' : 'budget_unavailable';
          state.pauseReason = !allowance.allowed ? 'customer_reserve' : 'budget_store_unavailable';
          break;
        }
        const task = tasks[state.taskIndex];
        const delay = Math.max(0, Number(state.lastProviderRequestAt || 0) + paceMs - now());
        if (delay) await wait(delay);
        state.lastProviderRequestAt = now();
        requests++;
        state.requests++;
        const response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST', signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': INDEX_FIELDS },
          body: JSON.stringify({
            textQuery: `${task.query || task.category.replaceAll('_', ' ')} in ${task.name.replaceAll('_', ' ')}, London`,
            pageSize: 20, rankPreference: 'DISTANCE', languageCode: 'en-GB',
            locationBias: { circle: { center: { latitude: task.lat, longitude: task.lng }, radius: 2600 } },
            ...(state.pageToken ? { pageToken: state.pageToken } : {}),
          }),
        });
        const data = await response.json();
        if (!response.ok || data.error) {
          failure = response.status === 429 || data.error?.status === 'RESOURCE_EXHAUSTED'
            ? 'quota_paused' : 'provider_unavailable';
          if (failure === 'quota_paused') {
            state.pauseReason = 'google_quota';
            state.quota = providerQuotaInfo(data.error, response.headers?.get?.('retry-after'));
          }
          break;
        }
        if (data.places != null && !Array.isArray(data.places)) {
          failure = 'provider_unavailable'; break;
        }
        const indexed = await indexPlaceIdentities(store, data.places || [], {
          now: now(), context: `${task.name}/${task.category}`, arrayUnion,
          requirePhoto,
          seedPlan: indexPlanId,
        });
        state.indexed += indexed;
        const coverageKey = `${task.name}/${task.category}`;
        const priorCoverage = state.categoryCoverage[coverageKey] || { pages: 0, observations: 0, indexed: 0 };
        state.categoryCoverage[coverageKey] = {
          pages: priorCoverage.pages + 1,
          observations: priorCoverage.observations + (data.places || []).length,
          indexed: priorCoverage.indexed + indexed,
          providerHasMore: !!data.nextPageToken,
        };
        // Sample one page by default, keeping budget for live discovery.
        // Optional deeper indexing never exceeds three pages per query.
        if (data.nextPageToken && state.page + 1 < pageLimit) {
          state.pageToken = data.nextPageToken;
          state.page++;
        } else {
          state.taskIndex++;
          state.page = 0;
          state.pageToken = '';
        }
        // Save progress after each successful provider page, so a later failure
        // does not discard completed pages. The lease owner is checked below.
        await store.runTransaction(async transaction => {
          const current = (await transaction.get(ref)).data();
          if (current?.owner !== owner) throw new Error('lease_changed');
          transaction.set(ref, { ...state, leaseUntil: now() + 90000 }, { merge: true });
        });
      }
    } catch {
      failure = 'temporarily_unavailable';
    } finally {
      state.status = state.taskIndex >= tasks.length ? 'complete' : failure || 'running';
      await store.runTransaction(async transaction => {
        const current = (await transaction.get(ref)).data();
        if (current?.owner === owner) transaction.set(ref, {
          ...state, leaseUntil: 0, updatedAt: now(), totalTasks: tasks.length,
        }, { merge: true });
      });
    }
    return {
      status: state.status, week: state.week, taskIndex: state.taskIndex,
      totalTasks: tasks.length, indexed: state.indexed, requests: state.requests,
      requestsThisChunk: requests, coverage: 'sampled_not_exhaustive',
      pauseReason: state.pauseReason, quota: state.quota,
      planId, categoriesQueried: Object.keys(state.categoryCoverage).length,
      categoriesWithoutPhotoCandidates: Object.values(state.categoryCoverage).filter(item => !item.indexed).length,
      ...(state.status === 'complete' ? {
        emptyCategories: Object.entries(state.categoryCoverage).filter(([, item]) => !item.indexed).map(([key]) => key),
      } : {}),
    };
  };
}
