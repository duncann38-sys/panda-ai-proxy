// Grounded, request-scoped outing handling. Never broaden a show request to hospitality.
export function outingIntent(text, contents = []) {
  const value = String(text || '').toLowerCase();
  const previous = (Array.isArray(contents) ? contents : []).filter(item => item?.role === 'user')
    .slice(-5).map(item => (Array.isArray(item.parts) ? item.parts : []).map(part => part?.text || '').join(' ')).join(' ');
  const concert = /\b(concerts?|gigs?|live bands?|orchestras?)\b/i;
  const theatre = /\b(theat(?:re|er)s?|musicals?|west end|stage shows?|plays|see a play|play on|opera|ballet)\b/i;
  const shows = /\b(?:what(?:'s| is| shows? are| performances? are)?\s*(?:shows?|performances?)\s+(?:are\s+)?on|what(?:'s| is)\s+on(?:\s+(?:today|tonight|tomorrow|this weekend))?)\b/i;
  if (concert.test(value) || theatre.test(value) || (shows.test(value) && !/\b(menu|on tap|television|tv|netflix|football)\b/i.test(value))) {
    if (/\b(?:directions?|nearest station|how (?:do|can) i get|how to get|closing time|when.*close)\b/i.test(value)) return null;
    const context = concert.test(value) || theatre.test(value) ? value : previous;
    const kind = concert.test(context) ? 'concerts' : /\bmusicals?\b/i.test(context) ? 'musicals' : 'theatre';
    return { kind, query: kind === 'concerts' ? 'concert halls live music venues' : kind === 'musicals' ? 'musical theatres' : 'theatres live stage shows', label: kind === 'concerts' ? 'concert and live-music venues' : kind === 'musicals' ? 'musical theatres' : 'theatres and stage venues' };
  }
  const drinking = /\b(?:want to get drunk|get tipsy|boozy night|places? (?:that )?(?:serve|serving) alcohol|somewhere to drink|go(?:ing)? (?:out )?for drinks|pubs|bars|cocktail bars?|wine bars?)\b/i;
  if (drinking.test(value) && !/\b(?:what is|explain|recipe|refund|complaint|allerg|nearest station|directions?|how.*get (?:to|there))\b/i.test(value)) {
    const query = /\bwine\b/.test(value) ? 'wine bars' : /\bcocktail/.test(value) ? 'cocktail bars' : /\bpubs\b/.test(value) ? 'pubs' : 'pubs and bars';
    return { kind: 'drinks', query, label: 'pubs and bars' };
  }
  return null;
}

export function filterOutingVenues(venues, intent) {
  return (Array.isArray(venues) ? venues : []).filter(venue => {
    const primary = String(venue?.primaryType || '').replace(/_/g, ' ').toLowerCase();
    const types = (Array.isArray(venue?.types) ? venue.types : []).map(value => String(value).replace(/_/g, ' ').toLowerCase());
    const type = String(venue?.type || '').toLowerCase();
    // A name containing "bar" or "theatre" is not evidence of a business category.
    const identity = primary || [...types, type].join(' ');
    if (intent.kind === 'drinks') {
      if (/\b(?:hotel|lodging|liquor store|wine store|supermarket)\b/.test(identity)) return false;
      const bar = /\b(?:pub|bar|brewery|beer garden|taproom|night club|nightclub)\b/.test(identity);
      return bar || venue.servesBeer === true || venue.servesWine === true || venue.servesCocktails === true;
    }
    if (/\b(?:shop|store|hotel|lodging|restaurant|cafe|coffee|movie|cinema)\b/.test(identity)) return false;
    if (intent.kind === 'concerts') return /\b(?:concert hall|live music venue|performing arts theater|performing arts theatre|amphitheatre|amphitheater|opera house)\b/.test(identity);
    return /\b(?:theater|theatre|performing arts|opera house|amphitheatre|amphitheater)\b/.test(identity);
  });
}

