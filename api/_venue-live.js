import { applyGuard } from './_guard.js';

const GOOGLE_DETAILS_URL = 'https://places.googleapis.com/v1/places';
const GOOGLE_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GOOGLE_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const CACHE_TTL_MS = 15 * 60 * 1000;
const VALID_PLACE_ID = /^[A-Za-z0-9_-]{8,256}$/;
const searchCache = new Map();
const profileCache = new Map();

const PROFILE_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'primaryType',
  'rating',
  'userRatingCount',
  'priceLevel',
  'currentOpeningHours',
  'utcOffsetMinutes',
  'nationalPhoneNumber',
  'websiteUri',
  'editorialSummary',
  'location',
  'allowsDogs',
  'delivery',
  'dineIn',
  'goodForChildren',
  'goodForGroups',
  'liveMusic',
  'outdoorSeating',
  'reservable',
  'servesBeer',
  'servesBreakfast',
  'servesBrunch',
  'servesCocktails',
  'servesCoffee',
  'servesVegetarianFood',
  'servesWine',
  'takeout',
].join(',');

function requestError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function apiKey() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw requestError('Google venue services are not configured.', 503);
  return key;
}

function formatPlaceType(value) {
  return String(value || 'venue')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isHospitalityType(value) {
  return /restaurant|cafe|bar|pub|night_club|food_court|meal_takeaway/i.test(String(value || ''));
}

function formatPriceLevel(value) {
  return {
    PRICE_LEVEL_FREE: 'Free',
    PRICE_LEVEL_INEXPENSIVE: '£',
    PRICE_LEVEL_MODERATE: '££',
    PRICE_LEVEL_EXPENSIVE: '£££',
    PRICE_LEVEL_VERY_EXPENSIVE: '££££',
  }[value] || null;
}

function getTodayHours(place) {
  const descriptions = place.currentOpeningHours?.weekdayDescriptions;
  if (!Array.isArray(descriptions) || descriptions.length === 0) return null;
  const offsetMinutes = Number.isFinite(place.utcOffsetMinutes) ? place.utcOffsetMinutes : 0;
  const localDay = new Date(Date.now() + offsetMinutes * 60_000).getUTCDay();
  const mondayFirstIndex = (localDay + 6) % 7;
  return descriptions[mondayFirstIndex] || null;
}

async function googleJson(url, options, fallbackMessage) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw requestError(
      payload?.error?.message || fallbackMessage,
      response.status === 429 ? 429 : response.status === 404 ? 404 : 502,
    );
  }
  return payload;
}

export function applyVenueGuard(req, res, { limit = false } = {}) {
  return applyGuard(req, res, { methods: ['GET', 'OPTIONS'], limit });
}

export function isValidPlaceId(value) {
  return typeof value === 'string' && VALID_PLACE_ID.test(value);
}

export function readCoordinates(query) {
  const latitude = Number(query.latitude);
  const longitude = Number(query.longitude);
  if (
    !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

export function sendVenueError(res, error, fallbackMessage) {
  const status = Number.isInteger(error?.status) ? error.status : 502;
  res.status(status).json({ error: error?.message || fallbackMessage });
}

export async function searchVenueListings(query, locationBias = null) {
  const normalized = [
    query.trim().toLocaleLowerCase('en-GB'),
    locationBias?.latitude?.toFixed(3) || '',
    locationBias?.longitude?.toFixed(3) || '',
  ].join(':');
  const cached = searchCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  if (locationBias && /\bnear me\b/i.test(query)) {
    const nearbyPayload = await googleJson(
      GOOGLE_NEARBY_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey(),
          'X-Goog-FieldMask': [
            'places.id',
            'places.displayName',
            'places.formattedAddress',
            'places.primaryType',
          ].join(','),
        },
        body: JSON.stringify({
          includedTypes: ['restaurant', 'cafe', 'bar', 'pub'],
          maxResultCount: 20,
          rankPreference: 'DISTANCE',
          languageCode: 'en-GB',
          regionCode: 'GB',
          locationRestriction: {
            circle: {
              center: locationBias,
              radius: 5000,
            },
          },
        }),
      },
      'Google nearby venue search is unavailable right now.',
    );
    const nearbyResults = (nearbyPayload.places || []).flatMap((place) =>
      place?.id && place?.displayName?.text && place?.formattedAddress && isHospitalityType(place.primaryType)
        ? [{
            id: place.id,
            name: place.displayName.text,
            address: place.formattedAddress,
            category: formatPlaceType(place.primaryType),
          }]
        : [],
    );
    if (nearbyResults.length) {
      searchCache.set(normalized, { results: nearbyResults, expiresAt: Date.now() + CACHE_TTL_MS });
      return nearbyResults;
    }
  }

  const payload = await googleJson(
    GOOGLE_SEARCH_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey(),
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.primaryType',
        ].join(','),
      },
      body: JSON.stringify({
        textQuery: query,
        regionCode: 'GB',
        languageCode: 'en-GB',
        pageSize: 20,
        ...(locationBias
          ? {
              locationBias: {
                circle: {
                  center: locationBias,
                  radius: 8000,
                },
              },
            }
          : {}),
      }),
    },
    'Google venue search is unavailable right now.',
  );

  const results = (payload.places || []).flatMap((place) =>
    place?.id && place?.displayName?.text && place?.formattedAddress && isHospitalityType(place.primaryType)
      ? [{
          id: place.id,
          name: place.displayName.text,
          address: place.formattedAddress,
          category: formatPlaceType(place.primaryType),
        }]
      : [],
  );
  searchCache.set(normalized, { results, expiresAt: Date.now() + CACHE_TTL_MS });
  return results;
}

