import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { safePublicError } from '../api/_public-errors.js';
import { publicSeedStatus } from '../api/_seed-status.js';

const api = fileURLToPath(new URL('../api/', import.meta.url));
const readApi = path => readFile(`${api}/${path}`, 'utf8');

test('public provider errors use fixed safe messages and stable codes', () => {
  const response = safePublicError(502, 'Google venue details could not be loaded right now.');
  assert.deepEqual(response, {
    status: 502,
    body: {
      error: 'Google venue details could not be loaded right now.',
      code: 'upstream_unavailable',
    },
  });
  const sanitized = safePublicError(502, 'private project or key detail');
  assert.equal(sanitized.body.error, 'Upstream service unavailable.');
  assert.equal(JSON.stringify(sanitized).includes('private project or key detail'), false);
  assert.equal(safePublicError(429, 'Try again later.').body.code, 'rate_limited');
  assert.equal(safePublicError(504, 'Try again later.').body.code, 'upstream_timeout');
});

test('public seed status omits operational schedule, limits, and cluster names', () => {
  assert.deepEqual(publicSeedStatus(), {
    service: 'panda-london-index',
    status: 'available',
  });
});

test('public photo and venue handlers enable the shared rate limiter', async () => {
  const [venueLive, venuePhotos, placePhoto] = await Promise.all([
    readApi('_venue-live.js'),
    readApi('_venue-photos.js'),
    readApi('place-photo.js'),
  ]);
  assert.match(venueLive, /applyVenueGuard\(req,\s*res,\s*\{\s*limit\s*=\s*true\s*\}/);
  assert.match(venuePhotos, /methods:\s*\['GET',\s*'OPTIONS'\],\s*limit:\s*true/);
  assert.match(placePhoto, /methods:\s*\['GET',\s*'OPTIONS'\],\s*limit:\s*true/);
});

test('every low-level Places and Routes call is budgeted before provider fetch', async () => {
  const venueLive = await readApi('_venue-live.js');
  assert.equal((venueLive.match(/^\s*'places',\s*$/gm) || []).length, 4);
  assert.equal((venueLive.match(/^\s*'routes',\s*$/gm) || []).length, 3);
  assert.match(venueLive, /consumeDailyBudget\(budgetStore \|\| db\(\), budgetKind, limit\)/);
  assert.match(venueLive, /process\.env\.PANDA_DAILY_ROUTES_LIMIT/);
});

test('photo metadata requests use memory and shared caches before Google', async () => {
  const [venuePhotos, placePhoto] = await Promise.all([
    readApi('_venue-photos.js'),
    readApi('place-photo.js'),
  ]);
  assert.match(venuePhotos, /if \(!refresh && cached && cached\.expiresAt > Date\.now\(\)\) return cached\.photos/);
  assert.match(venuePhotos, /const shared = await readSharedVenuePhotos\(placeId\)/);
  assert.match(venuePhotos, /await writeSharedVenuePhotos\(placeId, photos\)/);
  assert.match(venuePhotos, /process\.env\.PANDA_DAILY_PLACES_LIMIT/);
  assert.match(venuePhotos, /process\.env\.PANDA_DAILY_PHOTO_LIMIT/);
  assert.match(venuePhotos, /retries:\s*0/);
  assert.match(placePhoto, /retries:\s*0/);
});

test('Banging paid Places and route calls require configured shared budgets', async () => {
  const banging = await readApi('_banging-directory.js');
  assert.match(banging, /export async function withBangingRouteElementBudget/);
  assert.match(banging, /configuredDailyLimit\(process\.env\.PANDA_BANGING_DAILY_ROUTE_ELEMENTS\)/);
  assert.match(banging, /await withBangingRouteElementBudget\(chunk\.length\)/);
  assert.doesNotMatch(banging, /withBudget\('places'\)/);
  assert.match(banging, /bypassCache:\s*true/);
});

test('venue routes do not pass raw transit/provider error messages to clients', async () => {
  const [venueLive, transit, venuePhotos] = await Promise.all([
    readApi('_venue-live.js'),
    readApi('partner/venues/[placeId]/transit.js'),
    readApi('_venue-photos.js'),
  ]);
  assert.match(venueLive, /safePublicError\(error\?\.status,\s*fallbackMessage\)/);
  assert.doesNotMatch(transit, /json\(\{\s*error:\s*error\.message\s*\}\)/);
  assert.match(venuePhotos, /safePublicError\(error\?\.status,\s*'Google venue photos are unavailable right now\.'\)/);
});
