import { searchVenueListings } from './_venue-live.js';
import { refresh, withBudget } from './_banging-directory.js';

const TTL = 3 * 60 * 60 * 1000;
const roles = {
  night: ['restaurants', 'cocktail bars', 'nightclubs'],
  morning: ['coffee shops', 'breakfast restaurants', 'brunch restaurants'],
  lunch: ['restaurants', 'coffee shops', 'dessert cafes'],
};

export async function getPlannerPool({ origin, area, mode, budget, wide }) {
  const centre = origin ? {
    latitude: Math.round(origin.latitude * 100) / 100,
    longitude: Math.round(origin.longitude * 100) / 100,
  } : null;
  const terms = roles[mode].map(term => term === 'restaurants' && budget >= 3 ? 'upscale restaurants' : term);
  const key = `planner-pool-v1:${mode}:${budget >= 3 ? 'upscale' : 'standard'}:${area.toLowerCase()}:${centre?.latitude}:${centre?.longitude}:${wide ? 'wide' : 'near'}`;
  const stored = await refresh(key, async () => {
    const found = new Map();
    const collect = async (term, bias, namedArea = area) => {
      await withBudget('places');
      const query = namedArea ? `${term} in ${namedArea}` : term;
      const results = await searchVenueListings(query, bias, { ttlMs: TTL });
      for (const result of results) found.set(result.id, result);
    };
    // Three nearest-role searches, reused by every phone in this area.
    await Promise.all(terms.map(term => collect(term, centre)));
    if (wide) {
      const first = [...found.values()].find(venue => Number.isFinite(venue.latitude) && Number.isFinite(venue.longitude));
      const base = area && first ? { latitude: first.latitude, longitude: first.longitude } : centre;
      if (base) {
        // Only widen on demand. Four distinct catchments prevent a single
        // 20-result search around one small location from hiding alternatives.
        const deltaLatitude = 0.16;
        const deltaLongitude = 0.16 / Math.max(0.25, Math.cos(base.latitude * Math.PI / 180));
        for (const [north, east] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const bias = { latitude: base.latitude + north * deltaLatitude, longitude: base.longitude + east * deltaLongitude };
          await Promise.all(terms.map(term => collect(term, bias, '')));
        }
      }
    }
    return [...found.values()].filter(venue => Number(venue.rating) >= 4 && /^£{1,4}$/.test(venue.price || '') &&
      venue.photoNames?.length && Number.isFinite(venue.latitude) && Number.isFinite(venue.longitude));
  });
  return { results: stored.value, expiresAt: stored.ts + TTL, stage: wide ? 'wide' : 'near' };
}
