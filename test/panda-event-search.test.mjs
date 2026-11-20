import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isEventSearchQuestion,
  isPriceLookupQuestion,
  reserveEventGroundingBudget,
  settleEventGroundingBudget,
  buildChatInstruction,
  extractWeatherArea,
} from '../api/_panda-chat-policy.js';
import {
  groundingQueryCount,
  groundingSources,
  buildLiveShowSearchInstruction,
  buildOfficialArtistWebsiteFallbackInstruction,
  buildOfficialArtistCandidateVerificationInstruction,
  buildPriceSearchInstruction,
  buildPriceSourceFallbackInstruction,
  isFlightPriceQuestion,
  extractFlightRoute,
  extractPriceSearchArea,
  extractEventArea,
  extractArtistName,
  extractArtistWebsiteCandidate,
  isArtistClarification,
  isVerifiedOfficialArtistSource,
  shouldSearchOfficialArtistSite,
  stripRawUrls,
} from '../api/_panda-event-search.js';
import { clearEventAreaCacheForTests, resolveEventSearchArea } from '../api/_panda-event-location.js';

function makeStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    collection(name) {
      return {
        doc(id) {
          const key = `${name}/${id}`;
          return {
            key,
            name,
            id,
          };
        },
      };
    },
    async runTransaction(callback) {
      return callback({
        async get(ref) {
          const value = values.get(ref.key);
          return { data: () => value || {} };
        },
        set(ref, value) {
          values.set(ref.key, { ...(values.get(ref.key) || {}), ...value });
        },
      });
    },
  };
}

for (const query of [
  'When is Usher performing next?',
  'Does Bruce Springsteen have any concerts coming up?',
  'Find tickets for a live show by Adele',
  'What are Beyoncé’s tour dates?',
  'When is The Rolling Stones in concert?',
]) {
  test(`live show lookup recognizes explicit event questions: ${query}`, () => {
    assert.equal(isEventSearchQuestion(query), true);
  });
}

test('event lookup does not intercept transport tickets or ordinary venue searches', () => {
  assert.equal(isEventSearchQuestion('Find me train tickets to Malmö'), false);
  assert.equal(isEventSearchQuestion('Show me jazz bars in New York'), false);
  assert.equal(isEventSearchQuestion('I love Usher'), false);
  assert.equal(isEventSearchQuestion('Will it rain at the concert tonight?'), false);
});

test('price lookup recognizes products, restaurant meals and flight fares', () => {
  assert.equal(isPriceLookupQuestion('How much is a bottle of Bollinger?'), true);
  assert.equal(isPriceLookupQuestion('How much is lunch at The Ivy with and without wine?'), true);
  assert.equal(isPriceLookupQuestion('How much to fly from London to Paris?'), true);
  assert.equal(isPriceLookupQuestion('What is the average price of a 750 ml bottle in London?'), true);
  assert.equal(isPriceLookupQuestion('How much time do I need in Paris?'), false);
  assert.equal(isPriceLookupQuestion('How much do you love me?'), false);
  assert.equal(isFlightPriceQuestion('How much to fly from London to Paris?'), true);
  assert.equal(extractFlightRoute('How much to fly from London to Paris next week?'), 'London to Paris');
  assert.equal(extractPriceSearchArea('How much is lunch at The Ivy?'), '');
  assert.equal(extractPriceSearchArea('How much is lunch at The Ivy in London with wine?'), 'London');
});

test('weather area extraction handles natural city wording and ignores forecast periods', () => {
  assert.equal(extractWeatherArea('How’s the weather on Oslo next week?'), 'Oslo');
  assert.equal(extractWeatherArea('What is the current weather for Malmö, Sweden?'), 'Malmö, Sweden');
  assert.equal(extractWeatherArea('Will it rain in New York this weekend?'), 'New York');
  assert.equal(extractWeatherArea('What will the weather be like for next week?'), '');
  assert.equal(extractWeatherArea('Will it rain around here tomorrow?'), '');
  assert.equal(extractWeatherArea('What is the weather on the weekend?'), '');
});

