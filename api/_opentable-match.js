import { createHash } from 'node:crypto';

export const OT_INDEX = 'panda_opentable_directory_v1';
export const OT_BINDINGS = 'panda_opentable_place_bindings_v1';
export const OT_CHECKS = 'panda_opentable_place_checks_v1';
export const OT_TTL_MS = 24 * 60 * 60 * 1000;
export const OT_MATCH_SCHEMA = 2;
const CELL_SIZE = 0.01;
const HOSTS = ['opentable.com', 'opentable.co.uk', 'opentable.ca', 'opentable.com.au',
  'opentable.com.mx', 'opentable.de', 'opentable.es', 'opentable.fr',
  'opentable.ie', 'opentable.it', 'opentable.jp', 'opentable.hk', 'opentable.sg',
  'opentable.ae', 'opentable.nl'];

export function nameKey(value) {
  return typeof value === 'string' ? value.normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^the /, '') : '';
}
function number(value) {
  if (value === null || value === undefined || typeof value === 'boolean'
    || (typeof value === 'string' && !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function point(value) {
  const latitude = number(value?.latitude), longitude = number(value?.longitude);
  return latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { latitude, longitude } : null;
}
function cell(latitude, longitude) {
  const row = Math.floor(latitude / CELL_SIZE);
  const width = CELL_SIZE / Math.max(0.1, Math.cos((row + 0.5) * CELL_SIZE * Math.PI / 180));
  return `${row}:${Math.floor(longitude / width)}`;
}
function neighbours(p) {
  const keys = new Set();
  for (let y = -1; y <= 1; y++) {
    const lat = Math.max(-90, Math.min(90, p.latitude + y * CELL_SIZE));
    const row = Math.floor(lat / CELL_SIZE);
    const width = CELL_SIZE / Math.max(0.1, Math.cos((row + 0.5) * CELL_SIZE * Math.PI / 180));
    for (let x = -1; x <= 1; x++) {
      const lon = ((p.longitude + x * width + 180) % 360 + 360) % 360 - 180;
      keys.add(cell(lat, lon));
    }
  }
  return [...keys];
}
function indexKey(name, area) {
  return createHash('sha256').update(`${name}|${area}`).digest('hex');
}
function aliasName(value) {
  // Only remove the generic restaurant descriptor, never branch names,
  // "bar", "hotel", "Asia", or other potentially distinct businesses.
  return nameKey(nameKey(value).replace(/^restaurant(?: at)? /, '').replace(/ restaurant$/, ''));
}
function identityKeys(value) {
  return [...new Set([nameKey(value.name), aliasName(value.name),
    ...(phone(value.phone ?? value.phone_number) ? [`phone:${phone(value.phone ?? value.phone_number)}`] : [])])]
    .filter(Boolean);
}
function compatibleAlias(profile, row) {
  const a = aliasName(profile.name), b = aliasName(row.name);
  if (!a || !b || /^(?:restaurant|bar|cafe|hotel|kitchen|london)$/.test(a)
    || /^(?:restaurant|bar|cafe|hotel|kitchen|london)$/.test(b)) return false;
  if (a === b) return true;
  const extra = a.startsWith(`${b} `) ? a.slice(b.length + 1)
    : b.startsWith(`${a} `) ? b.slice(a.length + 1) : '';
  // A longer provider name may include its real locality. It must appear in
  // the physical address; arbitrary brand extensions are not equivalent.
  return extra.length > 0 && !/\b(bar|hotel|asia|brasserie|bistro|cafe|kitchen|terrace|rooftop|lounge|club|grill)\b/.test(extra)
    && ` ${nameKey(profile.address ?? profile.fullAddress)} `.includes(` ${extra} `);
}
export function bookingUrl(value, rid) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || !HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    // Directory currently returns legacy http OpenTable links. Upgrade only the
    // scheme of an allow-listed provider URL, never invent its path or RID.
    url.protocol = 'https:';
    // A returned RID-bearing link must agree with the actual Directory record.
    const ids = [url.searchParams.get('rid'), url.pathname.match(/^\/restaurant\/profile\/(\d+)\/?$/i)?.[1]]
      .filter(value => value !== null && value !== undefined);
    if (ids.some(id => String(id) !== String(rid))) return null;
    if (/^\/r\/[a-z0-9][a-z0-9-]+\/?$/i.test(url.pathname)
      || /^\/restaurant\/profile\/[1-9]\d*\/?$/i.test(url.pathname)
      || (/^\/(?:booking\/)?restref\/client\/?$/i.test(url.pathname) && /^[1-9]\d*$/.test(url.searchParams.get('rid') ?? ''))) {
      return url.href;
    }
  } catch { /* Fail closed; never build a destination from a guessed RID. */ }
  return null;
}
export function normalizeDirectoryRestaurant(value, fetchedAt) {
  if (!value || typeof value.rid === 'boolean' || !/^[1-9]\d{0,15}$/.test(String(value.rid))) return null;
  const rid = Number(value.rid), p = point(value), key = nameKey(value.name);
  if (!Number.isSafeInteger(rid) || !p || !key || !Number.isFinite(fetchedAt)) return null;
  const url = [value.reservation_url, value.natural_reservation_url,
    value.profile_url, value.natural_profile_url].map(candidate => bookingUrl(candidate, rid)).find(Boolean);
  if (!url) return null;
  return {
    rid, name: value.name.slice(0, 300), nameKey: key, ...p,
    address: String(value.address ?? '').slice(0, 500),
    address2: String(value.address2 ?? '').slice(0, 300),
    city: String(value.city ?? '').slice(0, 200),
    country: String(value.country ?? '').slice(0, 100),
    postalCode: String(value.postal_code ?? '').slice(0, 30),
    phone: String(value.phone_number ?? '').slice(0, 50),
    reservationUrl: url,
    matchKeys: identityKeys(value).map(key => indexKey(key, cell(p.latitude, p.longitude))),
    fetchedAt,
  };
}
function postcode(value) {
  return String(value ?? '').toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/)?.[0].replace(/\s/g, '') ?? '';
}
function street(value) {
  return nameKey(String(value ?? '').split(',')[0]).replace(/\b(street|avenue|road|place|lane|square)\b/g,
    word => ({ street: 'st', avenue: 'ave', road: 'rd', place: 'pl', lane: 'ln', square: 'sq' })[word]);
}
function house(value) {
  return street(value).match(/^\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?\b/)?.[0] ?? '';
}
function phone(value) {
  let result = String(value ?? '').replace(/\D/g, '');
  if (result.startsWith('0044')) result = result.slice(2);
  if (result.startsWith('44') && result.length === 12) result = `0${result.slice(2)}`;
  return result.length >= 9 ? result : '';
}
function distance(a, b) {
  const rad = n => n * Math.PI / 180;
  const x = Math.sin(rad(a.latitude - b.latitude) / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude))
    * Math.sin(rad(a.longitude - b.longitude) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, x)));
}
export function matchRestaurant(profile, records) {
  const p = point(profile), key = nameKey(profile?.name);
  if (!p || !key || !Array.isArray(records)) return { status: 'no_match' };
  const found = new Map();
  for (const row of records) {
    const q = point(row);
    const url = bookingUrl(row?.reservationUrl, row?.rid);
    if (!q || distance(p, q) > 120 || !url) continue;
    const address = profile.address ?? profile.fullAddress;
    const aPost = postcode(address), bPost = postcode(row.postalCode || row.address);
    const aHouse = house(address), bHouse = house(row.address);
    if ((aPost && bPost && aPost !== bPost) || (aHouse && bHouse && aHouse !== bHouse)) continue;
    const aStreet = street(address), bStreet = street(row.address);
    const sameStreet = aStreet.length >= 10 && bStreet.length >= 10 && aStreet === bStreet;
    const samePhone = phone(profile.phone) && phone(profile.phone) === phone(row.phone);
    if (!(sameStreet || samePhone || (aPost && aPost === bPost && aHouse && aHouse === bHouse))) continue;
    const exactName = row.nameKey === key;
    const strongAlias = compatibleAlias(profile, row) && samePhone
      && aPost && aPost === bPost && (sameStreet || (aHouse && aHouse === bHouse)) && distance(p, q) <= 40;
    if (!exactName && !strongAlias) continue;
    found.set(row.rid, { row: { ...row, reservationUrl: url },
      method: !exactName ? 'name_alias_address_phone_coordinates' : sameStreet ? 'name_address_coordinates'
        : samePhone ? 'name_phone_coordinates' : 'name_postcode_number_coordinates' });
  }
  if (found.size > 1) return { status: 'ambiguous' };
  if (!found.size) return { status: 'no_match' };
  const { row, method } = [...found.values()][0];
  return { status: 'matched', rid: row.rid, reservationUrl: row.reservationUrl, method };
}

