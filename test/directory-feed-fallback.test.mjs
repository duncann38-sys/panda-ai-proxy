import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryService } from '../api/_discovery-lite.js';
import { testStore } from './index-store-fixture.mjs';

const location = { lat: 51.5, lng: -0.14 };
function service() {
  return createDiscoveryService({
    store: testStore(), apiKey: 'test-only', persistFullContent: false,
    consumeBudget: async () => ({ allowed: false, shared: true }),
    fetchImpl: async () => { throw new Error('Google must not be called.'); },
  });
}
test('the discovery feed never substitutes OpenStreetMap venues when Google is unavailable', async () => {
  const result = await service()({ query: 'restaurants', location });
  assert.equal(result.dataMode, 'unavailable');
  assert.deepEqual(result.venues, []);
  assert.equal(result.directoryVenues, undefined);
});
test('a combined category search stays empty rather than substituting unrelated directory records', async () => {
  const result = await service()({ query: 'bars and pubs', location });
  assert.deepEqual(result.venues, []);
});
test('an unavailable venue search never exposes OpenStreetMap records in a batch', async () => {
  const result = await service()({ queries: ['restaurants', 'pubs'], location });
  assert.deepEqual(result.venues, []);
  assert.equal(result.directoryVenues, undefined);
  assert.equal(result.directory, undefined);
});

/* Legacy directory fixtures remain in admin-directory tests only. */
test('the Google-only fallback does not make an unmetered request', async () => {
  const guarded = createDiscoveryService({
    store: testStore(), apiKey: 'test-only', persistFullContent: false,
    consumeBudget: async () => ({ allowed: false, shared: true }),
    fetchImpl: async () => { throw new Error('Google must not be called.'); },
    loadFallback: async () => ({ directoryVenues: [
      { id: 'osm:node:1', name: 'Actual Restaurant', type: 'Restaurant', lat: 51.5, lng: -0.14, types: ['restaurant'] },
      { id: 'osm:node:2', name: 'Actual Pub', type: 'Pub', lat: 51.5, lng: -0.14, types: ['pub'] },
      { id: 'ChIJexcluded', name: 'Not independent directory data', lat: 51.5, lng: -0.14 },
    ] }),
  });
  const result = await guarded({ query: 'restaurants', location });
  assert.deepEqual(result.venues, []);
  assert.equal(result.dataMode, 'unavailable');
});
