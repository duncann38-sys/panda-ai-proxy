import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVenueDirectoryLoader,
  normalizeOsmVenue,
  normalizeOsmVenues,
  VENUE_DIRECTORY_MAX_RECORDS,
  VENUE_DIRECTORY_TTL_MS,
  venueDirectoryArea,
} from '../api/_venue-directory.js';

function fakeStore() {
  const documents = new Map();
  const queueByKey = new Map();

  function documentRef(key) {
    return {
      key,
      async get() {
        const value = documents.get(key);
        return { exists: value !== undefined, data: () => value };
      },
    };
  }

  return {
    documents,
    collection() {
      return { doc: documentRef };
    },
    async runTransaction(callback) {
      const writes = [];
      let release;
      const key = 'venue-area-index';
      const previous = queueByKey.get(key) || Promise.resolve();
      const current = new Promise((resolve) => { release = resolve; });
      queueByKey.set(key, previous.then(() => current));
      await previous;
      const transaction = {
        async get(ref) {
          const value = documents.get(ref.key);
          return { exists: value !== undefined, data: () => value };
        },
        set(ref, value, options = {}) {
          writes.push({ key: ref.key, value, merge: options.merge === true });
        },
      };
      try {
        const result = await callback(transaction);
        for (const write of writes) {
          const next = write.merge
            ? { ...(documents.get(write.key) || {}), ...write.value }
            : write.value;
          documents.set(write.key, next);
        }
        return result;
      } finally {
        release();
      }
    },
  };
}

function listing(id = 42, extraTags = {}) {
  return {
    type: 'node',
    id,
    lat: 51.51,
    lon: -0.13,
    tags: {
      amenity: 'pub',
      name: 'The Example',
      'addr:housenumber': '5',
      'addr:street': 'High Street',
      'addr:city': 'London',
      ...extraTags,
    },
  };
}

function response(elements) {
  return { ok: true, async json() { return { elements }; } };
}

test('area keys share nearby coordinates in an approximately two-kilometre grid', () => {
  const first = venueDirectoryArea(51.5, -0.14);
  const nearby = venueDirectoryArea(51.501, -0.139);
  const nextCell = venueDirectoryArea(51.53, -0.14);

  assert.ok(first);
  assert.equal(first.key, nearby.key);
  assert.notEqual(first.key, nextCell.key);
  assert.equal(venueDirectoryArea(91, 0), null);
  assert.equal(venueDirectoryArea(0, Number.NaN), null);
});

test('OSM normalization preserves provenance and does not invent photos, ratings, or hours', () => {
  const venue = normalizeOsmVenue(listing());

  assert.equal(venue.id, 'osm:node:42');
  assert.equal(venue.name, 'The Example');
  assert.equal(venue.address, '5, High Street, London');
  assert.equal(venue.source, 'OpenStreetMap');
  assert.equal(venue.sourceLicense, 'ODbL-1.0');
  assert.equal(venue.attribution, '© OpenStreetMap contributors');
  assert.equal(venue.sourceUrl, 'https://www.openstreetmap.org/node/42');
  for (const absent of ['photoName', 'photoCount', 'rating', 'openingHours', 'openNow', 'hours']) {
    assert.equal(Object.hasOwn(venue, absent), false);
  }
  assert.equal(normalizeOsmVenue(listing(43, { amenity: 'bank' })), null);
  assert.equal(normalizeOsmVenue({ ...listing(44), tags: { amenity: 'pub' } }), null);
  const restaurant = normalizeOsmVenue(listing(45, { amenity: 'restaurant', cuisine: 'italian;pizza' }));
  assert.deepEqual(restaurant.categories, ['Italian', 'Pizza']);
  const shop = normalizeOsmVenue(listing(46, { amenity: undefined, shop: 'wine', website: 'javascript:alert(1)' }));
  assert.deepEqual(shop.categories, ['Shops']);
  assert.equal(shop.website, '');
  const museum = normalizeOsmVenue(listing(47, { amenity: undefined, tourism: 'museum' }));
  assert.deepEqual(museum.categories, ['Places of Interest']);
});

test('OSM normalization deduplicates venues and enforces the record cap', () => {
  const records = Array.from({ length: VENUE_DIRECTORY_MAX_RECORDS + 10 }, (_, index) => listing(index + 1));
  records.push(listing(1, { name: 'Duplicate record' }));

  const venues = normalizeOsmVenues(records);
  assert.equal(venues.length, VENUE_DIRECTORY_MAX_RECORDS);
  assert.equal(venues[0].name, 'The Example');
});

test('a shared area result is reused for three hours, then refreshed', async () => {
  const store = fakeStore();
  let time = 1_000_000;
  let providerCalls = 0;
  const loader = createVenueDirectoryLoader({
    now: () => time,
    fetchImpl: async (_url, options) => {
      providerCalls += 1;
      assert.equal(options.method, 'POST');
      assert.match(String(options.body), /around%3A2600/);
      return response([listing()]);
    },
  });

  const first = await loader.load(store, 51.5, -0.14);
  const sameArea = await loader.load(store, 51.501, -0.139);
  assert.equal(providerCalls, 1);
  assert.equal(first.directory.stale, false);
  assert.equal(sameArea.directoryVenues[0].id, 'osm:node:42');

  time += VENUE_DIRECTORY_TTL_MS;
  const refreshed = await loader.load(store, 51.5, -0.14);
  assert.equal(providerCalls, 2);
  assert.equal(refreshed.directory.stale, false);
});

