import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEventSearchQuestion,
  reserveEventGroundingBudget,
  settleEventGroundingBudget,
  buildChatInstruction,
  extractWeatherArea,
} from '../api/_panda-chat-policy.js';
import {
  groundingQueryCount,
  groundingSources,
  extractEventArea,
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

test('Panda prompt supports natural warmth, hospitality, emojis, birthdays and weather attribution', () => {
  const prompt = buildChatInstruction([], { timeZone: 'Europe/London' }, {
    source: 'MET Norway',
    attribution: 'Weather data from MET Norway, licensed under CC BY 4.0.',
    forecast: [],
  }, [], null, 'Oslo');
  assert.match(prompt, /Hospitality is your heart/i);
  assert.match(prompt, /emojis sparingly/i);
  assert.match(prompt, /birthday/i);
  assert.match(prompt, /CC BY 4\.0/i);
  assert.match(prompt, /model forecast/i);
  assert.match(prompt, /requested area "Oslo"/i);
  assert.match(prompt, /one fitting weather emoji/i);
  assert.doesNotMatch(prompt, /not a forecast/i);
});
