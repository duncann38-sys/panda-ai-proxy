import { applyGuard } from './_guard.js';

const GOOGLE_DETAILS_URL = 'https://places.googleapis.com/v1/places';
const GOOGLE_PHOTO_FIELD_MASK = 'photos.name,photos.authorAttributions';
const MAX_VENUE_PHOTOS = 5;
const VALID_PLACE_ID = /^[A-Za-z0-9_-]{8,256}$/;
const CACHE_TTL_MS = 15 * 60 * 1000;
const photoCache = new Map();
const inFlightPhotos = new Map();

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

export async function getVenuePhotos(placeId) {
  const cached = photoCache.get(placeId);
  if (cached && cached.expiresAt > Date.now()) return cached.photos;

  const active = inFlightPhotos.get(placeId);
  if (active) return active;

  const request = loadVenuePhotos(placeId)
    .then((photos) => {
      photoCache.set(placeId, { photos, expiresAt: Date.now() + CACHE_TTL_MS });
      return photos;
    })
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
