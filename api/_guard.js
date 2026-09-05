// Panda — shared request guard: origin allow-list (CORS) + rate limiting. (ESM)
const NATIVE_APP_ORIGINS = new Set(['null', 'capacitor://localhost', 'ionic://localhost']);
const LOCAL_APP_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

const ALLOWED_ORIGINS = [
  'https://duncann38-sys.github.io',
  'https://bbfb166e-b180-43a7-a542-83c501c07b45-00-2u9xn7rdnqdst.archer.replit.dev',
  'https://bbfb166e-b180-43a7-a542-83c501c07b45-00-2u9xn7rdnqdst.expo.archer.replit.dev',
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
  // Installed mobile bundles can identify their local JS runtime as null or localhost.
  // These endpoints are public and separately rate-limited; admit those app origins
  // while continuing to reject unrelated web origins.
  const isAllowed =
    ALLOWED_ORIGINS.includes(origin) ||
    NATIVE_APP_ORIGINS.has(origin) ||
    LOCAL_APP_ORIGIN.test(origin);

  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }

  if (!methods.includes(req.method)) {
    res.status(405).json({ error: 'method_not_allowed' });
    return true;
  }

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
