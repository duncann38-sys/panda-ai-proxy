import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearOpeningFeedCache,
  findRecentOpeningVenues,
  isNewOpeningRequest,
  matchesOpeningVenueName,
  parseHotDinnersOpenings,
  rotateOpeningResults,
} from '../api/_panda-new-openings.js';

const now = Date.parse('2026-10-18T12:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

function entry(title, publishedAt, summary, slug, host = 'www.hot-dinners.com') {
  return '<entry><title>' + title + '</title><link rel="alternate" href="https://' + host + '/' + slug + '"/><published>' + publishedAt + '</published><summary><![CDATA[' + summary + ']]></summary></entry>';
}

function feed(...entries) {
  return '<feed>' + entries.join('') + '</feed>';
}

test('the AI shortcut and typed wording both route to the new-opening finder', () => {
  assert.equal(isNewOpeningRequest('New restaurants near me'), true);
  assert.equal(isNewOpeningRequest('Show recently opened places'), true);
  assert.equal(isNewOpeningRequest('Dinner tonight'), false);
});

test('only dated, already-open London reports inside the last 90 days are candidates', () => {
  const exactCutoff = new Date(now - 90 * day).toISOString();
  const valid = entry('Conviviale has just opened', exactCutoff, 'Conviviale has just opened its doors.', 'conviviale');
  const old = entry('Old venue has just opened', new Date(now - 90 * day - 1).toISOString(), 'Old venue has just opened its doors.', 'old');
  const future = entry('New venue is coming soon', new Date(now).toISOString(), 'New venue is getting ready to open next month.', 'future');
  const popup = entry('Popup House has just opened', new Date(now).toISOString(), 'Popup House has just opened as a pop-up.', 'popup');
  const wrongHost = entry('Impostor has just opened', new Date(now).toISOString(), 'Impostor has just opened its doors.', 'impostor', 'example.com');
  const candidates = parseHotDinnersOpenings(feed(valid, old, future, popup, wrongHost), { now });
  assert.deepEqual(candidates.map((candidate) => candidate.venueName), ['Conviviale']);
  assert.equal(candidates[0].sourceName, 'Hot Dinners');
  assert.equal(candidates[0].sourceUrl, 'https://www.hot-dinners.com/conviviale');
});

test('conservative name extraction handles reported venue names without guessing future openings', () => {
  const horse = entry('Test Driving The Horses, a modern tavern', '2026-10-06T10:00:00Z', 'The Public House Group have opened their fifth London pub.', 'horses');
  const candidate = parseHotDinnersOpenings(feed(horse), { now })[0];
  assert.equal(candidate.venueName, 'The Horses');
  assert.equal(matchesOpeningVenueName('The Horses', 'The Horses Tavern'), true);
  assert.equal(matchesOpeningVenueName('The Horses', 'The White Horse'), false);
});

test('only source-matched Google venues rated at least 4.3 with one photo are returned', async () => {
  clearOpeningFeedCache();
  const items = [
    ['Conviviale', 'valid'],
    ['Low Rated', 'low'],
    ['No Photo', 'photo'],
    ['Too Far', 'distance'],
  ].map(([name, slug]) => entry(name + ' has just opened', '2026-10-10T10:00:00Z', name + ' has just opened its doors.', slug));
  const result = await findRecentOpeningVenues({
    now,
    fetchImpl: async () => ({ ok: true, text: async () => feed(...items) }),
    sleep: async () => {},
    searchCandidate: async (_query, candidate) => {
      const common = { id: 'ChIJ' + candidate.venueName.replace(/\s/g, ''), name: candidate.venueName, photoName: 'places/cover', photoCount: 1, distanceMeters: 1200 };
      if (candidate.venueName === 'Low Rated') return { venues: [{ ...common, rating: 4.2 }] };
      if (candidate.venueName === 'No Photo') return { venues: [{ ...common, rating: 4.5, photoName: '', photoCount: 0 }] };
      if (candidate.venueName === 'Too Far') return { venues: [{ ...common, rating: 4.5, distanceMeters: 20001 }] };
      return { venues: [{ ...common, rating: 4.5 }] };
    },
  });
  assert.equal(result.venues.length, 1);
  assert.equal(result.venues[0].name, 'Conviviale');
  assert.equal(result.venues[0].openingSourceName, 'Hot Dinners');
  assert.equal(result.venues[0].openingReportedAt, '2026-10-10T10:00:00.000Z');
});

test('shown opening IDs are excluded first and the remaining pool rotates after exhaustion', () => {
  const venues = [{ id: 'ChIJone' }, { id: 'ChIJtwo' }, { id: 'ChIJthree' }];
  assert.deepEqual(rotateOpeningResults(venues, ['ChIJone'], 0, 2).map((venue) => venue.id), ['ChIJtwo', 'ChIJthree']);
  assert.deepEqual(rotateOpeningResults(venues, ['ChIJone', 'ChIJtwo', 'ChIJthree'], 1, 2).map((venue) => venue.id), ['ChIJtwo', 'ChIJthree']);
});

test('the finder caps Google candidate searches and never pads with generic venues', async () => {
  clearOpeningFeedCache();
  const candidates = Array.from({ length: 12 }, (_, index) => entry('Venue ' + index + ' has just opened', '2026-10-10T10:00:00Z', 'Venue ' + index + ' has just opened its doors.', 'venue-' + index));
  let searchCount = 0;
  const result = await findRecentOpeningVenues({
    now,
    fetchImpl: async () => ({ ok: true, text: async () => feed(...candidates) }),
    sleep: async () => {},
    searchCandidate: async () => { searchCount += 1; return { venues: [] }; },
  });
  assert.equal(searchCount, 10);
  assert.equal(result.venues.length, 0);
  assert.match(result.text, /won’t pad this with ordinary nearby restaurants/);
});

test('a failed opening source returns a clear error without searching generic places', async () => {
  clearOpeningFeedCache();
  let searchCount = 0;
  const result = await findRecentOpeningVenues({
    now,
    fetchImpl: async () => ({ ok: false, text: async () => '' }),
    searchCandidate: async () => { searchCount += 1; return { venues: [] }; },
  });
  assert.equal(result.sourceStatus, 'unavailable');
  assert.equal(searchCount, 0);
  assert.match(result.text, /won’t guess/);
});
