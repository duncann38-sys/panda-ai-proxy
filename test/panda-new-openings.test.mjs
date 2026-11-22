import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEW_OPENINGS_CACHE_MS, NEW_OPENINGS_SEARCH_VERSION, buildNewOpeningSearchPrompt, createNewOpeningsFeed,
  normalizeCitySlug, openingPlaceIsEligible, parseGroundedOpeningCandidates, parseGroundedOpeningCandidatesDetailed,
} from '../api/_panda-new-openings.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const source = { web: { uri: 'https://example.com/news/new-venue', title: 'City Dining News' } };
const candidate = {
  name: 'Noma New', openingDate: '2026-11-02',
  openingEvidence: 'Noma New opened on 2 November 2026 in Oslo.',
  positioningEvidence: 'A Michelin-level chef-led fine dining restaurant.',
  independentVenue: true,
  independenceEvidence: 'The report describes a single independent restaurant from a local operator.',
  editorialNote: 'A new tasting-menu destination.', cuisine: 'Nordic',
  sourceUrl: 'https://www.example.com/news/new-venue?utm_source=search',
};
function makeStore() {
  const docs = new Map();
  return {
    docs,
    collection(name) {
      return { doc(id) {
        const key = name + '/' + id;
        return {
          async get() { const value = docs.get(key); return { exists: value !== undefined, data: () => value }; },
          async set(value, options = {}) { docs.set(key, options.merge ? { ...(docs.get(key) || {}), ...value } : value); },
          async delete() { docs.delete(key); },
        };
      } };
    },
  };
}
const reverseGeocode = async () => ({ city: 'Oslo', country: 'Norway', countryCode: 'NO', lat: 59.9, lng: 10.7 });

test('uses stable city-country cache slugs and appropriate candidate limits', () => {
  assert.equal(normalizeCitySlug('Malmö', 'SE'), 'malmo-se');
  assert.match(buildNewOpeningSearchPrompt({ city: 'London', country: 'UK', now: NOW, maxCandidates: 40 }), /up to 40/);
  assert.match(buildNewOpeningSearchPrompt({ city: 'Malmö', country: 'Sweden', now: NOW }), /no more than 15/);
  assert.match(buildNewOpeningSearchPrompt({ city: 'London', country: 'UK', now: NOW }), /new restaurants London/);
  assert.match(buildNewOpeningSearchPrompt({ city: 'London', country: 'UK', focus: 'Zone 1–3 central areas', now: NOW }), /Search specifically within these neighborhoods/);
  assert.match(buildNewOpeningSearchPrompt({ city: 'London', country: 'UK', now: NOW }), /hotel restaurant, cocktail bar, wine bar/);
});

test('accepts only recent dated premium independent candidates with grounded sources', () => {
  const valid = parseGroundedOpeningCandidates({ text: JSON.stringify([candidate]), groundingMetadata: { groundingChunks: [source] } }, { city: 'Oslo', country: 'Norway', now: NOW });
  assert.equal(valid.length, 1);
  assert.equal(valid[0].sourceName, 'City Dining News');
  assert.equal(valid[0].sourceUrl, source.web.uri);
  for (const rejected of [
    { ...candidate, openingDate: '2026-12-02' },
    { ...candidate, independentVenue: false },
    { ...candidate, positioningEvidence: 'A casual neighborhood cafe.' },
  ]) assert.equal(parseGroundedOpeningCandidates({ text: JSON.stringify([rejected]), groundingMetadata: { groundingChunks: [source] } }, { city: 'Oslo', country: 'Norway', now: NOW }).length, 0);
  assert.equal(parseGroundedOpeningCandidates({ text: JSON.stringify([candidate]), groundingMetadata: { groundingChunks: [] } }, { city: 'Oslo', country: 'Norway', now: NOW }).length, 0);
});


