import test from 'node:test';
import assert from 'node:assert/strict';
import { currentWeatherResponse, weatherFallbackSummary } from '../api/_current-weather.js';

function makeStore(initialRequests = 0) {
  let requests = initialRequests;
  let transactionQueue = Promise.resolve();
  const cache = new Map();
  return {
    get requests() { return requests; },
    cache,
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              const value = cache.get(`${name}/${id}`);
              return { exists: Boolean(value), data: () => value };
            },
            async set(value) {
              cache.set(`${name}/${id}`, { ...(cache.get(`${name}/${id}`) || {}), ...value });
            },
            name,
            id,
            key: `${name}/${id}`,
          };
        },
      };
    },
    runTransaction(callback) {
      const operation = transactionQueue.then(() => callback({
        async get(ref) {
          const value = ref.name === 'panda_weather_usage_v1' ? { requests } : cache.get(ref.key);
          return { exists: Boolean(value), data: () => value || {} };
        },
        set(ref, value) {
          if (ref.name === 'panda_weather_usage_v1') requests = value.requests;
          else cache.set(ref.key, { ...(cache.get(ref.key) || {}), ...value });
        },
      }));
      transactionQueue = operation.catch(() => {});
      return operation;
    },
  };
}

const location = { lat: 51.5074, lng: -0.1278 };
const sampleForecast = {
  properties: {
    meta: { updated_at: '2026-11-20T11:20:00Z' },
    timeseries: [
      {
        time: '2026-11-20T11:00:00Z',
        data: {
          instant: { details: { air_temperature: 8.2, wind_speed: 3.8 } },
          next_1_hours: { summary: { symbol_code: 'partlycloudy_day' }, details: { precipitation_amount: 0 } },
        },
      },
      {
        time: '2026-11-20T12:00:00Z',
        data: {
          instant: { details: { air_temperature: 8.5, wind_speed: 4.1 } },
          next_1_hours: { summary: { symbol_code: 'lightrain' }, details: { precipitation_amount: 0.4 } },
        },
      },
    ],
  },
};

test('weather uses MET Norway with a contactable User-Agent, short coordinates and attribution', async () => {
  const store = makeStore();
  const usage = [];
  let requestedUrl;
  let requestedOptions;
  const result = await currentWeatherResponse({
    location,
    store,
    now: Date.parse('2026-11-20T11:22:00Z'),
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url);
      requestedOptions = options;
      return {
        ok: true,
        headers: { get: name => name.toLowerCase() === 'expires' ? 'Fri, 20 Nov 2026 11:53:36 GMT' : null },
        async json() { return sampleForecast; },
      };
    },
    recordUsage: event => usage.push(event),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.weather.source, 'MET Norway');
  assert.match(result.body.weather.attribution, /MET Norway.*CC BY 4\.0/);
  assert.equal(result.body.weather.attributionUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(result.body.weather.temperatureC, 8.2);
  assert.equal(result.body.weather.condition, 'Partly cloudy');
  assert.equal(result.body.weather.forecast[1].precipitationMm, 0.4);
  assert.equal(requestedUrl.origin, 'https://api.met.no');
  assert.equal(requestedUrl.searchParams.get('lat'), '51.51');
  assert.equal(requestedUrl.searchParams.get('lon'), '-0.13');
  assert.match(requestedOptions.headers['User-Agent'], /PandaAI.*github\.com\/duncann38-sys\/panda-ai-proxy/);
  assert.equal(store.requests, 1);
  assert.ok([...store.cache.values()][0].expiresAt >= Date.parse('2026-11-20T14:22:00Z'));
  assert.deepEqual(usage, ['weather_provider_call']);
});

test('weather keeps a full ten-day MET Norway horizon with six-hour samples after the first day', async () => {
  const store = makeStore();
  const start = Date.parse('2026-11-20T11:23:00Z');
  const forecast = Array.from({ length: 360 }, (_, index) => ({
    time: new Date(start + index * 60 * 60_000).toISOString(),
    data: {
      instant: { details: { air_temperature: 5 + (index % 8), wind_speed: 3 } },
      next_1_hours: { summary: { symbol_code: 'partlycloudy_day' }, details: { precipitation_amount: 0.1 } },
    },
  }));
  const result = await currentWeatherResponse({
    location: { lat: 59.9139, lng: 10.7522 },
    store,
    now: start,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      async json() { return { properties: { timeseries: forecast } }; },
    }),
  });

  assert.equal(result.status, 200);
  const points = result.body.weather.forecast;
  const horizonHours = (Date.parse(points.at(-1).time) - Date.parse(points[0].time)) / 3_600_000;
  assert.equal(horizonHours, 240);
  assert.ok(points.length >= 60 && points.length <= 62);
});

