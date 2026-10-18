export const MAX_ITINERARY_STOPS = 4;

const STAGE_DEFINITIONS = [
  {
    key: 'coffee',
    label: 'Coffee / breakfast',
    query: 'coffee shops',
    pattern: /\b(?:coffee|caf[eé]|breakfast)\b/i,
  },
  { key: 'brunch', label: 'Brunch', query: 'brunch restaurants', pattern: /\bbrunch\b/i },
  { key: 'lunch', label: 'Lunch', query: 'lunch restaurants', pattern: /\blunch\b/i },
  {
    key: 'culture',
    label: 'Gallery / exhibition',
    query: 'art galleries and exhibitions',
    pattern: /\b(?:art exhibit(?:ion)?|gallery|galleries|museum|museums|exhibition)\b/i,
  },
  {
    key: 'dinner',
    label: 'Dinner',
    query: 'dinner restaurants',
    pattern: /\b(?:dinner|restaurants?|food)\b/i,
  },
  {
    key: 'dessert',
    label: 'Dessert',
    query: 'dessert shops',
    pattern: /\b(?:dessert|ice cream|patisserie)\b/i,
  },
  {
    key: 'drinks',
    label: 'Drinks',
    query: 'cocktail and wine bars',
    pattern: /\b(?:cocktails?|drinks?|wine bars?|natural wine)\b/i,
  },
  { key: 'pub', label: 'Pub', query: 'pubs', pattern: /\b(?:pubs?|pints?|beer)\b/i },
  {
    key: 'music',
    label: 'Live music',
    query: 'live music venues',
    pattern: /\b(?:live music|music venues?|bands?)\b/i,
  },
  {
    key: 'dancing',
    label: 'Dancing',
    query: 'nightclubs for dancing',
    pattern: /\b(?:dancing|nightclubs?|clubs?)\b/i,
  },
];

const PLAN_INTENT = /\b(?:plan|itinerary|outing|night out|day out|evening out|date night)\b|\bstart with\b|\bfinish (?:at|with)\b/i;
const SENSITIVE_REQUIREMENT = /\b(?:allerg\w*|dietary|gluten[- ]free|coeliac|celiac|halal|kosher|nut[- ]free|vegan|vegetarian|wheelchair|accessib\w*)\b/i;

export function detectItineraryStages(text) {
  const source = String(text || '');
  if (!PLAN_INTENT.test(source) || SENSITIVE_REQUIREMENT.test(source)) return null;

  const stages = STAGE_DEFINITIONS
    .map(stage => {
      const match = source.match(stage.pattern);
      return match ? { ...stage, index: match.index ?? 0 } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index)
    .slice(0, MAX_ITINERARY_STOPS)
    .map(({ key, label, query }) => ({ key, label, query }));

  return stages.length >= 2 ? stages : null;
}

export async function collectItineraryVenues(stages, searchStage) {
  const venues = [];
  const missing = [];
  const seen = new Set();
  const selectedStages = Array.isArray(stages) ? stages.slice(0, MAX_ITINERARY_STOPS) : [];

  for (const [index, stage] of selectedStages.entries()) {
    let candidates = [];
    try {
      candidates = await searchStage(stage);
    } catch {
      candidates = [];
    }
    const venue = (Array.isArray(candidates) ? candidates : []).find(candidate =>
      typeof candidate?.id === 'string' &&
      candidate.id.length > 0 &&
      typeof candidate?.name === 'string' &&
      candidate.name.trim().length > 0 &&
      typeof candidate?.photoName === 'string' &&
      candidate.photoName.length > 0 &&
      Number(candidate.photoCount) >= 5 &&
      !seen.has(candidate.id)
    );

    if (!venue) {
      missing.push(stage.label);
      continue;
    }
    seen.add(venue.id);
    venues.push({ ...venue, stopLabel: 'Stop ' + (index + 1) + ' of ' + selectedStages.length + ' · ' + stage.label });
  }

  return { venues, missing };
}

export function itineraryReply({ stages, venues, missing, area, weather }) {
  const place = area ? ' in ' + area : ' near you';
  const weatherNote = weather?.condition
    ? ' Current conditions: ' + weather.condition +
      (Number.isFinite(Number(weather.temperatureC)) ? ', ' + weather.temperatureC + '°C' : '') + '.'
    : '';
  if (!Array.isArray(venues) || venues.length === 0) {
    return 'I couldn’t verify any venue cards for that multi-stop plan' + place + '. Try another area or change the stops, and I’ll look again.' + weatherNote;
  }

  const stops = venues.map(venue => venue.stopLabel + ': ' + venue.name).join(' → ');
  if (Array.isArray(missing) && missing.length) {
    return 'Here are ' + venues.length + ' verified stops' + place + ': ' + stops + '. I couldn’t verify ' + missing.join(', ') + ', so I left it out rather than guess.' + weatherNote;
  }

  const requestedCount = Array.isArray(stages) ? Math.min(stages.length, MAX_ITINERARY_STOPS) : venues.length;
  return 'Here’s your ' + requestedCount + '-stop plan' + place + ', in the order you asked: ' + stops + '. Tap each card for verified venue details and directions.' + weatherNote;
}
