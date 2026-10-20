import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { outingIntent, filterOutingVenues, outingReply, answerOutingRequest } from '../api/_panda-outing-intent.js';
import { programmeDate, extractProgrammeEvents, officialProgrammes } from '../api/_panda-programmes.js';

const pub = { id: 'real-pub', name: 'Nine Elms Tavern', primaryType: 'pub', openNow: false };
const bar = { id: 'real-bar', name: 'A cocktail bar', primaryType: 'cocktail_bar', openNow: true };
const cafe = { id: 'cafe', name: 'The Black Cab Coffee Shop', primaryType: 'coffee_shop' };
const hotel = { id: 'hotel', name: 'Hotel', primaryType: 'hotel' };
const theatre = { id: 'theatre', name: 'A real theatre', primaryType: 'performing_arts_theater' };
const concert = { id: 'concert', name: 'A concert hall', primaryType: 'concert_hall' };
const request = text => ({ text, contents: [], location: { lat: 51.48, lng: -0.14 }, hasLocation: true });

test('both photographed theatre prompts keep their actual intent', () => {
  assert.equal(outingIntent('What is going on in theatres today').kind, 'theatre');
  assert.equal(outingIntent('What shows are on').kind, 'theatre');
  const contents = [{ role: 'user', parts: [{ text: 'Any concerts tonight?' }] }];
  assert.equal(outingIntent('What shows are on', contents).kind, 'concerts');
  assert.equal(outingIntent('Any musicals today?').kind, 'musicals');
  assert.equal(outingIntent('What’s on the menu?'), null);
  assert.equal(outingIntent('Show me restaurants'), null);
});

test('drinking intent admits pubs and verified alcohol service, not coffee shops or hotels', () => {
  const intent = outingIntent('I want to get drunk');
  assert.equal(intent.kind, 'drinks');
  assert.deepEqual(filterOutingVenues([pub, bar, cafe, hotel], intent), [pub, bar]);
  assert.deepEqual(filterOutingVenues([{ ...cafe, servesWine: true }], intent).length, 1);
  assert.deepEqual(filterOutingVenues([{ ...hotel, types: ['hotel', 'bar'] }], intent), []);
  assert.deepEqual(filterOutingVenues([{ name: 'Theatre Bar', primaryType: 'gift_shop' }], intent), []);
  assert.equal(outingIntent('What is alcohol?'), null);
});

test('entertainment excludes hospitality, cinemas, and venue-name false positives', () => {
  assert.deepEqual(filterOutingVenues([pub, cafe, hotel, theatre, concert], outingIntent('theatres today')), [theatre]);
  assert.deepEqual(filterOutingVenues([pub, cafe, hotel, theatre, concert], outingIntent('concerts tonight')), [theatre, concert]);
  assert.deepEqual(filterOutingVenues([{ name: 'Royal Opera Shop', primaryType: 'gift_shop' }], outingIntent('musicals')), []);
});

test('screenshot drinking request uses one category-specific search and a polite grounded reply', async () => {
  const queries = [];
  const result = await answerOutingRequest(request('I want to get drunk'), {
    search: async query => { queries.push(query); return [cafe, hotel, pub, bar]; },
  });
  assert.deepEqual(queries, ['pubs and bars']);
  assert.deepEqual(result.venues.map(venue => venue.id), ['real-pub', 'real-bar']);
  assert.match(result.text, /^Certainly/);
  assert.doesNotMatch(result.text, /real nearby matches|definitely|get you drunk/i);
  assert.equal(result.outingKind, 'drinks');
});

test('closed-only pubs are not advertised as currently serving', () => {
  assert.match(outingReply(outingIntent('pubs'), [pub]), /marked closed/);
  assert.doesNotMatch(outingReply(outingIntent('pubs'), [pub]), /Some are marked open/);
});

test('an explicit open-now request never returns closed or unknown-hours pubs', async () => {
  const result = await answerOutingRequest(request('pubs open now'), {
    search: async (query, area, wantOpen) => { assert.equal(wantOpen, true); return [pub, bar, { ...pub, openNow: null }]; },
  });
  assert.deepEqual(result.venues, [bar]);
});

test('official shows can still be returned if the Places provider is unavailable', async () => {
  const production = { name: 'A verified show', url: 'https://officiallondontheatre.com/show/a-show/', evidence: 'official_running_production' };
  const result = await answerOutingRequest(request('musicals today'), {
    search: async () => { throw Error('Google unavailable'); },
    programmes: async () => ({ events: [], productions: [production], dateLabel: 'Tuesday 20 October' }),
  });
  assert.equal(result.programmeStatus, 'running_productions');
  assert.match(result.text, /A verified show/);
});