test('reports grounding-stage rejection counts without exposing candidate text', () => {
  const invalid = parseGroundedOpeningCandidatesDetailed({ text: 'No structured results returned.', groundingMetadata: { groundingChunks: [] } }, { city: 'London', country: 'UK', now: NOW });
  assert.equal(invalid.candidates.length, 0);
  assert.equal(invalid.diagnostics.jsonArrayFound, false);
  assert.equal(invalid.diagnostics.groundingChunkCount, 0);
  assert.equal(invalid.diagnostics.version, 3);
  const missingSource = parseGroundedOpeningCandidatesDetailed({ text: JSON.stringify([candidate]), groundingMetadata: { groundingChunks: [] } }, { city: 'London', country: 'UK', now: NOW });
  assert.equal(missingSource.diagnostics.parsedItems, 1);
  assert.equal(missingSource.diagnostics.rejected.noGroundedSource, 1);
  assert.equal(JSON.stringify(missingSource.diagnostics).includes(candidate.name), false);
  const supportedCandidate = { ...candidate, sourceUrl: 'https://unmatched.example.org/article', positioningEvidence: 'A high-end restaurant led by a celebrated chef.' };
  const supported = parseGroundedOpeningCandidatesDetailed({ text: JSON.stringify([supportedCandidate]),
    groundingMetadata: { groundingChunks: [source], groundingSupports: [{ segment: { text: 'Noma New opened on 2 November 2026 in Oslo.' }, groundingChunkIndices: [0] }] } },
    { city: 'Oslo', country: 'Norway', now: NOW });
  assert.equal(supported.candidates.length, 1);
  assert.equal(supported.candidates[0].sourceUrl, source.web.uri);
  assert.equal(supported.diagnostics.sourceViaGroundingSupport, 1);
  const googleFallback = parseGroundedOpeningCandidatesDetailed({ text: JSON.stringify([supportedCandidate]),
    groundingMetadata: { groundingChunks: [], webSearchQueries: ['new restaurants Oslo'] } }, { city: 'Oslo', country: 'Norway', now: NOW });
  assert.equal(googleFallback.candidates.length, 1);
  assert.equal(googleFallback.candidates[0].sourceType, 'google_search');
  assert.match(googleFallback.candidates[0].sourceUrl, /^https:\/\/www\.google\.com\/search\?q=/);
  assert.equal(googleFallback.diagnostics.sourceViaGoogleSearch, 1);
});

test('rejects non-operational, moderate, poorly rated, or over-established places', () => {
  const base = { id: 'ChI12345678901234567890', businessStatus: 'OPERATIONAL', location: { latitude: 59.9, longitude: 10.7 }, rating: 4.5, userRatingCount: 12, priceLevel: 'PRICE_LEVEL_EXPENSIVE' };
  assert.equal(openingPlaceIsEligible(base), true);
  assert.equal(openingPlaceIsEligible({ ...base, businessStatus: 'CLOSED_PERMANENTLY' }), false);
  assert.equal(openingPlaceIsEligible({ ...base, priceLevel: 'PRICE_LEVEL_MODERATE' }), false);
  assert.equal(openingPlaceIsEligible({ ...base, userRatingCount: 91 }), false);
  assert.equal(openingPlaceIsEligible({ ...base, rating: 4.0 }), false);
  assert.equal(openingPlaceIsEligible({ ...base, primaryType: 'cafe' }), false);
  assert.equal(openingPlaceIsEligible({ ...base, priceLevel: undefined }), true);
});

