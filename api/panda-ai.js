
// Panda AI proxy — Vercel serverless function.
// Mints a FRESH Google access token per request, looks up REAL nearby venues via
// Google Places (New), feeds them to Gemini on Vertex AI, and returns { text }.
//
// The Panda app POSTs { systemInstruction, contents, generationConfig } (and,
// optionally, { location: { lat, lng } }) and gets back { text, venues }.

import { GoogleAuth } from 'google-auth-library';

const MODEL = process.env.PANDA_MODEL || 'gemini-2.5-flash';
const LOCATION = process.env.PANDA_LOCATION || 'us-central1';
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Default search centre = central London (the app is London-focused).
// If the front-end later sends { location: { lat, lng } }, that overrides this.
const DEFAULT_LAT = 51.5074;
const DEFAULT_LNG = -0.1278;

// --- Google Places (New) Text Search -----------------------------------------
async function searchVenues(query, lat, lng) {
  if (!MAPS_KEY || !query) return [];
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': MAPS_KEY,
        'X-Goog-FieldMask': [
          'places.displayName',
          'places.formattedAddress',
          'places.rating',
          'places.priceLevel',
          'places.googleMapsUri',
          'places.currentOpeningHours.openNow',
        ].join(','),
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: 6,
        rankPreference: 'DISTANCE',
        locationBias: {
          circle: { center: { latitude: lat, longitude: lng }, radius: 4000.0 },
        },
      }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return data.places || [];
  } catch {
    return []; // Never let a Places failure break the chat — just skip venues.
  }
}

function venuesToText(places) {
  if (!places.length) return '';
  return places
    .map((p, i) => {
      const name = p.displayName?.text || 'Unknown';
      const addr = p.formattedAddress || '';
      const rating = p.rating ? `${p.rating}\u2605` : '';
      const open =
        p.currentOpeningHours?.openNow === true ? 'open now'
        : p.currentOpeningHours?.openNow === false ? 'currently closed'
        : '';
      const bits = [addr, rating, open].filter(Boolean).join(' \u00b7 ');
      return `${i + 1}. ${name}${bits ? ' \u2014 ' + bits : ''}`;
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

// --- Handler -----------------------------------------------------------------
export default async function handler(req, res) {
  // CORS — set ALLOWED_ORIGIN to your site (e.g. https://duncann38-sys.github.io) for safety.
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const body = req.body || {};
    const { systemInstruction, contents, generationConfig, location } = body;

    // 1) Find real venues near the user based on their latest message.
    const lat = location?.lat ?? DEFAULT_LAT;
    const lng = location?.lng ?? DEFAULT_LNG;
    const places = await searchVenues(latestUserText(contents), lat, lng);
    const venueText = venuesToText(places);

    // 2) Keep the app's existing system prompt, then append the live venue list.
    let sysParts = [];
    if (systemInstruction?.parts) sysParts = [...systemInstruction.parts];
    else if (typeof systemInstruction === 'string') sysParts = [{ text: systemInstruction }];
    if (venueText) {
      sysParts.push({
        text:
          '\n\nREAL NEARBY VENUES (live from Google Places, ordered by distance). ' +
          'Only use these when the user is asking about places to eat, drink, or go out. ' +
          'Recommend by name from this list and never invent venues:\n' +
          venueText,
      });
    }

    // 3) Call Gemini on Vertex AI.
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
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(geminiBody),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json({
        error: data.error?.message || 'Gemini error',
        detail: data,
      });
      return;
    }

    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';

    // venues is extra info the front-end can ignore or use later for map pins.
    res.status(200).json({
      text,
      venues: places.map((p) => ({
        name: p.displayName?.text,
        address: p.formattedAddress,
        rating: p.rating,
        mapsUri: p.googleMapsUri,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
