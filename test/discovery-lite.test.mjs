import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryService, DISCOVERY_FIELDS, DISCOVERY_NEARBY_FIELDS, DISCOVERY_TTL_MS, discoveryKey, discoveryRequest, sharedDiscoveryCacheApproved } from '../api/_discovery-lite.js';

test('shared Google-content cache stays off without explicit approval and an auditable reference', () => {
  assert.equal(sharedDiscoveryCacheApproved(), false);
  assert.equal(sharedDiscoveryCacheApproved({
    PANDA_GOOGLE_SHARED_DISCOVERY_CACHE_APPROVED: 'true',
  }), false);
  assert.equal(sharedDiscoveryCacheApproved({
    PANDA_GOOGLE_SHARED_DISCOVERY_CACHE_APPROVED: 'true',
    PANDA_GOOGLE_SHARED_DISCOVERY_CACHE_APPROVAL_REFERENCE: ' ',
  }), false);
  assert.equal(sharedDiscoveryCacheApproved({
    PANDA_GOOGLE_SHARED_DISCOVERY_CACHE_APPROVED: 'false',
    PANDA_GOOGLE_SHARED_DISCOVERY_CACHE_APPROVAL_REFERENCE: 'example-agreement',
  }), false);
  assert.equal(sharedDiscoveryCacheApproved({
    PANDA_GOOGLE_SHARED_DISCOVERY_CACHE_APPROVED: 'true',
    PANDA_GOOGLE_SHARED_DISCOVERY_CACHE_APPROVAL_REFERENCE: 'example-agreement',
  }), true);
});

function fakeStore() {
  const collections = new Map();
  const table = name => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  return {
    table,
    collection(name) {
      const rows = table(name);
      const conditions = [];
      const query = {
        doc(id) { return { name, id, async get() { return { exists: rows.has(id), data: () => rows.get(id) }; } }; },
        where(field, op, value) { conditions.push({field, op, value}); return query; },
        limit() { return query; },
        async get() {
          return { docs: [...rows].filter(([, data]) => conditions.every(c => c.op === '>=' ? data[c.field] >= c.value : data[c.field] <= c.value))
            .map(([id, data]) => ({ id, data: () => data })) };
        },
      };
      return query;
    },
    batch() {
      const writes = [];
      return {
        set(ref, data, options) { writes.push([ref, data, options]); },
        async commit() { for (const [ref, data, options] of writes) {
          table(ref.name).set(ref.id, options?.merge ? {...table(ref.name).get(ref.id), ...data} : data);
        } },
      };
    },
  };
}
const body = { query: 'restaurants', location: {lat: 51.48, lng: -0.13} };
const place = {
  id: 'ChIJtest', displayName: {text: 'A real restaurant'}, formattedAddress: 'London',
  location: {latitude: 51.481, longitude: -0.13}, primaryType: 'restaurant', types: ['restaurant'],
  photos: [{name: 'places/ChIJtest/photos/one', authorAttributions: [{displayName: 'Owner'}]},
    {name: 'places/ChIJtest/photos/two'}],
  rating: 4.8, currentOpeningHours: {openNow: true}, priceLevel: 'PRICE_LEVEL_MODERATE',
};
const allowed = async () => ({allowed: true, shared: true});
function setup(options = {}) {
  let calls = 0, last;
  const store = options.store || fakeStore();
  const search = createDiscoveryService({
    // Synthetic fixtures exercise the optional approved-cache implementation.
    // Production explicitly uses false; no agreement flag is enabled.
    persistFullContent: true,
    store, apiKey: 'test-only', consumeBudget: allowed, warn: () => {},
    fetchImpl: async (url, init) => {
      calls++; last = {url, init};
      const request = JSON.parse(init.body);
      const nearbyType = request.includedTypes?.[0];
      const responsePlace = nearbyType ? { ...place, primaryType: nearbyType, types: [nearbyType] } : place;
      return {ok: true, status: 200, json: async () => ({places: [responsePlace]})};
    },
    ...options,
  });
  return {search, store, calls: () => calls, last: () => last};
}

