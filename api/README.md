# panda-ai-proxy

Vercel serverless proxy that powers Panda's venue discovery + Panda AI.

- **`api/panda-ai.js`** — the single endpoint (`/api/panda-ai`).
  - `venuesOnly` mode → direct Google Places search for the Discover feed.
  - chat mode → Gemini (Vertex AI) decides via function-calling when to search venues.
- Holds the Google credentials server-side (`GOOGLE_MAPS_API_KEY`, `GOOGLE_SERVICE_ACCOUNT`) so no keys are exposed in the app.

## Cost controls and caching
Standard Discover and Panda AI venue searches use `searchVenues()`, with a
30-minute Firestore cache keyed by query and a fine location grid. Distances are
recomputed per user. Banging uses a separate path and bypasses both process and
Firestore Google-result caches, so it does not reuse another user's Places results.
When a required shared budget cannot be checked, new paid provider calls fail closed;
eligible cached results may still be returned.

Exact concurrent Gemini requests are coalesced, and successful raw Gemini responses
are retained for 15 seconds to absorb double taps and immediate network retries.
The cache key includes the complete request and rounded location context, so different conversations,
locations, instructions, or generation settings do not share a response.

An optional cross-instance Firestore cache stores only function-call-only Gemini
responses for five minutes. It never stores Panda's final conversational text.
This reduces repeated intent-routing calls without sharing personalised answers,
changing personality, or making opening hours and directions stale.

Venue listing and profile lookups use shared Firestore caches as well as bounded
in-process caches. Profiles retain the existing 15-minute freshness window because
they contain current opening information. Photo metadata is cached for six hours in
memory and 24 hours in Firestore. Photo bytes are private/no-store and use a separate
shared daily media budget; they are not served through the Vercel CDN.

Conversation compaction is opt-in and preserves complete user-led turns. When
`PANDA_COMPACT_CONVERSATION=true`, payloads retain the newest 24 content items up
to 60,000 serialized characters. With the flag
unset, Panda sends the full conversation exactly as before. This makes the initial
rollout backwards-compatible while allowing token controls to be canary-tested later.

Required daily request budgets are enforced through Firestore transactions and shared
by Vercel instances. Places, photo-media, Gemini and Routes each have separate daily
limits. When a budget is reached, cached requests continue to work where available,
while new provider calls fail closed. Banging also has a separate matrix-element cap.
Provider-side Google Cloud quotas should remain the final hard billing stop.

The existing per-minute request guard is per warm instance and prunes expired client
records. If an instance already has 5,000 active client windows, previously unseen
clients are conservatively limited until a window expires; active allowances are never
evicted or reset by high-cardinality traffic. Shared daily budgets are the cross-instance
backstop.

These controls live in Panda's GitHub/Vercel backend. The Native app does not depend
on Replit at runtime. Successful mobile response shapes are unchanged; public error
responses retain `error` and now include stable machine-readable codes.

