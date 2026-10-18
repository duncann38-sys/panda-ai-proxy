import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ITINERARY_STOPS,
  collectItineraryVenues,
  detectItineraryStages,
  itineraryReply,
} from '../api/_panda-itinerary.js';

const candidate = (id, name, extra = {}) => ({
  id,
  name,
  photoName: 'places/' + id + '/photos/cover',
  photoCount: 6,
  ...extra,
});

test('only explicit multi-stop plans trigger and preserve the requested order', () => {
  const stages = detectItineraryStages('Plan a Battersea evening: dinner, cocktails, then live music');
  assert.deepEqual(stages.map(stage => stage.key), ['dinner', 'drinks', 'music']);
  assert.equal(detectItineraryStages('Find dinner and cocktails in Battersea'), null);
  assert.equal(detectItineraryStages('Plan dinner in Battersea'), null);
});

test('itinerary is limited to four requested stop types and excludes sensitive requirements', () => {
  const stages = detectItineraryStages('Plan a day out: coffee, gallery, lunch, dessert and cocktails');
  assert.equal(stages.length, MAX_ITINERARY_STOPS);
  assert.deepEqual(stages.map(stage => stage.key), ['coffee', 'culture', 'lunch', 'dessert']);
  assert.equal(detectItineraryStages('Plan a vegan dinner and cocktails'), null);
  assert.equal(detectItineraryStages('Plan a nut-free dinner and music'), null);
});

test('venue selection is sequential, deduplicated, photo-qualified and labelled by requested stop', async () => {
  const stages = detectItineraryStages('Plan dinner then cocktails then live music');
  const calls = [];
  const result = await collectItineraryVenues(stages, async stage => {
    calls.push(stage.key);
    if (stage.key === 'dinner') return [candidate('same', 'First place')];
    if (stage.key === 'drinks') return [candidate('same', 'Duplicate'), candidate('bar', 'Cocktail bar')];
    return [candidate('music', 'Music room', { photoCount: 5 })];
  });
  assert.deepEqual(calls, ['dinner', 'drinks', 'music']);
  assert.deepEqual(result.venues.map(venue => venue.id), ['same', 'bar', 'music']);
  assert.match(result.venues[1].stopLabel, /^Stop 2 of 3 · Drinks$/);
  assert.deepEqual(result.missing, []);
});

test('unverified or incomplete candidates are skipped and missing stages are explicit', async () => {
  const stages = detectItineraryStages('Plan brunch then live music');
  const result = await collectItineraryVenues(stages, async stage => {
    if (stage.key === 'brunch') return [{ id: 'no-photo', name: 'No photo', photoCount: 0 }];
    throw new Error('provider unavailable');
  });
  assert.deepEqual(result.venues, []);
  assert.deepEqual(result.missing, ['Brunch', 'Live music']);
  assert.match(itineraryReply({ stages, venues: result.venues, missing: result.missing, area: 'Chelsea' }), /couldn’t verify any venue cards/);
});

test('reply identifies verified cards, omissions, location and observed weather without claiming a forecast', () => {
  const stages = detectItineraryStages('Plan dinner and cocktails tonight');
  const venues = [
    { ...candidate('dinner', 'Dining room'), stopLabel: 'Stop 1 of 2 · Dinner' },
    { ...candidate('bar', 'Cocktail bar'), stopLabel: 'Stop 2 of 2 · Drinks' },
  ];
  const reply = itineraryReply({ stages, venues, missing: [], area: 'Battersea', weather: { condition: 'Rain', temperatureC: 9 } });
  assert.match(reply, /Battersea/);
  assert.match(reply, /Dining room/);
  assert.match(reply, /Cocktail bar/);
  assert.match(reply, /Current conditions: Rain, 9°C/);
  assert.doesNotMatch(reply, /forecast/i);
});
