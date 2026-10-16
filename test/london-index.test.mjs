import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { testStore } from './index-store-fixture.mjs';
import {
  ID_COLLECTION, LOCATION_COLLECTION, JOB_COLLECTION, LOCATION_TTL_MS, INDEX_FIELDS,
  createLondonSeeder, indexPlaceIdentities, nearbyPlaceIdentities, londonClock, indexedVenueBaseline,
} from '../api/_london-index.js';
import { LONDON_CLUSTERS, PANDA_CATEGORIES, LONDON_SEED_TASKS } from '../constants/london_clusters.js';
import { verifySeedJob, SEED_AUDIENCE } from '../api/_seed-job-auth.js';
import { createDiscoveryService } from '../api/_discovery-lite.js';

const now = Date.parse('2026-10-18T02:00:00Z'); // Sunday 03:00 London BST
const point = { id: 'ChIJunit', location: { latitude: 51.48, longitude: -0.14 } };
const allowance = async () => ({ allowed: true, shared: true });
const task = { name: 'battersea_nine_elms', lat: 51.48, lng: -0.14, category: 'restaurant' };
function seedFixture(extra = {}) {
  const store = extra.store || testStore();
  let calls = 0;
  const seed = createLondonSeeder({
    store, apiKey: 'test-only', now: () => now, tasks: [task],
    consumeBudget: allowance,
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.headers['X-Goog-FieldMask'], INDEX_FIELDS);
      return { ok: true, status: 200, json: async () => ({ places: [point] }) };
    }, ...extra,
  });
  return { store, seed, calls: () => calls };
}
test('all 18 requested clusters and seven categories yield 126 tasks', () => {
  assert.equal(LONDON_CLUSTERS.length, 18);
  assert.equal(PANDA_CATEGORIES.length, 7);
  assert.equal(LONDON_SEED_TASKS.length, 126);
  assert.equal(new Set(LONDON_SEED_TASKS.map(t => `${t.name}/${t.category}`)).size, 126);
  assert.doesNotMatch(INDEX_FIELDS, /displayName|formattedAddress|photos|rating|currentOpeningHours/);
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
  const s = seedFixture({ fetchImpl: async () => ({
    ok: true, status: 200, json: async () => ({
      places: [point], nextPageToken: `page-${++calls}`,
    }),
  }) });
  assert.equal((await s.seed({ maxRequests: 1 })).status, 'running');
  assert.equal((await s.seed({ maxRequests: 1 })).status, 'running');
  assert.equal((await s.seed({ maxRequests: 1 })).status, 'complete');
  assert.equal(calls, 3);
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
test('quota fallback retains independent directory records in batch responses', async () => {
  const search = createDiscoveryService({
    store: testStore(), apiKey: 'test-only',
    consumeBudget: async () => ({ allowed: false, shared: true }),
    loadFallback: async () => ({ directoryVenues: [{ id: 'osm:node:1', name: 'Independent name' }],
      directory: { source: 'OpenStreetMap' } }),
    fetchImpl: () => { throw new Error('No paid request allowed.'); },
  });
  const result = await search({ queries: ['restaurants', 'pubs'], location: { lat: 51.48, lng: -0.14 } });
  assert.equal(result.directoryVenues.length, 1);
  assert.equal(result.quotaExceeded, true);
  assert.equal(result.dataMode, 'cached');
});

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'unit-key', alg: 'RS256', use: 'sig' };
const claims = {
  iss: 'https://token.actions.githubusercontent.com', aud: SEED_AUDIENCE,
  repository: 'duncann38-sys/panda-ai-proxy', ref: 'refs/heads/main',
  sub: 'repo:duncann38-sys/panda-ai-proxy:ref:refs/heads/main',
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
  assert.equal((await verifySeedJob(jwt(), authOptions)).manual, true);
});
test('different repositories, branches, workflows and audiences cannot seed', async () => {
  for (const change of [{ repository: 'attacker/repo' }, { ref: 'refs/heads/dev' },
    { workflow_ref: 'another-file' }, { aud: 'other' }, { event_name: 'pull_request' }]) {
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
