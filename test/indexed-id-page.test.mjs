import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndexedIdCandidatePage } from '../api/_indexed-feed-page.js';

const identities = Array.from({ length: 200 }, (_, index) => ({
  place_id: `google-place-${String(index).padStart(3, '0')}`,
  lat: 51.46 + index / 1_000_000,
  lng: -0.16,
  distanceMeters: index * 10,
}));

test('category page returns 200 stored IDs without calling a Google hydrator', async () => {
  let readArgs;
  const response = await buildIndexedIdCandidatePage({
    location: { lat: 51.46, lng: -0.16 }, category: 'Pubs', pageSize: 200,
  }, {
    readPage: async args => { readArgs = args; return { identities, nextCursor: 'next', indexExhausted: false, expandedArea: true }; },
  });
  assert.equal(response.status, 200);
  assert.equal(readArgs.pageSize, 200);
  assert.equal(response.body.venues.length, 200);
  assert.equal(response.body.dataMode, 'indexed_feed_id_candidates');
  assert.ok(response.body.venues.every(venue => venue.detailsDeferred && venue.categories.includes('Pubs')));
  assert.equal(response.body.nextCursor, 'next');
});

test('category page refuses to claim the 200 floor when the stored index is short', async () => {
  const response = await buildIndexedIdCandidatePage({
    location: { lat: 51.46, lng: -0.16 }, category: 'Pubs', pageSize: 200,
  }, { readPage: async () => ({ identities: identities.slice(0, 199), nextCursor: null, indexExhausted: true }) });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'insufficient_indexed_category_candidates');
  assert.equal(response.body.matchedCount, 199);
});

test('category candidate page rejects a different requested page size', async () => {
  const response = await buildIndexedIdCandidatePage({
    location: { lat: 51.46, lng: -0.16 }, category: 'Pubs', pageSize: 30,
  }, { readPage: async () => { throw new Error('must not query'); } });
  assert.equal(response.status, 400);
  assert.equal(response.body.requiredCount, 200);
});
