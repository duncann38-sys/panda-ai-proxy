import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillVenueTaxonomyPage, classifyGoogleTypeCategories, deriveVenueTaxonomy,
  selectTaxonomyVerificationSample, verifyTaxonomyDetailsBatch,
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

test('verification sample is balanced across broad contexts and never includes the generic All category', () => {
  const documents = [
    {
      id: 'ChIJOne',
      get: field => field === 'place_id' ? 'ChIJOne'
        : field === 'panda_taxonomy_v1.verification_required_contexts'
          ? ['battersea/Breakfast', 'battersea/Live Music', 'battersea/All'] : undefined,
    },
    {
      id: 'ChIJTwo',
      get: field => field === 'place_id' ? 'ChIJTwo'
        : field === 'panda_taxonomy_v1.verification_required_contexts'
          ? ['battersea/Bottomless'] : undefined,
    },
  ];
  const sample = selectTaxonomyVerificationSample(documents, { perCategory: 1 });
  assert.equal(sample.candidates.length, 2);
  assert.deepEqual(sample.candidates.find(candidate => candidate.id === 'ChIJOne').categories,
    ['Breakfast', 'Live Music']);
  assert.deepEqual(sample.candidates.find(candidate => candidate.id === 'ChIJTwo').categories,
    ['Bottomless']);
  assert.equal(sample.perCategory.All, undefined);
});

test('live verification uses exact Google place types and does not infer offerings from names', () => {
  assert.deepEqual(classifyGoogleTypeCategories({
    primaryType: 'breakfast_restaurant',
    types: ['restaurant', 'brunch_restaurant', 'night_club', 'sports_bar'],
    displayName: { text: 'Bottomless Live Music' },
  }), ['Breakfast', 'Drinks', 'Nightlife', 'Sports']);
  assert.deepEqual(classifyGoogleTypeCategories({
    types: ['bar'],
    displayName: { text: 'Bottomless Live Music' },
  }), ['Drinks']);
  assert.deepEqual(classifyGoogleTypeCategories({ types: ['restaurant'] }), []);
});

test('read-only verification uses only basic type fields and never stores the Google response', async () => {
  const stored = {
    ChIJSports: {
      place_id: 'ChIJSports',
      searchContexts: ['battersea/Sports'],
      panda_taxonomy_v1: { verification_required_contexts: ['battersea/Sports'] },
      partnerTier: 'banging',
    },
    ChIJBottomless: {
      place_id: 'ChIJBottomless',
      panda_taxonomy_v1: { verification_required_contexts: ['battersea/Bottomless'] },
    },
  };
  const store = {
    documents: structuredClone(stored),
    collection() {
      return {
        doc(id) {
          const data = store.documents[id];
          return {
            async get() {
              return {
                exists: Boolean(data),
                get: field => field.split('.').reduce((value, key) => value?.[key], data),
              };
            },
          };
        },
      };
    },
  };
  const calls = [];
  const result = await verifyTaxonomyDetailsBatch({
    ids: ['ChIJSports', 'ChIJBottomless'],
    store,
    apiKey: 'test-only',
    dailyLimit: 1000,
    consumeBudget: async (_store, kind, limit) => {
      assert.equal(kind, 'places');
      assert.equal(limit, 500);
      return { allowed: true, enabled: true, shared: true };
    },
    waitImpl: async ms => assert.equal(ms, 100),
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ types: ['sports_bar'] }), { status: 200 });
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.googleRequests, 2);
  assert.equal(result.writes, 0);
  assert.equal(result.verificationByCategory.Sports.typeMatches, 1);
  assert.equal(result.verificationByCategory.Bottomless.typeMatches, 0);
  assert.deepEqual(Object.keys(calls[0].headers).sort(), ['X-Goog-Api-Key', 'X-Goog-FieldMask']);
  assert.equal(calls[0].headers['X-Goog-FieldMask'], 'id,primaryType,types');
  assert.equal(JSON.stringify(result).includes('ChIJSports'), false);
  assert.deepEqual(store.documents, stored);
});

test('read-only verification fails closed when the shared daily budget is unavailable', async () => {
  let requests = 0;
  const result = await verifyTaxonomyDetailsBatch({
    ids: ['ChIJOverBudget'],
    store: {
      collection: () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            get: field => field === 'place_id' ? 'ChIJOverBudget'
              : field === 'panda_taxonomy_v1.verification_required_contexts'
                ? ['battersea/Live Music'] : undefined,
          }),
        }),
      }),
    },
    apiKey: 'test-only',
    dailyLimit: 1000,
    consumeBudget: async () => ({ allowed: false, enabled: true, shared: true }),
    fetchImpl: async () => { requests += 1; return new Response('{}'); },
  });
  assert.equal(result.status, 'budget_paused');
  assert.equal(result.googleRequests, 0);
  assert.equal(requests, 0);
});
