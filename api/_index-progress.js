import { ID_COLLECTION, LOCATION_COLLECTION, JOB_COLLECTION, londonClock } from './_london-index.js';
import { LONDON_SEED_TASKS, LONDON_SEED_PLAN, PANDA_CATEGORIES } from '../constants/london_clusters.js';

export async function readCategoryCoverage(store, now = Date.now(), {
  indexPlanId = LONDON_SEED_PLAN,
  minimum = 100,
} = {}) {
  const snapshot = await store.collection(ID_COLLECTION)
    .where('seed_plan', '==', indexPlanId).get();
  const documents = snapshot.docs || [];
  const categoryCounts = new Map(PANDA_CATEGORIES.map(category => [category, {
    storedIdCount: 0,
    feedReadyIdCount: 0,
  }]));
  let feedReadyUniquePlaceIds = 0;

  for (let offset = 0; offset < documents.length; offset += 200) {
    const page = documents.slice(offset, offset + 200);
    const refs = page.map(document => store.collection(LOCATION_COLLECTION).doc(document.id));
    const positions = typeof store.getAll === 'function'
      ? await store.getAll(...refs)
      : await Promise.all(refs.map(ref => ref.get()));

    for (let index = 0; index < page.length; index += 1) {
      const document = page[index];
      const identity = document.data() || {};
      const hasPhotoRoute = identity.primary_photo_path
        === `/api/partner/venues/${encodeURIComponent(document.id)}/photos/0/image`;
      if (!hasPhotoRoute) continue;

      const contexts = new Set(Array.isArray(identity.searchContexts) ? identity.searchContexts : []);
      const position = positions[index]?.data() || {};
      const expiry = position.expiresAt?.toMillis?.() ?? new Date(position.expiresAt).getTime();
      const feedReady = Number.isFinite(position.lat) && Number.isFinite(position.lng)
        && Number.isFinite(expiry) && expiry > now;
      if (feedReady) feedReadyUniquePlaceIds += 1;

      for (const category of PANDA_CATEGORIES) {
        const contextSuffix = `/${category}`;
        if (![...contexts].some(context => context.endsWith(contextSuffix))) continue;
        const counts = categoryCounts.get(category);
        counts.storedIdCount += 1;
        if (feedReady) counts.feedReadyIdCount += 1;
      }
    }
  }

  const categories = [...categoryCounts].map(([category, counts]) => ({
    category,
    ...counts,
    meetsStoredMinimum: counts.storedIdCount >= minimum,
    meetsFeedReadyMinimum: counts.feedReadyIdCount >= minimum,
  }));
  return {
    status: 'complete',
    indexPlanId,
    targetPerCategory: minimum,
    uniquePlaceIds: documents.length,
    feedReadyUniquePlaceIds,
    coverageBasis: 'unique IDs with category search context and first-party photo route; feed-ready additionally requires unexpired coordinates',
    categories,
    belowStoredTarget: categories.filter(item => !item.meetsStoredMinimum).map(item => item.category),
    belowFeedReadyTarget: categories.filter(item => !item.meetsFeedReadyMinimum).map(item => item.category),
  };
}

export async function readIndexProgress(store, now = Date.now(), {
  jobPlanId = LONDON_SEED_PLAN,
  indexPlanId = LONDON_SEED_PLAN,
  tasks = LONDON_SEED_TASKS,
} = {}) {
  const current = londonClock(new Date(now)).week;
  const previous = new Date(Date.parse(current + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  const prior = await store.collection(JOB_COLLECTION).doc(`${previous}_${jobPlanId}`).get();
  const week = prior.exists && prior.data()?.status !== 'complete' ? previous : current;
  const job = await store.collection(JOB_COLLECTION).doc(`${week}_${jobPlanId}`).get();
  const data = job.data() || {};
  const query = store.collection(ID_COLLECTION).where('seed_plan', '==', indexPlanId);
  const unique = typeof query.count === 'function'
    ? (await query.count().get()).data().count : (await query.get()).docs.length;
  const rows = Object.entries(data.categoryCoverage || {});
  const result = {
    status: data.status || 'not_started', planId: jobPlanId,
    taskIndex: data.taskIndex || 0, totalTasks: tasks.length,
    observationsIndexed: data.indexed || 0, uniquePlaceIds: unique,
    requests: data.requests || 0, categoriesQueried: rows.length,
    emptyCategories: rows.filter(([, value]) => !value.indexed).map(([key]) => key),
    coverage: 'sampled_not_exhaustive',
    updatedAt: data.updatedAt || 0, leaseUntil: data.leaseUntil || 0,
    pauseReason: data.pauseReason || null, quota: data.quota || null,
  };
  if (data.status === 'complete') {
    const sample = await query.limit(3).get();
    result.samples = await Promise.all(sample.docs.map(async doc => {
      const id = doc.id;
      const position = await store.collection(LOCATION_COLLECTION).doc(id).get();
      const value = position.data() || {};
      return {
        placeId: id,
        hasPhotoRoute: doc.data().primary_photo_path === `/api/partner/venues/${id}/photos/0/image`,
        coordinatesValid: Number.isFinite(value.lat) && Number.isFinite(value.lng),
        coordinatesUnexpired: (value.expiresAt?.toMillis?.() || new Date(value.expiresAt).getTime()) > now,
      };
    }));
  }
  return result;
}
