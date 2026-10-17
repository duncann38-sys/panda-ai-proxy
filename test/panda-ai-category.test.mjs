import test from 'node:test';
import assert from 'node:assert/strict';
import { googleCategoryTags } from '../api/_google-category-tags.js';

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
