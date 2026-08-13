// Panda AI proxy — Vercel serverless function.
// Holds a Google service account, mints a FRESH access token on every request
// (so it never expires like a static token), calls Gemini on Vertex AI, returns { text }.
//
// The Panda app POSTs the Gemini request body { systemInstruction, contents,
// generationConfig } here and gets back { text }.

import { GoogleAuth } from 'google-auth-library';

const MODEL = process.env.PANDA_MODEL || 'gemini-2.5-flash';
const LOCATION = process.env.PANDA_LOCATION || 'us-central1';

export default async function handler(req, res) {
  // CORS — set ALLOWED_ORIGIN to your site (e.g. https://duncann38-sys.github.io) for safety.
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    // Service account JSON is stored in the GOOGLE_SERVICE_ACCOUNT env var on Vercel.
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();

    // Project is read straight from the service account so nothing is hardcoded.
    const projectId = credentials.project_id;

    const url =
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}` +
      `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      // The app already sends { systemInstruction, contents, generationConfig },
      // which is exactly the Vertex generateContent body — forward it as-is.
      body: JSON.stringify(req.body),
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

    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
