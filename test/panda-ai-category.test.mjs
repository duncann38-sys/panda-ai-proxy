import test from 'node:test';
import assert from 'node:assert/strict';
import { googleCategoryTags } from '../api/_google-category-tags.js';
import { classifyGoogleTypeCategories } from '../api/_venue-taxonomy.js';

test('category classification without a query does not turn generic hospitality into Live Music or Pubs', () => {
  const restaurant = {
    displayName: { text: 'BAO Battersea' },
    primaryType: 'restaurant',
    primaryTypeDisplayName: { text: 'Restaurant' },
    types: ['restaurant'],
  };
  const categories = googleCategoryTags(restaurant, '');
  assert.equal(categories.includes('Live Music'), false);
  assert.equal(categories.includes('Pubs'), false);
});

test('an actual Google pub type remains in the Pubs category', () => {
  const pub = {
    displayName: { text: 'The Riverside' },
    primaryType: 'pub',
    primaryTypeDisplayName: { text: 'Pub' },
    types: ['pub', 'bar'],
  };
  assert.equal(googleCategoryTags(pub, '').includes('Pubs'), true);
});

test('broad activity categories require an explicit Google place-type match', () => {
  const pub = {
    displayName: { text: 'The Riverside' },
    primaryType: 'pub',
    primaryTypeDisplayName: { text: 'Pub' },
    types: ['pub', 'bar'],
  };
  const pubCategories = classifyGoogleTypeCategories(pub);
  assert.equal(pubCategories.includes('Sports'), false);
  assert.equal(pubCategories.includes('Live Music'), false);

  const sportsBar = { primaryType: 'sports_bar', types: ['sports_bar', 'bar'] };
  assert.equal(classifyGoogleTypeCategories(sportsBar).includes('Sports'), true);

  const musicVenue = { primaryType: 'live_music_venue', types: ['live_music_venue'] };
  assert.deepEqual(classifyGoogleTypeCategories(musicVenue), ['Live Music']);
});

test('a strict cuisine search context adds only its own tag to a Google restaurant', () => {
  const restaurant = {
    displayName: { text: 'Maison Claire' },
    primaryType: 'restaurant',
    primaryTypeDisplayName: { text: 'Restaurant' },
    types: ['restaurant'],
  };
  const tags = googleCategoryTags(restaurant, 'French');
  assert.equal(tags.includes('French'), true);
  assert.equal(tags.includes('Indian'), false);
});