test('event destination parsing ignores “in concert” and respects named cities', () => {
  assert.equal(extractEventArea('When is The Rolling Stones in concert?'), '');
  assert.equal(extractEventArea('When is Usher performing next in Malmö, Sweden?'), 'Malmö, Sweden');
  assert.equal(extractEventArea('When is Bruce performing in London next week?'), 'London');
  assert.equal(extractEventArea('When is Bruce Springsteen playing at Wembley Stadium?'), 'Wembley Stadium');
});

test('event search uses an explicit destination before device location', async () => {
  let requests = 0;
  const result = await resolveEventSearchArea({
    text: 'When is Usher performing next in Malmö?',
    location: { lat: 51.5074, lng: -0.1278 },
    apiKey: 'test-key',
    fetchImpl: async () => { requests++; throw new Error('must not geocode'); },
  });
  assert.deepEqual(result, { area: 'Malmö', source: 'explicit' });
  assert.equal(requests, 0);
});

test('local event searches resolve only a coarse device location and cache the city', async () => {
  clearEventAreaCacheForTests();
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    return {
      ok: true,
      json: async () => ({
        results: [{
          address_components: [
            { long_name: 'London', types: ['locality', 'political'] },
            { long_name: 'England', types: ['administrative_area_level_1', 'political'] },
            { long_name: 'United Kingdom', types: ['country', 'political'] },
          ],
        }],
      }),
    };
  };
  const location = { lat: 51.5074, lng: -0.1278 };
  const first = await resolveEventSearchArea({ text: 'When is Bruce performing next?', location, apiKey: 'test-key', fetchImpl, now: 1000 });
  const second = await resolveEventSearchArea({ text: 'When is Bruce performing next?', location, apiKey: 'test-key', fetchImpl, now: 2000 });
  assert.deepEqual(first, { area: 'London, England, United Kingdom', source: 'device-location' });
  assert.deepEqual(second, first);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /latlng=51\.51%2C-0\.13/);
  assert.doesNotMatch(urls[0], /51\.5074|-0\.1278/);
});

test('event search asks for an area instead of silently defaulting to a global answer', async () => {
  assert.deepEqual(await resolveEventSearchArea({ text: 'When is Bruce performing next?', apiKey: 'test-key' }), {
    area: '',
    source: 'unavailable',
  });
});

test('Panda reservation budget fails closed and settles provider-reported queries', async () => {
  const month = new Date('2026-11-20T12:00:00Z');
  const store = makeStore();
  const reservation = await reserveEventGroundingBudget(store, 1000, 10, month);
  assert.equal(reservation.allowed, true);
  const reserved = store.values.get('panda_event_search_usage_v1/2026-11');
  assert.equal(reserved.reservedQueries, 10);
  assert.equal(await settleEventGroundingBudget(store, reservation, 3, month), true);
  const settled = store.values.get('panda_event_search_usage_v1/2026-11');
  assert.equal(settled.usedQueries, 3);
  assert.equal(settled.reservedQueries, 0);

  const fullStore = makeStore({
    'panda_event_search_usage_v1/2026-11': { usedQueries: 995, reservedQueries: 0 },
  });
  const denied = await reserveEventGroundingBudget(fullStore, 1000, 10, month);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'limit');
  assert.equal((await reserveEventGroundingBudget(null, 1000, 10, month)).reason, 'unavailable');

  const tenThousandStore = makeStore({
    'panda_event_search_usage_v1/2026-11': { usedQueries: 9980, reservedQueries: 0 },
  });
  const higherCap = await reserveEventGroundingBudget(tenThousandStore, 10000, 10, month);
  assert.equal(higherCap.allowed, true);
  assert.equal(higherCap.limit, 10000);
});

test('grounding source links accept unique HTTPS pages and exclude search-result pages', () => {
  const candidate = {
    groundingMetadata: {
      webSearchQueries: ['Usher upcoming concerts'],
      groundingChunks: [
        { web: { uri: 'https://www.ticketmaster.com/usher-tickets/artist/781899', title: 'Usher Tickets' } },
        { web: { uri: 'https://www.ticketmaster.com/usher-tickets/artist/781899', title: 'Duplicate' } },
        { web: { uri: 'https://www.google.com/search?q=usher', title: 'Google results' } },
        { web: { uri: 'javascript:alert(1)', title: 'Unsafe' } },
        { web: { uri: 'http://insecure.example.com/show', title: 'Insecure' } },
        { web: { uri: 'https://www.venue.example/events/usher', title: 'Venue event' } },
        { web: { uri: 'https://www.usherworld.example/tour', title: 'Artist tour' } },
        { web: { uri: 'https://www.promoter.example/usher', title: 'Promoter listing' } },
        { web: { uri: 'https://www.localvenue.example/events/usher', title: 'Local venue listing' } },
        { web: { uri: 'https://www.ticket.example/usher', title: 'Ticket listing' } },
      ],
    },
  };
  assert.equal(groundingQueryCount(candidate), 1);
  assert.deepEqual(groundingSources(candidate).map(source => source.title), [
    'Usher Tickets', 'Venue event', 'Artist tour', 'Promoter listing', 'Local venue listing', 'Ticket listing',
  ]);
});

