const RIDE_VEHICLE = /\b(?:uber|taxi|cab|ride(?:\s+share)?)\b/i;
const RIDE_ACTION = /\b(?:get|call|book|order|hail|request|send|need|want|like|arrange|take)\b/i;

export function parseRideRequest(text) {
  const value = String(text || '').trim();
  const vehicle = value.match(RIDE_VEHICLE);
  if (!vehicle || !RIDE_ACTION.test(value)) return null;

  const afterVehicle = value.slice(vehicle.index + vehicle[0].length);
  const destinationMatch = afterVehicle.match(/\bto\s+(.+)$/i)
    || afterVehicle.match(/\bfor\s+(.+)$/i);
  if (!destinationMatch) return { destination: '', area: '' };

  let destination = destinationMatch[1]
    .replace(/[?.!].*$/s, '')
    .replace(/,\s*(?:please|now)$/i, '')
    .replace(/\b(?:please|now|tonight|today|tomorrow)\s*$/i, '')
    .trim();
  let area = '';
  const areaMatch = destination.match(/\b(?:in|near|around)\s+(.+)$/i);
  if (areaMatch) {
    area = areaMatch[1].replace(/\b(?:please|now|tonight|today|tomorrow)\s*$/i, '').trim();
    destination = destination.slice(0, areaMatch.index).replace(/[,\s]+$/g, '').trim();
  }
  if (/^(?:there|here|it|that|this|that place|this place|that venue|this venue|the same place|home)$/i.test(destination)) {
    return { destination: '', area };
  }
  return { destination, area };
}

function normalizedTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(token => token && !['the', 'a', 'an', 'hotel', 'hotels', 'venue'].includes(token));
}

export function rankRideDestinations(venues, destination) {
  const requestedTokens = normalizedTokens(destination);
  if (!requestedTokens.length) return [];
  const requested = requestedTokens.join(' ');
  const wantsHotel = /\b(?:hotel|inn|resort)\b/i.test(destination);
  const ranked = (Array.isArray(venues) ? venues : [])
    .filter(venue => venue && typeof venue.name === 'string')
    .map(venue => {
      const typeText = [venue.type, venue.primaryType, ...(Array.isArray(venue.types) ? venue.types : [])]
        .filter(Boolean)
        .join(' ');
      if (wantsHotel && !/\b(?:hotel|lodging|resort|inn)\b/i.test(`${venue.name} ${typeText}`)) return null;
      const venueTokens = normalizedTokens(venue.name);
      if (!venueTokens.length) return null;
      const venueName = venueTokens.join(' ');
      const overlap = requestedTokens.filter(token => venueTokens.includes(token)).length;
      const score = venueName === requested
        ? 1
        : Math.max(
          overlap / requestedTokens.length,
          requested.includes(venueName) || venueName.includes(requested) ? 0.8 : 0,
        );
      return { venue, score, typeText };
    })
    .filter(item => item && item.score >= 0.5)
    .sort((left, right) =>
      right.score - left.score
      || Number(left.venue.distanceMeters ?? Infinity) - Number(right.venue.distanceMeters ?? Infinity),
    );
  return ranked;
}

export function pickRideDestination(venues, destination) {
  const ranked = rankRideDestinations(venues, destination);
  const best = ranked[0];
  if (!best) return null;
  const tied = ranked.filter(candidate => candidate.score === best.score);
  const kind = candidate => {
    const text = `${candidate.venue?.name || ''} ${candidate.typeText || ''}`.toLowerCase();
    if (/\b(?:hotel|lodging|resort|inn)\b/.test(text)) return 'lodging';
    if (/\b(?:theatre|theater|concert hall|performing arts)\b/.test(text)) return 'theatre';
    if (/\b(?:pub|bar|nightclub|night club)\b/.test(text)) return 'nightlife';
    if (/\b(?:restaurant|cafe|café|coffee shop)\b/.test(text)) return 'dining';
    if (/\b(?:station|railway|train)\b/.test(text)) return 'station';
    if (/\b(?:airport|terminal)\b/.test(text)) return 'airport';
    return '';
  };
  const distinctKinds = new Set(tied.map(kind).filter(Boolean));
  return distinctKinds.size > 1 ? null : best.venue;
}
