import admin from 'firebase-admin';
import { consumeDailyBudget } from './_cost-controls.js';
import { createLondonSeeder } from './_london-index.js';
import { verifySeedJob } from './_seed-job-auth.js';
import {
  ACTIVE_LONDON_SEED_PLAN, ACTIVE_LONDON_SEED_TASKS,
  FOCUS_SEED_PLAN, FOCUS_SEED_TASKS,
  LONDON_SEED_PLAN,
} from '../constants/london_clusters.js';
import { discoveryDailyLimit } from './_index-budget.js';
import { readCategoryCoverage } from './_index-progress.js';
import { publicSeedStatus } from './_seed-status.js';

function storage() {
  if (!admin.apps.length) {
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
    account.private_key = account.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(account) });
  }
  return admin.firestore();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json(publicSeedStatus());
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  const scope = typeof req.body?.scope === 'string' ? req.body.scope : 'standard';
  if (!['standard', 'focus-areas', 'coverage-audit'].includes(scope)) {
    return res.status(400).json({ error: 'Unknown indexing scope.' });
  }
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const auth = await verifySeedJob(token);
  if (!auth) return res.status(401).json({ error: 'Authorized indexing job required.' });
  if (scope === 'focus-areas' && !auth.manual && !auth.scheduled) {
    return res.status(403).json({ error: 'Focused area indexing requires an authorized workflow run.' });
  }
  try {
    const store = storage();
    if (scope === 'coverage-audit') {
      return res.status(200).json(await readCategoryCoverage(store));
    }
    const focus = scope === 'focus-areas';
    const seed = createLondonSeeder({
      store,
      apiKey: process.env.GOOGLE_MAPS_API_KEY,
      consumeBudget: consumeDailyBudget,
      arrayUnion: admin.firestore.FieldValue.arrayUnion,
      tasks: focus ? FOCUS_SEED_TASKS : ACTIVE_LONDON_SEED_TASKS,
      planId: focus ? FOCUS_SEED_PLAN : ACTIVE_LONDON_SEED_PLAN,
      indexPlanId: LONDON_SEED_PLAN,
      pagesPerQuery: focus ? 3 : 1,
      requirePhoto: true,
      dailyRequestLimit: () => discoveryDailyLimit(),
      customerReserve: 500,
      customerReserveOverride: focus ? 500 : undefined,
      paceMs: auth.manual ? 1000 : 3000,
      scheduleHours: focus ? [4] : [3, 9],
    });
    return res.status(200).json({ scope, ...await seed({ manual: auth.manual, maxRequests: 4 }) });
  } catch {
    return res.status(503).json({ error: 'Indexing storage or provider unavailable.' });
  }
}
