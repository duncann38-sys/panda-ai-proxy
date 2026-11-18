// Request-local context only. Never write conversation text, preferences,
// referenced cards or a home address into Firestore or analytics.
const MORE = /^(?:please\s+)?(?:more(?:\s+(?:places|options|restaurants|bars|pubs|like (?:these|those)))?|any (?:others|more)|what else|another (?:few|one)|show me more)[?!. ]*$/i;
const MODIFIER = /\b(?:tomorrow|tonight|today|instead|rather|at \d|after \d|before \d|for (?:two|three|four|\d+))\b/i;
const VENUE = /\b(?:restaurants?|dinner|lunch|brunch|breakfast|pubs?|bars?|cocktails?|sushi|pizza|italian|french|indian|thai|new openings?)\b/i;
const compact = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1200);

export function conciergeArea(text) {
  const matches = [...String(text ?? '').matchAll(
    /\b(?:in|near|around)\s+([\p{L}\d][\p{L}\d '&’-]*?)(?=\s+(?:tonight|today|tomorrow|please|after|before|for|at)\b|[.!?,;]|$)/giu,
  )];
  const area = matches.at(-1)?.[1]?.trim() || '';
  return /^(?:me|here|there|it|that place)$/i.test(area) || area.length > 100 ? '' : area;
}

export function requestVenueIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(id)))].slice(-500);
}

export function conciergeTurn(contents, suppliedIds = []) {
  const users = (Array.isArray(contents) ? contents : []).filter(message => message?.role === 'user')
    .map(message => compact((Array.isArray(message.parts) ? message.parts : []).map(part => part?.text ?? '').join(' ')))
    .filter(Boolean).slice(-12);
  const text = users.at(-1) || '';
  const more = MORE.test(text);
  const previous = users.slice(0, -1);
  let start = -1;
  for (let index = previous.length - 1; index >= 0; index--) {
    if (VENUE.test(previous[index]) && !MORE.test(previous[index])) { start = index; break; }
  }
  const continuation = start >= 0 && (more || MODIFIER.test(text));
  const inherited = continuation
    ? previous.slice(start).filter(statement => VENUE.test(statement) || MODIFIER.test(statement)).join('. ')
    : '';
  return {
    text, more, continuation, inherited,
    searchText: inherited ? more ? inherited : `${inherited}. ${text}` : text,
    requestedArea: conciergeArea(continuation ? `${inherited}. ${text}` : text),
    // Exclusion applies to a request for alternatives, not a changed date at
    // the same restaurant. No mutable process-global session.
    excludedPlaceIds: more ? requestVenueIds(suppliedIds) : [],
    wantsNew: /\b(?:new restaurants?|new openings?)\b/i.test(inherited || text),
  };
}

export function conciergeTimeWindow(text, context = {}, now = new Date()) {
  let timeZone = 'Europe/London';
  try {
    if (typeof context.timeZone === 'string' && context.timeZone.length <= 80) {
      new Intl.DateTimeFormat('en-GB', { timeZone: context.timeZone }).format(now);
      timeZone = context.timeZone;
    }
  } catch { /* Invalid client zone must not change the server clock. */ }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const part = type => parts.find(item => item.type === type)?.value;
  const localDay = `${part('year')}-${part('month')}-${part('day')}`;
  const tomorrow = new Date(`${localDay}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  // The most recent date/time modifier overrides an earlier one.
  const dates = [...String(text).matchAll(/\b(tomorrow|tonight|today|\d{4}-\d{2}-\d{2})\b/gi)];
  const dateWord = dates.at(-1)?.[0]?.toLowerCase();
  let date = dateWord === 'tomorrow' ? tomorrow.toISOString().slice(0, 10)
    : /^\d{4}-\d{2}-\d{2}$/.test(dateWord || '') ? dateWord : localDay;
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) date = null;
  const times = [...String(text).matchAll(/\b(?:at|after|before|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi)];
  const latest = times.at(-1);
  let time = null;
  if (latest) {
    let hour = Number(latest[1]);
    const minute = Number(latest[2] || 0);
    const meridiem = latest[3]?.toLowerCase();
    if (meridiem && hour >= 1 && hour <= 12) hour = hour % 12 + (meridiem === 'pm' ? 12 : 0);
    else if (meridiem) hour = -1;
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }
  const lateDinner = time
    ? /\b(?:dinner|food|eat)\b/i.test(text) && time >= '22:30'
    : /\blate (?:dinner|meal|food)\b/i.test(text);
  return { date, time: time || (lateDinner ? '22:30' : null), timeZone, lateDinner,
    availabilityVerified: false, kitchenHoursVerified: false };
}

export function conciergeInstruction(turn, context, now) {
  const window = conciergeTimeWindow(turn.searchText, context, now);
  return [
    'Be a thoughtful, naturally witty British dining concierge, not a search form. Reply to casual conversation without searching. Never force banter or use a gendered title.',
    'For discovery, offer a maximum of four verified venues and one useful, short follow-up. Preserve the customer’s area, cuisine, budget and date across follow-ups; do not ask again for known details.',
    `Request-local interpreted time window: ${JSON.stringify(window)}. This is a requested time, NOT evidence of availability or kitchen service.`,
    'Never equate venue closing time with the kitchen closing time. For late dinner, explain that kitchen service needs confirmation unless a provider explicitly verifies dining at the requested time.',
    'Never invent a dish, opening date, station, fare, availability or booking confirmation. No unsupported superlatives.',
    turn.more ? 'The user requested alternatives. Use the retained intent and exclude every already displayed ID supplied for this turn. If exhausted, say so rather than repeat cards.' : '',
  ].filter(Boolean).join('\n');
}
