import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillVenueTaxonomyPage, deriveVenueTaxonomy,
} from '../api/_venue-taxonomy.js';

function migrationStore(records) {
  const documents = new Map(Object.entries(records).map(([id, data]) => [id, structuredClone(data)]));
  const reference = id => ({
    id,
    get(field) {
      return field.split('.').reduce((value, key) => value?.[key], documents.get(id));
    },
  });
  return {
    documents,
    collection() {
      const query = {
        cursor: null,
        pageSize: 200,
        orderBy() { return this; },
        startAfter(cursor) { this.cursor = cursor; return this; },
        limit(size) { this.pageSize = size; return this; },
        async get() {
          const rows = [...documents.keys()].sort()
            .filter(id => !query.cursor || id > query.cursor)
            .slice(0, query.pageSize);
          return {
            docs: rows.map(id => ({
              id,
              ref: reference(id),
              get: field => reference(id).get(field),
            })),
          };
        },
        count() {
          return { get: async () => ({ data: () => ({ count: documents.size }) }) };
        },
      };
      return query;
    },
    batch() {
      const changes = [];
      return {
        update(ref, fields) { changes.push([ref.id, fields]); },
        async commit() {
          for (const [id, fields] of changes) {
            const document = documents.get(id);
            if (!document) throw new Error('update must not recreate a missing document');
            for (const [path, value] of Object.entries(fields)) {
              const keys = path.split('.');
              let parent = document;
              for (const key of keys.slice(0, -1)) parent = parent[key] ||= {};
              parent[keys.at(-1)] = structuredClone(value);
            }
          }
        },
      };
    },
  };
}

test('a dedicated French and Indian search context only adds its own cuisine tags', () => {
  const taxonomy = deriveVenueTaxonomy([
    'battersea/French',
    'chelsea/Indian',
    'battersea/All',
  ]);

  assert.deepEqual(taxonomy.internal_category_tags, ['french', 'indian']);
  assert.deepEqual(taxonomy.cuisine_tags, ['french', 'indian']);
  assert.deepEqual(taxonomy.feature_tags, []);
  assert.deepEqual(taxonomy.evidence.cuisine.french, ['battersea/French']);
  assert.deepEqual(taxonomy.evidence.cuisine.indian, ['chelsea/Indian']);
  assert.deepEqual(taxonomy.verification_required_contexts, ['battersea/All']);
});

test('broad service and experience searches are held for verification, not tagged as features', () => {
  const taxonomy = deriveVenueTaxonomy([
    'battersea/Live Music',
    'battersea/Sports',
    'battersea/Nightlife',
    'battersea/Lunch',
    'battersea/Pubs',
    'battersea/Bottomless',
  ]);

  assert.deepEqual(taxonomy.internal_category_tags, ['pubs']);
  assert.deepEqual(taxonomy.cuisine_tags, []);
  assert.deepEqual(taxonomy.feature_tags, []);
  assert.deepEqual(taxonomy.verification_required_contexts, [
    'battersea/Bottomless',
    'battersea/Live Music',
    'battersea/Lunch',
    'battersea/Nightlife',
    'battersea/Sports',
  ]);
});

test('unknown or malformed discovery contexts never create tags', () => {
  const taxonomy = deriveVenueTaxonomy([
    'battersea/French',
    'not-a-seed-query',
    null,
  ]);

  assert.deepEqual(taxonomy.internal_category_tags, ['french']);
  assert.deepEqual(taxonomy.unknown_contexts, ['not-a-seed-query']);
});

test('dry-run is read-only and apply updates existing IDs in place without changing document count', async () => {
  const store = migrationStore({
    ChIJFrench: {
      place_id: 'ChIJFrench',
      searchContexts: ['battersea/French'],
      primary_photo_path: '/api/partner/venues/ChIJFrench/photos/0/image',
      partnerTier: 'banging',
    },
    ChIJMusic: {
      place_id: 'ChIJMusic',
      searchContexts: ['battersea/Live Music'],
      primary_photo_path: '/api/partner/venues/ChIJMusic/photos/0/image',
    },
  });
  const dryRun = await backfillVenueTaxonomyPage(store);
  assert.equal(dryRun.totalDocuments, 2);
  assert.equal(dryRun.documentsWouldUpdate, 2);
  assert.equal(dryRun.documentsUpdated, 0);
  assert.equal(store.documents.get('ChIJFrench').panda_taxonomy_v1, undefined);

  const firstPage = await backfillVenueTaxonomyPage(store, { apply: true, pageSize: 1 });
  assert.equal(firstPage.status, 'more');
  assert.equal(firstPage.documentsUpdated, 1);
  const secondPage = await backfillVenueTaxonomyPage(store, {
    apply: true, pageSize: 1, cursor: firstPage.cursor, expectedCount: firstPage.totalDocuments,
  });
  assert.equal(secondPage.status, 'more');
  assert.equal(secondPage.documentsUpdated, 1);
  const applied = await backfillVenueTaxonomyPage(store, {
    apply: true, pageSize: 1, cursor: secondPage.cursor, expectedCount: secondPage.totalDocuments,
  });
  assert.equal(applied.status, 'complete');
  assert.equal(applied.documentsUpdated, 0);
  assert.equal(applied.documentsAfterMigration, 2);
  assert.equal(applied.createdDocuments, 0);
  assert.equal(applied.deletedDocuments, 0);
  assert.deepEqual(
    store.documents.get('ChIJFrench').panda_taxonomy_v1.cuisine_tags,
    ['french'],
  );
  assert.deepEqual(
    store.documents.get('ChIJFrench').panda_taxonomy_v1.feature_tags,
    [],
  );
  assert.deepEqual(
    store.documents.get('ChIJFrench').partnerTier,
    'banging',
  );
  assert.deepEqual(
    store.documents.get('ChIJMusic').panda_taxonomy_v1.internal_category_tags,
    [],
  );
  assert.deepEqual(
    store.documents.get('ChIJMusic').panda_taxonomy_v1.verification_required_contexts,
    ['battersea/Live Music'],
  );
});
