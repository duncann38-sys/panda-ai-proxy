import { ID_COLLECTION, LOCATION_COLLECTION, JOB_COLLECTION, londonClock } from './_london-index.js';
import { LONDON_SEED_TASKS, LONDON_SEED_PLAN } from '../constants/london_clusters.js';

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
