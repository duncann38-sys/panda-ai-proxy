import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { testStore } from './index-store-fixture.mjs';
import {
  ID_COLLECTION, LOCATION_COLLECTION, JOB_COLLECTION, LOCATION_TTL_MS, INDEX_FIELDS,
  MAX_INDEXED_FEED_PAGE_SIZE,
  createLondonSeeder, indexPlaceIdentities, nearbyPlaceIdentities, nearbySeededPlacePage,
  londonClock, indexedVenueBaseline, providerQuotaInfo,
} from '../api/_london-index.js';
import {
  ACTIVE_LONDON_SEED_PLAN, ACTIVE_LONDON_SEED_TASKS, LEGACY_PANDA_CATEGORIES,
  FOCUS_CLUSTERS, FOCUS_SEED_PLAN, FOCUS_SEED_TASKS,
  LONDON_CLUSTERS, LONDON_SEED_PLAN, PANDA_CATEGORIES, LONDON_SEED_TASKS,
} from '../constants/london_clusters.js';
import {
  verifySeedJob, SEED_AUDIENCE, SEED_SUBJECT, TAXONOMY_WORKFLOW,
} from '../api/_seed-job-auth.js';
import { createDiscoveryService } from '../api/_discovery-lite.js';
import { readCategoryCoverage } from '../api/_index-progress.js';

