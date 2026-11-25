// Place photo proxy — Vercel serverless function.
// Streams a real Google Places (New) photo without exposing the API key.
// Public photo proxy: origin allow-list, per-instance rate limit, and shared daily budget.
import { applyGuard } from './_guard.js';
import { fetchPhoto } from './_photo-fetch.js';
import { db } from './_venue-live.js';
import { consumeDailyBudget } from './_cost-controls.js';

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

export default async function handler(req, res) {
  if (applyGuard(req, res, { methods: ['GET', 'OPTIONS'], limit: true })) return;

  const name = typeof req.query.name === 'string' ? req.query.name : '';
  const requestedMax = Number.parseInt(String(req.query.max || '800'), 10) || 800;
  const max = Math.max(1, Math.min(requestedMax, 1600));
  if (!name || name.length > 2048 || !/^places\/[^/]+\/photos\/[^/]+$/.test(name)) {
    res.status(400).json({ error: 'bad photo name' });
    return;
  }
  if (!MAPS_KEY) {
    res.status(503).json({ error: 'Google photo delivery is temporarily unavailable.', code: 'photo_unavailable' });
    return;
  }
  try {
    const budget = await consumeDailyBudget(
      db(),
      'photos',
      process.env.PANDA_DAILY_PHOTO_LIMIT,
    );
    if (!budget.allowed) {
      res.status(budget.reason === 'limit' ? 429 : 503).json({
        error: 'Google photo delivery is temporarily unavailable.',
        code: budget.reason === 'limit' ? 'rate_limited' : 'photo_unavailable',
      });
      return;
    }
    const url =
      `https://places.googleapis.com/v1/${name}/media` +
      `?maxWidthPx=${max}&maxHeightPx=${max}&key=${MAPS_KEY}`;
    const r = await fetchPhoto(url, undefined, { retries: 0 });
    if (!r.ok) {
      const limited = r.status === 429;
      res.status(limited ? 429 : 503).json({
        error: 'Google photo delivery is temporarily unavailable.',
        code: limited ? 'rate_limited' : 'photo_unavailable',
      });
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(buf);
  } catch (err) {
    res.status(503).json({ error: 'Google photo delivery is temporarily unavailable.' });
  }
}
