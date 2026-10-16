# Panda: cover-only discovery, full details on tap

## Current London-index rollout
The production path keeps photo-led cards, uses the lighter Pro search mask and
persists **only place IDs and expiring coordinates** from these new Google calls.
Google venue names/photo references remain in the response, not this new shared
index. `persistFullContent:false` is explicit in the route. The optional full
content cache code below is a dormant prototype, not the active deployment path.

- All 18 requested clusters and seven categories are included.
- IDs live in `panda_london_place_ids_v1`; coordinates live separately in
  `panda_london_place_locations_v1` and expire at 29 days, before the 30-day
  allowance. Weekly refreshes replace coordinates with current results.
- Existing partner, billing, promotions and Banging rotation records are never
  written by indexing. No seed operation writes `Free` over a paid tier.
- Firestore identity lookup happens before the live cover request. IDs alone do
  not provide names or photos; photo-led discovery can still require Google.
- Independently sourced OSM directory records can provide an explicit local
  fallback. Google details cannot be invented if the provider or quota is down.
- Limited profile responses retain independently owned partner information and
  active tier, with unknown opening hours explicitly null.
- Initial searches can page up to three times: **126–378 calls per round**,
  not a guaranteed full-London census or a verified “less than 1%” bill.
- The shared 500/day guard covers this index and cover searches, not all existing
  photo/profile/routes costs. It is not a guarantee that all Maps spending stays
  within the credit and is not a per-customer or registration limit.
- GitHub Actions starts Sunday at 03:00 London, with daily resume attempts only
  for an unfinished round. DST is handled by the backend's local-hour check.
- The seeding endpoint requires a verified, short-lived GitHub OIDC token from
  this exact repository/main branch/workflow. No new shared secret is copied.
- Seeding has four-request chunks, a distributed lease, per-page checkpoints,
  idempotent weekly completion and explicit quota pause states.
- Background seeding stops at half the default shared daily budget, leaving
  headroom for customers. An unfinished seed resumes rather than consuming the
  whole interactive search allowance.

Release: apply the scoped backend sources, constants, workflow, runner and
vercel.json together; enable `expiresAt` TTL only on the new empty coordinate
collection; verify the Vercel deployment; then dispatch the seed workflow.
Old installed Android apps retain their existing contract. The new lean caller
and fallback integration require the updated Android source/build.

## Earlier full-content prototype (NOT activated)

Backend source is based on the current external panda-ai-proxy repository.
Baseline main commit: c7daa88b05452900e8fe9ac7c822e2aa9a8a50b7.
Check for subsequent remote changes before applying; never replace newer code.
Apply api/_discovery-lite.js and the scoped api/panda-ai.js change together.
This folder is not a replacement for the full backend repository.

## Backward compatibility
- Only `venuesOnly: true, discoveryMode: "cover"` requests use the new service.
- The new production cover path does not use the optional full-content cache.
- Existing installed apps, Panda AI and Planner retain their existing behavior.
- Native home, category expansion and search use the same established transport.
- List payloads contain names, coordinates, address/type metadata and one cover
  photo reference. They do not contain hours, ratings, prices or reviews.
- The full native venue page still uses the existing profile endpoint. It hydrates
  address, rating, price, hours, phone, website and the complete photo gallery.
- Paid flags are never overwritten by a Google result.
- When Planner opens with cover-only nearby data, it requests its existing rich
  payload, rather than inventing prices from the lightweight discovery records.
  Planner's presentation is unchanged. No rich request runs while it is closed.

## Google billing
The search mask is Pro, not free/Essentials. Types and photo reference metadata
stay in the Pro tier so the cover does not require a separate Details request
for every list item. Only the first reference is returned to the app; the actual
cover image is separately billed when loaded. Full Details/Atmosphere requests
remain on the opened profile only. Other pre-existing surfaces are unchanged.

## Cache and limits
- Firestore is external Panda storage, never a Replit database.
- Separate collections: discovery_cover_searches_v1, discovery_cover_venues_v1.
- Search keys include query, rounded location, radius, pagination and schema.
- Cache TTL is 24 hours; failed provider responses are not cached as empty success.
- Configure Firestore TTL on expiresAt for both collections before rollout.
  Reads enforce expiry even before physical TTL deletion, which is asynchronous.
- Per-venue fallback uses latitude bounds, then exact distance and category checks.
  The query is bounded at 300 records; it is not proof of complete area coverage.
- No expired Google-derived rows are served indefinitely. A new area with no
  usable cache returns dataMode: unavailable rather than fabricated venues.
- Default distributed list-search budget: 500/day; PANDA_DAILY_PLACES_LIMIT can
  configure it. This uses the existing shared `places` counter. Photo, profile,
  routing and older rich-search paths are NOT comprehensively capped by this.
- If shared budget storage cannot enforce the limit, no paid cover search is made.
- Validate caching/redistribution permission with Google before enabling this
  production cache; implementation instructions are not a contractual exception.

## Permission and Firestore setup
Google's published Places policies permit indefinite place-ID storage and the
service-specific terms permit coordinates for up to 30 days. They do not grant
general permission to retain/reuse names, addresses, types or photo references
across users for 24 hours:
- https://developers.google.com/maps/documentation/places/web-service/policies
- https://cloud.google.com/maps-platform/terms/maps-service-terms (section 14)

Obtain written confirmation of the actual fields, shared cross-user reuse,
permitted storage duration and photo-reference expiry handling. Firestore TTL
does not physically delete at the instant of expiry; deletion is typically
within the following 24 hours. Read-time expiry is enforced separately.
Do not claim a strict 24-hour physical-retention guarantee from TTL alone.

The external production Firestore project is `panda-partners`. The readiness
script defaults to read-only and requires an explicit matching project:

    node scripts/firestore-cache-readiness.cjs --project=panda-partners

Optional `--verify-write` creates, reads and deletes only uniquely identified
technical canaries, never Google content or user data. Optional `--apply-ttl`
sets `expiresAt` TTL only on the two named, empty cache collections. It refuses
to enable TTL on existing populated collections, because that can bulk-delete
expired records. It never changes partner, billing or analytics collections.

Data access does not imply TTL administration access. Enabling TTL needs
`datastore.indexes.update`; the least-privilege predefined role for this is
Cloud Datastore Index Admin (`roles/datastore.indexAdmin`). A project owner can
grant it to Panda's existing service account, or configure the two TTL policies
in the console themselves. Do not request broad Owner/Editor access.

Do not enable the dormant full-content prototype through environment flags.
The current production route deliberately hardcodes `persistFullContent:false`.
Any future full-content agreement needs a separate reviewed change.

## Release checks
1. Run node --test test/discovery-lite.test.mjs in this folder.
2. Confirm Google's written reuse/retention permission.
3. Check Firestore read/write access and configure TTL policies; verify their state.
4. Configure the approval variables and publish the backward-compatible backend
   through its external repository. Validate genuine cache misses/hits/expiry.
5. Build Android with the updated native files; verify tap-through, all photos,
   open/closed, menu, booking, directions and calling on the actual build.
6. This workspace change does not itself update an installed Android app.
