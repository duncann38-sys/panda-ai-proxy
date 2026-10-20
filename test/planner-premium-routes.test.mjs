import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const live = fs.readFileSync(new URL('../api/_venue-live.js', import.meta.url), 'utf8');
const transit = fs.readFileSync(new URL('../api/partner/venues/[placeId]/transit.js', import.meta.url), 'utf8');
const banging = fs.readFileSync(new URL('../api/_banging-directory.js', import.meta.url), 'utf8');
const origin = { latitude: 51.48, longitude: -0.14 };
const id = 'ChIJpaidAlpha1';
const plain = value => JSON.parse(JSON.stringify(value));
const stripExports = source => source.replace(/\bexport (?:default )?/g, '');
const globals = { AbortSignal, console, Date, Math, Map, Set, Number, Promise };
const error = (message, status) => Object.assign(new Error(message), { status });

function routeContext(googleJson) {
  const source = live.slice(live.indexOf('const walkingRouteCache = new Map();'));
  return vm.runInNewContext(`${stripExports(source)}
    ;({ getWalkingRoute, getTransitRoute, getBangingTransitDurations })`, {
    ...globals, googleJson, GOOGLE_ROUTES_URL: 'https://routes.googleapis.com/directions/v2:computeRoutes',
    apiKey: () => 'test-only', requestError: error,
    isValidPlaceId: value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(value),
    recordCostEvent() {}, chooseTransitRoute: routes => routes[0],
  });
}

test('walking routes accept a Place ID directly, retain coordinate routing and share successful proofs', async () => {
  const requests = [];
  const routes = routeContext(async (_, options) => {
    requests.push(options);
    return { routes: [{ duration: '600s', distanceMeters: 550, polyline: { encodedPolyline: 'real-provider-polyline' } }] };
  });
  const signal = AbortSignal.timeout(1000);
  const result = await routes.getWalkingRoute(origin, { placeId: id }, { signal });
  assert.equal(result.durationMinutes, 10);
  assert.equal(result.source, 'google_routes');
  assert.equal(requests[0].signal, signal);
  assert.deepEqual(JSON.parse(requests[0].body).destination, { placeId: id });
  await routes.getWalkingRoute(origin, { placeId: id });
  assert.equal(requests.length, 1);
  const destination = { latitude: 51.49, longitude: -0.13 };
  await routes.getWalkingRoute(origin, destination);
  assert.deepEqual(JSON.parse(requests[1].body).destination, { location: { latLng: destination } });
  await assert.rejects(routes.getWalkingRoute(origin, { placeId: 'invalid' }), /valid Google venue/);
});