test('list requests exclude all expensive details, retain only a cover reference', async () => {
  assert.doesNotMatch(DISCOVERY_FIELDS, /rating|OpeningHours|reviews|priceLevel|websiteUri|editorialSummary/);
  const s = setup();
  const result = await s.search(body);
  assert.equal(s.calls(), 1);
  assert.equal(s.last().init.headers['X-Goog-FieldMask'], DISCOVERY_FIELDS);
  assert.equal(result.venues[0].photoCount, 1);
  assert.equal(result.venues[0].photoName, place.photos[0].name);
  assert.equal(result.venues[0].detailsDeferred, true);
  assert.equal(result.venues[0].rating, undefined);
  assert.equal(result.venues[0].openNow, undefined);
});
test('a second server instance reuses the shared location cache with zero Google calls', async () => {
  const first = setup();
  await first.search(body);
  const second = setup({store: first.store});
  const result = await second.search(body);
  assert.equal(second.calls(), 0);
  assert.equal(result.cached, true);
});
test('different locations and pages have separate cache keys', () => {
  const key = value => discoveryKey(discoveryRequest(value));
  assert.notEqual(key(body), key({...body, location: {lat: 53.48, lng: -2.24}}));
  assert.notEqual(key(body), key({...body, pageToken: 'page-two'}));
});
test('24-hour expiry triggers refresh; empty valid searches also cache', async () => {
  let clock = 1000000;
  const s = setup({now: () => clock});
  await s.search(body); clock += DISCOVERY_TTL_MS;
  await s.search(body);
  assert.equal(s.calls(), 2);
  let emptyCalls = 0;
  const empty = setup({fetchImpl: async () => {emptyCalls++; return {ok:true, json:async()=>({})};}});
  await empty.search(body); await empty.search(body);
  assert.equal(emptyCalls, 1);
});
test('quota fallback is local, excludes expired venues and does not call Google', async () => {
  const store = fakeStore(), ts = Date.now();
  const seed = (id, lat, lng, timestamp) => store.table('discovery_cover_venues_v1').set(id, {
    lat, lng, last_updated: timestamp, venue: {id, name:'Restaurant', lat, lng, type:'restaurant'},
  });
  seed('near',51.481,-0.13,ts);
  seed('other-city',53.48,-2.24,ts);
  seed('expired',51.481,-0.13,ts-DISCOVERY_TTL_MS);
  const s = setup({store, now: () => ts, consumeBudget: async()=>({allowed:false,current:500,limit:500})});
  const result = await s.search(body);
  assert.deepEqual(result.venues.map(v=>v.id), ['near']);
  assert.equal(s.calls(), 0);
  assert.equal(result.quotaExceeded, true);
});
for (const status of [429, 403]) {
  test(`provider ${status} RESOURCE_EXHAUSTED invokes fallback, not an empty success cache`, async () => {
    const s = setup({fetchImpl:async()=>({ok:false,status,json:async()=>({error:{status:'RESOURCE_EXHAUSTED'}})})});
    const result = await s.search(body);
    assert.equal(result.quotaExceeded,true);
    assert.equal(s.store.table('discovery_cover_searches_v1').size,0);
    assert.equal(result.dataMode,'unavailable');
  });
}
test('concurrent same-location misses share one provider request in an instance', async () => {
  const s = setup();
  await Promise.all([s.search(body), s.search(body), s.search(body)]);
  assert.equal(s.calls(),1);
});
test('invalid locations and a bad batch are rejected before any paid calls', async () => {
  const s = setup();
  await assert.rejects(s.search({...body,location: {lat: 99,lng: 0}}), /location/);
  await assert.rejects(s.search({...body,queries:['restaurants','']}), /query/);
  assert.equal(s.calls(),0);
});
test('batch preserves query evidence and deduplicates venues', async () => {
  const s = setup();
  const result = await s.search({...body,query:undefined,queries:['restaurants','italian restaurants']});
  assert.equal(result.venues.length,1);
  assert.deepEqual(result.venues[0].sourceQueries,['restaurants','italian restaurants']);
});
test('unavailable distributed budget storage never sends an unmetered request', async () => {
  const s = setup({consumeBudget:async()=>({allowed:true,shared:false})});
  const result = await s.search(body);
  assert.equal(s.calls(),0);
  assert.equal(result.fallbackReason,'budget_storage_unavailable');
});

test('typed Nearby Search uses one valid includedTypes request and a cover-only field mask', async () => {
  assert.doesNotMatch(DISCOVERY_NEARBY_FIELDS, /nextPageToken|rating|openingHours|reviews|priceLevel/);
  const s = setup();
  const result = await s.search({ ...body, searchMode: 'nearby', includedTypes: ['pub', 'bar', 'beer_garden'] });
  assert.equal(s.calls(), 1);
  assert.match(s.last().url, /places:searchNearby$/);
  const request = JSON.parse(s.last().init.body);
  assert.deepEqual(request.includedTypes, ['pub', 'bar', 'beer_garden']);
  assert.equal(request.maxResultCount, 20);
  assert.equal(request.locationRestriction.circle.radius, 6000);
  assert.equal(request.textQuery, undefined);
  assert.equal(s.last().init.headers['X-Goog-FieldMask'], DISCOVERY_NEARBY_FIELDS);
  assert.equal(result.nextPageToken, null);
});
test('Nearby Search validates type lists and cannot take Text Search page tokens', async () => {
  const s = setup();
  await assert.rejects(s.search({ ...body, searchMode: 'nearby' }), /includedTypes/);
  await assert.rejects(s.search({ ...body, searchMode: 'nearby', includedTypes: ['pub'], pageToken: 'x' }), /page tokens/);
  await assert.rejects(s.search({ ...body, searchMode: 'nearby', includedTypes: ['pub;bad'] }), /valid Google place types/);
  await assert.rejects(s.search({ ...body, includedTypes: ['pub', 'bar'] }), /Text Search accepts one includedType/);
  assert.equal(s.calls(), 0);
});
test('discovery cache keys distinguish type-fallback categories', () => {
  const key = value => discoveryKey(discoveryRequest(value));
  assert.notEqual(key({ ...body, searchMode: 'nearby', includedTypes: ['pub'] }),
    key({ ...body, searchMode: 'nearby', includedTypes: ['sports_complex'] }));
  assert.notEqual(key(body), key({ ...body, searchMode: 'nearby', includedTypes: ['pub'] }));
});
