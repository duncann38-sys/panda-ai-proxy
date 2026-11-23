import { applyVenueGuard, getVenueProfile, isValidPlaceId } from '../../../_venue-live.js';

const CACHE_TTL_MS = 15 * 60_000;
const MAX_CACHE_ENTRIES = 300;
const weatherCache = new Map();

function weatherEmoji(condition) {
  const normalized = condition.toLowerCase();
  if (["snow", "sleet", "ice", "hail", "blizzard"].some((word) => normalized.includes(word))) return "❄️";
  if (["thunder", "storm", "rain", "shower", "drizzle"].some((word) => normalized.includes(word))) return "🌧️";
  if (["clear", "sun"].some((word) => normalized.includes(word))) return "☀️";
  if (["cloud", "overcast", "fog", "mist"].some((word) => normalized.includes(word))) return "☁️";
  return "🌤️";
}

export function normalizeGoogleWeather(data) {
  const observedAt = typeof data?.currentTime === "string" ? data.currentTime : "";
  const condition = typeof data?.weatherCondition?.description?.text === "string"
    ? data.weatherCondition.description.text.trim()
    : "";
  const rawTemperatureC = data?.temperature?.degrees;
  const temperatureC = typeof rawTemperatureC === "number" ? rawTemperatureC : Number.NaN;
  if (!observedAt || !Number.isFinite(Date.parse(observedAt)) || !condition || !Number.isFinite(temperatureC)) return null;
  return { observedAt, condition, temperatureC, emoji: weatherEmoji(condition) };
}

export async function fetchGoogleCurrentWeather(latitude, longitude, { apiKey, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    const error = new Error("Current weather is unavailable right now.");
    error.status = 503;
    throw error;
  }
  const url = new URL("https://weather.googleapis.com/v1/currentConditions:lookup");
  url.search = new URLSearchParams({
    key: apiKey.trim(),
    "location.latitude": String(latitude),
    "location.longitude": String(longitude),
    unitsSystem: "METRIC",
  }).toString();
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(4_000) });
  } catch {
    const error = new Error("Current weather is unavailable right now.");
    error.status = 503;
    throw error;
  }
  if (!response.ok) {
    const error = new Error("Current weather is unavailable right now.");
    error.status = response.status === 429 ? 503 : 502;
    throw error;
  }
  const data = await response.json().catch(() => null);
  const weather = normalizeGoogleWeather(data);
  if (!weather) {
    const error = new Error("Current weather is unavailable right now.");
    error.status = 502;
    throw error;
  }
  return weather;
}

export function createVenueWeatherHandler({
  profileLookup = getVenueProfile,
  fetchImpl = fetch,
  apiKey = () => process.env.GOOGLE_MAPS_API_KEY,
  now = () => Date.now(),
  cache = new Map(),
} = {}) {
  return async function venueWeatherHandler(req, res) {
    const placeId = req.query?.placeId;
    if (!isValidPlaceId(placeId)) return res.status(400).json({ error: "Choose a valid Google venue." });

    const cached = cache.get(placeId);
    if (cached && cached.expiresAt > now()) {
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=900, stale-while-revalidate=3600");
      return res.status(200).json(cached.weather);
    }

    try {
      const profile = await profileLookup(placeId);
      if (!profile || !Number.isFinite(profile.latitude) || !Number.isFinite(profile.longitude)) {
        return res.status(404).json({ error: "Google does not have coordinates for this venue." });
      }
      const key = typeof apiKey === "function" ? apiKey() : apiKey;
      const weather = await fetchGoogleCurrentWeather(profile.latitude, profile.longitude, { apiKey: key, fetchImpl });
      cache.set(placeId, { weather, expiresAt: now() + CACHE_TTL_MS });
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=900, stale-while-revalidate=3600");
      return res.status(200).json(weather);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 503;
      return res.status(status).json({ error: "Current weather is unavailable right now." });
    }
  };
}

const venueWeatherHandler = createVenueWeatherHandler();
export default async function handler(req, res) {
  if (applyVenueGuard(req, res, { limit: true })) return;
  return venueWeatherHandler(req, res);
}
