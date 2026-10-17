import test from 'node:test';
import assert from 'node:assert/strict';
import { ID_COLLECTION, LOCATION_COLLECTION } from '../api/_london-index.js';
import { readCategoryCoverage } from '../api/_index-progress.js';

const now = Date.parse('2026-10-17T12:00:00.000Z');

function document(id, searchContexts) {
  return {
    id,
    data: () => ({
      searchContexts,
      primary_photo_path: '/api/partner/venues/' + encodeURIComponent(id) + '/photos/0/image',
    }),
  };
}

test('Battersea coverage counts category IDs inside the feed radius and separates expired locations', async () => {
  const docs = [
    document('meat-near', ['battersea/Meat']),
    document('sports-expired', ['nine_elms/Sports']),
    document('music-far', ['battersea/Live Music']),
  ];
  const positions = {
    'meat-near': { lat: 51.4722, lng: -0.1668, expiresAt: new Date(now + 60_000) },
    'sports-expired': { lat: 51.4814, lng: -0.1393, expiresAt: new Date(now - 60_000) },
    'music-far': { lat: 51.8, lng: -0.1668, expiresAt: new Date(now + 60_000) },
  };
  const store = {
    collection(name) {
      if (name === ID_COLLECTION) return { where: () => ({ get: async () => ({ docs }) }) };
      if (name === LOCATION_COLLECTION) return { doc: id => ({ id }) };
      throw new Error('Unexpected collection ' + name);
    },
    getAll: async (...refs) => refs.map(ref => ({ data: () => positions[ref.id] || {} })),
  };

  const report = await readCategoryCoverage(store, now);
  const meat = report.categories.find(item => item.category === 'Meat');
  const sports = report.categories.find(item => item.category === 'Sports');
  const liveMusic = report.categories.find(item => item.category === 'Live Music');

  assert.equal(report.batterseaCoverageRadiusMeters, 20_000);
  assert.equal(report.batterseaTargetPerCategory, 300);
  assert.equal(meat.batterseaStoredIdCount, 1);
  assert.equal(meat.batterseaFeedReadyIdCount, 1);
  assert.equal(sports.batterseaStoredIdCount, 1);
  assert.equal(sports.batterseaFeedReadyIdCount, 0);
  assert.equal(liveMusic.batterseaStoredIdCount, 0);
});
