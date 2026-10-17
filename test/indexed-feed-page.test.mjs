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

test('indexed feed continues through stored IDs until 200 valid cards are found', async () => {
  const firstIdentities = Array.from({ length: 200 }, (_, index) => ({
    place_id: `first-${String(index).padStart(3, '0')}`,
    lat: 51.46,
    lng: -0.16,
  }));
  const secondIdentities = Array.from({ length: 200 }, (_, index) => ({
    place_id: `second-${String(index).padStart(3, '0')}`,
    lat: 51.46,
    lng: -0.16,
  }));
  const cursors = [];
  const response = await buildIndexedFeedPage({
    location: { lat: 51.46, lng: -0.16 },
    category: 'Pubs',
    pageSize: 200,
  }, {
    maxPageSize: 200,
    readPage: async ({ cursor, pageSize }) => {
      cursors.push({ cursor, pageSize });
      if (!cursor) {
        return {
          identities: firstIdentities,
          nextCursor: 'next-index-page',
          indexExhausted: false,
        };
      }
      return {
        identities: secondIdentities,
        nextCursor: null,
        indexExhausted: true,
      };
    },
    hydratePlace: async (placeId) => ({
      venue: placeId.startsWith('first-')
        ? {
          id: placeId,
          name: `Venue ${placeId}`,
          photoName: `places/${placeId}/photos/cover`,
          categories: ['Coffee'],
        }
        : {
          id: placeId,
          name: `Venue ${placeId}`,
          photoName: `places/${placeId}/photos/cover`,
          categories: ['Pubs'],
        },
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(cursors, [
    { cursor: null, pageSize: 200 },
    { cursor: 'next-index-page', pageSize: 200 },
  ]);
  assert.equal(response.body.venues.length, 200);
  assert.equal(response.body.partial, undefined);
  assert.ok(response.body.venues.every(venue =>
    venue.photoName && venue.categories.includes('Pubs')));
});

test('category feed refuses to serve fewer than 200 verified matches', async () => {
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

  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'insufficient_google_verified_venues');
  assert.equal(response.body.requiredCount, 200);
  assert.equal(response.body.matchedCount, 100);
  assert.equal(response.body.venues, undefined);
});


test('diagnostic hydration limit caps Google lookups and reports verified matches', async () => {
  const identities = Array.from({ length: 200 }, (_, index) => ({
    place_id: 'sports-' + index, lat: 51.46, lng: -0.16,
  }));
  let hydrationCount = 0;
  const response = await buildIndexedFeedPage({
    location: { lat: 51.46, lng: -0.16 },
    category: 'Sports',
    pageSize: 200,
    maxHydrations: 37,
  }, {
    maxPageSize: 200,
    readPage: async ({ pageSize }) => {
      assert.equal(pageSize, 37);
      return { identities, nextCursor: 'next-page', indexExhausted: false };
    },
    hydratePlace: async placeId => {
      hydrationCount += 1;
      return { venue: { id: placeId, name: 'Pub', photoName: 'photo', categories: [] } };
    },
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'hydration_attempt_limit_reached');
  assert.equal(response.body.hydrationAttempts, 37);
  assert.equal(response.body.hydrationLimitReached, true);
  assert.equal(response.body.matchedCount, 0);
  assert.equal(hydrationCount, 37);
});


test('diagnostic hydration limit cannot exceed one 200-card page', async () => {
  const response = await buildIndexedFeedPage({
    location: { lat: 51.46, lng: -0.16 },
    category: 'Sports',
    pageSize: 200,
    maxHydrations: 201,
  }, {
    maxPageSize: 200,
    readPage: async () => { assert.fail('invalid cap must not read Firestore'); },
    hydratePlace: async () => { assert.fail('invalid cap must not call Google'); },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid_hydration_limit');
  assert.equal(response.body.maxAllowed, 200);
});

test('Planner All lookup can return a smaller nearby candidate set from the existing index', async () => {
  const identities = Array.from({ length: 24 }, (_, index) => ({
    place_id: `planner-${String(index).padStart(3, '0')}`,
    lat: 51.46,
    lng: -0.16,
  }));
  const response = await buildIndexedFeedPage({
    location: { lat: 51.46, lng: -0.16 },
    category: 'All',
    pageSize: 60,
    radiusMeters: 20_000,
  }, {
    maxPageSize: 200,
    readPage: async ({ pageSize }) => {
      assert.equal(pageSize, 60);
      return { identities, nextCursor: null, indexExhausted: true };
    },
    hydratePlace: async (placeId) => ({
      venue: {
        id: placeId,
        name: `Venue ${placeId}`,
        photoName: `places/${placeId}/photos/cover`,
        categories: ['Coffee'],
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.venues.length, 24);
  assert.equal(response.body.pageSize, 60);
  assert.equal(response.body.partial, true);
  assert.equal(response.body.indexExhausted, true);
});

test('category feeds cannot bypass the 200-result floor with a smaller request', async () => {
  const response = await buildIndexedFeedPage({
    location: { lat: 51.46, lng: -0.16 },
    category: 'Pubs',
    pageSize: 60,
  }, {
    maxPageSize: 200,
    readPage: async () => {
      assert.fail('A non-200 category request must be rejected before reading the index.');
    },
    hydratePlace: async () => {
      assert.fail('A non-200 category request must be rejected before Google hydration.');
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'category_feed_page_size_must_be_200');
});