export async function getVenueProfile(placeId) {
  const cached = profileCache.get(placeId);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  let place;
  try {
    place = await googleJson(
      GOOGLE_DETAILS_URL + '/' + encodeURIComponent(placeId),
      {
        headers: {
          'X-Goog-Api-Key': apiKey(),
          'X-Goog-FieldMask': PROFILE_FIELD_MASK,
        },
      },
      'Google venue details are unavailable right now.',
    );
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
  if (!place?.id || !place?.displayName?.text || !place?.formattedAddress) return null;

  const supportedHighlights = [
    ['liveMusic', 'live-music', 'Live music'],
    ['outdoorSeating', 'outdoor-seating', 'Outdoor seating'],
    ['servesCocktails', 'cocktails', 'Cocktails'],
    ['servesBeer', 'beer', 'Beer served'],
    ['servesWine', 'wine', 'Wine served'],
    ['reservable', 'reservations', 'Reservations'],
    ['goodForGroups', 'groups', 'Good for groups'],
    ['goodForChildren', 'children', 'Good for children'],
    ['allowsDogs', 'dogs', 'Dogs allowed'],
    ['servesVegetarianFood', 'vegetarian', 'Vegetarian options'],
    ['servesBreakfast', 'breakfast', 'Breakfast'],
    ['servesBrunch', 'brunch', 'Brunch'],
    ['servesCoffee', 'coffee', 'Coffee'],
    ['delivery', 'delivery', 'Delivery'],
    ['takeout', 'takeaway', 'Takeaway'],
    ['dineIn', 'dine-in', 'Dine-in'],
  ];

  const profile = {
    id: place.id,
    name: place.displayName.text,
    address: place.formattedAddress,
    primaryType: formatPlaceType(place.primaryType),
    rating: typeof place.rating === 'number' ? place.rating : null,
    ratingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    price: formatPriceLevel(place.priceLevel),
    openNow:
      typeof place.currentOpeningHours?.openNow === 'boolean'
        ? place.currentOpeningHours.openNow
        : null,
    todayHours: getTodayHours(place),
    phone: place.nationalPhoneNumber || null,
    website: place.websiteUri || null,
    editorialSummary: place.editorialSummary?.text || null,
    highlights: supportedHighlights.flatMap(([field, id, label]) =>
      place[field] === true ? [{ id, label }] : [],
    ),
    googleMapsUrl:
      'https://www.google.com/maps/place/?q=place_id:' + encodeURIComponent(place.id),
    latitude: typeof place.location?.latitude === 'number' ? place.location.latitude : null,
    longitude: typeof place.location?.longitude === 'number' ? place.location.longitude : null,
    source: 'google_places',
  };

  profileCache.set(placeId, { profile, expiresAt: Date.now() + CACHE_TTL_MS });
  return profile;
}

export async function findNearestTransitStation(latitude, longitude) {
  const payload = await googleJson(
    GOOGLE_NEARBY_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey(),
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
        ].join(','),
      },
      body: JSON.stringify({
        includedTypes: ['subway_station', 'train_station'],
        maxResultCount: 5,
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: {
            center: { latitude, longitude },
            radius: 5_000,
          },
        },
        languageCode: 'en-GB',
      }),
    },
    'Google transit search is unavailable right now.',
  );

  const station = (payload.places || []).find((place) =>
    Boolean(
      place?.id
      && place?.displayName?.text
      && place?.formattedAddress
      && typeof place?.location?.latitude === 'number'
      && typeof place?.location?.longitude === 'number',
    ),
  );
  if (!station) return null;

  return {
    id: station.id,
    name: station.displayName.text,
    address: station.formattedAddress,
    latitude: station.location.latitude,
    longitude: station.location.longitude,
    googleMapsUrl:
      'https://www.google.com/maps/place/?q=place_id:' + encodeURIComponent(station.id),
    source: 'google_places',
  };
}