test('two independent loaders share one Firestore refresh lease for a new area', async () => {
  const store = fakeStore();
  let providerCalls = 0;
  let finishFetch;
  const fetchImpl = async () => {
    providerCalls += 1;
    await new Promise((resolve) => { finishFetch = resolve; });
    return response([listing()]);
  };
  const options = {
    fetchImpl,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    waitMs: 1_000,
    pollMs: 1,
  };
  const firstLoader = createVenueDirectoryLoader(options);
  const secondLoader = createVenueDirectoryLoader(options);
  const firstRequest = firstLoader.load(store, 51.5, -0.14);
  while (providerCalls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const secondRequest = secondLoader.load(store, 51.501, -0.139);

  assert.equal(providerCalls, 1);
  finishFetch();
  const [first, second] = await Promise.all([firstRequest, secondRequest]);
  assert.equal(providerCalls, 1);
  assert.equal(first.directoryVenues[0].id, second.directoryVenues[0].id);
  assert.equal(first.directory.updatedAt, second.directory.updatedAt);
});

test('an expired refresh owner returns the winner instead of an uncommitted result', async () => {
  const store = fakeStore();
  let time = 2_000_000;
  let calls = 0;
  let releaseFirst;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => { releaseFirst = resolve; });
      return response([listing(1)]);
    }
    return response([listing(2)]);
  };
  const first = createVenueDirectoryLoader({ fetchImpl, now: () => time }).load(store, 51.5, -0.14);
  while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  time += 31_000;
  const second = await createVenueDirectoryLoader({ fetchImpl, now: () => time }).load(store, 51.5, -0.14);
  releaseFirst();
  const firstResult = await first;
  assert.equal(second.directoryVenues[0].id, 'osm:node:2');
  assert.equal(firstResult.directoryVenues[0].id, 'osm:node:2');
  assert.equal(calls, 2);
});

test('a failed Overpass refresh serves previously stored OSM data as stale', async () => {
  const store = fakeStore();
  let time = 2_000_000;
  const loader = createVenueDirectoryLoader({
    now: () => time,
    fetchImpl: async () => response([listing()]),
  });
  const initial = await loader.load(store, 51.5, -0.14);
  time += VENUE_DIRECTORY_TTL_MS;

  const failingLoader = createVenueDirectoryLoader({
    now: () => time,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  const fallback = await failingLoader.load(store, 51.5, -0.14);

  assert.equal(initial.directory.stale, false);
  assert.equal(fallback.directory.stale, true);
  assert.equal(fallback.directoryVenues[0].source, 'OpenStreetMap');
  assert.equal(fallback.directoryVenues[0].photoCount, undefined);
});

test('an empty local area widens once before declaring it empty', async () => {
  const radii = [];
  const loader = createVenueDirectoryLoader({
    fetchImpl: async (_url, options) => {
      const body = String(options.body);
      radii.push(body.includes('around%3A8000') ? 8_000 : 2_600);
      return response(radii.length === 1 ? [] : [listing()]);
    },
  });
  const result = await loader.load(fakeStore(), 51.5, -0.14);
  assert.deepEqual(radii, [2_600, 8_000]);
  assert.equal(result.directoryVenues[0].name, 'The Example');
});

test('an upstream outage has a shared cooldown rather than retrying for every visitor', async () => {
  const store = fakeStore();
  let time = 2_000_000;
  let calls = 0;
  const failing = createVenueDirectoryLoader({
    now: () => time,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 503 };
    },
  });
  await assert.rejects(failing.load(store, 51.5, -0.14), { code: 'venue_directory_unavailable' });
  await assert.rejects(failing.load(store, 51.5, -0.14), { code: 'venue_directory_unavailable' });
  assert.equal(calls, 1);

  time += 16 * 60 * 1000;
  const recovered = createVenueDirectoryLoader({ now: () => time, fetchImpl: async () => {
    calls += 1;
    return response([listing()]);
  } });
  const result = await recovered.load(store, 51.5, -0.14);
  assert.equal(result.directoryVenues.length, 1);
  assert.equal(calls, 2);
});

test('directory requests fail explicitly instead of making an unshared upstream request', async () => {
  let providerCalls = 0;
  const loader = createVenueDirectoryLoader({
    fetchImpl: async () => {
      providerCalls += 1;
      return response([]);
    },
  });

  await assert.rejects(loader.load(null, 51.5, -0.14), { code: 'venue_directory_unavailable' });
  await assert.rejects(loader.load(fakeStore(), Number.NaN, -0.14), { code: 'location_required' });
  assert.equal(providerCalls, 0);
});