test('show lookup does not substitute hospitality when listings or providers fail', async () => {
  let calls = 0;
  const result = await answerOutingRequest(request('What shows are on'), {
    search: async query => { calls++; assert.match(query, /theatres/); return [cafe, pub, theatre]; },
    programmes: async () => { throw Error('publisher temporarily unavailable'); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.venues, [theatre]);
  assert.equal(result.programmeStatus, 'performances_unverified');
  assert.match(result.text, /haven’t confirmed individual performances/);
  assert.doesNotMatch(result.text, /AI is temporarily unavailable|real nearby matches/);
  const failed = await answerOutingRequest(request('concerts tonight'), { search: async () => { throw Error('Google unavailable'); } });
  assert.deepEqual(failed.venues, []);
  assert.match(failed.text, /concert/);
});

test('location is clarified instead of silently assuming London; weekday is clarified', async () => {
  const search = async () => { throw Error('must not search'); };
  const result = await answerOutingRequest({ ...request('musicals'), hasLocation: false }, { search });
  assert.equal(result.aiMode, 'clarification');
  const day = await answerOutingRequest(request('concerts this Saturday'), { search });
  assert.match(day.text, /exact date/);
});

const date = programmeDate('today', 'Europe/London', new Date('2026-10-20T09:00:00Z'));
const source = 'https://www.nationaltheatre.org.uk/whats-on/';
const script = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const event = (changes = {}) => ({
  '@type': 'TheaterEvent', name: 'A dated performance', startDate: '2026-10-20T19:30:00+01:00',
  location: { name: 'National Theatre' }, url: '/productions/a-show/', ...changes,
});

test('only actual dated performances qualify; show-run ranges and cancelled shows do not', () => {
  const html = script({ '@graph': [
    event(), event({ name: 'Yesterday', startDate: '2026-10-19T19:30:00+01:00' }),
    event({ name: 'A long run', startDate: '2026-01-01', endDate: '2026-12-31' }),
    event({ name: 'Run opening today', endDate: '2026-12-31T19:30:00+00:00' }),
    event({ name: 'Cancelled', eventStatus: 'https://schema.org/EventCancelled' }),
    event({ name: 'Unsafe URL', url: 'http://127.0.0.1/private' }),
  ] });
  const found = extractProgrammeEvents(html, source, date);
  assert.equal(found.length, 1);
  assert.equal(found[0].time, '19:30');
  assert.equal(found[0].evidence, 'official_dated_programme');
  assert.equal(found[0].url, 'https://www.nationaltheatre.org.uk/productions/a-show/');
});

test('running productions are clearly separated from dated performances and contain no invented times', () => {
  const found = extractProgrammeEvents(script(event({ startDate: '2026-01-01T09:44:00+00:00', endDate: '2026-12-31T09:44:00+00:00' })), source, date, { productions: true });
  assert.equal(found.length, 1);
  assert.equal(found[0].time, '');
  assert.equal(found[0].evidence, 'official_running_production');
  const reply = outingReply(outingIntent('musicals'), [], { events: [], productions: found, dateLabel: date.label });
  assert.match(reply, /not confirmed performances today/);
});

test('publisher URLs in location.name are not presented as venue names', () => {
  const found = extractProgrammeEvents(script(event({ location: { name: 'https://officiallondontheatre.com/venue/a-theatre/' } })), source, date);
  assert.equal(found[0].venue, '');
});

test('a mixed arts programme cannot turn an exhibition or play into a concert', () => {
  const html = script({ '@graph': [event(), event({ '@type': 'Event', name: 'An exhibition' }), event({ '@type': 'MusicEvent', name: 'A real concert' })] });
  const found = extractProgrammeEvents(html, source, date, { kind: 'concerts' });
  assert.deepEqual(found.map(value => value.name), ['A real concert']);
});

test('UK local dates and tomorrow are evaluated using the session time zone', () => {
  assert.equal(programmeDate('today', 'Europe/London', new Date('2026-06-30T23:30:00Z')).iso, '2026-07-01');
  assert.equal(programmeDate('tomorrow', 'Europe/London', new Date('2026-06-30T23:30:00Z')).iso, '2026-07-02');
  assert.equal(programmeDate('', 'invalid-zone', new Date('2026-10-20T09:00:00Z')).iso, '2026-10-20');
});

test('official programme links use real dates and never promise ticket availability', async () => {
  const result = await answerOutingRequest(request('theatre today'), {
    search: async () => [theatre],
    programmes: async () => ({ events: extractProgrammeEvents(script(event()), source, date), dateLabel: date.label }),
  });
  assert.equal(result.programmeStatus, 'dated_listings');
  assert.match(result.text, /A dated performance/);
  assert.match(result.text, /doesn’t guarantee availability/);
  assert.match(result.text, /Tuesday,? 20 October/);
});

test('London programme sources are not shown for a different city', async () => {
  const result = await officialProgrammes({ ...request('concerts'), location: { lat: 53.48, lng: -2.24 }, intent: outingIntent('concerts') }, {
    fetchImpl: async () => { throw Error('must not contact London publishers'); },
    now: new Date('2026-10-20T09:00:00Z'),
  });
  assert.deepEqual(result.events, []);
});

test('dedicated intent handling precedes the broad maySearchVenues gate in the live handler', () => {
  const code = readFileSync(new URL('../api/panda-ai.js', import.meta.url), 'utf8');
  const entry = code.indexOf('const outing=await answerOutingRequest');
  assert.ok(entry > 0);
  assert.ok(entry < code.indexOf('if(maySearchVenues(userText)&&ambiguousClub'));
  assert.match(code.slice(entry, entry + 800), /if\(outing\).*json\(outing\)/s);
});
