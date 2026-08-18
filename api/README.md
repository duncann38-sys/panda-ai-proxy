# panda-ai-proxy

Vercel serverless proxy that powers Panda's venue discovery + Panda AI.

- **`api/panda-ai.js`** — the single endpoint (`/api/panda-ai`).
  - `venuesOnly` mode → direct Google Places search for the Discover feed.
  - chat mode → Gemini (Vertex AI) decides via function-calling when to search venues.
- Holds the Google credentials server-side (`GOOGLE_MAPS_API_KEY`, `GOOGLE_SERVICE_ACCOUNT`) so no keys are exposed in the app.

## Caching (Firestore-backed)
Every Google Places lookup routes through `searchVenues()`, which caches results in
Firestore for **~10 minutes**, keyed by query + a coarse location grid, so nearby
users share one paid Google call. Distances are recomputed per-user, so accuracy is
unaffected. If Firestore is unavailable, it falls back to Google (never breaks).
Covers both the Discover feed and Panda AI.

**Tunable (top of `api/panda-ai.js`):** `CACHE_TTL_MS` (freshness, default 10 min),
`CACHE_GRID` (grid size, default 100 ≈ 1.1km).

## Environment variables (Vercel → Settings → Environment Variables)
| Name | Purpose | Secret |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | Google Places API | yes |
| `GOOGLE_SERVICE_ACCOUNT` | Vertex AI / Gemini (JSON, one line) | yes |
| `FIREBASE_SERVICE_ACCOUNT` | Firestore cache — same JSON used by panda-partners-api | yes |
| `ALLOWED_ORIGIN` | CORS origin (e.g. https://duncann38-sys.github.io) | no |
| `PANDA_MODEL` *(optional)* | pin a Gemini model | no |
| `PANDA_LOCATION` *(optional)* | Vertex region (default us-central1) | no |

## Dependencies (`package.json`)
```json
"dependencies": {
  "google-auth-library": "^9.0.0",
  "firebase-admin": "^12.0.0"
}
```

## Deploy
Push to the repo → Vercel auto-deploys. **Env var changes require a redeploy.**

## Test caching (once Google Places billing is live)
1. Load the feed for an area.
2. Reload / have someone nearby load the same area within 10 min → instant, no new Google charge.
3. A `places_cache` collection appears in Firestore.
