import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { bookingUrl } from './_opentable-match.js';

const cache = new Map();
const pending = new Map();
const TTL = 3 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 3500;

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
  return /^[23]/.test(value) && !(value === '::' || value === '::1' || value.startsWith('::ffff:') ||
    value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) ||
    value.startsWith('ff') || value.startsWith('2001:db8:'));
}

function unsafeUrl(message) {
  const error = new Error(message);
  error.code = 'UNSAFE_OFFICIAL_URL';
  return error;
}

function publicUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password ||
    (url.port && url.port !== '443') || /(?:^|\.)(?:localhost|local)$/i.test(hostname)
    || (isIP(hostname) && !publicAddress(hostname))) throw unsafeUrl('Unsafe official website URL');
  return url;
}

async function readOfficialPage(value, redirects = 0, deadline = Date.now() + LOOKUP_TIMEOUT_MS) {
  const url = publicUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('Official link lookup timed out');
    return ms;
  };
  let dnsTimer;
  const addresses = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('Official link lookup timed out')), remaining()); }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) {
    throw unsafeUrl('Official website does not resolve to public addresses');
  }
  const timeoutMs = remaining();
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
    const timer = setTimeout(() => request.destroy(new Error('Official link lookup timed out')), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
  if (response.redirect) {
    if (redirects >= 3) throw new Error('Too many official website redirects');
    return readOfficialPage(new URL(response.redirect, url).href, redirects + 1, deadline);
  }
  return { html: response.html, url: url.href };
}

const decode = value => value.replace(/&amp;/gi, '&').replace(/&#(\d+);/g,
  (_, number) => String.fromCharCode(Number(number))).replace(/&quot;/gi, '"');
