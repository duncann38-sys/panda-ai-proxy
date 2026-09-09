# panda-ai-proxy

Vercel serverless proxy that powers Panda's venue discovery + Panda AI.

- **`api/panda-ai.js`** — the single endpoint (`/api/panda-ai`).
  - `venuesOnly` mode → direct Google Places search for the Discover feed.
  - chat mode → Gemini (Vertex AI) decides via function-calling when to search venues.
- Holds the Google credentials server-side (`GOOGLE_MAPS_API_KEY`, `GOOGLE_SERVICE_ACCOUNT`) so no keys are exposed in the app.

## Cost controls and caching
Every Google Places lookup routes through `searchVenues()`, which caches results in
Firestore for **30 minutes**, keyed by query + a fine location grid, so nearby
users share one paid Google call. Distances are recomputed per-user, so accuracy is
unaffected. If Firestore is unavailable, it falls back to Google (never breaks).
Covers both the Discover feed and Panda AI.

Exact concurrent Gemini requests are coalesced, and successful raw Gemini responses
are retained for 15 seconds to absorb double taps and immediate network retries.
The cache key includes the complete compacted request, so different conversations,
locations, instructions, or generation settings do not share a response.

Conversation compaction is opt-in. When `PANDA_COMPACT_CONVERSATION=true`, payloads
retain the newest 24 content items up to 60,000 serialized characters. With the flag
unset, Panda sends the full conversation exactly as before. This makes the initial
rollout backwards-compatible while allowing token controls to be canary-tested later.

Optional daily request budgets are enforced through Firestore transactions and are
shared by Vercel instances. When the Gemini budget is reached, Panda uses its existing
venue-aware fallback and preserves the normal response shape. When the Places budget
is reached, cached requests continue to work while new cache misses return no venues.
Provider-side Google Cloud quotas should remain the final hard billing stop.

These controls live in Panda's GitHub/Vercel backend. The Native app does not depend
on Replit at runtime, and no mobile response contract is changed.

## Environment variables (Vercel → Settings → Environment Variables)
| Name | Purpose | Secret |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | Google Places API | yes |
| `GOOGLE_SERVICE_ACCOUNT` | Vertex AI / Gemini (JSON, one line) | yes |
| `FIREBASE_SERVICE_ACCOUNT` | Firestore cache — same JSON used by panda-partners-api | yes |
| `ALLOWED_ORIGIN` | CORS origin (e.g. https://duncann38-sys.github.io) | no |
| `PANDA_MODEL` *(optional)* | pin a Gemini model | no |
| `PANDA_LOCATION` *(optional)* | Vertex region (default us-central1) | no |
| `PANDA_DAILY_GEMINI_LIMIT` *(optional)* | Shared logical Gemini-call budget per UTC day; unset disables the application limit | no |
| `PANDA_DAILY_PLACES_LIMIT` *(optional)* | Shared Google Places cache-miss budget per UTC day; unset disables the application limit | no |
| `PANDA_COMPACT_CONVERSATION` *(optional)* | Set to `true` only after canary testing to enable conversation bounds | no |
| `PANDA_MAX_CONVERSATION_ITEMS` *(optional)* | Maximum recent conversation items sent to Gemini (default 24) | no |
| `PANDA_MAX_CONVERSATION_CHARS` *(optional)* | Maximum serialized conversation characters sent to Gemini (default 60000) | no |

## Dependencies (`package.json`)
```json
"dependencies": {
  "google-auth-library": "^9.0.0",
  "firebase-admin": "^12.0.0"
}
```

## Deploy
Push to the repo → Vercel auto-deploys. **Env var changes require a redeploy.**

## Verification
Run the offline cost-control tests without Google billing:

```bash
npm test
```

Once billing is restored, use a small canary:

1. Set conservative daily limits in Vercel Preview first.
2. Load the same feed twice within 30 minutes and confirm the second response is cached.
3. Submit the same Panda AI message twice quickly and confirm only one logical Gemini call is counted.
4. Force a very low Gemini budget and confirm Panda returns its existing fallback response.
5. Verify humour, location, nearest-first ordering, the 60 km boundary, photo eligibility,
   15-card cap, closing-time answers, pub crawls, and live transport before enabling limits in Production.

Firestore collections:

- `places_cache_v2` — shared Places results.
- `panda_usage_budgets_v1` — UTC daily request counters.

## Rollout

1. Deploy code with daily limits and conversation compaction unset. This enables exact duplicate-call protection without blocking or trimming traffic.
2. Confirm the production endpoint response contract with a few canary requests after billing is restored.
3. Set budgets below the matching Google Cloud quotas, leaving capacity for operational checks.
4. Monitor cache-hit rate, fallback rate, Gemini calls per conversation, and Places calls per discovery session.
5. Raise budgets gradually as verified revenue and traffic grow.
