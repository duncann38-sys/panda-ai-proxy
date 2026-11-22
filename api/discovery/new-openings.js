import pandaAi from '../panda-ai.js';

function queryValue(req, name) {
  const value = req.query?.[name];
  if (Array.isArray(value)) return value[0];
  if (value !== undefined) return value;
  try { return new URL(req.url || '/', 'https://panda.invalid').searchParams.get(name); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method === 'OPTIONS') return pandaAi(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ status: 'method_not_allowed' });
  }
  const incoming = req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : {};
  const latValue = incoming.location?.lat ?? incoming.lat ?? queryValue(req, 'lat');
  const lngValue = incoming.location?.lng ?? incoming.lng ?? queryValue(req, 'lng');
  const lat = Number(latValue), lng = Number(lngValue);
  const areaValue = incoming.area ?? queryValue(req, 'area');
  const area = typeof areaValue === 'string' ? areaValue.trim().slice(0, 120) : '';
  const coordinatesValid = Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180;
  if (!coordinatesValid && !area) {
    return res.status(400).json({ status: 'location_required', text: 'Provide device coordinates or a city name.' });
  }
  const offsetValue = incoming.offset ?? queryValue(req, 'offset') ?? 0;
  const limitValue = incoming.limit ?? queryValue(req, 'limit') ?? 15;
  req.method = 'POST';
  req.body = {
    ...incoming,
    newOpeningsOnly: true,
    venuesOnly: true,
    area: area || undefined,
    location: coordinatesValid ? { lat, lng } : undefined,
    offset: Math.max(0, Number.parseInt(String(offsetValue), 10) || 0),
    limit: Math.max(1, Math.min(15, Number.parseInt(String(limitValue), 10) || 15)),
  };
  return pandaAi(req, res);
}