const now = Date.parse('2026-10-18T02:00:00Z'); // Sunday 03:00 London BST
const point = { id: 'ChIJunit', location: { latitude: 51.48, longitude: -0.14 } };
const allowance = async () => ({ allowed: true, shared: true });
const task = { name: 'battersea_nine_elms', lat: 51.48, lng: -0.14, category: 'restaurant' };
function seedFixture(extra = {}) {
  const store = extra.store || testStore();
  let calls = 0;
  const seed = createLondonSeeder({
    store, apiKey: 'test-only', now: () => now, tasks: [task],
    consumeBudget: allowance, paceMs: 0,
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.headers['X-Goog-FieldMask'], INDEX_FIELDS);
      return { ok: true, status: 200, json: async () => ({ places: [point] }) };
    }, ...extra,
  });
  return { store, seed, calls: () => calls };
}
test('retired categories disappear while the existing index plan remains stable', () => {
  assert.equal(LONDON_CLUSTERS.length, 23);
  assert.equal(FOCUS_CLUSTERS.length, 5);
  assert.equal(LEGACY_PANDA_CATEGORIES.length, 33);
  assert.equal(PANDA_CATEGORIES.length, 30);
  assert.deepEqual(PANDA_CATEGORIES.filter(category => ['Dessert', 'Brunch', 'Clubs'].includes(category)), []);
  assert.equal(LONDON_SEED_TASKS.length, 594);
  assert.equal(new Set(LONDON_SEED_TASKS.map(t => `${t.name}/${t.category}`)).size, 594);
  assert.equal(ACTIVE_LONDON_SEED_TASKS.length, 540);
  assert.ok(ACTIVE_LONDON_SEED_PLAN.startsWith('google-photo-active-'));
  assert.equal(LONDON_SEED_PLAN, 'google-photo-719bfbae5546');
  assert.equal(FOCUS_SEED_TASKS.length, 150);
  assert.equal(new Set(FOCUS_SEED_TASKS.map(t => `${t.name}/${t.category}`)).size, 150);
  assert.deepEqual(FOCUS_CLUSTERS.map(cluster => cluster.name),
    ['battersea', 'nine_elms', 'chelsea', 'victoria', 'clapham']);
  assert.ok(FOCUS_SEED_PLAN.startsWith('google-photo-focus-'));
  assert.doesNotMatch(INDEX_FIELDS, /displayName|formattedAddress|rating|currentOpeningHours/);
  assert.match(INDEX_FIELDS, /places.photos.name/);
});
test('focus-area pages add IDs under the existing feed plan with a separate resumable job', async () => {
  const focusPoint = {
    ...point,
    photos: [{ name: `places/${point.id}/photos/cover` }],
  };
  const s = seedFixture({
    tasks: [{ ...task, name: 'battersea' }],
    planId: FOCUS_SEED_PLAN,
    indexPlanId: LONDON_SEED_PLAN,
    requirePhoto: true,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ places: [focusPoint] }) }),
  });
  const result = await s.seed({ manual: true });
  assert.equal(result.status, 'complete');
  const identity = s.store.table(ID_COLLECTION).get(point.id);
  assert.equal(identity.seed_plan, LONDON_SEED_PLAN);
  assert.deepEqual(identity.searchContexts, ['battersea/restaurant']);
  assert.ok(s.store.table(JOB_COLLECTION).has(`2026-10-18_${FOCUS_SEED_PLAN}`));
});
test('a one-time explicit seeder reserve override leaves the rest of the daily budget available', async () => {
  const store = testStore();
  const limits = [];
  const seed = createLondonSeeder({
    store, apiKey: 'test-only', now: () => now, tasks: [task],
    dailyRequestLimit: () => 1000, customerReserve: 500, customerReserveOverride: 356,
    paceMs: 0,
    consumeBudget: async (_store, _kind, limit) => {
      limits.push(limit);
      return { allowed: true, shared: true };
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ places: [] }) }),
  });
  assert.equal((await seed({ manual: true })).status, 'complete');
  assert.deepEqual(limits, [644]);
});
test('index writes whitelist IDs/coordinates and never overwrite paid records', async () => {
  const store = testStore();
  store.table('partner_venues').set(point.id, { tier: 'banging', active: true });
  await indexPlaceIdentities(store, [{
    ...point, name: 'Do not persist', photos: ['do not persist'], tier: 'Free',
  }], { now });
  assert.equal(store.table('partner_venues').get(point.id).tier, 'banging');
  const id = store.table(ID_COLLECTION).get(point.id);
  assert.deepEqual(Object.keys(id).sort(), ['last_indexed', 'place_id', 'searchContexts', 'source']);
  const location = store.table(LOCATION_COLLECTION).get(point.id);
  assert.equal(location.expiresAt.getTime(), now + LOCATION_TTL_MS);
  assert.equal(id.expiresAt, undefined);
  assert.equal(JSON.stringify([...store.table(ID_COLLECTION).values()]).includes('Do not persist'), false);
});
test('malformed coordinates and injected document paths are rejected', async () => {
  const store = testStore();
  assert.equal(await indexPlaceIdentities(store, [
    { ...point, id: '../partner_venues' },
    { ...point, location: { latitude: 300, longitude: 0 } },
  ]), 0);
  assert.equal(store.table(ID_COLLECTION).size, 0);
});
test('limited profile fallback preserves active paid tier and never invents hours or photos', async () => {
  const store = testStore();
  await indexPlaceIdentities(store, [point], { now });
  store.table('partner_venues').set(point.id, { tier: 'banging', active: true, name: 'Partner name' });
  const profile = await indexedVenueBaseline(store, point.id, now);
  assert.equal(profile.partnerTier, 'banging');
  assert.equal(profile.openNow, null);
  assert.deepEqual(profile.photoNames, []);
  assert.equal(profile.name, 'Partner name');
  assert.equal(profile.limited, true);
  assert.equal(await indexedVenueBaseline(store, 'unknown', now), null);
  store.table('partner_venues').set(point.id, { tier: 'discovery', active: false });
  assert.equal((await indexedVenueBaseline(store, point.id, now)).partnerTier, undefined);
});
test('indexed discovery returns nearby category IDs in small pages and skips expired or unseeded records', async () => {
  const store = testStore();
  const origin = { lat: 51.4791, lng: -0.1420 };
  const indexed = [
    ['near-one', 51.4795, -0.1422, ['battersea_nine_elms/All'], LONDON_SEED_PLAN],
    ['near-two', 51.4800, -0.1415, ['battersea_nine_elms/All'], LONDON_SEED_PLAN],
    ['wrong-category', 51.4801, -0.1414, ['battersea_nine_elms/Pubs'], LONDON_SEED_PLAN],
    ['expired', 51.4802, -0.1413, ['battersea_nine_elms/All'], LONDON_SEED_PLAN],
    ['wrong-plan', 51.4803, -0.1412, ['battersea_nine_elms/All'], 'old-plan'],
  ];
  for (const [id, lat, lng, contexts, seedPlan] of indexed) {
    store.table(ID_COLLECTION).set(id, {
      place_id: id, searchContexts: contexts, seed_plan: seedPlan,
      primary_photo_path: `/api/partner/venues/${id}/photos/0/image`,
    });
    store.table(LOCATION_COLLECTION).set(id, {
      place_id: id, lat, lng,
      expiresAt: new Date(now + (id === 'expired' ? -1000 : LOCATION_TTL_MS)),
    });
  }
  const first = await nearbySeededPlacePage(store, {
    ...origin, category: 'All', radius: 5000, pageSize: 1,
  }, now);
  assert.equal(first.identities.length, 1);
  assert.equal(first.identities[0].place_id, 'near-one');
  assert.ok(first.nextCursor);

  const second = await nearbySeededPlacePage(store, {
    ...origin, category: 'All', radius: 5000, pageSize: 1, cursor: first.nextCursor,
  }, now);
  assert.equal(second.identities.length, 1);
  assert.equal(second.identities[0].place_id, 'near-two');
  assert.notEqual(second.identities[0].place_id, first.identities[0].place_id);
});
test('category discovery returns a full 200-ID page and continues with the next stored IDs', async () => {
  const store = testStore();
  const seedContext = (clusterName, count, base) => {
    const cluster = LONDON_CLUSTERS.find(item => item.name === clusterName);
    assert.ok(cluster, `missing test cluster ${clusterName}`);
    for (let index = 0; index < count; index += 1) {
      const id = `${base}-${String(index).padStart(3, '0')}`;
      store.table(ID_COLLECTION).set(id, {
        place_id: id, searchContexts: [`${clusterName}/Italian`], seed_plan: LONDON_SEED_PLAN,
        primary_photo_path: `/api/partner/venues/${id}/photos/0/image`,
      });
      store.table(LOCATION_COLLECTION).set(id, {
        place_id: id, lat: cluster.lat, lng: cluster.lng, expiresAt: new Date(now + LOCATION_TTL_MS),
      });
    }
  };
  seedContext('battersea', 100, 'bat');
  seedContext('chelsea', 100, 'che');
  seedContext('nine_elms', 100, 'nine');
  const origin = LONDON_CLUSTERS.find(item => item.name === 'battersea');
  assert.equal(MAX_INDEXED_FEED_PAGE_SIZE, 200);
  const first = await nearbySeededPlacePage(store, {
    lat: origin.lat, lng: origin.lng, radius: 10_000, category: 'Italian', pageSize: 200,
  }, now);
  assert.equal(first.identities.length, 200);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.identities.map(item => item.distanceMeters),
    [...first.identities].map(item => item.distanceMeters).sort((a, b) => a - b));
  const second = await nearbySeededPlacePage(store, {
    lat: origin.lat, lng: origin.lng, radius: 10_000, category: 'Italian', pageSize: 200, cursor: first.nextCursor,
  }, now);
  assert.equal(second.identities.length, 100);
  assert.equal(new Set([...first.identities, ...second.identities].map(item => item.place_id)).size, 300);
});

