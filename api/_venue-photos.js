import { applyGuard } from './_guard.js';
import admin from 'firebase-admin';
import { boundedCacheExpiry, recordCostEvent } from './_cost-controls.js';

const GOOGLE_DETAILS_URL = 'https://places.googleapis.com/v1/places';
const GOOGLE_PHOTO_FIELD_MASK = 'photos.name,photos.authorAttributions';
const MAX_VENUE_PHOTOS = 10;
const VALID_PLACE_ID = /^[A-Za-z0-9_-]{8,256}$/;
const MEMORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SHARED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
  return applyGuard(req, res, { methods: ['GET', 'OPTIONS'], limit: false });
}

export function isValidPlaceId(value) {
  return typeof value === 'string' && VALID_PLACE_ID.test(value);
}

export function sendVenuePhotoError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 502;
  res.status(status).json({ error: error?.message || 'Google venue photos are unavailable right now.' });
}

async function loadVenuePhotos(placeId) {
  recordCostEvent('photo_metadata_provider_call');
  const response = await fetch(GOOGLE_DETAILS_URL + '/' + encodeURIComponent(placeId), {
    headers: {
      'X-Goog-Api-Key': apiKey(),
      'X-Goog-FieldMask': GOOGLE_PHOTO_FIELD_MASK,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw requestError(
      payload?.error?.message || 'Google venue photos are unavailable right now.',
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
  photoCache.set(placeId, {
    photos,
    sourceTimestamp,
    expiresAt: boundedCacheExpiry(now, MEMORY_CACHE_TTL_MS, sourceTimestamp, sourceTtlMs),
  });
}

async function readSharedVenuePhotos(placeId) {
  const store = db();
  if (!store) return null;
  try {
    const snapshot = await store.collection(SHARED_CACHE_COLLECTION).doc(placeId).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    if (!data || !Array.isArray(data.photos) || !Number.isFinite(Number(data.ts))) return null;
    return { photos: data.photos.slice(0, MAX_VENUE_PHOTOS), ts: Number(data.ts) };
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

export async function getVenuePhotos(placeId) {
  const cached = photoCache.get(placeId);
  if (cached && cached.expiresAt > Date.now()) {
    recordCostEvent('photo_metadata_cache_hit', { layer: 'memory' });
    return cached.photos;
  }

  const active = inFlightPhotos.get(placeId);
  if (active) return active;

  const request = (async () => {
      const shared = await readSharedVenuePhotos(placeId);
      if (shared && Date.now() - shared.ts < SHARED_CACHE_TTL_MS) {
        cacheInMemory(placeId, shared.photos, shared.ts);
        recordCostEvent('photo_metadata_cache_hit', { layer: 'firestore' });
        return shared.photos;
      }
      try {
        const photos = await loadVenuePhotos(placeId);
        cacheInMemory(placeId, photos);
        await writeSharedVenuePhotos(placeId, photos);
        return photos;
      } catch (error) {
        if (shared && Date.now() - shared.ts < STALE_CACHE_TTL_MS) {
          cacheInMemory(placeId, shared.photos, shared.ts, STALE_CACHE_TTL_MS);
          recordCostEvent('photo_metadata_stale_hit', { layer: 'firestore' });
          return shared.photos;
        }
        throw error;
      }
    })()
    .finally(() => inFlightPhotos.delete(placeId));

  inFlightPhotos.set(placeId, request);
  return request;
}

export async function getVenuePhotoImage(placeId, photoIndex) {
  const photo = (await getVenuePhotos(placeId))[photoIndex];
  if (!photo) throw requestError('This venue does not have that Google photo.', 404);

  const response = await fetch(
    'https://places.googleapis.com/v1/' + encodeURI(photo.name) + '/media?maxHeightPx=900',
    { headers: { 'X-Goog-Api-Key': apiKey() } },
  );
  if (!response.ok) {
    throw requestError(
      'This Google venue photo is unavailable right now.',
      response.status === 429 ? 429 : 502,
    );
  }

  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'image/jpeg',
  };
}
