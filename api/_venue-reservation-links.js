export function createVenueReservationLinks({ getProfile, getOfficialLinks, getOpenTableMatch }) {
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
          new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unavailable' }), 1500); }),
        ]);
      } catch { return { status: 'unavailable' }; }
      finally { clearTimeout(timer); }
    }
    const readOfficial = () => Promise.resolve().then(() => getOfficialLinks(profile.website, profile.name,
      { preferOpenTable: reservationOnly }))
      .catch(() => ({ ...base, website: null, lookupStatus: 'unavailable' }));
    if (reservationOnly) {
      const match = await readMatch();
      // A verified Directory match needs no website crawl at all.
      if (match.status === 'matched') return matched(base, match);
      return { ...await readOfficial(), reservationSource: 'official_website', openTableLookup: match.status };
    }
    // Existing menu, website and older APK consumers keep their established
    // provenance and links. Only the new explicit Reserve intent joins sources.
    return readOfficial();
  };
}