// Request-path matching reads a completed production index only. It never scans
// the provider Directory, calls OAuth, stores Google names/addresses, or reads a
// sandbox generation for a live customer.
export function createOpenTableMatcher({ store, now = Date.now } = {}) {
  return async function match(profile) {
    if (!store || !/^[A-Za-z0-9_-]{8,256}$/.test(profile?.id ?? '') || !point(profile)) {
      return { status: 'unavailable' };
    }
    let generation = null;
    const report = async result => {
      const openTableChecked = ['matched', 'no_match', 'ambiguous'].includes(result.status);
      try {
        await store.collection(OT_CHECKS).doc(profile.id).set({
          placeId: profile.id, generation, checkedAt: now(),
          googleChecked: true, openTableChecked, status: result.status,
          rid: result.rid ?? null,
        });
        return { ...result, generation, coverageRecorded: true };
      } catch {
        return { ...result, generation, coverageRecorded: false };
      }
    };
    const root = store.collection(OT_INDEX).doc('production');
    const manifest = (await root.get()).data();
    if (!manifest?.complete || manifest.country !== 'UK' || manifest.matchSchema !== OT_MATCH_SCHEMA
      || !/^[\w-]{1,100}$/.test(manifest.activeGeneration ?? '')
      || !Number.isFinite(manifest.completedAt) || now() < manifest.completedAt
      || now() - manifest.completedAt >= OT_TTL_MS) return report({ status: 'index_not_ready' });
    generation = manifest.activeGeneration;
    const restaurants = root.collection('generations').doc(manifest.activeGeneration).collection('restaurants');
    // At most three identity labels × nine cells: below Firestore's 30-value
    // array-contains-any bound. Phone finds name variations without a broad scan.
    const keys = identityKeys(profile).flatMap(label => neighbours(point(profile)).map(area => indexKey(label, area)));
    const rows = await restaurants.where('matchKeys', 'array-contains-any', keys).limit(101).get();
    if (rows.size > 100) return report({ status: 'ambiguous' });
    const result = matchRestaurant(profile, rows.docs.map(doc => doc.data()));
    if (result.status !== 'matched') return report(result);
    const expiresAt = manifest.completedAt + OT_TTL_MS;
    const match = {
      placeId: profile.id, rid: result.rid, environment: 'production', method: result.method,
      generation: manifest.activeGeneration, verifiedAt: now(), expiresAt,
    };
    // Mapping contains Panda routing IDs/proof metadata, never Google rich data.
    let bindingRecorded = true;
    try { await store.collection(OT_BINDINGS).doc(profile.id).set(match); }
    catch { bindingRecorded = false; }
    return report({ ...result, match, bindingRecorded });
  };
}
