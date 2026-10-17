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
export const TAXONOMY_VERIFICATION_CATEGORIES = [
  'Breakfast', 'Brunch', 'Bottomless', 'Dinner', 'Drinks',
  'Live Music', 'Lunch', 'Nightlife', 'Sports',
];

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

function stablePlaceHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

export function selectTaxonomyVerificationSample(documents, { perCategory = 25 } = {}) {
  const candidateCategories = new Map();
  for (const category of TAXONOMY_VERIFICATION_CATEGORIES) {
    const ids = new Set();
    for (const document of documents) {
      const placeId = document.get('place_id') || document.id;
      if (typeof placeId !== 'string' || !placeId) continue;
      const contexts = document.get('panda_taxonomy_v1.verification_required_contexts');
      if (!Array.isArray(contexts)) continue;
      if (contexts.some(context => typeof context === 'string'
        && context.slice(context.lastIndexOf('/') + 1) === category)) {
        ids.add(placeId);
      }
    }
    candidateCategories.set(category, [...ids]
      .sort((a, b) => stablePlaceHash(a) - stablePlaceHash(b) || a.localeCompare(b))
      .slice(0, perCategory));
  }

  const selected = new Map();
  for (const [category, ids] of candidateCategories) {
    for (const id of ids) {
      if (!selected.has(id)) selected.set(id, { id, categories: [] });
      selected.get(id).categories.push(category);
    }
  }
  return {
    candidates: [...selected.values()].slice(0, TAXONOMY_VERIFICATION_CATEGORIES.length * perCategory),
    perCategory: Object.fromEntries(candidateCategories),
  };
}

export function classifyGoogleTypeCategories(place) {
  const types = new Set([
    ...(Array.isArray(place?.types) ? place.types : []),
    ...(typeof place?.primaryType === 'string' ? [place.primaryType] : []),
  ].map(type => String(type).toLowerCase()));
  const verified = [];
  if (types.has('breakfast_restaurant')) verified.push('Breakfast');
  if (types.has('brunch_restaurant')) verified.push('Brunch');
  if (['bar', 'wine_bar', 'pub', 'night_club'].some(type => types.has(type))) {
    verified.push('Drinks');
  }
  if (types.has('night_club') || types.has('dance_hall')) verified.push('Nightlife');
  if (types.has('sports_bar')) verified.push('Sports');
  if (types.has('live_music_venue') || types.has('concert_hall')) verified.push('Live Music');
  // Google place types do not prove bottomless offers or meal service times.
  return verified;
}

export async function verifyTaxonomyDetailsBatch({
  ids,
  store,
  apiKey,
  dailyLimit,
  consumeBudget,
  fetchImpl = fetch,
  waitImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  if (!Array.isArray(ids) || ids.length > 25) {
    throw new Error('A live verification batch must contain at most 25 existing Place IDs.');
  }
  if (!apiKey) return { status: 'unavailable', providerStatus: 503, googleRequests: 0, writes: 0 };

  const verificationByCategory = {};
  for (const category of TAXONOMY_VERIFICATION_CATEGORIES) {
    verificationByCategory[category] = { eligible: 0, responses: 0, typeMatches: 0 };
  }
  let googleRequests = 0;
  let detailsResponses = 0;
  let skipped = 0;
  let providerStatus = null;
  let status = 'complete';
  const collection = store.collection(ID_COLLECTION);

  for (const id of [...new Set(ids)]) {
    if (typeof id !== 'string' || !id || id.length > 255 || id.includes('/')) {
      skipped += 1;
      continue;
    }
    const snapshot = await collection.doc(id).get();
    if (!snapshot.exists || snapshot.get('place_id') !== id) {
      skipped += 1;
      continue;
    }
    const contexts = snapshot.get('panda_taxonomy_v1.verification_required_contexts');
    const categories = TAXONOMY_VERIFICATION_CATEGORIES.filter(category =>
      Array.isArray(contexts) && contexts.some(context => typeof context === 'string'
        && context.slice(context.lastIndexOf('/') + 1) === category));
    if (!categories.length) {
      skipped += 1;
      continue;
    }
    for (const category of categories) verificationByCategory[category].eligible += 1;

    const reservedLimit = Math.max(0, dailyLimit - 500);
    const budget = await consumeBudget(store, 'places', reservedLimit);
    if (budget.enabled !== true || budget.shared !== true || budget.allowed !== true) {
      status = 'budget_paused';
      break;
    }
    if (googleRequests > 0) await waitImpl(100);
    googleRequests += 1;
    try {
      const response = await fetchImpl(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`,
        {
          headers: {
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'id,primaryType,types',
          },
        },
      );
      if (!response.ok) {
        providerStatus = response.status;
        status = response.status === 429 ? 'quota_paused' : 'provider_blocked';
        break;
      }
      const place = await response.json();
      detailsResponses += 1;
      const typeMatches = new Set(classifyGoogleTypeCategories(place));
      for (const category of categories) {
        verificationByCategory[category].responses += 1;
        if (typeMatches.has(category)) verificationByCategory[category].typeMatches += 1;
      }
    } catch {
      providerStatus = 'network';
      status = 'provider_blocked';
      break;
    }
  }

  return {
    status,
    verificationByCategory,
    googleRequests,
    detailsResponses,
    skipped,
    providerStatus,
    writes: 0,
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
