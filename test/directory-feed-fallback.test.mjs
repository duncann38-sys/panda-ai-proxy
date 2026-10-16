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
    loadFallback: async () => ({ directoryVenues: [
      { id: 'osm:node:1', name: 'Actual Restaurant', type: 'Restaurant', lat: 51.5, lng: -0.14, types: ['restaurant'] },
      { id: 'osm:node:2', name: 'Actual Pub', type: 'Pub', lat: 51.5, lng: -0.14, types: ['pub'] },
      { id: 'ChIJexcluded', name: 'Not independent directory data', lat: 51.5, lng: -0.14 },
    ] }),
  });
}
test('the feed receives clearly sourced directory previews during Google quota denial', async () => {
  const result = await service()({ query: 'restaurants', location });
  assert.equal(result.dataMode, 'directory');
  assert.equal(result.venues.length, 1);
  assert.equal(result.venues[0].source, 'openstreetmap');
  assert.equal(result.venues[0].detailsDeferred, true);
  assert.equal(result.venues[0].photoCount, 0);
  assert.equal(result.venues[0].openNow, undefined);
  assert.equal(result.directoryVenues.length, 2);
});
test('batch fallback does not infer venue categories from unrelated requested searches', async () => {
  const result = await service()({ queries: ['restaurants', 'pubs'], location });
  assert.equal(result.venues.length, 2);
  for (const venue of result.venues) {
    assert.deepEqual(venue.sourceQueries, ['OpenStreetMap directory']);
    assert.equal(venue.rating, undefined);
  }
});
