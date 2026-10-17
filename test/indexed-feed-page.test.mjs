import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndexedFeedPage } from '../api/_indexed-feed-page.js';

test('indexed feed returns a complete 200-card Google-hydrated page by default', async () => {
  const identities = Array.from({ length: 200 }, (_, index) => ({
    place_id: `place-${String(index).padStart(3, '0')}`,
    lat: 51.46,
    lng: -0.16,
  }));
  let requestedSize = 0;
  let hydrationCount = 0;
  const response = await buildIndexedFeedPage({
    location: { lat: 51.46, lng: -0.16 },
    category: 'Pubs',
  }, {
    maxPageSize: 200,
    readPage: async ({ pageSize }) => {
      requestedSize = pageSize;
      return {
        identities,
        nextCursor: null,
        indexExhausted: true,
      };
    },
    hydratePlace: async (placeId) => {
      hydrationCount += 1;
      return {
        venue: {
          id: placeId,
          name: `Venue ${placeId}`,
          photoName: `places/${placeId}/photos/cover`,
          categories: ['Pubs'],
        },
      };
    },
  });

  assert.equal(response.status, 200);
  assert.equal(requestedSize, 200);
  assert.equal(hydrationCount, 200);
  assert.equal(response.body.venues.length, 200);
  assert.equal(response.body.partial, undefined);
  assert.ok(response.body.venues.every(venue =>
    venue.name && venue.photoName && venue.categories.includes('Pubs')));
});

test('indexed feed never fills a 200-card page with mismatched or photo-less results', async () => {
  const identities = Array.from({ length: 200 }, (_, index) => ({
    place_id: `place-${String(index).padStart(3, '0')}`,
    lat: 51.46,
    lng: -0.16,
  }));
  const response = await buildIndexedFeedPage({
    location: { lat: 51.46, lng: -0.16 },
    category: 'Pubs',
    pageSize: 200,
  }, {
    maxPageSize: 200,
    readPage: async () => ({
      identities,
      nextCursor: null,
      indexExhausted: true,
    }),
    hydratePlace: async (placeId, _identity, _category) => ({
      venue: {
        id: placeId,
        name: `Venue ${placeId}`,
        photoName: Number(placeId.slice(-3)) % 2 === 0 ? `places/${placeId}/photos/cover` : null,
        categories: Number(placeId.slice(-3)) % 2 === 0 ? ['Pubs'] : ['Coffee'],
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.venues.length, 100);
  assert.equal(response.body.partial, true);
  assert.ok(response.body.venues.every(venue =>
    venue.photoName && venue.categories.includes('Pubs')));
});