const normal = value => decode(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
const seasonal = /\b(christmas|xmas|festive|nye|valentine|easter|wedding)\b/;

export function linksFromOfficialHtml(html, base, venueName = '', { preferOpenTable = false } = {}) {
  const candidates = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decode(match[1]), base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      if (url.href.split('#')[0] === new URL(base).href.split('#')[0] && !url.hash) continue;
      const text = decode(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().toLowerCase();
      candidates.push({ url: url.href, text, pathname: url.pathname.toLowerCase(), intent: normal(text + ' ' + decodeURIComponent(url.pathname + url.search)) });
    } catch { /* Ignore malformed website anchors. */ }
  }
  const words = value => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(word => word.length > 2 && word !== 'the');
  const venueWords = words(venueName);
  const venueSlug = venueWords.join('');
  const affinity = link => {
    const linkedWords = words(link.text + ' ' + link.pathname);
    const matched = venueWords.filter(word => linkedWords.includes(word)).length;
    const exactPath = venueSlug && link.pathname.split('/').some(segment =>
      segment.replace(/[^a-z0-9]/g, '') === venueSlug);
    return matched * 20 + (exactPath ? 100 : 0);
  };
  const choose = score => candidates.map(link => {
    const baseScore = score(link);
    return { ...link, score: baseScore > 0 ? baseScore + affinity(link) : 0 };
  }).filter(link => link.score > 0).sort((a, b) => b.score - a.score)[0]?.url || null;
  const bookingScore = link => seasonal.test(link.intent)
    || /\b(events?|tickets?|cinema|movies?|private hire|book rooms?|hotel rooms?|accommodation|weddings?)\b/.test(link.intent) ? 0
    : /\b(reserve|reservation|reservations|book a table|book now|table booking|boka bord|bordsbokning|bestil bord)\b/.test(link.text) ? 100
      : /reserv|book-a-table|boka-bord|opentable|sevenrooms|resdiary|quandoo|thefork/.test(link.url.toLowerCase()) ? 40 : 0;
  let preferred = null;
  const allowedOpenTable = new Set();
  const openTableDestination = link => {
    const url = new URL(link.url);
    const rid = url.searchParams.get('rid') ?? url.pathname.match(/^\/restaurant\/profile\/(\d+)\/?$/i)?.[1];
    return bookingUrl(link.url, rid);
  };
  const eligibleBookingScore = link => preferOpenTable
    && new URL(link.url).hostname.includes('opentable') && !openTableDestination(link) ? 0 : bookingScore(link);
  if (preferOpenTable) {
    const options = candidates.filter(link => eligibleBookingScore(link) > 0).map(link => {
      return { ...link, destination: openTableDestination(link), affinity: affinity(link) };
    }).filter(link => link.destination);
    const unique = new Set(options.map(link => link.destination));
    const strongest = Math.max(0, ...candidates.filter(link => eligibleBookingScore(link) > 0).map(affinity));
    const eligible = options.filter(link => {
      const linked = words(link.text + ' ' + link.pathname);
      const completeName = venueWords.length > 0 && venueWords.every(word => linked.includes(word));
      const genericButton = words(link.text).every(word =>
        ['book', 'now', 'reserve', 'reservation', 'reservations', 'table', 'online', 'here', 'with', 'opentable'].includes(word));
      return completeName || (unique.size === 1 && genericButton && link.affinity === 0 && strongest === 0);
    }).sort((a, b) => b.affinity - a.affinity);
    // A generic brand name that fits two branches is not a verified branch.
    const tied = new Set(eligible.filter(link => link.affinity === eligible[0]?.affinity)
      .map(link => link.destination)).size > 1;
    if (!tied && eligible.length) {
      preferred = eligible[0].destination;
      allowedOpenTable.add(preferred);
    }
  }
  const providerHosts = ['sevenrooms.com', 'resdiary.com', 'dishcult.com', 'quandoo.com', 'quandoo.co.uk',
    'thefork.com', 'thefork.co.uk', 'resy.com', 'exploretock.com', 'designmynight.com', 'tablein.com', 'guestplan.com'];
  const providerDestinations = new Map();
  for (const link of preferOpenTable ? candidates.filter(link => {
    const hostname = new URL(link.url).hostname;
    return eligibleBookingScore(link) > 0
      && providerHosts.some(host => hostname === host || hostname.endsWith(`.${host}`));
  }) : []) {
    const rank = affinity(link);
    const existing = providerDestinations.get(link.url);
    if (!existing || rank > existing.rank) providerDestinations.set(link.url, { ...link, rank });
  }
  const providerOptions = [...providerDestinations.values()].sort((a, b) => b.rank - a.rank);
  const providerTied = providerOptions.filter(link => link.rank === providerOptions[0]?.rank).length > 1;
  const provider = !providerTied ? providerOptions[0]?.url : null;
  return {
    menuUrl: choose(link => seasonal.test(link.intent) ? 0
      : /\b(a la carte|all day|main menu|food menu|restaurant menu)\b/.test(link.intent) ? 200
        : /\b(menu|menus|meny|menyer|menukort|food\s*(?:&|and)\s*drink)\b/.test(link.text)
          ? 100 + (/menus?|meny|menukort|\.pdf/.test(link.pathname) ? 20 : 0)
          : /(?:^|\/)(?:menus?|meny|menukort)(?:\/|\.|$)/.test(link.pathname) ? 40 : 0),
    reservationUrl: preferred || provider || choose(link => preferOpenTable && (
      new URL(link.url).hostname.includes('opentable') && !allowedOpenTable.has(openTableDestination(link))
      || providerTied && providerOptions.some(option => option.url === link.url)) ? 0 : eligibleBookingScore(link)),
  };
}

export async function getOfficialVenueLinks(website, venueName = '', readPage = readOfficialPage, options = {}) {
  if (!website) return { menuUrl: null, reservationUrl: null, source: 'official_website', website: null, lookupStatus: 'no_direct_links' };
  const url = new URL(website);
  if (url.protocol === 'http:') url.protocol = 'https:';
  const pageUrl = publicUrl(url.href).href;
  const key = pageUrl + '|' + venueName.trim().toLowerCase() + (options.preferOpenTable ? '|opentable-first' : '') + (options.visit ? '|visit' : '');
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    let value;
    try {
      const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(LOOKUP_TIMEOUT_MS, options.timeoutMs)) : LOOKUP_TIMEOUT_MS;
      const page = await readPage(pageUrl, 0, Date.now() + timeoutMs);
      const links = linksFromOfficialHtml(page.html, page.url, venueName, options);
      value = { ...links, website: page.url, source: 'official_website',
        ...(options.visit ? { visitInfo: (await import('./_panda-visit-info.js')).officialVisitInfo(page.html, page.url) } : {}),
        lookupStatus: links.menuUrl || links.reservationUrl ? 'verified' : 'no_direct_links' };
    } catch (error) {
      if (error?.code === 'UNSAFE_OFFICIAL_URL') throw error;
      value = { menuUrl: null, reservationUrl: null, website: pageUrl,
        source: 'official_website', lookupStatus: 'unavailable' };
    }
    cache.set(key, { expires: Date.now() + (value.lookupStatus === 'unavailable' ? 30_000 : TTL), value });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return value;
  })().finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
