import test from 'node:test';
import assert from 'node:assert/strict';
import { createVenueWeatherHandler, fetchGoogleCurrentWeather, normalizeGoogleWeather } from '../api/partner/venues/[placeId]/weather.js';

const placeId = 'ChIJ1234567890';
const sample = { currentTime: '2026-11-23T10:00:00Z', weatherCondition: { description: { text: 'Light rain' } }, temperature: { degrees: 12.4 } };
function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('normalizes Google current conditions without adding another provider label', () => {
  assert.deepEqual(normalizeGoogleWeather(sample), {
    observedAt: sample.currentTime, condition: 'Light rain', temperatureC: 12.4, emoji: '🌧️',
  });
  assert.equal(normalizeGoogleWeather({}), null);
  assert.equal(normalizeGoogleWeather({ ...sample, temperature: { degrees: null } }), null);
});

test('requests metric Google weather for the venue coordinates', async () => {
  let requestedUrl;
  const weather = await fetchGoogleCurrentWeather(51.5, -0.12, {
    apiKey: 'test-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return { ok: true, json: async () => sample }; },
  });
  assert.equal(requestedUrl.origin, 'https://weather.googleapis.com');
  assert.equal(requestedUrl.pathname, '/v1/currentConditions:lookup');
  assert.equal(requestedUrl.searchParams.get('location.latitude'), '51.5');
  assert.equal(requestedUrl.searchParams.get('location.longitude'), '-0.12');
  assert.equal(requestedUrl.searchParams.get('unitsSystem'), 'METRIC');
  assert.deepEqual(weather, normalizeGoogleWeather(sample));
});

test('returns venue weather and caches the Google request', async () => {
  let requests = 0;
  const cache = new Map();
  const handler = createVenueWeatherHandler({
    profileLookup: async () => ({ latitude: 51.5, longitude: -0.12 }),
    apiKey: 'test-key',
    cache,
    fetchImpl: async () => { requests += 1; return { ok: true, json: async () => sample }; },
  });
  const first = makeResponse();
  const second = makeResponse();
  await handler({ query: { placeId } }, first);
  await handler({ query: { placeId } }, second);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(first.body, normalizeGoogleWeather(sample));
  assert.equal(requests, 1);
  assert.match(first.headers['Cache-Control'], /s-maxage=900/);
});

test('rejects invalid place ids and venues without coordinates', async () => {
  let lookups = 0;
  const handler = createVenueWeatherHandler({
    profileLookup: async () => { lookups += 1; return { latitude: null, longitude: null }; },
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  const invalid = makeResponse();
  await handler({ query: { placeId: 'bad' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  const missing = makeResponse();
  await handler({ query: { placeId } }, missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(lookups, 1);
});

test('fails safely when Google does not return usable weather', async () => {
  const handler = createVenueWeatherHandler({
    profileLookup: async () => ({ latitude: 51.5, longitude: -0.12 }),
    apiKey: 'test-key',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: 'private provider detail' }) }),
  });
  const res = makeResponse();
  await handler({ query: { placeId } }, res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'Current weather is unavailable right now.' });
});
