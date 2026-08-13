// Panda AI proxy — Vercel serverless function.
// Holds a Google service account, mints a FRESH access token on every request
// (so it never expires like the AQ. token), calls Gemini, returns { text }.
//
// The Panda app POSTs the Gemini request body { systemInstruction, contents,
// generationConfig } here and gets back { text }.

import { GoogleAuth } from 'google-auth-library';

const MODEL = process.env.PANDA_MODEL || 'gemini-1.5-flash';

export default async function handler(req, res) {
  // CORS — set ALLOWED_ORIGIN to your site (e.g. https://duncann38-sys.github.io) for safety.
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const auth = new GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const token = (await client.getAccessToken()).token; // fresh, auto-managed

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }
    );
    const data = await r.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      (data.error ? 'Error: ' + data.error.message : 'No response');
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
