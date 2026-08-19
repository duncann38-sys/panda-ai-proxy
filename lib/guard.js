// Panda — shared request guard: origin allow-list (CORS) + rate limiting. (ESM)
const ALLOWED_ORIGINS = [
  'https://duncann38-sys.github.io',
  'https://pandaindustry.co',
  'https://www.pandaindustry.co',
  'https://shariah.pandaindustry.co',
];

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 15;
const hits = new Map();

function rateLimited(req) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count++;
  return rec.count > MAX_PER_WINDOW;
}

export function applyGuard(req, res, { methods = ['POST', 'OPTIONS'], limit = true } = {}) {
  const origin = req.headers.origin || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  // Always set CORS headers FIRST, before any early return, so even rejected
  // requests come back with a proper CORS response the browser can read.
  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // Unknown/no origin: still set a header so the browser gets a clean answer.
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Answer the preflight immediately and cleanly.
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }

  if (!methods.includes(req.method)) {
    res.status(405).json({ error: 'method_not_allowed' });
    return true;
  }

  // Block data requests from origins not on the list (but they still got a
  // CORS header above, so the browser reports our clean 403 instead of a
  // confusing "no CORS header" error).
  if (origin && !isAllowed) {
    res.status(403).json({ error: 'forbidden_origin' });
    return true;
  }

  if (limit && rateLimited(req)) {
    res.status(429).json({ error: 'rate_limited' });
    return true;
  }

  return false;
}
