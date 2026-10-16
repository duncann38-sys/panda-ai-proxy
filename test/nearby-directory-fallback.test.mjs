import assert from 'node:assert/strict';
import test from 'node:test';
import { testStore } from './index-store-fixture.mjs';
import { createNearbySavedDirectoryReader, venueDirectoryArea, VENUE_DIRECTORY_COLLECTION,
  VENUE_DIRECTORY_STALE_MAX_AGE_MS } from '../api/_venue-directory.js';

const now = 100 * 24 * 60 * 60 * 1000;
function fixture(age = 60_000) {
  const store = testStore();
  const neighbour = venueDirectoryArea(51.5, -0.14);
  store.table(VENUE_DIRECTORY_COLLECTION).set(neighbour.key, {
    updatedAt: now - age, venues: [
      { id: 'osm:node:1', name: 'Nearby saved pub', type: 'pub', lat: 51.48, lng: -0.14 },
      { id: 'osm:node:2', name: 'Distant pub', type: 'pub', lat: 52, lng: -0.14 },
      { id: 'ChIJexcluded', name: 'Not independent directory data', lat: 51.48, lng: -0.14 },
    ],
  });
  return store;
}
test('a missing exact cell can use genuinely nearby saved venues without provider calls', async () => {
  const store = fixture();
  const result = await createNearbySavedDirectoryReader({ now: () => now })(store, 51.48, -0.14);
  assert.equal(result.directoryVenues.length, 1);
  assert.equal(result.directoryVenues[0].id, 'osm:node:1');
  assert.equal(result.directoryVenues[0].cachedAt, now - 60_000);
  assert.equal(result.directoryVenues[0].distanceMeters, 0);
});
test('neighbouring saved data remains distance bounded', async () => {
  const result = await createNearbySavedDirectoryReader({ now: () => now })(fixture(), 51.5, -0.14, 100);
  assert.equal(result, null);
});
test('old directory data is labelled stale, but expired data is not reused', async () => {
  const read = () => createNearbySavedDirectoryReader({ now: () => now });
  const stale = await read()(fixture(2 * 24 * 60 * 60 * 1000), 51.48, -0.14);
  assert.equal(stale.directory.stale, true);
  assert.equal(await read()(fixture(VENUE_DIRECTORY_STALE_MAX_AGE_MS), 51.48, -0.14), null);
});
