import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRideRequest, pickRideDestination, rankRideDestinations } from '../api/_panda-ride-request.js';

test('ride requests extract the requested venue and optional city without booking a ride', () => {
  assert.deepEqual(parseRideRequest('Get me an Uber to the Ritz Hotel'), {
    destination: 'the Ritz Hotel',
    area: '',
  });
  assert.deepEqual(parseRideRequest('Could you get me an Uber to The Ritz in London, please?'), {
    destination: 'The Ritz',
    area: 'London',
  });
  assert.deepEqual(parseRideRequest('I need a taxi to Heathrow tonight'), {
    destination: 'Heathrow',
    area: '',
  });
  assert.deepEqual(parseRideRequest('I need an Uber'), { destination: '', area: '' });
  assert.deepEqual(parseRideRequest('Can you get me an Uber there?'), { destination: '', area: '' });
  assert.equal(parseRideRequest('Uber prices look high tonight'), null);
});

test('ride destination selection prefers matching venue names and then the closest one', () => {
  const closest = { name: 'The Ritz London', type: 'hotel', distanceMeters: 3000 };
  const venues = [
    { name: 'Ritz Hotel Reading', type: 'hotel', distanceMeters: 5000 },
    { name: 'The Ritz lounge', type: 'bar', distanceMeters: 50 },
    { name: 'A hotel nearby', distanceMeters: 100 },
    closest,
  ];
  assert.equal(pickRideDestination(venues, 'the Ritz Hotel'), closest);
  assert.equal(pickRideDestination(venues, 'A completely different place'), null);
  assert.equal(pickRideDestination(venues, ''), null);
});

test('an ambiguous destination such as The Savoy returns choices instead of guessing', () => {
  const venues = [
    { name: 'Savoy Theatre', type: 'theatre', distanceMeters: 120 },
    { name: 'The Savoy Hotel', type: 'hotel', distanceMeters: 800 },
  ];
  assert.equal(pickRideDestination(venues, 'The Savoy'), null);
  assert.equal(rankRideDestinations(venues, 'The Savoy').length, 2);
  assert.equal(pickRideDestination(venues, 'The Savoy Hotel'), venues[1]);
});

test('ride requests take the focused one-card path and never claim to book a ride', () => {
  const handler = readFileSync(new URL('../api/panda-ai.js', import.meta.url), 'utf8');
  const ridePath = handler.indexOf('if(rideRequest){');
  const outingPath = handler.indexOf('if(!sessionVenueTransitFollowUp&&!groundedLookupQuestion)');
  assert.ok(ridePath >= 0 && ridePath < outingPath);
  const block = handler.slice(ridePath, outingPath);
  assert.match(block, /searchVenuesSmart/);
  assert.match(block, /venues:\[destinationVenue\]/);
  assert.match(block, /Tap the Uber estimate/);
  assert.match(block, /I haven’t requested a ride/);
  assert.match(block, /popular bars pubs restaurants cafes/);
  assert.match(block, /ride-options/);
  assert.match(block, /ride-choices/);
});