test('transit and matrix requests address real Google Place IDs without a Place Details lookup', async () => {
  const requests = [];
  const routes = routeContext(async (url, options) => {
    requests.push({ url, options });
    if (url.includes('computeRouteMatrix')) {
      return [{ originIndex: 0, destinationIndex: 0, duration: '1200s', condition: 'ROUTE_EXISTS', status: {} },
        { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_NOT_FOUND', status: { code: 5 } }];
    }
    throw new Error('request-captured');
  });
  await assert.rejects(routes.getTransitRoute(origin, { placeId: id }, { includeLive: false }), /request-captured/);
  assert.deepEqual(JSON.parse(requests[0].options.body).destination, { placeId: id });
  assert.equal(JSON.parse(requests[0].options.body).travelMode, 'TRANSIT');
  const times = await routes.getBangingTransitDurations(origin, [{ placeId: id }, { placeId: 'ChIJpaidBeta22' }]);
  assert.deepEqual(plain(times), [20, null]);
  assert.deepEqual(JSON.parse(requests[1].options.body).destinations[0], { waypoint: { placeId: id } });
});

const realTransit = minutes => ({
  durationMinutes: minutes, polyline: 'verified-route', steps: [{
    mode: 'TRANSIT', departureStop: 'Start', arrivalStop: 'Finish',
    departureLocation: origin, arrivalLocation: { latitude: 51.5, longitude: -0.12 },
  }],
});

async function callTransit({ planner = true, max = 60, walk = 10, ride = 20, walkError } = {}) {
  let profiles = 0, transitCalls = 0;
  const source = transit.replace(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';\s*/m, '');
  const name = source.match(/export default async function (\w+)/)[1];
  const handler = vm.runInNewContext(`${stripExports(source)};${name}`, {
    ...globals, applyVenueGuard: () => false, isValidPlaceId: () => true,
    readCoordinates: () => origin,
    getVenueProfile: async () => { profiles++; return { latitude: 51.49, longitude: -0.12 }; },
    getWalkingRoute: async (_, destination, options) => {
      assert.equal(Boolean(destination.placeId), planner);
      assert.equal(Boolean(options.signal), planner);
      if (walkError) throw walkError;
      return walk == null ? null : { durationMinutes: walk, distanceMeters: 800 };
    },
    getTransitRoute: async (_, destination, options) => {
      transitCalls++;
      assert.equal(Boolean(destination.placeId), planner);
      assert.equal(options.includeLive, !planner);
      return ride == null ? null : realTransit(ride);
    },
    sendVenueError: (res, cause) => res.status(cause.status || 502).json({ error: cause.message }),
  });
  const response = { code: 200, setHeader() {}, status(code) { this.code = code; return this; },
    json(body) { this.body = plain(body); return this; } };
  await handler({ method: 'GET', query: { placeId: id, ...(planner ? { planner: '1', max_minutes: String(max) } : {}) } }, response);
  return { response, profiles, transitCalls };
}

test('nearby planner journeys return actual walking proof without profile or transit calls', async () => {
  const result = await callTransit();
  assert.equal(result.profiles, 0);
  assert.equal(result.transitCalls, 0);
  assert.equal(result.response.code, 200);
  assert.equal(result.response.body.directWalk.durationMinutes, 10);
});

test('longer planner journeys use real transit and preserve both 60- and 40-minute limits', async () => {
  const valid = await callTransit({ walk: 70, ride: 35, max: 40 });
  assert.equal(valid.profiles, 0);
  assert.equal(valid.response.code, 200);
  assert.equal(valid.response.body.transitRoute.durationMinutes, 35);
  assert.equal(valid.response.body.source, 'google_routes');
  for (const max of [40, 60]) {
    const invalid = await callTransit({ walk: 80, ride: max + 1, max });
    assert.equal(invalid.response.code, 404);
  }
});

test('normal venue transit keeps its original profile lookup and coordinate-based behavior', async () => {
  const result = await callTransit({ planner: false });
  assert.equal(result.profiles, 1);
  assert.equal(result.response.code, 200);
});

test('route quota denial is explicit and never starts a second provider request', async () => {
  const result = await callTransit({ walkError: error('daily route quota exhausted', 429) });
  assert.equal(result.response.code, 429);
  assert.equal(result.transitCalls, 0);
});

test('planner requests use one bounded deadline without changing other route requests', () => {
  assert.match(transit, /planner \? AbortSignal\.timeout\(13_000\) : undefined/);
  assert.match(live, /signal: options\.signal \?\? AbortSignal\.timeout\(10_000\)/);
});

function bangingContext({ denyWalk = false, walkDistance, paidMinutes = 15 } = {}) {
  const now = Date.now();
  const source = banging.slice(banging.indexOf('export function premiumPlacements('));
  const globalsForBanging = {
    ...globals, TTL: 3 * 60 * 60 * 1000, error, meters: () => 0,
    directory: async () => ({ value: [{ id: 'organic' }], ts: now }),
    activePlacements: async () => ({ value: [{ place_id: id, tier: 'banging' },
      { place_id: 'ChIJpaidBeta22', tier: 'banging' }, { place_id: 'ChIJdiscovery', tier: 'discovery' }], ts: now }),
    refresh: async (_, loader) => ({ value: await loader(), ts: now }),
    withBudget: async () => {},
    getBangingTransitDurations: async (_, destinations) => destinations.map((v, index) =>
      v.placeId ? index === 0 ? paidMinutes : null : 30),
    getWalkingRoute: async () => {
      if (walkDistance != null) return { distanceMeters: walkDistance, durationMinutes: 3 };
      throw error('unavailable', denyWalk ? 429 : 502);
    },
  };
  return vm.runInNewContext(`${stripExports(source)};({premiumPlacements,getBangingDirectory})`, globalsForBanging);
}

test('only active paid Banging IDs receive Premium travel verification; Discovery and duplicates stay out', () => {
  const { premiumPlacements } = bangingContext();
  assert.deepEqual(plain(premiumPlacements([id, id, 'discovery', 'inactive'], [
    { place_id: id, tier: 'banging' }, { place_id: 'discovery', tier: 'discovery' },
  ])), [{ id }]);
  assert.doesNotMatch(banging, /\bgetVenueProfile\b/);
});

test('one unavailable Premium walking proof does not suppress other genuinely verified emerald cards', async () => {
  const { getBangingDirectory } = bangingContext();
  const body = await getBangingDirectory(origin, [id, 'ChIJpaidBeta22']);
  assert.equal(body.premiumVerification.requested, 2);
  assert.equal(body.premiumVerification.verified, 1);
  assert.equal(body.premiumJourneys[id].bangingTransitMinutes, 16);
  assert.equal(body.premiumJourneys.ChIJpaidBeta22, undefined);
  assert.equal(body.results.length, 1);
});

test('Premium fallback still obeys route budgets and never hides a 429 quota denial', async () => {
  await assert.rejects(bangingContext({ denyWalk: true }).getBangingDirectory(origin, [id, 'ChIJpaidBeta22']),
    /unavailable/);
  assert.match(banging, /await withBudget\('routes', 1\)/);
  assert.match(banging, /walking\.distanceMeters <= 250/);
  assert.match(banging, /minutes \+ accessMinutes <= 120/);
});

test('Premium without a transit leg requires a real walk of no more than 250 metres', async () => {
  const near = await bangingContext({ walkDistance: 250 }).getBangingDirectory(origin, [id, 'ChIJpaidBeta22']);
  assert.equal(near.premiumVerification.verified, 2);
  const far = await bangingContext({ walkDistance: 251 }).getBangingDirectory(origin, [id, 'ChIJpaidBeta22']);
  assert.equal(far.premiumVerification.verified, 1);
});

test('the Banging two-hour catchment includes the verified access leg', async () => {
  const valid = await bangingContext({ paidMinutes: 119 }).getBangingDirectory(origin, [id]);
  assert.equal(valid.premiumJourneys[id].bangingTransitMinutes, 120);
  const tooFar = await bangingContext({ paidMinutes: 120 }).getBangingDirectory(origin, [id]);
  assert.equal(tooFar.premiumVerification.verified, 0);
});