test('live show answers prioritize the last verified show, next date, ticket price and official fallback', () => {
  const prompt = buildLiveShowSearchInstruction('London, United Kingdom', 'device');
  assert.match(prompt, /most recent confirmed performance.*date, venue and city/i);
  assert.match(prompt, /next confirmed upcoming performance/i);
  assert.match(prompt, /verified official website or official tour page/i);
  assert.match(prompt, /price or range, currency/i);
  assert.match(prompt, /whether fees are included/i);
  assert.match(prompt, /first name alone such as “Bruce”/i);
  assert.match(prompt, /Do not substitute generic Google search-result cards/i);
  assert.match(prompt, /one relevant emoji/i);
});

test('official-site fallback excludes Google result pages and ticket resellers', () => {
  const prompt = buildOfficialArtistWebsiteFallbackInstruction('London, United Kingdom');
  assert.match(prompt, /first-party official website or official tour page/i);
  assert.match(prompt, /Search the exact performer name plus/i);
  assert.match(prompt, /Do not write a URL in the reply text/i);
  assert.match(prompt, /Do not return search results, fan pages, news articles, venues, social networks, or ticket resellers/i);
  assert.match(prompt, /If no official page is verified, say so plainly/i);
});

test('official artist links must be first-party-looking and match the named performer', () => {
  assert.equal(extractArtistName('When did Bruce Springsteen last perform?'), 'Bruce Springsteen');
  assert.equal(extractArtistName('Where is Usher performing next in London?'), 'Usher');
  assert.equal(extractArtistName('When is the artist performing?'), '');
  assert.equal(isVerifiedOfficialArtistSource({ title: 'brucespringsteen.net' }, 'Bruce Springsteen'), true);
  assert.equal(isVerifiedOfficialArtistSource({ title: 'Bruce Springsteen | Official Website' }, 'Bruce Springsteen'), true);
  assert.equal(isVerifiedOfficialArtistSource({ title: 'ultimateclassicrock.com' }, 'Bruce Springsteen'), false);
  assert.equal(isVerifiedOfficialArtistSource({ title: 'Bruce Springsteen Official Tickets | Ticketmaster' }, 'Bruce Springsteen'), false);
});

test('official-site retry verifies candidate domains and clarifications are not misclassified', () => {
  assert.equal(extractArtistWebsiteCandidate('Visit brucespringsteen.net for more.', 'Bruce Springsteen'), 'brucespringsteen.net');
  assert.equal(extractArtistWebsiteCandidate('Read ultimateclassicrock.com.', 'Bruce Springsteen'), '');
  assert.equal(isArtistClarification('Which Bruce do you mean?'), true);
  assert.equal(isArtistClarification('Their 2024 tour, which concluded in Vancouver.'), false);
  assert.match(
    buildOfficialArtistCandidateVerificationInstruction('London', 'Bruce Springsteen', 'brucespringsteen.net'),
    /a matching name alone is not proof/i,
  );
});

test('artist answers with no upcoming dates trigger an official-page lookup and raw URLs are removed', () => {
  assert.equal(shouldSearchOfficialArtistSite('There are no confirmed tour dates announced for London.'), true);
  assert.equal(shouldSearchOfficialArtistSite('You can check https://artist.example/tour for updates.'), true);
  assert.equal(shouldSearchOfficialArtistSite('The next show is confirmed for London on 12 June.'), false);
  assert.equal(shouldSearchOfficialArtistSite('Which Bruce do you mean?'), false);
  assert.equal(stripRawUrls('Check the official page: https://artist.example/tour 🎟️'), 'Check the official page 🎟️');
  assert.equal(stripRawUrls('Check brucespringsteen.net for dates.'), 'Check for dates.');
  assert.equal(stripRawUrls('Use [brucespringsteen.net](https://brucespringsteen.net/) or [the site]()'), 'Use or the site');
});

