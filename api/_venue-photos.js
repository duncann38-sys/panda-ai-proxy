import { applyGuard } from './_guard.js';
import admin from 'firebase-admin';
import { boundedCacheExpiry, consumeDailyBudget, recordCostEvent } from './_cost-controls.js';
import { fetchPhoto } from './_photo-fetch.js';
import { safePublicError } from './_public-errors.js';

const GOOGLE_DETAILS_URL = 'https://places.googleapis.com/v1/places';
const GOOGLE_PHOTO_FIELD_MASK = 'photos.name,photos.authorAttributions';
const MAX_VENUE_PHOTOS = 10;
const MAX_MEMORY_CACHE_ENTRIES = 500;
const VALID_PLACE_ID = /^[A-Za-z0-9_-]{8,256}$/;
const MEMORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SHARED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SHARED_CACHE_COLLECTION = 'venue_photo_cache_v1';
const photoCache = new Map();
const inFlightPhotos = new Map();
let _db = null;
let _dbTried = false;

function db() {
  if (_dbTried) return _db;
  _dbTried = true;
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return (_db = null);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      });
    }
    _db = admin.firestore();
  } catch {
    _db = null;
  }
  return _db;
}

function requestError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function apiKey() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw requestError('Google venue photos are not configured.', 503);
  return key;
}

export function applyVenuePhotoGuard(req, res) {
  return applyGuard(req, res, { methods: ['GET', 'OPTIONS'], limit: true });
}

export function isValidPlaceId(value) {
  return typeof value === 'string' && VALID_PLACE_ID.test(value);
}

export function sendVenuePhotoError(res, error) {
  const result = safePublicError(error?.status, 'Google venue photos are unavailable right now.');
  res.status(result.status).json(result.body);
}

async function loadVenuePhotos(placeId) {
  const budget = await consumeDailyBudget(
    db(),
    'places',
    process.env.PANDA_DAILY_PLACES_LIMIT,
  );
  if (!budget.allowed) {
    throw requestError(
      'Google venue photos are unavailable right now.',
      budget.reason === 'limit' ? 429 : 503,
    );
  }
  recordCostEvent('photo_metadata_provider_call');
  const response = await fetchPhoto(
    GOOGLE_DETAILS_URL + '/' + encodeURIComponent(placeId),
    {
      headers: {
        'X-Goog-Api-Key': apiKey(),
        'X-Goog-FieldMask': GOOGLE_PHOTO_FIELD_MASK,
      },
    },
    { retries: 0 },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw requestError(
      'Google venue photos are unavailable right now.',
      response.status === 429 ? 429 : 502,
    );
  }

  return (payload.photos || [])
    .flatMap((photo) => photo?.name ? [{
      name: photo.name,
      attribution: (photo.authorAttributions || [])
        .filter((item) => Boolean(item?.displayName))
        .map((item) => ({ displayName: item.displayName, uri: item.uri })),
    }] : [])
    .slice(0, MAX_VENUE_PHOTOS);
}

function cacheInMemory(
  placeId,
  photos,
  sourceTimestamp = Date.now(),
  sourceTtlMs = SHARED_CACHE_TTL_MS,
) {
  const now = Date.now();
  photoCache.delete(placeId);
  photoCache.set(placeId, {
    photos,
    expiresAt: boundedCacheExpiry(now, MEMORY_CACHE_TTL_MS, sourceTimestamp, sourceTtlMs),
  });
  while (photoCache.size > MAX_MEMORY_CACHE_ENTRIES) {
    photoCache.delete(photoCache.keys().next().value);
  }
}

async function readSharedVenuePhotos(placeId) {
  const store = db();
  if (!store) return null;
  try {
    const snapshot = await store.collection(SHARED_CACHE_COLLECTION).doc(placeId).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    const timestamp = Number(data?.ts);
    if (!data || !Array.isArray(data.photos) || !Number.isFinite(timestamp)
        || timestamp <= 0 || timestamp > Date.now()) return null;
    return { photos: data.photos.slice(0, MAX_VENUE_PHOTOS), ts: timestamp };
  } catch {
    return null;
  }
}

async function writeSharedVenuePhotos(placeId, photos) {
  const store = db();
  if (!store) return;
  try {
    await store.collection(SHARED_CACHE_COLLECTION).doc(placeId).set({
      placeId,
      photos,
      ts: Date.now(),
    });
  } catch {
    // Photo delivery must not fail because the shared cache is unavailable.
  }
}

export async function getVenuePhotos(placeId, { refresh = false } = {}) {
  const cached = photoCache.get(placeId);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.photos;
  if (cached && cached.expiresAt <= Date.now()) photoCache.delete(placeId);

  const active = inFlightPhotos.get(placeId);
  if (active) return active;

  const request = (async () => {
    if (!refresh) {
      const shared = await readSharedVenuePhotos(placeId);
      const now = Date.now();
      if (shared && now - shared.ts < SHARED_CACHE_TTL_MS) {
        cacheInMemory(placeId, shared.photos, shared.ts, SHARED_CACHE_TTL_MS);
        return shared.photos;
      }
    }

    const photos = await loadVenuePhotos(placeId);
    const timestamp = Date.now();
    cacheInMemory(placeId, photos, timestamp, SHARED_CACHE_TTL_MS);
    await writeSharedVenuePhotos(placeId, photos);
    return photos;
  })().finally(() => inFlightPhotos.delete(placeId));
  inFlightPhotos.set(placeId, request);
  return request;
}

async function fetchBudgetedPhoto(url) {
  const budget = await consumeDailyBudget(
    db(),
    'photos',
    process.env.PANDA_DAILY_PHOTO_LIMIT,
  );
  if (!budget.allowed) {
    throw requestError(
      'Google venue photos are unavailable right now.',
      budget.reason === 'limit' ? 429 : 503,
    );
  }
  return fetchPhoto(url, { headers: { 'X-Goog-Api-Key': apiKey() } }, { retries: 0 });
}

export async function getVenuePhotoImage(placeId, photoIndex) {
  let photo = (await getVenuePhotos(placeId))[photoIndex];
  if (!photo) throw requestError('This venue does not have that Google photo.', 404);

  let response = await fetchBudgetedPhoto(
    'https://places.googleapis.com/v1/' + encodeURI(photo.name) + '/media?maxHeightPx=900',
  );
  if (response.status === 400 || response.status === 404) {
    photo = (await getVenuePhotos(placeId, { refresh: true }))[photoIndex];
    if (!photo) throw requestError('This venue does not have that Google photo.', 404);
    response = await fetchBudgetedPhoto(
      'https://places.googleapis.com/v1/' + encodeURI(photo.name) + '/media?maxHeightPx=900',
    );
  }
  if (!response.ok) {
    const failure = requestError(
      'This Google venue photo is unavailable right now.',
      response.status === 429 ? 429 : 502,
    );
    throw failure;
  }

  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'image/jpeg',
  };
}