test('category coverage audit flags 200 search-context candidates without claiming Google type verification', async () => {
  const store = testStore();
  const cluster = LONDON_CLUSTERS.find(item => item.name === 'battersea');
  for (let index = 0; index < 200; index += 1) {
    const id = `italian-${index}`;
    store.table(ID_COLLECTION).set(id, {
      place_id: id, searchContexts: ['battersea/Italian'], seed_plan: LONDON_SEED_PLAN,
      primary_photo_path: `/api/partner/venues/${id}/photos/0/image`,
    });
    store.table(LOCATION_COLLECTION).set(id, {
      place_id: id, lat: cluster.lat, lng: cluster.lng, expiresAt: new Date(now + LOCATION_TTL_MS),
    });
  }
  const report = await readCategoryCoverage(store, now);
  const italian = report.categories.find(item => item.category === 'Italian');
  assert.equal(report.targetPerCategory, 200);
  assert.equal(report.categories.length, 29);
  assert.equal(italian.storedIdCount, 200);
  assert.equal(italian.feedReadyIdCount, 200);
  assert.match(report.coverageBasis, /does not verify live Google types/);
  assert.ok(!report.categories.some(item => ['Dessert', 'Brunch', 'Clubs'].includes(item.category)));
});
test('category discovery excludes indexed candidates outside the requested walking radius', async () => {
  const store = testStore();
  const cluster = LONDON_CLUSTERS.find(item => item.name === 'battersea');
  for (const [id, lat] of [['close-pub', cluster.lat], ['far-pub', cluster.lat + 0.05]]) {
    store.table(ID_COLLECTION).set(id, {
      place_id: id, searchContexts: ['battersea/Pubs'], seed_plan: LONDON_SEED_PLAN,
    });
    store.table(LOCATION_COLLECTION).set(id, {
      place_id: id, lat, lng: cluster.lng, expiresAt: new Date(now + LOCATION_TTL_MS),
    });
  }
  const result = await nearbySeededPlacePage(store, {
    lat: cluster.lat, lng: cluster.lng, radius: 3_200, category: 'Pubs', pageSize: 200,
  }, now);
  assert.deepEqual(result.identities.map(item => item.place_id), ['close-pub']);
});
test('Mayfair category expansion returns the nearest indexed central venues first', async () => {
  const store = testStore();
  const seedContext = (clusterName, count, base) => {
    const cluster = LONDON_CLUSTERS.find(item => item.name === clusterName);
    assert.ok(cluster, `missing test cluster ${clusterName}`);
    for (let index = 0; index < count; index += 1) {
      const id = `${base}-${String(index).padStart(3, '0')}`;
      store.table(ID_COLLECTION).set(id, {
        place_id: id, searchContexts: [`${clusterName}/Coffee`],
        seed_plan: LONDON_SEED_PLAN,
      });
      store.table(LOCATION_COLLECTION).set(id, {
        place_id: id, lat: cluster.lat, lng: cluster.lng,
        expiresAt: new Date(now + LOCATION_TTL_MS),
      });
    }
  };
  seedContext('mayfair_marylebone', 40, 'mayfair');
  seedContext('soho_covent_garden', 40, 'soho');
  seedContext('chelsea_kensington', 40, 'knightsbridge-proxy');
  const origin = LONDON_CLUSTERS.find(item => item.name === 'mayfair_marylebone');
  const first = await nearbySeededPlacePage(store, {
    lat: origin.lat, lng: origin.lng, radius: 10_000,
    category: 'Coffee', pageSize: 200,
  }, now);
  assert.equal(first.identities.length, 120);
  assert.deepEqual(first.identities[0].searchContexts, ['mayfair_marylebone/Coffee']);
  assert.equal(first.indexExhausted, true);
  assert.deepEqual(first.identities.map(item => item.distanceMeters),
    [...first.identities].map(item => item.distanceMeters).sort((a, b) => a - b));

});
test('a combined Battersea/Nine Elms focus cluster resolves to the nearest neighbourhood first', async () => {
  const store = testStore();
  for (const name of ['battersea', 'nine_elms']) {
    const cluster = LONDON_CLUSTERS.find(item => item.name === name);
    const id = `${name}-first`;
    store.table(ID_COLLECTION).set(id, {
      place_id: id,
      searchContexts: [`${name}/Pubs`],
      seed_plan: LONDON_SEED_PLAN,
    });
    store.table(LOCATION_COLLECTION).set(id, {
      place_id: id,
      lat: cluster.lat,
      lng: cluster.lng,
      expiresAt: new Date(now + LOCATION_TTL_MS),
    });
  }
  const focus = LONDON_CLUSTERS.find(item => item.name === 'battersea_nine_elms');
  const page = await nearbySeededPlacePage(store, {
    lat: focus.lat,
    lng: focus.lng,
    radius: 500,
    category: 'Pubs',
    pageSize: 1,
  }, now);
  assert.equal(page.identities[0].place_id, 'nine_elms-first');
  assert.equal(page.identities[0].clusterName, 'nine_elms');
});
test('one seed page is checkpointed and a completed round is idempotent', async () => {
  const s = seedFixture();
  assert.equal((await s.seed()).status, 'complete');
  assert.equal((await s.seed()).status, 'complete');
  assert.equal(s.calls(), 1);
  assert.equal(s.store.table(JOB_COLLECTION).get('2026-10-18').leaseUntil, 0);
});
test('quota pause sends no provider requests and resumes the same task', async () => {
  const store = testStore();
  const blocked = seedFixture({ store, consumeBudget: async () => ({ allowed: false, shared: true }) });
  const result = await blocked.seed();
  assert.equal(result.status, 'quota_paused');
  assert.equal(result.taskIndex, 0);
  assert.equal(blocked.calls(), 0);
  const resumed = seedFixture({ store });
  assert.equal((await resumed.seed()).status, 'complete');
});
test('seed fails closed when shared budget enforcement is unavailable', async () => {
  const s = seedFixture({ consumeBudget: async () => ({ allowed: true, shared: false }) });
  assert.equal((await s.seed()).status, 'budget_unavailable');
  assert.equal(s.calls(), 0);
});
test('background seeding reserves half the default shared budget for customers', async () => {
  let configured;
  const s = seedFixture({ consumeBudget: async (_store, _kind, limit) => {
    configured = limit; return { allowed: true, shared: true };
  } });
  await s.seed();
  assert.equal(configured, 250);
});
test('HTTP 200 quota error preserves task cursor and releases lease', async () => {
  const s = seedFixture({ fetchImpl: async () => ({
    ok: true, status: 200, json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED' } }),
  }) });
  const result = await s.seed();
  assert.equal(result.status, 'quota_paused');
  assert.equal(result.taskIndex, 0);
  assert.equal(s.store.table(JOB_COLLECTION).get('2026-10-18').leaseUntil, 0);
});
test('pagination is bounded to three pages and continues across chunks', async () => {
  let calls = 0;
  const s = seedFixture({ pagesPerQuery: 3, fetchImpl: async () => ({
    ok: true, status: 200, json: async () => ({
      places: [point], nextPageToken: `page-${++calls}`,
    }),
  }) });
  assert.equal((await s.seed({ maxRequests: 1 })).status, 'running');
  assert.equal((await s.seed({ maxRequests: 1 })).status, 'running');
  assert.equal((await s.seed({ maxRequests: 1 })).status, 'complete');
  assert.equal(calls, 3);
});
test('default indexing samples one page rather than spending three requests per query', async () => {
  const s = seedFixture({ fetchImpl: async () => ({
    ok: true, json: async () => ({ places: [point], nextPageToken: 'more' }),
  }) });
  const result = await s.seed();
  assert.equal(result.status, 'complete');
  assert.equal(result.requests, 1);
});
test('background requests are paced across provider pages', async () => {
  const delays = [];
  const s = seedFixture({ pagesPerQuery: 3, paceMs: 3000, wait: async ms => { delays.push(ms); },
    fetchImpl: async () => ({ ok: true, json: async () => ({ places: [point], nextPageToken: 'more' }) }) });
  await s.seed();
  assert.deepEqual(delays, [3000, 3000]);
});
test('resuming a previous deeper cursor does not repeat a sampled first page', async () => {
  const s = seedFixture();
  s.store.table(JOB_COLLECTION).set('2026-10-18', { taskIndex: 0, page: 1, pageToken: 'next', requests: 1 });
  assert.equal((await s.seed()).status, 'complete');
  assert.equal(s.calls(), 0);
});
test('a morning attempt resumes an unfinished previous week instead of restarting', async () => {
  const s = seedFixture({ now: () => Date.parse('2026-10-18T08:00:00Z') });
  s.store.table(JOB_COLLECTION).set('2026-10-11',
    { taskIndex: 0, page: 0, indexed: 12, requests: 7, status: 'quota_paused' });
  const result = await s.seed({ manual: false });
  assert.equal(result.week, '2026-10-11');
  assert.equal(result.status, 'complete');
  assert.equal(result.requests, 8);
  assert.equal(s.store.table(JOB_COLLECTION).has('2026-10-18'), false);
});
test('quota diagnostics distinguish Google minute/day limits without retaining consumer details', () => {
  const info = providerQuotaInfo({ details: [{ metadata: {
    quota_unit: '1/min/{project}', quota_limit: 'SearchTextRequestsPerMinutePerProject',
    quota_limit_value: '33', consumer: 'do-not-retain',
  } }] }, '1');
  assert.equal(info.period, 'minute');
  assert.equal(info.retryAfterSeconds, 65);
  assert.equal(info.consumer, undefined);
  assert.equal(providerQuotaInfo({ details: [{ metadata: { quota_unit: '1/d/{project}' } }] }).period, 'day');
  assert.equal(providerQuotaInfo({}).period, 'unknown');
});
test('another live lease prevents duplicate seed work', async () => {
  const s = seedFixture();
  s.store.table(JOB_COLLECTION).set('2026-10-18', { leaseUntil: now + 1000 });
  assert.equal((await s.seed()).status, 'busy');
  assert.equal(s.calls(), 0);
});
test('London local 03:00 scheduling handles summer and winter', async () => {
  assert.equal(londonClock(new Date('2026-07-19T02:00:00Z')).hour, 3);
  assert.equal(londonClock(new Date('2026-12-20T03:00:00Z')).hour, 3);
  const s = seedFixture({ now: () => Date.parse('2026-10-18T03:00:00Z') });
  assert.equal((await s.seed()).status, 'outside_schedule_window');
  assert.equal(s.calls(), 0);
});
test('focused area schedule starts at its own London hour and skips completed daily retries', async () => {
  const store = testStore();
  const sunday = seedFixture({
    store, now: () => Date.parse('2026-10-18T03:00:00Z'), scheduleHours: [4],
  });
  assert.equal(londonClock(new Date(Date.parse('2026-10-18T03:00:00Z'))).hour, 4);
  assert.equal((await sunday.seed({ manual: false })).status, 'complete');
  const monday = seedFixture({
    store, now: () => Date.parse('2026-10-19T03:00:00Z'), scheduleHours: [4],
  });
  assert.equal((await monday.seed({ manual: false })).status, 'complete');
  assert.equal(monday.calls(), 0);
  const wrongHour = seedFixture({
    now: () => Date.parse('2026-10-18T04:00:00Z'), scheduleHours: [4],
  });
  assert.equal((await wrongHour.seed({ manual: false })).status, 'outside_schedule_window');
  assert.equal(wrongHour.calls(), 0);
  assert.equal(londonClock(new Date(Date.parse('2026-10-25T04:00:00Z'))).hour, 4);
});
test('new scheduled rounds do not start on a weekday, but manual runs can', async () => {
  const s = seedFixture({ now: () => Date.parse('2026-10-19T02:00:00Z') });
  assert.equal((await s.seed()).status, 'nothing_to_resume');
  assert.equal((await s.seed({ manual: true })).status, 'complete');
});
test('nearby identity reads exclude expired records and other cities', async () => {
  const store = testStore();
  await indexPlaceIdentities(store, [point], { now });
  await indexPlaceIdentities(store, [{ ...point, id: 'old' }], { now: now - LOCATION_TTL_MS - 1 });
  await indexPlaceIdentities(store, [{ id: 'far', lat: 52.5, lng: -0.14 }], { now });
  const result = await nearbyPlaceIdentities(store, { lat: 51.48, lng: -0.14, radius: 1500 }, now);
  assert.deepEqual(result.map(p => p.place_id), [point.id]);
});
test('live photo-led discovery defaults to no persistent Google-content cache', async () => {
  const store = testStore();
  let calls = 0, indexed = 0;
  const search = createDiscoveryService({
    store, apiKey: 'test-only', consumeBudget: allowance,
    indexIdentities: async venues => { indexed += venues.length; },
    readIndex: async () => [point],
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ places: [{
        ...point, displayName: { text: 'Visible only in response' },
        photos: [{ name: 'places/ChIJunit/photos/cover' }],
      }] }) };
    },
  });
  const request = { query: 'restaurants', location: { lat: 51.48, lng: -0.14 } };
  const first = await search(request);
  await search(request);
  assert.equal(first.venues[0].photoCount, 1);
  assert.equal(first.indexedNearbyCount, 1);
  assert.equal(calls, 2);
  assert.equal(indexed, 2);
  assert.equal(store.table('discovery_cover_searches_v1').size, 0);
  assert.equal(store.table('discovery_cover_venues_v1').size, 0);
});
test('quota fallback does not expose independent directory records in batch responses', async () => {
  const search = createDiscoveryService({
    store: testStore(), apiKey: 'test-only',
    consumeBudget: async () => ({ allowed: false, shared: true }),
    loadFallback: async () => ({ directoryVenues: [{ id: 'osm:node:1', name: 'Independent name',
      type: 'Restaurant', lat: 51.48, lng: -0.14 }],
      directory: { source: 'OpenStreetMap' } }),
    fetchImpl: () => { throw new Error('No paid request allowed.'); },
  });
  const result = await search({ queries: ['restaurants'], location: { lat: 51.48, lng: -0.14 } });
  assert.deepEqual(result.venues, []);
  assert.equal(result.directoryVenues, undefined);
  assert.equal(result.quotaExceeded, true);
  assert.equal(result.dataMode, 'unavailable');
});

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'unit-key', alg: 'RS256', use: 'sig' };
const claims = {
  iss: 'https://token.actions.githubusercontent.com', aud: SEED_AUDIENCE,
  repository: 'duncann38-sys/panda-ai-proxy', ref: 'refs/heads/main',
  sub: SEED_SUBJECT, repository_id: '1332508666', repository_owner_id: '266837386',
  workflow_ref: 'duncann38-sys/panda-ai-proxy/.github/workflows/seed-london.yml@refs/heads/main',
  event_name: 'workflow_dispatch', exp: Math.floor(now / 1000) + 300, iat: Math.floor(now / 1000),
};
function jwt(changes = {}, headerChanges = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'RS256', kid: 'unit-key', ...headerChanges })}.${encode({ ...claims, ...changes })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url')}`;
}
const authOptions = {
  now: () => now,
  fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }),
};
test('authorized main-branch workflow signature is accepted', async () => {
  const manual = await verifySeedJob(jwt(), authOptions);
  assert.equal(manual.manual, true);
  assert.equal(manual.scheduled, false);
  assert.equal(manual.workflowRef, claims.workflow_ref);
  const scheduled = await verifySeedJob(jwt({ event_name: 'schedule' }), authOptions);
  assert.equal(scheduled.manual, false);
  assert.equal(scheduled.scheduled, true);
});
test('the dedicated manual taxonomy workflow is authorized without enabling pull-request callers', async () => {
  const auth = await verifySeedJob(jwt({ workflow_ref: TAXONOMY_WORKFLOW }), authOptions);
  assert.equal(auth.manual, true);
  assert.equal(auth.workflowRef, TAXONOMY_WORKFLOW);
  assert.equal(await verifySeedJob(jwt({
    workflow_ref: TAXONOMY_WORKFLOW, event_name: 'pull_request',
  }), authOptions), null);
});
test('different repositories, branches, workflows and audiences cannot seed', async () => {
  for (const change of [{ repository: 'attacker/repo' }, { ref: 'refs/heads/dev' },
    { workflow_ref: 'another-file' }, { aud: 'other' }, { event_name: 'pull_request' },
    { repository_id: 'another-repository' }, { repository_owner_id: 'another-owner' },
    { sub: 'repo:duncann38-sys/panda-ai-proxy:ref:refs/heads/main' }]) {
    assert.equal(await verifySeedJob(jwt(change), authOptions), null);
  }
});
test('expired, future-dated, algorithm-switched and tampered tokens fail closed', async () => {
  assert.equal(await verifySeedJob(jwt({ exp: now / 1000 - 1 }), authOptions), null);
  assert.equal(await verifySeedJob(jwt({ iat: now / 1000 + 600 }), authOptions), null);
  assert.equal(await verifySeedJob(jwt({}, { alg: 'none' }), authOptions), null);
  const parts = jwt().split('.');
  parts[2] = Buffer.alloc(256).toString('base64url');
  assert.equal(await verifySeedJob(parts.join('.'), authOptions), null);
});