test('price answers provide distinct guidance for flight fares and dining or retail prices', () => {
  const localPrompt = buildPriceSearchInstruction('London, United Kingdom', 'device', false);
  assert.match(localPrompt, /current official menu prices/i);
  assert.match(localPrompt, /food-only and food plus one glass of wine/i);
  assert.match(localPrompt, /standard 750 ml bottle/i);
  assert.match(localPrompt, /currency/i);
  assert.match(localPrompt, /indicative range or average/i);
  assert.match(localPrompt, /one or two relevant emojis/i);

  const flightPrompt = buildPriceSearchInstruction('London to Paris', 'explicit', true);
  assert.match(flightPrompt, /origin and destination/i);
  assert.match(flightPrompt, /current indicative average or range/i);
  assert.match(flightPrompt, /bookable or guaranteed/i);
  assert.match(flightPrompt, /baggage and fees/i);
});

test('price source recheck searches a clearer product or route and never emits raw URLs', () => {
  const productPrompt = buildPriceSourceFallbackInstruction('London, United Kingdom');
  assert.match(productPrompt, /focused Google Search grounded recheck/i);
  assert.match(productPrompt, /standard\/popular variant as an assumption/i);
  assert.match(productPrompt, /current page supports it/i);
  assert.match(productPrompt, /Do not write raw URLs/i);

  const flightPrompt = buildPriceSourceFallbackInstruction('London to Paris', true);
  assert.match(flightPrompt, /exact route/i);
  assert.match(flightPrompt, /one-way\/return basis/i);
});

test('ticket-price questions route to live event search', () => {
  assert.equal(isEventSearchQuestion('How much are Bruce Springsteen tickets?'), true);
  assert.equal(isEventSearchQuestion('What does a concert ticket cost in London?'), true);
  assert.equal(isEventSearchQuestion('How much is dinner at home?'), false);
});

test('live show and price searches share a 10000-query cap without generic search cards', () => {
  const handler = readFileSync(new URL('../api/panda-ai.js', import.meta.url), 'utf8');
  assert.match(handler, /PANDA_LIVE_LOOKUP_MONTHLY_LIMIT/);
  assert.match(handler, /boundedInteger\(configuredLookupLimit,10000,1,10000\)/);
  assert.doesNotMatch(handler, /groundingSearchLinks/);
});

test('show and price source gaps receive a bounded grounded recheck', () => {
  const handler = readFileSync(new URL('../api/panda-ai.js', import.meta.url), 'utf8');
  assert.match(handler, /shouldSearchOfficialArtistSite\(text\)/);
  assert.match(handler, /buildOfficialArtistWebsiteFallbackInstruction/);
  assert.match(handler, /buildOfficialArtistCandidateVerificationInstruction/);
  assert.match(handler, /isVerifiedOfficialArtistSource/);
  assert.match(handler, /officialSiteQuestion/);
  assert.match(handler, /stage:'official-site-verification-retry'/);
  assert.match(handler, /buildPriceSourceFallbackInstruction/);
  assert.match(handler, /stage:'grounded-price-recheck'/);
  assert.match(handler, /stripRawUrls\(text\)/);
});

test('Panda prompt supports natural warmth, hospitality, emojis, birthdays and weather attribution', () => {
  const prompt = buildChatInstruction([], { timeZone: 'Europe/London' }, {
    source: 'MET Norway',
    attribution: 'Weather data from MET Norway, licensed under CC BY 4.0.',
    forecast: [],
  }, [], null, 'Oslo');
  assert.match(prompt, /Hospitality is your heart/i);
  assert.match(prompt, /one or two relevant emojis naturally/i);
  assert.match(prompt, /birthday/i);
  assert.match(prompt, /CC BY 4\.0/i);
  assert.match(prompt, /model forecast/i);
  assert.match(prompt, /requested area "Oslo"/i);
  assert.match(prompt, /one fitting weather emoji/i);
  assert.doesNotMatch(prompt, /not a forecast/i);
});
