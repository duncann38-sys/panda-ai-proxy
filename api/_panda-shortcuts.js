// Explicit quick-search intent. Never infer this from arbitrary conversation.
export function quickVenueShortcut(text) {
  const value = String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[?!.,]+$/g, '').trim();
  if (/^(?:what(?:'s| is) open now|open (?:right )?now|restaurants open (?:right )?now near me)$/.test(value))
    return { kind: 'open', query: 'restaurants', openNow: true };
  if (/^(?:cheap eats|cheap eats near me|affordable restaurants near me)$/.test(value))
    return { kind: 'cheap', query: 'cheap restaurants', openNow: false };
  if (/^(?:dinner tonight|dinner tonight near me)$/.test(value))
    return { kind: 'dinner', query: 'restaurants for dinner', openNow: false };
  if (/^(?:cocktails|cocktails nearby|cocktails near me|nearby bars|bars near me)$/.test(value))
    return { kind: 'bars', query: 'bars', openNow: false };
  if (/^(?:pint|pubs near me|nearby pubs|find pubs near me)$/.test(value))
    return { kind: 'pubs', query: 'pubs', openNow: false };
  return null;
}

export const SHORTCUT_RADIUS_METERS = 5000;
export function matchesQuickVenueShortcut(venue, shortcut) {
  if (!shortcut) return true;
  if (!Number.isFinite(venue.distanceMeters) || venue.distanceMeters < 0
    || venue.distanceMeters > SHORTCUT_RADIUS_METERS) return false;
  const types = [venue.type, venue.primaryType, ...(Array.isArray(venue.types) ? venue.types : [])]
    .filter(Boolean).join(' ').replace(/_/g, ' ');
  if (shortcut.kind === 'open' && venue.openNow !== true) return false;
  if (shortcut.kind === 'cheap' && !['£', 'PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_FREE'].includes(venue.price)) return false;
  if (['open', 'cheap', 'dinner'].includes(shortcut.kind)
    && !/\b(?:restaurant|restaurants|cafe|cafes|café|cafés|meal|food)\b/i.test(types)) return false;
  if (shortcut.kind === 'bars' && !/\b(?:bar|bars|wine bar|cocktail bar)\b/i.test(types)) return false;
  if (shortcut.kind === 'pubs' && !/\b(?:pub|pubs|public house)\b/i.test(types)) return false;
  return true;
}

export function compareQuickVenueRatings(a, b) {
  const rating = venue => Number.isFinite(Number(venue.rating)) ? Number(venue.rating) : 0;
  return rating(b) - rating(a) || (Number(b.ratingCount) || 0) - (Number(a.ratingCount) || 0)
    || a.distanceMeters - b.distanceMeters;
}
