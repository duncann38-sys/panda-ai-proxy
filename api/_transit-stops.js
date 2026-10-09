const cache = new Map();
const pending = new Map();
const label = value => String(value || '').toLowerCase()
  .replace(/\s*\((?:stop|platform)\s+[^)]+\)/g, '')
  .replace(/\b(underground|station|stn|line)\b/g, '').replace(/[^a-z0-9]/g, '');
const matchesStop = (stop, name, point) => label(stop.name) === name || (point &&
  Number.isFinite(stop.lat) && Number.isFinite(stop.lon) &&
  Math.hypot((stop.lat - point.latitude) * 111320,
    (stop.lon - point.longitude) * 111320 * Math.cos(point.latitude * Math.PI / 180)) < 100);

export function chooseTransitRoute(routes, maxMinutes = Infinity) {
  const duration = route => Number.parseFloat(String(route.duration || '').replace(/s$/, ''));
  const valid = routes.filter(route => Number.isFinite(duration(route)) && duration(route) <= maxMinutes * 60);
  const rail = valid.filter(route => route.legs?.some(leg => leg.steps?.some(step =>
    /^(SUBWAY|METRO_RAIL|RAIL|TRAIN|COMMUTER_TRAIN|HEAVY_RAIL|HIGH_SPEED_TRAIN|LIGHT_RAIL|MONORAIL)$/
      .test(step.transitDetails?.transitLine?.vehicle?.type || ''))));
  return (rail.length ? rail : valid).sort((a, b) => duration(a) - duration(b))[0] || null;
}

export function stopsForLeg(payload, step) {
  const from = label(step.departureStop), to = label(step.arrivalStop);
  if (!from || !to || from === to) return [];
  const candidates = [];
  for (const sequence of payload?.stopPointSequences || []) {
    const stops = sequence.stopPoint || [];
    for (let first = 0; first < stops.length; first++) {
      if (!matchesStop(stops[first], from, step.departureLocation)) continue;
      const last = stops.findIndex((stop, index) => index > first && matchesStop(stop, to, step.arrivalLocation));
      if (last > first && (!step.stopCount || last - first === step.stopCount)) {
        candidates.push(stops.slice(first, last + 1).map(stop => ({ name: stop.name, id: stop.id })));
      }
    }
  }
  // Ambiguous branches must not be presented as a verified stop list.
  const distinct = [...new Map(candidates.map(stops => [stops.map(stop => stop.id).join('|'), stops])).values()];
  return distinct.length === 1 ? distinct[0] : [];
}

export async function addTransitStops(step) {
  const point = step.departureLocation;
  if (step.mode !== 'TRANSIT' || !point || point.latitude < 51.2 || point.latitude > 51.8 ||
    point.longitude < -0.6 || point.longitude > 0.4) return step;
  const id = label(step.lineName);
  if (!/^[a-z0-9]{1,40}$/.test(id)) return step;
  let result = cache.get(id);
  if (!result || result.expires < Date.now()) {
    let request = pending.get(id);
    if (!request) {
      request = (async () => {
        const response = await fetch(`https://api.tfl.gov.uk/Line/${id}/Route/Sequence/all`,
          { signal: AbortSignal.timeout(3500) });
        const value = response.ok ? await response.json() : null;
        const entry = { value, expires: Date.now() + (value ? 3 * 60 * 60 * 1000 : 60_000) };
        cache.set(id, entry);
        return entry;
      })().catch(() => {
        const entry = { value: null, expires: Date.now() + 60_000 };
        cache.set(id, entry);
        return entry;
      }).finally(() => pending.delete(id));
      pending.set(id, request);
    }
    result = await request;
  }
  const stops = stopsForLeg(result.value, step);
  return stops.length ? { ...step, intermediateStops: stops, stopsSource: 'tfl_route_sequence' } : step;
}
