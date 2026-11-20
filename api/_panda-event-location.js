import { extractEventArea } from './_panda-event-search.js';

const EVENT_AREA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const EVENT_AREA_CACHE_LIMIT = 128;
const eventAreaCache = new Map();

function firstComponent(components, typeNames) {
  const found = components.find(component =>
    Array.isArray(component?.types) && component.types.some(type => typeNames.includes(type)),
  );
  return typeof found?.long_name === 'string' ? found.long_name.trim() : '';
}

function localAreaFromResults(results) {
  for (const result of Array.isArray(results) ? results : []) {
    const components = Array.isArray(result?.address_components) ? result.address_components : [];
    const locality = firstComponent(components, ['locality', 'postal_town', 'administrative_area_level_3', 'administrative_area_level_2']);
    const region = firstComponent(components, ['administrative_area_level_1']);
    const country = firstComponent(components, ['country']);
    const area = [...new Set([locality, region, country].filter(Boolean))].join(', ');
    if (area) return area;
  }
  return '';
}

export async function resolveEventSearchArea({
  text,
  location,
  apiKey,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const explicitArea = extractEventArea(text);
  if (explicitArea) return { area: explicitArea, source: 'explicit' };

  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  if (!apiKey || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { area: '', source: 'unavailable' };
  }

  // Round to roughly kilometre scale: enough to identify a city, without sending
  // a precise device position to the geocoder or live-search model.
  const coarseLat = Math.round(lat * 100) / 100;
  const coarseLng = Math.round(lng * 100) / 100;
  const key = `${coarseLat},${coarseLng}`;
  const cached = eventAreaCache.get(key);
  if (cached && now - cached.savedAt < EVENT_AREA_CACHE_TTL_MS) {
    eventAreaCache.delete(key);
    eventAreaCache.set(key, cached);
    return { area: cached.area, source: 'device-location' };
  }
  if (cached) eventAreaCache.delete(key);

  try {
    const latlng = encodeURIComponent(`${coarseLat.toFixed(2)},${coarseLng.toFixed(2)}`);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latlng}&result_type=locality%7Cpostal_town%7Cadministrative_area_level_1&key=${apiKey}`;
    const response = await fetchImpl(url);
    if (!response.ok) return { area: '', source: 'unavailable' };
    const data = await response.json();
    const area = localAreaFromResults(data?.results);
    if (!area) return { area: '', source: 'unavailable' };

    eventAreaCache.set(key, { area, savedAt: now });
    if (eventAreaCache.size > EVENT_AREA_CACHE_LIMIT) {
      eventAreaCache.delete(eventAreaCache.keys().next().value);
    }
    return { area, source: 'device-location' };
  } catch {
    return { area: '', source: 'unavailable' };
  }
}

export function clearEventAreaCacheForTests() {
  eventAreaCache.clear();
}
