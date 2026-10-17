// Place photo proxy — Vercel serverless function.
// Streams a real Google Places (New) photo without exposing the API key.
// HARDENED: origin allow-list via ./_guard.js (GET). Rate limit OFF (images cache).
import { applyGuard } from './_guard.js';
import { fetchPhoto } from './_photo-fetch.js';

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

export default async function handler(req, res) {
  if (applyGuard(req, res, { methods: ['GET', 'OPTIONS'], limit: false })) return;

  const name = req.query.name || '';
  const max = Math.min(parseInt(req.query.max || '800', 10) || 800, 1600);
  if (!/^places\/[^/]+\/photos\/[^/]+$/.test(name)) {
    res.status(400).json({ error: 'bad photo name' });
    return;
  }
  if (!MAPS_KEY) {
    res.status(500).json({ error: 'missing key' });
    return;
  }
  try {
    const url =
      `https://places.googleapis.com/v1/${name}/media` +
      `?maxWidthPx=${max}&maxHeightPx=${max}&key=${MAPS_KEY}`;
    const r = await fetchPhoto(url);
    if (!r.ok) { res.status(r.status).end(); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(buf);
  } catch (err) {
    res.status(503).json({ error: 'Google photo delivery is temporarily unavailable.' });
  }
}
