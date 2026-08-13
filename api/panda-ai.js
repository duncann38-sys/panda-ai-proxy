
// Panda AI proxy — Vercel serverless function. (for our Launch)
// - Mints a FRESH Google access token per request (never a stale static token).
// - Looks up REAL nearby venues via Google Places (New) Text Search, with photos,
//   website, phone, hours, price and a true distance from the user's location.
// - Feeds them to Gemini on Vertex AI so it can only recommend places that exist.
//
// Modes:
//   { venuesOnly:true, query, location:{lat,lng} }  -> returns { venues } (no Gemini, fast/cheap)
//   { systemInstruction, contents, generationConfig, location } -> returns { text, venues }

import { GoogleAuth } from 'google-auth-library';

const MODEL = process.env.PANDA_MODEL || 'gemini-2.5-flash';
const LOCATION = process.env.PANDA_LOCATION || 'us-central1';
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Fallback centre if the phone hasn't shared its location yet (central London).
const DEFAULT_LAT = 51.5074;
const DEFAULT_LNG = -0.1278;

const PRICE = {
  PRICE_LEVEL_INEXPENSIVE: '\u00a3',
  PRICE_LEVEL_MODERATE: '\u00a3\u00a3',
  PRICE_LEVEL_EXPENSIVE: '\u00a3\u00a3\u00a3',
  PRICE_LEVEL_VERY_EXPENSIVE: '\u00a3\u00a3\u00a3\u00a3',
};

function distMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

async function searchVenues(query, lat, lng) {
  if (!MAPS_KEY || !query) return [];
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': MAPS_KEY,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.shortFormattedAddress',
          'places.location',
          'places.rating',
          'places.userRatingCount',
          'places.priceLevel',
          'places.primaryTypeDisplayName',
          'places.googleMapsUri',
          'places.websiteUri',
          'places.nationalPhoneNumber',
          'places.currentOpeningHours.openNow',
          'places.photos',
        ].join(','),
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: 10,
        rankPreference: 'DISTANCE',
        locationBias: {
          circle: { center: { latitude: lat, longitude: lng }, radius: 5000.0 },
        },
      }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const places = data.places || [];
    return places.map((p) => {
      const loc = p.location || {};
      const photo = (p.photos && p.photos[0]) || null;
      const attr =
        photo && photo.authorAttributions && photo.authorAttributions[0]
          ? photo.authorAttributions[0].displayName
          : '';
      return {
        id: p.id,
        name: p.displayName?.text || 'Unknown',
        type: p.primaryTypeDisplayName?.text || '',
        address: p.shortFormattedAddress || p.formattedAddress || '',
        fullAddress: p.formattedAddress || '',
        rating: p.rating || null,
        ratingCount: p.userRatingCount || null,
        price: PRICE[p.priceLevel] || '',
        openNow:
          p.currentOpeningHours && typeof p.currentOpeningHours.openNow === 'boolean'
            ? p.currentOpeningHours.openNow
            : null,
        lat: loc.latitude ?? null,
        lng: loc.longitude ?? null,
        distanceMeters:
          loc.latitude != null ? distMeters(lat, lng, loc.latitude, loc.longitude) : null,
        phone: p.nationalPhoneNumber || '',
        website: p.websiteUri || '',
        mapsUri: p.googleMapsUri || '',
        photoName: photo ? photo.name : '',
        photoAttribution: attr,
      };
    }).sort((a, b) => (a.distanceMeters ?? 9e9) - (b.distanceMeters ?? 9e9));
  } catch {
    return [];
  }
}

function fmtDist(m) {
  if (m == null) return '';
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

function venuesToText(v) {
  if (!v.length) return '';
  return v
    .map((x, i) => {
      const bits = [
        x.type,
        fmtDist(x.distanceMeters),
        x.rating ? `${x.rating}\u2605` : '',
        x.price,
        x.openNow === true ? 'open now' : x.openNow === false ? 'closed' : '',
      ].filter(Boolean).join(' \u00b7 ');
      return `${i + 1}. ${x.name}${bits ? ' \u2014 ' + bits : ''}`;
    })
    .join('\n');
}

function latestUserText(contents) {
  if (!Array.isArray(contents)) return '';
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (c?.role === 'user' && Array.isArray(c.parts)) {
      return c.parts.map((p) => p.text || '').join(' ').trim();
    }
  }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const body = req.body || {};
    const { systemInstruction, contents, generationConfig, location } = body;
    const lat = location?.lat ?? DEFAULT_LAT;
    const lng = location?.lng ?? DEFAULT_LNG;

    // FAST PATH: Discover screen just wants venue cards, no chat.
    if (body.venuesOnly) {
      const venues = await searchVenues(body.query, lat, lng);
      res.status(200).json({ venues });
      return;
    }

    // CHAT PATH: real venues -> context -> Gemini -> friendly reply + cards.
    const venues = await searchVenues(latestUserText(contents), lat, lng);
    const venueText = venuesToText(venues);

    let sysParts = [];
    if (systemInstruction?.parts) sysParts = [...systemInstruction.parts];
    else if (typeof systemInstruction === 'string') sysParts = [{ text: systemInstruction }];
    if (venueText) {
      sysParts.push({
        text:
          '\n\nREAL NEARBY VENUES (live from Google Places, ordered by distance from the user). ' +
          'Recommend only from this list, by name, and never invent a venue or detail. ' +
          'The app shows each as a tappable card with a "View official website & menu" button, ' +
          'so you can point people there for menus:\n' + venueText,
      });
    }

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    const projectId = credentials.project_id;

    const url =
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}` +
      `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

    const geminiBody = { contents };
    if (sysParts.length) geminiBody.systemInstruction = { parts: sysParts };
    if (generationConfig) geminiBody.generationConfig = generationConfig;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: data.error?.message || 'Gemini error', detail: data });
      return;
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    res.status(200).json({ text, venues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
