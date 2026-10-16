import { randomUUID } from 'node:crypto';
import { LONDON_SEED_TASKS } from '../constants/london_clusters.js';

export const ID_COLLECTION = 'panda_london_place_ids_v1';
export const LOCATION_COLLECTION = 'panda_london_place_locations_v1';
export const JOB_COLLECTION = 'panda_london_seed_jobs_v1';
// Expire before the 30-day coordinate allowance; physical TTL cleanup is async.
export const LOCATION_TTL_MS = 29 * 24 * 60 * 60 * 1000;
export const INDEX_FIELDS = 'places.id,places.location,nextPageToken';

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

// This is an identity index, not a persistent copy of Google venue content.
// In particular it never owns partner tiers or stores names/photos/hours.
export async function indexPlaceIdentities(store, places, {
  now = Date.now(), context = 'live_discovery',
  arrayUnion = (...items) => items,
} = {}) {
  const valid = (Array.isArray(places) ? places : []).filter(place => {
    const lat = place.location?.latitude ?? place.lat;
    const lng = place.location?.longitude ?? place.lng;
    return typeof place.id === 'string' && /^[\w-]{1,256}$/.test(place.id)
      && Number.isFinite(lat) && Math.abs(lat) <= 90
      && Number.isFinite(lng) && Math.abs(lng) <= 180;
  });
  // Stay below Firestore's 500-write batch maximum.
  for (let offset = 0; offset < valid.length; offset += 200) {
    const batch = store.batch();
    for (const place of valid.slice(offset, offset + 200)) {
      batch.set(store.collection(ID_COLLECTION).doc(place.id), {
        place_id: place.id, last_indexed: new Date(now),
        searchContexts: arrayUnion(context), source: 'google_place_id',
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
  arrayUnion, tasks = LONDON_SEED_TASKS,
}) {
  return async ({ manual = false, maxRequests = 4 } = {}) => {
    if (!store || !apiKey) return { status: 'not_configured' };
    const clock = londonClock(new Date(now()));
    if (!manual && clock.hour !== 3) return { status: 'outside_schedule_window' };
    const ref = store.collection(JOB_COLLECTION).doc(clock.week);
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
        ...previous, owner, leaseUntil: now() + 90000, status: 'running', week: clock.week,
      };
      transaction.set(ref, state, { merge: true });
      return state;
    });
    if (lease.skip) return { ...lease, status: lease.skip, owner: undefined };
    const state = { ...lease };
    let requests = 0;
    let failure = null;
    try {
      while (state.taskIndex < tasks.length && requests < Math.min(4, Math.max(1, maxRequests))) {
        const dailyLimit = Math.max(1, Number.parseInt(process.env.PANDA_DAILY_PLACES_LIMIT || '500', 10) || 500);
        const reserve = Math.max(0, Math.min(dailyLimit,
          Number.parseInt(process.env.PANDA_SEED_CUSTOMER_RESERVE || String(Math.floor(dailyLimit / 2)), 10) || 0));
        // Background indexing must not consume all interactive discovery headroom.
        if (dailyLimit <= reserve) { failure = 'quota_paused'; break; }
        const allowance = await consumeBudget(store, 'places', dailyLimit - reserve);
        if (!allowance.allowed || allowance.shared !== true) {
          failure = !allowance.allowed ? 'quota_paused' : 'budget_unavailable';
          break;
        }
        const task = tasks[state.taskIndex];
        requests++;
        state.requests++;
        const response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST', signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': INDEX_FIELDS },
          body: JSON.stringify({
            textQuery: `${task.category.replaceAll('_', ' ')} in ${task.name.replaceAll('_', ' ')}, London`,
            pageSize: 20, rankPreference: 'DISTANCE', languageCode: 'en-GB',
            locationBias: { circle: { center: { latitude: task.lat, longitude: task.lng }, radius: 2600 } },
            ...(state.pageToken ? { pageToken: state.pageToken } : {}),
          }),
        });
        const data = await response.json();
        if (!response.ok || data.error) {
          failure = response.status === 429 || data.error?.status === 'RESOURCE_EXHAUSTED'
            ? 'quota_paused' : 'provider_unavailable';
          break;
        }
        if (data.places != null && !Array.isArray(data.places)) {
          failure = 'provider_unavailable'; break;
        }
        state.indexed += await indexPlaceIdentities(store, data.places || [], {
          now: now(), context: `${task.name}/${task.category}`, arrayUnion,
        });
        // Three pages maximum. A sampled search is not an exhaustive census.
        if (data.nextPageToken && state.page < 2) {
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
      status: state.status, week: clock.week, taskIndex: state.taskIndex,
      totalTasks: tasks.length, indexed: state.indexed, requests: state.requests,
      requestsThisChunk: requests, coverage: 'sampled_not_exhaustive',
    };
  };
}
