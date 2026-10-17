import test from 'node:test';
import assert from 'node:assert/strict';
import { currentWeatherResponse } from '../api/_current-weather.js';

function makeStore(initialRequests = 0) {
  let requests = initialRequests;
  return {
    get requests() { return requests; },
    collection() {
      return { doc() { return {}; } };
    },
    async runTransaction(callback) {
      return callback({
        async get() {
          return { data: () => ({ requests }) };
        },
        set(_ref, value) {
          requests = value.requests;
        },
      });
    },
  };
}

const location = { lat: 51.47, lng: -0.17 };

test('current weather returns real conditions and counts within the shared daily allowance', async () => {
  const store = makeStore();
  const usage = [];
  let requestedUrl;
  const result = await currentWeatherResponse({
    location,
    store,
    apiKey: 'test-key',
    fetchImpl: async url => {
      requestedUrl = new URL(url);
      return {
        ok: true,
        async json() {
          return {
            currentTime: '2026-10-17T12:00:00Z',
            weatherCondition: { description: { text: 'Light rain' } },
            temperature: { degrees: 12.4 },
          };
        },
      };
    },
    recordUsage: event => usage.push(event),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.weather, {
    observedAt: '2026-10-17T12:00:00Z',
    condition: 'Light rain',
    temperatureC: 12.4,
    source: 'Google Weather',
  });
  assert.equal(requestedUrl.searchParams.get('location.latitude'), '51.47');
  assert.equal(requestedUrl.searchParams.get('location.longitude'), '-0.17');
  assert.equal(store.requests, 1);
  assert.deepEqual(usage, ['weather_provider_call']);
});

test('current weather rejects invalid coordinates before spending the daily allowance', async () => {
  const store = makeStore();
  let fetched = false;
  const result = await currentWeatherResponse({
    location: { lat: 91, lng: -0.17 },
    store,
    apiKey: 'test-key',
    fetchImpl: async () => { fetched = true; },
  });

  assert.equal(result.status, 400);
  assert.equal(store.requests, 0);
  assert.equal(fetched, false);
});

test('current weather stops at the shared daily limit without calling Google', async () => {
  const store = makeStore(25);
  let fetched = false;
  const result = await currentWeatherResponse({
    location,
    store,
    apiKey: 'test-key',
    fetchImpl: async () => { fetched = true; },
  });

  assert.equal(result.status, 429);
  assert.deepEqual(result.body, { error: 'weather_daily_limit_reached' });
  assert.equal(store.requests, 25);
  assert.equal(fetched, false);
});

test('current weather returns unavailable rather than guessing when Google fails', async () => {
  const result = await currentWeatherResponse({
    location,
    store: makeStore(),
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: false,
      async json() { return { error: { message: 'private provider detail' } }; },
    }),
  });

  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { error: 'weather_unavailable' });
});
