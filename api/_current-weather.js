import { createHash, randomUUID } from 'node:crypto';
import { consumeWeatherBudget } from './_panda-chat-policy.js';

const CACHE_COLLECTION = 'panda_met_weather_cache_v1';
const SOURCE = 'MET Norway';
const ATTRIBUTION = 'Weather data from MET Norway, licensed under CC BY 4.0.';
const ATTRIBUTION_URL = 'https://creativecommons.org/licenses/by/4.0/';
const USER_AGENT = 'PandaAI/1.0 (https://github.com/duncann38-sys/panda-ai-proxy)';
const memoryCache = new Map();

function roundedCoordinate(value) {
  const rounded = Number(Number(value).toFixed(2));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function cacheKey(latitude, longitude) {
  return createHash('sha256')
    .update(`${latitude.toFixed(2)},${longitude.toFixed(2)}`)
    .digest('hex');
}

function isNordicArea(latitude, longitude) {
  return latitude >= 54.5 && latitude <= 72.5 && longitude >= 4 && longitude <= 32;
}

function responseHeader(headers, name) {
  try {
    return headers?.get?.(name) || '';
  } catch {
    return '';
  }
}

function minimumRequestIntervalMs(latitude, longitude) {
  return isNordicArea(latitude, longitude) ? 30 * 60_000 : 3 * 60 * 60_000;
}

function cacheLifetimeMs(headers, latitude, longitude, now) {
  const minimum = minimumRequestIntervalMs(latitude, longitude);
  const fallback = isNordicArea(latitude, longitude) ? 60 * 60_000 : 6 * 60 * 60_000;
  const cacheControl = responseHeader(headers, 'cache-control');
  const maxAge = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (maxAge) return Math.max(minimum, Number(maxAge[1]) * 1000);
  const expires = Date.parse(responseHeader(headers, 'expires'));
  if (Number.isFinite(expires)) return Math.max(minimum, expires - now);
  return fallback;
}

function conditionLabel(symbolCode) {
  const normalized = String(symbolCode || '')
    .replace(/_(?:day|night|polartwilight)$/, '')
    .replace(/_/g, ' ')
    .toLowerCase();
  const known = {
    clearsky: 'Clear sky',
    fair: 'Fair',
    partlycloudy: 'Partly cloudy',
    cloudy: 'Cloudy',
    fog: 'Fog',
    lightrain: 'Light rain',
    rain: 'Rain',
    heavyrain: 'Heavy rain',
    lightrainshowers: 'Light rain showers',
    rainshowers: 'Rain showers',
    heavyrainshowers: 'Heavy rain showers',
    lightsleet: 'Light sleet',
    sleet: 'Sleet',
    heavysleet: 'Heavy sleet',
    lightsnow: 'Light snow',
    snow: 'Snow',
    heavysnow: 'Heavy snow',
    lightsnowshowers: 'Light snow showers',
    snowshowers: 'Snow showers',
    heavysnowshowers: 'Heavy snow showers',
    lightrainandthunder: 'Light rain and thunder',
    rainandthunder: 'Rain and thunder',
    heavyrainandthunder: 'Heavy rain and thunder',
    lightsleetandthunder: 'Light sleet and thunder',
    sleetandthunder: 'Sleet and thunder',
    heavysleetandthunder: 'Heavy sleet and thunder',
    lightsnowandthunder: 'Light snow and thunder',
    snowandthunder: 'Snow and thunder',
    heavysnowandthunder: 'Heavy snow and thunder',
  };
  return known[normalized] || (normalized ? normalized.replace(/\b\w/g, letter => letter.toUpperCase()) : null);
}

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function forecastPoint(item) {
  const data = item?.data || {};
  const instant = data.instant?.details || {};
  const period = data.next_1_hours || data.next_6_hours || data.next_12_hours || data.next_24_hours;
  const temperatureC = numeric(instant.air_temperature);
  if (!item?.time || temperatureC === null) return null;
  return {
    time: item.time,
    temperatureC,
    condition: conditionLabel(period?.summary?.symbol_code),
    feelsLikeC: numeric(instant.air_temperature),
    windSpeedMps: numeric(instant.wind_speed),
    precipitationMm: numeric(period?.details?.precipitation_amount),
  };
}

function normalizeForecast(data) {
  const entries = data?.properties?.timeseries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const current = forecastPoint(entries[0]);
  if (!current) return null;
  const start = Date.parse(current.time);
  if (!Number.isFinite(start)) return null;
  const forecast = [];
  for (const entry of entries) {
    const point = forecastPoint(entry);
    if (!point) continue;
    const pointTime = Date.parse(point.time);
    if (!Number.isFinite(pointTime)) continue;
    const hours = Math.floor((pointTime - start) / 3_600_000);
    if (hours < 0 || hours > 7 * 24) continue;
    if (hours > 24 && forecast.length) {
      const previousTime = Date.parse(forecast[forecast.length - 1].time);
      if (Number.isFinite(previousTime) && pointTime - previousTime < 6 * 3_600_000) continue;
    }
    forecast.push(point);
    if (forecast.length >= 56) break;
  }
  return {
    forecastUpdatedAt: data.properties.meta?.updated_at || null,
    condition: current.condition,
    temperatureC: current.temperatureC,
    feelsLikeC: current.feelsLikeC,
    windSpeedMps: current.windSpeedMps,
    precipitationMm: current.precipitationMm,
    forecast,
    source: SOURCE,
    attribution: ATTRIBUTION,
    attributionUrl: ATTRIBUTION_URL,
  };
}

async function inspectCache(store, key, now) {
  const snapshot = await store.collection(CACHE_COLLECTION).doc(key).get();
  const value = snapshot?.exists ? snapshot.data() || {} : {};
  if (value.weather && Number(value.expiresAt) > now) {
    return { state: 'cached', weather: value.weather, expiresAt: Number(value.expiresAt) };
  }
  if (Number(value.nextAllowedAt) > now) {
    return { state: 'cooldown', until: Number(value.nextAllowedAt) };
  }
  return { state: 'empty' };
}

function remember(key, weather, expiresAt) {
  memoryCache.delete(key);
  memoryCache.set(key, { weather, expiresAt, cooldownUntil: 0 });
  while (memoryCache.size > 512) memoryCache.delete(memoryCache.keys().next().value);
}

function rememberCooldown(key, cooldownUntil) {
  memoryCache.delete(key);
  memoryCache.set(key, { weather: null, expiresAt: 0, cooldownUntil });
  while (memoryCache.size > 512) memoryCache.delete(memoryCache.keys().next().value);
}

async function claimRefresh(store, key, owner, now) {
  return store.runTransaction(async transaction => {
    const ref = store.collection(CACHE_COLLECTION).doc(key);
    const snapshot = await transaction.get(ref);
    const value = snapshot?.data?.() || {};
    if (value.weather && Number(value.expiresAt) > now) {
      return { state: 'cached', weather: value.weather, expiresAt: Number(value.expiresAt) };
    }
    if (Number(value.nextAllowedAt) > now) {
      return { state: 'cooldown', until: Number(value.nextAllowedAt) };
    }
    if (Number(value.refreshLeaseUntil) > now) return { state: 'busy' };
    transaction.set(ref, {
      refreshLeaseOwner: owner,
      refreshLeaseUntil: now + 30_000,
    }, { merge: true });
    return { state: 'owner' };
  });
}

async function finishRefresh(store, key, owner, { weather, expiresAt, now, cooldownMs = 0 }) {
  return store.runTransaction(async transaction => {
    const ref = store.collection(CACHE_COLLECTION).doc(key);
    const snapshot = await transaction.get(ref);
    const value = snapshot?.data?.() || {};
    if (value.refreshLeaseOwner !== owner) return false;
    if (weather) {
      transaction.set(ref, {
        weather,
        cachedAt: now,
        expiresAt,
        nextAllowedAt: expiresAt,
        lastAttemptAt: now,
        refreshLeaseOwner: null,
        refreshLeaseUntil: 0,
      }, { merge: true });
      return true;
    }
    transaction.set(ref, {
      nextAllowedAt: cooldownMs ? now + cooldownMs : 0,
      lastAttemptAt: cooldownMs ? now : null,
      refreshLeaseOwner: null,
      refreshLeaseUntil: 0,
    }, { merge: true });
    return true;
  });
}

export async function currentWeatherResponse({
  location,
  store,
  limit = 1000,
  fetchImpl = fetch,
  recordUsage = () => {},
  now = Date.now(),
}) {
  const rawLatitude = Number(location?.lat);
  const rawLongitude = Number(location?.lng);
  if (
    !Number.isFinite(rawLatitude)
    || !Number.isFinite(rawLongitude)
    || Math.abs(rawLatitude) > 90
    || Math.abs(rawLongitude) > 180
  ) {
    return { status: 400, body: { error: 'weather_location_required' } };
  }
  if (!store) return { status: 503, body: { error: 'weather_cache_unavailable' } };

  const latitude = roundedCoordinate(rawLatitude);
  const longitude = roundedCoordinate(rawLongitude);
  const key = cacheKey(latitude, longitude);
  const memoryEntry = memoryCache.get(key);
  if (memoryEntry?.expiresAt > now && memoryEntry.weather) {
    return { status: 200, body: { weather: memoryEntry.weather, cacheHit: true } };
  }
  if (memoryEntry?.cooldownUntil > now) {
    return { status: 503, body: { error: 'weather_unavailable' } };
  }

  const owner = randomUUID();
  let claim;
  try {
    claim = await claimRefresh(store, key, owner, now);
  } catch {
    return { status: 503, body: { error: 'weather_cache_unavailable' } };
  }
  if (claim.state === 'cached') {
    remember(key, claim.weather, claim.expiresAt);
    return { status: 200, body: { weather: claim.weather, cacheHit: true } };
  }
  if (claim.state === 'cooldown') {
    rememberCooldown(key, claim.until);
    return { status: 503, body: { error: 'weather_unavailable' } };
  }
  if (claim.state === 'busy') {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
      try {
        const state = await inspectCache(store, key, now + (attempt + 1) * 200);
        if (state.state === 'cached') {
          remember(key, state.weather, state.expiresAt);
          return { status: 200, body: { weather: state.weather, cacheHit: true } };
        }
        if (state.state === 'cooldown') {
          rememberCooldown(key, state.until);
          return { status: 503, body: { error: 'weather_unavailable' } };
        }
      } catch {
        return { status: 503, body: { error: 'weather_cache_unavailable' } };
      }
    }
    return { status: 503, body: { error: 'weather_refresh_in_progress' } };
  }

  const allowed = await consumeWeatherBudget(store, limit, new Date(now));
  if (!allowed) {
    try {
      await finishRefresh(store, key, owner, { now });
    } catch {
      return { status: 503, body: { error: 'weather_cache_unavailable' } };
    }
    return { status: 429, body: { error: 'weather_daily_limit_reached' } };
  }

  try {
    const url = new URL('https://api.met.no/weatherapi/locationforecast/2.0/compact');
    url.search = new URLSearchParams({
      lat: latitude.toFixed(2),
      lon: longitude.toFixed(2),
    });
    recordUsage('weather_provider_call');
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const cooldownMs = minimumRequestIntervalMs(latitude, longitude);
      await finishRefresh(store, key, owner, { now, cooldownMs });
      rememberCooldown(key, now + cooldownMs);
      return { status: 502, body: { error: 'weather_unavailable' } };
    }
    const data = await response.json();
    const weather = normalizeForecast(data);
    if (!weather) {
      const cooldownMs = minimumRequestIntervalMs(latitude, longitude);
      await finishRefresh(store, key, owner, { now, cooldownMs });
      rememberCooldown(key, now + cooldownMs);
      return { status: 502, body: { error: 'weather_unavailable' } };
    }
    const expiresAt = now + cacheLifetimeMs(response.headers, latitude, longitude, now);
    const stored = await finishRefresh(store, key, owner, { weather, expiresAt, now });
    if (!stored) return { status: 503, body: { error: 'weather_cache_unavailable' } };
    remember(key, weather, expiresAt);
    return { status: 200, body: { weather, cacheHit: false } };
  } catch {
    const cooldownMs = minimumRequestIntervalMs(latitude, longitude);
    try {
      await finishRefresh(store, key, owner, { now, cooldownMs });
      rememberCooldown(key, now + cooldownMs);
    } catch {
      // The refresh lease still bounds retries if shared storage becomes unavailable.
    }
    return { status: 502, body: { error: 'weather_unavailable' } };
  }
}
