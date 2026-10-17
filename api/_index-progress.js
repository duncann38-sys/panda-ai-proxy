import { ID_COLLECTION, LOCATION_COLLECTION, JOB_COLLECTION, londonClock } from './_london-index.js';
import { ACTIVE_LONDON_SEED_TASKS, ACTIVE_LONDON_SEED_PLAN, FOCUS_CLUSTERS, LONDON_SEED_PLAN, PANDA_CATEGORIES } from '../constants/london_clusters.js';

const BATTERSEA_COVERAGE_RADIUS_METERS = 20_000;
const BATTERSEA_COVERAGE_TARGET = 300;
const BATTERSEA_COVERAGE_ORIGIN = FOCUS_CLUSTERS.find(cluster => cluster.name === 'battersea');

function distanceMeters(aLat, aLng, bLat, bLng) {
  const toRadians = value => value * Math.PI / 180;
  const deltaLat = toRadians(bLat - aLat);
  const deltaLng = toRadians(bLng - aLng);
  const arc = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(deltaLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(arc));
}

export async function readCategoryCoverage(store, now = Date.now(), {
  indexPlanId = LONDON_SEED_PLAN,
  minimum = 200,
} = {}) {
  const snapshot = await store.collection(ID_COLLECTION)
    .where('seed_plan', '==', indexPlanId).get();
  const documents = snapshot.docs || [];
  const feedCategories = PANDA_CATEGORIES.filter(category => category !== 'All');
  const categoryCounts = new Map(feedCategories.map(category => [category, {
    storedIdCount: 0,
    feedReadyIdCount: 0,
    batterseaStoredIdCount: 0,
    batterseaFeedReadyIdCount: 0,
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
      const inBatterseaRadius = BATTERSEA_COVERAGE_ORIGIN
        && Number.isFinite(position.lat) && Number.isFinite(position.lng)
        && distanceMeters(position.lat, position.lng, BATTERSEA_COVERAGE_ORIGIN.lat, BATTERSEA_COVERAGE_ORIGIN.lng)
          <= BATTERSEA_COVERAGE_RADIUS_METERS;

      for (const category of feedCategories) {
        const contextSuffix = '/' + category;
        if (![...contexts].some(context => context.endsWith(contextSuffix))) continue;
        const counts = categoryCounts.get(category);
        counts.storedIdCount += 1;
        if (feedReady) counts.feedReadyIdCount += 1;
        if (inBatterseaRadius) counts.batterseaStoredIdCount += 1;
        if (inBatterseaRadius && feedReady) counts.batterseaFeedReadyIdCount += 1;
      }
    }
  }

  const categories = [...categoryCounts].map(([category, counts]) => ({
    category,
    ...counts,
    meetsStoredMinimum: counts.storedIdCount >= minimum,
    meetsFeedReadyMinimum: counts.feedReadyIdCount >= minimum,
    meetsBatterseaStoredTarget: counts.batterseaStoredIdCount >= BATTERSEA_COVERAGE_TARGET,
    meetsBatterseaFeedReadyTarget: counts.batterseaFeedReadyIdCount >= BATTERSEA_COVERAGE_TARGET,
  }));
  return {
    status: 'complete',
    indexPlanId,
    targetPerCategory: minimum,
    uniquePlaceIds: documents.length,
    feedReadyUniquePlaceIds,
    batterseaCoverageOrigin: BATTERSEA_COVERAGE_ORIGIN
      ? { name: BATTERSEA_COVERAGE_ORIGIN.name, lat: BATTERSEA_COVERAGE_ORIGIN.lat, lng: BATTERSEA_COVERAGE_ORIGIN.lng }
      : null,
    batterseaCoverageRadiusMeters: BATTERSEA_COVERAGE_RADIUS_METERS,
    batterseaTargetPerCategory: BATTERSEA_COVERAGE_TARGET,
    coverageBasis: 'search-context candidate IDs only; this audit does not verify live Google types. Feed cards verify category on live detail hydration.',
    categories,
    belowStoredTarget: categories.filter(item => !item.meetsStoredMinimum).map(item => item.category),
    belowFeedReadyTarget: categories.filter(item => !item.meetsFeedReadyMinimum).map(item => item.category),
    belowBatterseaStoredTarget: categories.filter(item => !item.meetsBatterseaStoredTarget).map(item => item.category),
    belowBatterseaFeedReadyTarget: categories.filter(item => !item.meetsBatterseaFeedReadyTarget).map(item => item.category),
  };
}

export async function readIndexProgress(store, now = Date.now(), {
  jobPlanId = ACTIVE_LONDON_SEED_PLAN,
  indexPlanId = LONDON_SEED_PLAN,
  tasks = ACTIVE_LONDON_SEED_TASKS,
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
