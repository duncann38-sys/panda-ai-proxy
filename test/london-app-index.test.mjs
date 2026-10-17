import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore } from './index-store-fixture.mjs';
import { indexPlaceIdentities, createLondonSeeder, ID_COLLECTION, JOB_COLLECTION } from '../api/_london-index.js';
import { discoveryDailyLimit, TEMPORARY_INDEX_BOOST_END } from '../api/_index-budget.js';
import { readIndexProgress } from '../api/_index-progress.js';
import {
  FOCUS_SEED_PLAN, FOCUS_SEED_TASKS, LONDON_SEED_PLAN, LONDON_SEED_TASKS,
} from '../constants/london_clusters.js';

const now = Date.parse('2026-10-16T20:00:00Z');
const point = { id: 'ChIJphoto', location: { latitude: 51.48, longitude: -.14 },
  displayName: { text: 'Do not store this name' }, photos: [{ name: 'places/ChIJphoto/photos/private-reference' }] };
test('temporary allowance expires and explicit lower controls remain authoritative', () => {
  assert.equal(discoveryDailyLimit({}, now), 2000);
  assert.equal(discoveryDailyLimit({}, TEMPORARY_INDEX_BOOST_END), 1000);
  assert.equal(discoveryDailyLimit({ PANDA_DAILY_PLACES_LIMIT: '500' }, now), 500);
});
test('photo-only indexing stores own routing path, not Google rich content, and preserves Partner records', async () => {
  const store = testStore();
  const owner = { tier: 'banging', active: true, description: 'Owned copy',
    badges: ['Custom'], gallery: ['owned-image'], styling: { colour: 'gold' } };
  store.table('partner_venues').set(point.id, structuredClone(owner));
  const count = await indexPlaceIdentities(store, [point, {
    id: 'ChIJmissing', location: point.location, photos: [],
  }], { now, requirePhoto: true, seedPlan: LONDON_SEED_PLAN });
  assert.equal(count, 1);
  assert.deepEqual(store.table('partner_venues').get(point.id), owner);
  const data = store.table(ID_COLLECTION).get(point.id);
  assert.equal(data.primary_photo_path, `/api/partner/venues/${point.id}/photos/0/image`);
  assert.equal(data.seed_plan, LONDON_SEED_PLAN);
  assert.doesNotMatch(JSON.stringify(data), /Do not store|private-reference/);
  assert.equal(store.table(ID_COLLECTION).has('ChIJmissing'), false);
});
test('new matrix does not reuse completed old cursors and reports genuine empty queries', async () => {
  const store = testStore();
  store.table(JOB_COLLECTION).set('2026-10-11', { status: 'complete', taskIndex: 126 });
  const seed = createLondonSeeder({
    store, apiKey: 'fixture', now: () => now, paceMs: 0,
    planId: LONDON_SEED_PLAN, requirePhoto: true,
    tasks: LONDON_SEED_TASKS.slice(0, 2), dailyRequestLimit: () => 2000, customerReserve: 500,
    consumeBudget: async (_, kind, limit) => {
      assert.equal(limit, 1500); return { allowed: true, shared: true };
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ places: [] }) }),
  });
  const result = await seed({ manual: true });
  assert.equal(result.status, 'complete');
  assert.equal(result.categoriesWithoutPhotoCandidates, 2);
  assert.equal(store.table(JOB_COLLECTION).get('2026-10-11').taskIndex, 126);
  const progress = await readIndexProgress(store, now);
  assert.equal(progress.uniquePlaceIds, 0);
  assert.equal(progress.emptyCategories.length, 2);
});
test('progress verifies saved unique IDs, photo routes and coordinate expiry', async () => {
  const store = testStore();
  await indexPlaceIdentities(store, [point, point], { now, requirePhoto: true, seedPlan: LONDON_SEED_PLAN });
  store.table(JOB_COLLECTION).set(`2026-10-11_${LONDON_SEED_PLAN}`, { status: 'complete' });
  const result = await readIndexProgress(store, now);
  assert.equal(result.uniquePlaceIds, 1);
  assert.deepEqual(result.samples[0], { placeId: point.id, hasPhotoRoute: true,
    coordinatesValid: true, coordinatesUnexpired: true });
});
test('focused progress uses its own job cursor while counting IDs in the original active index', async () => {
  const store = testStore();
  await indexPlaceIdentities(store, [point], { now, requirePhoto: true, seedPlan: LONDON_SEED_PLAN });
  store.table(JOB_COLLECTION).set(`2026-10-11_${FOCUS_SEED_PLAN}`, {
    status: 'complete', taskIndex: FOCUS_SEED_TASKS.length, indexed: 1,
    categoryCoverage: { 'battersea/All': { indexed: 1 } },
  });
  const result = await readIndexProgress(store, now, {
    jobPlanId: FOCUS_SEED_PLAN, indexPlanId: LONDON_SEED_PLAN, tasks: FOCUS_SEED_TASKS,
  });
  assert.equal(result.planId, FOCUS_SEED_PLAN);
  assert.equal(result.totalTasks, 165);
  assert.equal(result.uniquePlaceIds, 1);
});