## Environment variables (Vercel → Settings → Environment Variables)
| Name | Purpose | Secret |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | Google Places API | yes |
| `GOOGLE_SERVICE_ACCOUNT` | Vertex AI / Gemini (JSON, one line) | yes |
| `FIREBASE_SERVICE_ACCOUNT` | Firestore cache — same JSON used by panda-partners-api | yes |
| `ALLOWED_ORIGIN` | CORS origin (e.g. https://duncann38-sys.github.io) | no |
| `PANDA_MODEL` *(optional)* | pin a Gemini model | no |
| `PANDA_LOCATION` *(optional)* | Vertex region (default us-central1) | no |
| `PANDA_DAILY_GEMINI_LIMIT` | Required shared logical Gemini-call budget per UTC day; missing configuration or unavailable Firestore skips Gemini and uses the existing fallback | no |
| `PANDA_DAILY_PLACES_LIMIT` | Required for direct AI/venue searches; overrides the separately bounded discovery-index allowance. Missing direct configuration or unavailable Firestore blocks those paid calls | no |
| `PANDA_DAILY_PHOTO_LIMIT` | Required shared Google Places photo-media budget per UTC day; missing configuration or unavailable Firestore blocks photo requests | no |
| `PANDA_DAILY_ROUTES_LIMIT` | Required shared Google Routes request budget per UTC day; missing configuration or unavailable Firestore blocks route requests | no |
| `PANDA_COMPACT_CONVERSATION` *(optional)* | Set to `true` only after canary testing to enable conversation bounds | no |
| `PANDA_MAX_CONVERSATION_ITEMS` *(optional)* | Maximum recent conversation items sent to Gemini (default 24) | no |
| `PANDA_MAX_CONVERSATION_CHARS` *(optional)* | Maximum serialized conversation characters sent to Gemini (default 60000) | no |
| `PANDA_SHARED_GEMINI_CACHE` *(optional)* | Set to `true` after canary testing to share function-call-only Gemini results across Vercel instances | no |
| `PANDA_MAX_TOOL_ROUNDS` *(optional)* | Maximum Gemini tool rounds, clamped to 0–2; unset preserves the current value of 2 | no |
| `PANDA_MAX_OUTPUT_TOKENS` *(optional)* | Optional server ceiling for Gemini output tokens; unset preserves the caller's current setting | no |
| `PANDA_DAILY_CLIENT_AI_LIMIT` | Required per-client Gemini admission budget; missing configuration or unavailable Firestore skips Gemini and uses the existing fallback | no |
| `PANDA_CLIENT_HASH_SALT` | Required for the client Gemini budget; raw values are never stored and missing salt skips Gemini | yes |
| `PANDA_BANGING_DAILY_ROUTE_ELEMENTS` | Required maximum number of Banging transit-matrix elements per UTC day; missing configuration or unavailable Firestore blocks paid route calls | no |
| `PANDA_USAGE_METRICS` *(optional)* | Set to `true` to emit allowlisted cache/provider cost fields to Vercel logs; questions, coordinates and raw client identifiers are discarded | no |

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
- `venue_search_cache_v1` — shared lightweight venue listings.
- `venue_profile_cache_v1` — shared 15-minute venue profiles.
- `venue_photo_cache_v1` — shared photo metadata with stale resilience.
- `gemini_function_cache_v1` — optional function-call-only Gemini responses.
- `panda_usage_budgets_v1` — UTC daily request counters.
- `panda_client_budgets_v1` — optional hashed-client daily AI counters.

## Current Production state — 25 November 2026

The production branch is at commit 2b09ff1d4f5379adfbaac9d52ab2ae02d3d6d4fc. Its Vercel deployment reached READY. A safe public status request was intercepted by Vercel Authentication before reaching the app, so deployment readiness is verified but endpoint runtime behavior is not.

These starting daily caps are configured in the Vercel Production environment only. Preview variables were left unchanged:

| Variable | Production starting cap |
|---|---:|
| PANDA_DAILY_GEMINI_LIMIT | 5,000 per UTC day |
| PANDA_DAILY_PLACES_LIMIT | 5,000 per UTC day for direct Places; discovery-index allowance is separate |
| PANDA_DAILY_PHOTO_LIMIT | 10,000 per UTC day |
| PANDA_DAILY_ROUTES_LIMIT | 2,000 per UTC day |
| PANDA_DAILY_CLIENT_AI_LIMIT | 1,000 per client per UTC day |
| PANDA_BANGING_DAILY_ROUTE_ELEMENTS | 10,000 per UTC day |
| PANDA_CLIENT_HASH_SALT | Required sensitive secret; never commit or print its value |

Values can change in Vercel independently of Git; inspect the Production settings before relying on this snapshot. Missing required budget configuration or unavailable Firestore accounting fails closed for new paid calls. Existing local-device Banging fallback is separate from shared Google-result caching.

Banging bypasses shared and in-process Google venue-result caches. The server cache named banging_directory_cache_v1 is for public partner placements, not Google venue results. Do not re-enable cross-user Google-result reuse for Banging without a separate policy review.

## Future rollout checklist

1. Keep each required budget set below the matching Google Cloud quota and verify Firestore budget accounting before changing limits.
2. Configure Preview budgets and its data store separately before testing paid calls in a Vercel Preview deployment; Preview is currently not configured with these Production caps.
3. After a production merge, verify the exact Vercel deployment commit and READY state. Do not bypass Vercel Authentication to probe a protected endpoint.
4. Confirm the app’s fallback state separately; deployment readiness alone does not prove every API route returned live data.