export function outingReply(intent, venues, listings = { events: [], dateLabel: 'today' }) {
  if (intent.kind === 'drinks') {
    if (!venues.length) return 'Certainly — let’s find you a proper pub or bar. I couldn’t verify a matching one in that area just now; shall we try a nearby neighbourhood?';
    const open = venues.some(venue => venue.openNow === true);
    const closed = venues.every(venue => venue.openNow === false);
    return `Certainly — let’s find you a proper drink. Here are pubs and bars${venues.some(venue => venue.servesWine === true || venue.servesBeer === true || venue.servesCocktails === true) ? ', or places explicitly listed as serving alcohol' : ''}. ${open ? 'Some are marked open now; check each card before heading over.' : closed ? 'These are marked closed at the moment, so check their opening times before heading over.' : 'I haven’t confirmed they’re open right now, so check the hours on each card.'}`;
  }
  if (listings.events?.length) {
    const lines = listings.events.slice(0, 4).map(event => `• ${event.name}${event.venue ? ` — ${event.venue}` : ''}${event.time ? `, ${event.time}` : ''}\n${event.url}`);
    return `Of course — a little culture sounds lovely. Here’s what the official programmes list for ${listings.dateLabel}:\n\n${lines.join('\n\n')}\n\nCheck the official listing for tickets; a scheduled performance doesn’t guarantee availability.`;
  }
  if (listings.productions?.length) {
    const lines = listings.productions.slice(0, 4).map(show => `• ${show.name}${show.venue ? ` — ${show.venue}` : ''}\n${show.url}`);
    return `Of course — let’s make it a proper theatre night. These productions have published runs that include ${listings.dateLabel}:\n\n${lines.join('\n\n')}\n\nThose are show-run dates, not confirmed performances today. Check the official programme for the day’s times and ticket availability.`;
  }
  if (!venues.length) return `Of course — let’s look at ${intent.label} for ${listings.dateLabel}. I couldn’t confirm a matching venue or dated performance in that area just now. Which neighbourhood would you like me to try?`;
  return `Of course — let’s make it a proper night out. Here are ${intent.label} to explore for ${listings.dateLabel}. I haven’t confirmed individual performances or ticket availability, so check the venue’s official programme before making plans.`;
}

export async function answerOutingRequest(request, services) {
  const intent = outingIntent(request.text, request.contents);
  if (!intent) return null;
  const area = /^(?:(?:the|local)\s+)?(?:theatres?|theaters?|musicals?|concerts?|shows?|pubs?|bars?)(?:\s+(?:today|tonight|tomorrow))?$/i.test(request.area || '') ? '' : request.area || '';
  if (!request.hasLocation && !area) {
    return { text: `Of course — which city or neighbourhood shall I look in for ${intent.label}?`, venues: [], aiMode: 'clarification' };
  }
  if (intent.kind !== 'drinks' && /\b(?:weekend|next week|next month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(request.text)) {
    return { text: 'Of course — which exact date shall I check? I’d rather find the right performance than send you on the wrong night.', venues: [], aiMode: 'clarification', outingKind: intent.kind };
  }
  let venues = [];
  let listings = { events: [], dateLabel: /\btomorrow\b/i.test(request.text) ? 'tomorrow' : 'today' };
  const wantOpen = intent.kind === 'drinks' && /\bopen(?:\s+now)?\b/i.test(request.text);
  try {
    const result = await services.search(intent.query, area, wantOpen);
    venues = filterOutingVenues(result, intent);
    if (wantOpen) venues = venues.filter(venue => venue.openNow === true);
  } catch {
    // Keep the exact category even when a provider fails. No restaurants-and-bars retry.
  }
  if (intent.kind !== 'drinks' && services.programmes) {
    try { listings = await services.programmes({ ...request, area, intent }); }
    catch { /* Official listings are independent of the Places/AI provider. */ }
  }
  return {
    text: outingReply(intent, venues, listings), venues, richMetadata: true,
    aiMode: 'grounded_outing', outingKind: intent.kind,
    ...(intent.kind !== 'drinks' ? {
      programmeStatus: listings.events.length ? 'dated_listings' : listings.productions?.length ? 'running_productions' : 'performances_unverified',
      events: listings.events, productions: listings.productions || [],
    } : {}),
  };
}
