import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const cache = new Map();
const pending = new Map();
const TTL = 3 * 60 * 60 * 1000;

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0) ||
      address.startsWith('192.0.2.') || address.startsWith('198.51.100.') || address.startsWith('203.0.113.'));
  }
  if (isIP(address) !== 6) return false;
  const value = address.toLowerCase();
  // Reject mapped addresses rather than allowing private IPv4 through IPv6.
  return /^[23]/.test(value) && !(value === '::' || value === '::1' || value.startsWith('::ffff:') ||
    value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) ||
    value.startsWith('ff') || value.startsWith('2001:db8:'));
}

function publicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password ||
    (url.port && url.port !== '443')) throw new Error('Unsafe official website URL');
  return url;
}

async function readOfficialPage(value, redirects = 0) {
  const url = publicUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) {
    throw new Error('Official website does not resolve to public addresses');
  }
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, {
      agent: false,
      headers: { 'User-Agent': 'PandaOfficialLinks/1.0', Accept: 'text/html', 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => {
        const first = addresses[0];
        if (options?.all) callback(null, [first]);
        else callback(null, first.address, first.family);
      },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        resolve({ redirect: res.headers.location });
        return;
      }
      if (res.statusCode !== 200 || !/text\/html/i.test(res.headers['content-type'] || '')) {
        res.resume();
        reject(new Error('Official website did not return HTML'));
        return;
      }
      let bytes = 0;
      const chunks = [];
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) request.destroy(new Error('Official page is too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error('Official link lookup timed out')), 8000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
  if (response.redirect) {
    if (redirects >= 3) throw new Error('Too many official website redirects');
    return readOfficialPage(new URL(response.redirect, url).href, redirects + 1);
  }
  return { html: response.html, url: url.href };
}

const decode = value => value.replace(/&amp;/gi, '&').replace(/&#(\d+);/g,
  (_, number) => String.fromCharCode(Number(number))).replace(/&quot;/gi, '"');

export function linksFromOfficialHtml(html, base) {
  const candidates = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decode(match[1]), base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      if (url.href.split('#')[0] === new URL(base).href.split('#')[0] && !url.hash) continue;
      const text = decode(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().toLowerCase();
      candidates.push({ url: url.href, text, pathname: url.pathname.toLowerCase() });
    } catch { /* Ignore malformed website anchors. */ }
  }
  const choose = score => candidates.map(link => ({ ...link, score: score(link) }))
    .filter(link => link.score > 0).sort((a, b) => b.score - a.score)[0]?.url || null;
  return {
    menuUrl: choose(link => /\b(menu|menus|food\s*(?:&|and)\s*drink)\b/.test(link.text)
      ? 100 + (/menus?|\.pdf/.test(link.pathname) ? 20 : 0)
      : /(?:^|\/)menus?(?:\/|\.|$)/.test(link.pathname) ? 40 : 0),
    reservationUrl: choose(link => /\b(room|hotel|event|private hire)\b/.test(link.text) ? 0 :
      /\b(reserve|reservation|reservations|book a table|book now|table booking)\b/.test(link.text) ? 100 :
        /reserv|book-a-table|opentable|sevenrooms|resdiary|quandoo|thefork/.test(link.url.toLowerCase()) ? 40 : 0),
  };
}

export async function getOfficialVenueLinks(website) {
  if (!website) return { menuUrl: null, reservationUrl: null, source: 'official_website', website: null };
  const url = new URL(website);
  if (url.protocol === 'http:') url.protocol = 'https:';
  const key = publicUrl(url.href).href;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    const page = await readOfficialPage(key);
    const value = { ...linksFromOfficialHtml(page.html, page.url), website: page.url, source: 'official_website' };
    cache.set(key, { expires: Date.now() + TTL, value });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return value;
  })().finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
