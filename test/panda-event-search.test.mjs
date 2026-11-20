import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEventSearchQuestion,
  reserveEventGroundingBudget,
  settleEventGroundingBudget,
  buildChatInstruction,
} from '../api/_panda-chat-policy.js';
import {
  groundingQueryCount,
  groundingSources,
} from '../api/_panda-event-search.js';

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
      ],
    },
  };
  assert.equal(groundingQueryCount(candidate), 1);
  assert.deepEqual(groundingSources(candidate).map(source => source.title), ['Usher Tickets', 'Venue event']);
});

test('Panda prompt supports natural warmth, hospitality, emojis, birthdays and weather attribution', () => {
  const prompt = buildChatInstruction([], { timeZone: 'Europe/London' }, {
    source: 'MET Norway',
    attribution: 'Weather data from MET Norway, licensed under CC BY 4.0.',
    forecast: [],
  });
  assert.match(prompt, /Hospitality is your heart/i);
  assert.match(prompt, /emojis sparingly/i);
  assert.match(prompt, /birthday/i);
  assert.match(prompt, /CC BY 4\.0/i);
  assert.match(prompt, /model forecast/i);
  assert.doesNotMatch(prompt, /not a forecast/i);
});
