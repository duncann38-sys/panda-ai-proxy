// A cold Firestore connection can exceed 1.5s even for a valid indexed match.
// Keep enough time to return that verified destination rather than incorrectly
// preferring the website fallback. No additional provider calls are introduced.
export const RESERVATION_MATCH_TIMEOUT_MS = 3000;
export function createVenueReservationLinks({ getProfile, getOfficialLinks, getOpenTableMatch, officialTimeoutMs = 1500 }) {
  return async function load(placeId, { reservationOnly = false } = {}) {
    const profile = await getProfile(placeId);
    if (!profile || profile.id !== placeId) return null;
    const base = { source: 'official_website', website: profile.website ?? null, menuUrl: null,
      reservationUrl: null, lookupStatus: 'no_direct_links' };
    const matched = (official, match) => ({
      ...official, reservationUrl: match.reservationUrl, lookupStatus: 'verified',
      reservationSource: 'opentable_directory', openTableMatch: match.match, openTableLookup: 'matched',
    });
    async function readMatch() {
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => getOpenTableMatch(profile)),
          new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unavailable' }), RESERVATION_MATCH_TIMEOUT_MS); }),
        ]);
      } catch { return { status: 'unavailable' }; }
      finally { clearTimeout(timer); }
    }
    const readOfficial = async () => {
      let timer;
      const unavailable = { ...base, website: reservationOnly ? profile.website ?? null : null, lookupStatus: 'unavailable' };
      try {
        const request = Promise.resolve().then(() => getOfficialLinks(profile.website, profile.name,
          { preferOpenTable: reservationOnly, ...(reservationOnly ? { timeoutMs: officialTimeoutMs } : {}) }));
        return await (reservationOnly ? Promise.race([request, new Promise(resolve => {
          timer = setTimeout(() => resolve(unavailable), officialTimeoutMs);
        })]) : request);
      } catch { return unavailable; }
      finally { clearTimeout(timer); }
    };
    const withContacts = links => ({ ...links, placeId: profile.id,
      website: links.website || profile.website || null, phone: profile.phone || null });
    if (reservationOnly) {
      const match = await readMatch();
      // A verified Directory match needs no website crawl at all.
      if (match.status === 'matched') return withContacts(matched(base, match));
      return withContacts({ ...await readOfficial(), reservationSource: 'official_website', openTableLookup: match.status });
    }
    // Existing menu, website and older APK consumers keep their established
    // provenance and links. Only the new explicit Reserve intent joins sources.
    return readOfficial();
  };
}