test('limits pages to 15, advances, avoids repeats, and wraps at the end', async () => {
  const store = makeStore();
  const venues = Array.from({ length: 22 }, (_, i) => ({ id: 'ChI' + String(i).padStart(12, '0'), name: 'Place ' + i, lat: 59.9 + i / 1000, lng: 10.7, openingDate: '2026-11-02' }));
  await store.collection('new_openings_by_city').doc('oslo-no').set({ updatedAt: NOW, searchVersion: NEW_OPENINGS_SEARCH_VERSION, venues });
  const feed = createNewOpeningsFeed({ store, reverseGeocode, searchGrounded: async () => { throw new Error('must use fresh cache'); }, hydratePlace: async () => { throw new Error('must use fresh cache'); }, now: () => NOW });
  const first = await feed({ location: { lat: 59.91, lng: 10.75 }, limit: 50 });
  assert.equal(first.venues.length, 15); assert.equal(first.nextOffset, 15); assert.equal(first.hasMore, true);
  const second = await feed({ location: { lat: 59.91, lng: 10.75 }, offset: first.nextOffset, limit: 15 });
  assert.equal(second.venues.length, 7); assert.equal(second.nextOffset, 0); assert.equal(second.hasMore, false);
  const chatMore = await feed({ location: { lat: 59.91, lng: 10.75 }, offset: 15, excludedPlaceIds: first.venues.map(venue => venue.id) });
  assert.equal(chatMore.venues.length, 7); assert.equal(chatMore.venues[0].id, venues[15].id);
  const wrapped = await feed({ location: { lat: 59.91, lng: 10.75 }, offset: 22, limit: 15 });
  assert.equal(wrapped.venues[0].id, first.venues[0].id);
  const freshRotation = await feed({ location: { lat: 59.91, lng: 10.75 }, excludedPlaceIds: venues.map(venue => venue.id) });
  assert.equal(freshRotation.venues[0].id, first.venues[0].id);
  assert.match(freshRotation.text, /fresh rotation/);
});



test('searches London in priority passes without exposing zone labels in results', async () => {
  const store = makeStore(); const focuses = [];
  const feed = createNewOpeningsFeed({ store,
    reverseGeocode: async () => ({ city: 'London', country: 'United Kingdom', countryCode: 'GB', lat: 51.5074, lng: -0.1278 }),
    searchGrounded: async ({ focus }) => { focuses.push(focus); return { ok: true, queryCount: 2, text: '[]', groundingMetadata: { groundingChunks: [], webSearchQueries: ['new restaurants London'] } }; },
    hydratePlace: async () => { throw new Error('no candidates should be hydrated'); }, now: () => NOW,
  });
  const result = await feed({ location: { lat: 51.5074, lng: -0.1278 } });
  assert.equal(focuses.length, 3);
  assert.match(focuses[0], /highest-priority inner zones/);
  assert.match(focuses[1], /next priority ring/);
  assert.match(focuses[2], /outer-London/);
  assert.equal(result.status, 'no_results');
  assert.equal(result.diagnostics.searchPassCount, 3);
  assert.equal(result.diagnostics.groundingQueryCount, 6);
  assert.equal(JSON.stringify(result).includes('zone1-3'), false);
});

test('reports whether the live venue verification stage rejected grounded candidates', async () => {
  const store = makeStore();
  const feed = createNewOpeningsFeed({ store, reverseGeocode,
    searchGrounded: async () => ({ ok: true, queryCount: 3, text: JSON.stringify([candidate]), groundingMetadata: { groundingChunks: [source] } }),
    hydratePlace: async () => [{ id: 'ChI12345678901234567890', displayName: { text: 'Noma New' }, location: { latitude: 59.9, longitude: 10.7 }, businessStatus: 'CLOSED_PERMANENTLY' }],
    now: () => NOW,
  });
  const result = await feed({ location: { lat: 59.91, lng: 10.75 } });
  assert.equal(result.status, 'no_results', JSON.stringify(result));
  assert.ok(result.diagnostics, JSON.stringify(result));
  assert.equal(result.diagnostics.stage, 'places');
  assert.equal(result.diagnostics.acceptedItems, 1);
  assert.equal(result.diagnostics.placeLookupCount, 1);
  assert.equal(result.diagnostics.placeIneligibleResults, 1);
  assert.match(result.text, /could not confirm matching venues/);
});

test('does not let a legacy empty cooldown hide new diagnostic searches', async () => {
  const store = makeStore(); let searches = 0;
  await store.collection('new_openings_refresh_state').doc('oslo-no').set({ lastEmptyAt: NOW, city: 'Oslo', country: 'Norway' });
  const place = { id: 'ChI12345678901234567890', displayName: { text: 'Noma New' }, location: { latitude: 59.9, longitude: 10.7 }, businessStatus: 'OPERATIONAL', priceLevel: 'PRICE_LEVEL_EXPENSIVE', rating: 4.6, userRatingCount: 25, photos: [] };
  const feed = createNewOpeningsFeed({ store, reverseGeocode,
    searchGrounded: async () => { searches++; return { ok: true, text: JSON.stringify([candidate]), groundingMetadata: { groundingChunks: [source] } }; },
    hydratePlace: async () => [place], now: () => NOW,
  });
  const result = await feed({ location: { lat: 59.91, lng: 10.75 } });
  assert.equal(searches, 1);
  assert.equal(result.status, 'ready');
});


