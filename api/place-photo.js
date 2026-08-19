// Place photo proxy — Vercel serverless function.
// Streams a real Google Places (New) photo without ever exposing the API key
// to the browser. The app calls: /api/place-photo?name=places/XXX/photos/YYY&max=800
// HARDENED: origin allow-list via ../lib/guard (GET). Rate limit OFF (images cache).
import { applyGuard } from '../lib/guard';

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

export default async function handler(req, res) {
  if (applyGuard(req, res, { methods: ['GET', 'OPTIONS'], limit: false })) return;

  const name = req.query.name || '';
  const max = Math.min(parseInt(req.query.max || '800', 10) || 800, 1600);
  // Only allow well-formed Places photo resource names (blocks SSRF).
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
    const r = await fetch(url); // follows the redirect to the real image bytes
    if (!r.ok) { res.status(r.status).end(); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.status(200).send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
