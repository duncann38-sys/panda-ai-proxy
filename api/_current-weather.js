import { consumeWeatherBudget } from './_panda-chat-policy.js';

export async function currentWeatherResponse({
  location,
  store,
  apiKey,
  limit = 25,
  fetchImpl = fetch,
  recordUsage = () => {},
}) {
  const latitude = Number(location?.lat);
  const longitude = Number(location?.lng);
  if (
    !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90
    || Math.abs(longitude) > 180
  ) {
    return { status: 400, body: { error: 'weather_location_required' } };
  }
  if (!apiKey) return { status: 503, body: { error: 'weather_unavailable' } };
  if (!store) return { status: 503, body: { error: 'weather_budget_unavailable' } };

  const allowed = await consumeWeatherBudget(store, limit);
  if (!allowed) return { status: 429, body: { error: 'weather_daily_limit_reached' } };

  try {
    const url = new URL('https://weather.googleapis.com/v1/currentConditions:lookup');
    url.search = new URLSearchParams({
      key: apiKey,
      'location.latitude': String(latitude),
      'location.longitude': String(longitude),
      unitsSystem: 'METRIC',
    });
    recordUsage('weather_provider_call');
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2500) });
    const data = await response.json();
    const condition = data.weatherCondition?.description?.text;
    const temperatureC = Number(data.temperature?.degrees);
    if (
      !response.ok
      || !data.currentTime
      || typeof condition !== 'string'
      || !Number.isFinite(temperatureC)
    ) {
      return { status: 502, body: { error: 'weather_unavailable' } };
    }
    return {
      status: 200,
      body: {
        weather: {
          observedAt: data.currentTime,
          condition,
          temperatureC,
          source: 'Google Weather',
        },
      },
    };
  } catch {
    return { status: 502, body: { error: 'weather_unavailable' } };
  }
}