test('weather fallback summarizes the next calendar week when source coverage reaches it', () => {
  const start = Date.parse('2026-11-20T19:00:00Z');
  const forecast = Array.from({ length: 41 }, (_, index) => ({
    time: new Date(start + index * 6 * 60 * 60_000).toISOString(),
    temperatureC: index % 2 === 0 ? -2 : 5,
    condition: index % 2 === 0 ? 'Clear sky' : 'Partly cloudy',
    precipitationMm: index % 3 === 0 ? 0.4 : 0,
  }));
  const text = weatherFallbackSummary({
    condition: 'Clear sky',
    temperatureC: 1,
    forecast,
  }, 'Oslo', 'How is the weather in Oslo next week?');

  assert.match(text, /In Oslo.*next week \(Mon 23 Nov–Sun 29 Nov \(UTC\)\)/);
  assert.match(text, /-2°C to 5°C/);
  assert.match(text, /Rain is indicated in some forecast periods/);
  assert.match(text, /not a station observation/);
  assert.match(text, /🌧️|🌤️|❄️|🌦️/);
});

test('weather fallback refuses a full-week claim when forecast coverage stops early', () => {
  const start = Date.parse('2026-11-20T19:00:00Z');
  const forecast = Array.from({ length: 9 }, (_, index) => ({
    time: new Date(start + index * 6 * 60 * 60_000).toISOString(),
    temperatureC: 1,
    condition: 'Clear sky',
    precipitationMm: 0,
  }));
  const text = weatherFallbackSummary({
    condition: 'Clear sky',
    temperatureC: 1,
    forecast,
  }, 'Oslo', 'How is the weather in Oslo next week?');

  assert.match(text, /does not cover the full next-week window/);
  assert.doesNotMatch(text, /model forecast for next week \(Mon 23 Nov/);
});

test('weather cache is reused before spending the shared daily allowance', async () => {
  const store = makeStore();
  const cacheLocation = { lat: -33.8688, lng: 151.2093 };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      headers: { get: () => null },
      async json() { return sampleForecast; },
    };
  };
  const first = await currentWeatherResponse({ location: cacheLocation, store, now: 1000, fetchImpl });
  const second = await currentWeatherResponse({
    location: { lat: -33.86881, lng: 151.20931 },
    store,
    now: 2000,
    fetchImpl,
  });

  assert.equal(first.status, 200);
  assert.equal(first.body.cacheHit, false);
  assert.equal(second.status, 200);
  assert.equal(second.body.cacheHit, true);
  assert.equal(calls, 1);
  assert.equal(store.requests, 1);
  const cached = [...store.cache.values()][0];
  assert.equal(Object.hasOwn(cached, 'latitude'), false);
  assert.equal(Object.hasOwn(cached, 'longitude'), false);
});

test('invalid coordinates are rejected before touching the budget or provider', async () => {
  const store = makeStore();
  let fetched = false;
  const result = await currentWeatherResponse({
    location: { lat: 91, lng: -0.17 },
    store,
    fetchImpl: async () => { fetched = true; },
  });
  assert.equal(result.status, 400);
  assert.equal(store.requests, 0);
  assert.equal(fetched, false);
});

test('weather stops at the configured shared daily limit without calling MET Norway', async () => {
  const store = makeStore(1000);
  let fetched = false;
  const result = await currentWeatherResponse({
    location: { lat: -1.2921, lng: 36.8219 },
    store,
    limit: 1000,
    fetchImpl: async () => { fetched = true; },
  });
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, { error: 'weather_daily_limit_reached' });
  assert.equal(store.requests, 1000);
  assert.equal(fetched, false);
});

test('provider failures return unavailable rather than guessing', async () => {
  const store = makeStore();
  let calls = 0;
  const result = await currentWeatherResponse({
    location: { lat: 35.6762, lng: 139.6503 },
    store,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        headers: { get: () => null },
        async json() { return { error: { message: 'private provider detail' } }; },
      };
    },
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { error: 'weather_unavailable' });
  const retry = await currentWeatherResponse({
    location: { lat: 35.6762, lng: 139.6503 },
    store,
    now: Date.now() + 1,
    fetchImpl: async () => { calls += 1; },
  });
  assert.equal(retry.status, 503);
  assert.equal(calls, 1);
});

test('concurrent identical misses share one MET Norway request', async () => {
  const store = makeStore();
  const concurrentLocation = { lat: 25.2048, lng: 55.2708 };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 80));
    return {
      ok: true,
      headers: { get: () => null },
      async json() { return sampleForecast; },
    };
  };
  const results = await Promise.all([
    currentWeatherResponse({ location: concurrentLocation, store, fetchImpl }),
    currentWeatherResponse({ location: concurrentLocation, store, fetchImpl }),
  ]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(calls, 1);
  assert.equal(store.requests, 1);
});