export async function getWalkingRoute(origin, destination) {
  let payload;
  try {
    payload = await googleJson(
      GOOGLE_ROUTES_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey(),
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
        },
        body: JSON.stringify({
          origin: { location: { latLng: origin } },
          destination: { location: { latLng: destination } },
          travelMode: 'WALK',
          languageCode: 'en-GB',
          units: 'METRIC',
        }),
      },
      'Google walking directions are unavailable right now.',
    );
  } catch (error) {
    if (error?.status === 403 || error?.status === 404) return null;
    throw error;
  }

  const route = payload.routes?.[0];
  const seconds = Number.parseFloat(String(route?.duration || '').replace(/s$/, ''));
  if (typeof route?.distanceMeters !== 'number' || !Number.isFinite(seconds)) return null;
  return {
    distanceMeters: route.distanceMeters,
    durationMinutes: Math.max(1, Math.round(seconds / 60)),
    source: 'google_routes',
  };
}

export async function getTransitRoute(origin, destination) {
  let payload;
  try {
    payload = await googleJson(
      GOOGLE_ROUTES_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey(),
          'X-Goog-FieldMask': [
            'routes.distanceMeters',
            'routes.duration',
            'routes.legs.steps.distanceMeters',
            'routes.legs.steps.staticDuration',
            'routes.legs.steps.travelMode',
            'routes.legs.steps.navigationInstruction.instructions',
            'routes.legs.steps.transitDetails.stopDetails',
            'routes.legs.steps.transitDetails.headsign',
            'routes.legs.steps.transitDetails.transitLine.name',
            'routes.legs.steps.transitDetails.transitLine.nameShort',
          ].join(','),
        },
        body: JSON.stringify({
          origin: { location: { latLng: origin } },
          destination: { location: { latLng: destination } },
          travelMode: 'TRANSIT',
          departureTime: new Date().toISOString(),
          languageCode: 'en-GB',
          units: 'METRIC',
        }),
      },
      'Google public transport directions are unavailable right now.',
    );
  } catch (error) {
    if (error?.status === 403 || error?.status === 404) return null;
    throw error;
  }

  const route = payload.routes?.[0];
  const seconds = Number.parseFloat(String(route?.duration || '').replace(/s$/, ''));
  if (typeof route?.distanceMeters !== 'number' || !Number.isFinite(seconds)) return null;

  const steps = (route.legs || []).flatMap((leg) =>
    (leg.steps || []).flatMap((step) => {
      const mode = step.travelMode === 'TRANSIT'
        ? 'TRANSIT'
        : step.travelMode === 'WALK'
          ? 'WALK'
          : null;
      if (!mode || typeof step.distanceMeters !== 'number') return [];
      const stepSeconds = Number.parseFloat(String(step.staticDuration || '').replace(/s$/, ''));
      if (!Number.isFinite(stepSeconds)) return [];

      const transit = step.transitDetails;
      const lineName =
        transit?.transitLine?.nameShort
        || transit?.transitLine?.name
        || null;
      const departureStop = transit?.stopDetails?.departureStop?.name || null;
      const arrivalStop = transit?.stopDetails?.arrivalStop?.name || null;
      const instruction = mode === 'TRANSIT'
        ? [
            lineName ? `Take ${lineName}` : 'Take public transport',
            transit?.headsign ? `towards ${transit.headsign}` : '',
            departureStop && arrivalStop ? `from ${departureStop} to ${arrivalStop}` : '',
          ].filter(Boolean).join(' ')
        : step.navigationInstruction?.instructions || 'Walk to the next stop';

      return [{
        mode,
        instruction,
        durationMinutes: Math.max(1, Math.round(stepSeconds / 60)),
        distanceMeters: step.distanceMeters,
        lineName,
        headsign: transit?.headsign || null,
        departureStop,
        arrivalStop,
      }];
    }),
  );

  return steps.length
    ? {
        durationMinutes: Math.max(1, Math.round(seconds / 60)),
        distanceMeters: route.distanceMeters,
        steps,
        source: 'google_routes',
      }
    : null;
}