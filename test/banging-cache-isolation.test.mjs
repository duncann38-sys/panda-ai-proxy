import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const directorySource = readFileSync(new URL('../api/_banging-directory.js', import.meta.url), 'utf8');
const venueLiveSource = readFileSync(new URL('../api/_venue-live.js', import.meta.url), 'utf8');

test('Banging Places, transit proofs, and fallback no longer reuse shared Google results', () => {
  const directoryStart = directorySource.indexOf('async function directory(origin, signal) {');
  const directoryEnd = directorySource.indexOf('async function activePlacements', directoryStart);
  const directory = directorySource.slice(directoryStart, directoryEnd);
  assert.ok(directory.includes('bypassCache: true'));
  assert.equal(directory.includes('refresh('), false);

  const verifiedStart = directorySource.indexOf('async function getVerifiedBangingDirectory');
  const endpointStart = directorySource.indexOf('export async function getBangingDirectory', verifiedStart);
  const verification = directorySource.slice(verifiedStart, endpointStart);
  assert.equal(verification.includes('refresh('), false);
  assert.ok(verification.split('bypassCache: true').length - 1 >= 2);

  const endpoint = directorySource.slice(endpointStart);
  for (const helper of ['readStoredDirectory', 'estimatedFallbackBody', 'mergeVerifiedAndStored']) {
    assert.equal(endpoint.includes(helper), false);
    assert.equal(directorySource.includes('function ' + helper), false);
  }
  assert.ok(venueLiveSource.includes('if (!bypassCache) {'));
  assert.ok(venueLiveSource.includes("writeSharedCache('venue_search_cache_v1'"));
});

test('searchVenueListings bypasses process and Firestore caches only when requested', async () => {
  const originalFetch = globalThis.fetch;
  const originalGoogleKey = process.env.GOOGLE_MAPS_API_KEY;
  const originalFirebaseAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  let fetchCount = 0;
  process.env.GOOGLE_MAPS_API_KEY = 'test-only-key';
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { places: [{
          id: 'ChIJtestBanging123456',
          displayName: { text: 'Test Fine Dining' },
          formattedAddress: '1 Test Street, London',
          primaryType: 'restaurant',
          location: { latitude: 51.5, longitude: -0.1 },
          rating: 4.9,
          userRatingCount: 300,
        }] };
      },
    };
  };
  try {
    const { searchVenueListings } = await import('../api/_venue-live.js?banging-cache-isolation');
    const bypassQuery = 'Banging bypass cache test ' + Date.now();
    await searchVenueListings(bypassQuery, null, { bypassCache: true });
    await searchVenueListings(bypassQuery, null, { bypassCache: true });
    assert.equal(fetchCount, 2);

    const normalQuery = 'Banging default cache test ' + Date.now();
    await searchVenueListings(normalQuery);
    await searchVenueListings(normalQuery);
    assert.equal(fetchCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGoogleKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
    if (originalFirebaseAccount === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
    else process.env.FIREBASE_SERVICE_ACCOUNT = originalFirebaseAccount;
  }
});
