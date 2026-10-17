import { ID_COLLECTION } from './_london-index.js';
import { FOCUS_SEED_TASKS, LONDON_SEED_TASKS, PANDA_CATEGORIES } from '../constants/london_clusters.js';

export const VENUE_TAXONOMY_VERSION = 1;

const TASKS_BY_CONTEXT = new Map(
  [...LONDON_SEED_TASKS, ...FOCUS_SEED_TASKS]
    .map(task => [`${task.name}/${task.category}`, task]),
);
const CUISINE_CATEGORIES = new Set([
  'Indian', 'Italian', 'Chinese', 'Spanish', 'French', 'British',
  'Japanese', 'Mexican', 'Turkish', 'American', 'Lebanese', 'Thai',
]);
const STRICT_CATEGORY_CATEGORIES = new Set([
  ...CUISINE_CATEGORIES,
  'Meat', 'Bar', 'Chicken', 'Pizza', 'Burgers', 'Dessert', 'Coffee',
  'Pubs', 'Clubs', 'Shops', 'Places of Interest',
]);

const toTag = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function deriveVenueTaxonomy(searchContexts) {
  const categoryEvidence = new Map();
  const cuisineEvidence = new Map();
  const featureEvidence = new Map();
  const verificationRequiredContexts = new Set();
  const unknownContexts = new Set();

  for (const context of Array.isArray(searchContexts) ? searchContexts : []) {
    if (typeof context !== 'string') continue;
    const task = TASKS_BY_CONTEXT.get(context);
    if (!task || !PANDA_CATEGORIES.includes(task.category)) {
      unknownContexts.add(context);
      continue;
    }

    const category = task.category;
    if (category === 'All') {
      verificationRequiredContexts.add(context);
      continue;
    }
    if (!STRICT_CATEGORY_CATEGORIES.has(category)) {
      // These searches are broad or describe a service/occasion that the
      // stored ID index cannot verify without live details.
      verificationRequiredContexts.add(context);
      continue;
    }

    const tag = toTag(category);
    if (!categoryEvidence.has(tag)) categoryEvidence.set(tag, new Set());
    categoryEvidence.get(tag).add(context);

    if (CUISINE_CATEGORIES.has(category)) {
      // Cuisine tags only come from that cuisine's dedicated restaurant query.
      const expectedQuery = `${category} restaurants`;
      if (task.query.toLowerCase() !== expectedQuery.toLowerCase()) {
        categoryEvidence.delete(tag);
        verificationRequiredContexts.add(context);
        continue;
      }
      if (!cuisineEvidence.has(tag)) cuisineEvidence.set(tag, new Set());
      cuisineEvidence.get(tag).add(context);
    }
  }

  const asEvidenceObject = evidence => Object.fromEntries(
    [...evidence.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, contexts]) => [tag, [...contexts].sort()]),
  );
  const categoryEvidenceObject = asEvidenceObject(categoryEvidence);
  const cuisineEvidenceObject = asEvidenceObject(cuisineEvidence);
  const featureEvidenceObject = asEvidenceObject(featureEvidence);

  return {
    version: VENUE_TAXONOMY_VERSION,
    source: 'searchContexts',
    verification: 'search-context-only; not live-detail verified',
    internal_category_tags: Object.keys(categoryEvidenceObject),
    cuisine_tags: Object.keys(cuisineEvidenceObject),
    feature_tags: Object.keys(featureEvidenceObject),
    evidence: {
      internal_category: categoryEvidenceObject,
      cuisine: cuisineEvidenceObject,
      feature: featureEvidenceObject,
    },
    verification_required_contexts: [...verificationRequiredContexts].sort(),
    unknown_contexts: [...unknownContexts].sort(),
  };
}

export async function backfillVenueTaxonomyPage(store, {
  apply = false,
  cursor = null,
  expectedCount = null,
  pageSize = 200,
  documentIdField,
} = {}) {
  const collection = store.collection(ID_COLLECTION);
  if (typeof collection.count !== 'function') {
    throw new Error('Firestore count aggregation is required for the preservation check.');
  }
  const total = expectedCount ?? (await collection.count().get()).data().count;
  if (!Number.isInteger(total) || total < 0) throw new Error('Invalid expected Firestore record count.');

  let query = collection.orderBy(documentIdField).limit(pageSize);
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();
  const documents = snapshot.docs || [];
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    collection: ID_COLLECTION,
    totalDocuments: total,
    cursor: documents.at(-1)?.id || cursor,
    pageDocuments: documents.length,
    status: documents.length < pageSize ? 'complete' : 'more',
    documentsWouldUpdate: 0,
    documentsUpdated: 0,
    documentsSkippedNewerTaxonomy: 0,
    categoryTags: {},
    cuisineTags: {},
    featureTags: {},
    verificationRequiredContexts: {},
    unknownContexts: {},
    createdDocuments: 0,
    deletedDocuments: 0,
    googleRequests: 0,
  };

  const updates = documents.flatMap(document => {
    const priorVersion = Number(document.get('panda_taxonomy_v1.version'));
    if (Number.isFinite(priorVersion) && priorVersion > VENUE_TAXONOMY_VERSION) {
      summary.documentsSkippedNewerTaxonomy += 1;
      return [];
    }
    const taxonomy = deriveVenueTaxonomy(document.get('searchContexts'));
    summary.documentsWouldUpdate += 1;
    for (const tag of taxonomy.internal_category_tags) {
      summary.categoryTags[tag] = (summary.categoryTags[tag] || 0) + 1;
    }
    for (const tag of taxonomy.cuisine_tags) {
      summary.cuisineTags[tag] = (summary.cuisineTags[tag] || 0) + 1;
    }
    for (const tag of taxonomy.feature_tags) {
      summary.featureTags[tag] = (summary.featureTags[tag] || 0) + 1;
    }
    for (const context of taxonomy.verification_required_contexts) {
      summary.verificationRequiredContexts[context] =
        (summary.verificationRequiredContexts[context] || 0) + 1;
    }
    for (const context of taxonomy.unknown_contexts) {
      summary.unknownContexts[context] = (summary.unknownContexts[context] || 0) + 1;
    }
    return [{ document, taxonomy }];
  });

  if (apply && updates.length > 0) {
    const batch = store.batch();
    for (const { document, taxonomy } of updates) {
      // update() cannot recreate an ID record deleted during the migration.
      // Dotted fields merge only this migration's namespace into that record.
      batch.update(document.ref, {
        'panda_taxonomy_v1.version': taxonomy.version,
        'panda_taxonomy_v1.source': taxonomy.source,
        'panda_taxonomy_v1.verification': taxonomy.verification,
        'panda_taxonomy_v1.internal_category_tags': taxonomy.internal_category_tags,
        'panda_taxonomy_v1.cuisine_tags': taxonomy.cuisine_tags,
        'panda_taxonomy_v1.feature_tags': taxonomy.feature_tags,
        'panda_taxonomy_v1.evidence': taxonomy.evidence,
        'panda_taxonomy_v1.verification_required_contexts': taxonomy.verification_required_contexts,
        'panda_taxonomy_v1.unknown_contexts': taxonomy.unknown_contexts,
      });
    }
    await batch.commit();
    summary.documentsUpdated = updates.length;
  }

  if (apply && summary.status === 'complete') {
    const afterCount = (await collection.count().get()).data().count;
    summary.documentsAfterMigration = afterCount;
    if (afterCount !== total) {
      throw new Error(
        `Taxonomy backfill safety check failed: document count changed from ${total} to ${afterCount}.`,
      );
    }
  }
  return summary;
}