test('keeps search-only evidence visibly labeled when Google supplies queries without citation chunks', async () => {
  const store = makeStore();
  const place = { id: 'ChI12345678901234567890', displayName: { text: 'Noma New' }, formattedAddress: 'Oslo, Norway', location: { latitude: 59.9, longitude: 10.7 }, businessStatus: 'OPERATIONAL', priceLevel: 'PRICE_LEVEL_EXPENSIVE', rating: 4.6, userRatingCount: 25, photos: [] };
  const feed = createNewOpeningsFeed({ store, reverseGeocode,
    searchGrounded: async () => ({ ok: true, queryCount: 2, text: JSON.stringify([candidate]), groundingMetadata: { groundingChunks: [], webSearchQueries: ['new restaurants Oslo'] } }),
    hydratePlace: async () => [place], now: () => NOW,
  });
  const result = await feed({ location: { lat: 59.91, lng: 10.75 } });
  assert.equal(result.status, 'ready');
  assert.equal(result.venues[0].openingDesignation, 'panda-search-reported-new');
  assert.equal(result.venues[0].openingSourceName, 'Google Search results · verify opening');
  assert.match(result.venues[0].openingSourceUrl, /^https:\/\/www\.google\.com\/search\?q=/);
  assert.equal(result.venues[0].openingSourceType, 'google_search');
  assert.equal(result.diagnostics.sourceViaGoogleSearch, 1);
  assert.match(result.text, /Google Places confirms these venues are operating/);
});

test('coalesces concurrent refreshes and stores only verified Place results', async () => {
  const store = makeStore(); let searches = 0;
  const place = { id: 'ChI12345678901234567890', displayName: { text: 'Noma New' }, formattedAddress: 'Oslo, Norway', location: { latitude: 59.9, longitude: 10.7 }, businessStatus: 'OPERATIONAL', priceLevel: 'PRICE_LEVEL_EXPENSIVE', rating: 4.6, userRatingCount: 25, photos: [] };
  const feed = createNewOpeningsFeed({ store, reverseGeocode,
    searchGrounded: async () => { searches++; await new Promise(resolve => setTimeout(resolve, 20)); return { ok: true, text: JSON.stringify([candidate]), groundingMetadata: { groundingChunks: [source] } }; },
    hydratePlace: async () => [place], now: () => NOW,
  });
  const [a, b] = await Promise.all([feed({ location: { lat: 59.91, lng: 10.75 } }), feed({ location: { lat: 59.92, lng: 10.76 } })]);
  assert.equal(searches, 1); assert.equal(a.venues.length, 1); assert.equal(b.venues.length, 1);
  assert.equal(a.venues[0].openingSourceUrl, source.web.uri);
  assert.equal(a.venues[0].openingDesignation, 'panda-verified-new');
  assert.equal(store.docs.has('new_openings_by_city/oslo-no'), true);
});

test('keeps the last positive cache if an expired refresh finds no verified candidates', async () => {
  const store = makeStore();
  const old = { updatedAt: NOW - NEW_OPENINGS_CACHE_MS - 1000, venues: [{ id: 'ChIold123456789012', name: 'Older verified venue' }] };
  await store.collection('new_openings_by_city').doc('oslo-no').set(old);
  const feed = createNewOpeningsFeed({ store, reverseGeocode,
    searchGrounded: async () => ({ ok: true, text: '[]', groundingMetadata: { groundingChunks: [] } }),
    hydratePlace: async () => [], now: () => NOW,
  });
  const result = await feed({ location: { lat: 59.91, lng: 10.75 } });
  assert.equal(result.status, 'no_results');
  assert.deepEqual(store.docs.get('new_openings_by_city/oslo-no'), old);
});
