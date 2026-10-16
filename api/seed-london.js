import admin from 'firebase-admin';
import { consumeDailyBudget } from './_cost-controls.js';
import { createLondonSeeder } from './_london-index.js';
import { verifySeedJob } from './_seed-job-auth.js';
import { LONDON_SEED_TASKS, LONDON_SEED_PLAN } from '../constants/london_clusters.js';
import { discoveryDailyLimit, TEMPORARY_INDEX_BOOST_END } from './_index-budget.js';
import { readIndexProgress } from './_index-progress.js';

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
  if (req.method === 'GET' && req.query.progress === '1') {
    try { return res.status(200).json(await readIndexProgress(storage())); }
    catch { return res.status(503).json({ error: 'Index progress storage unavailable.' }); }
  }
  if (req.method === 'GET') {
    return res.status(200).json({
      service: 'panda-london-index', version: 1,
      schedule: 'Sunday 03:00 Europe/London; daily resume at 03:00 and 09:00 if incomplete',
      tasks: LONDON_SEED_TASKS.length, pagesPerTask: 1, maxRequestsPerChunk: 4,
      planId: LONDON_SEED_PLAN, dailyLimit: discoveryDailyLimit(),
      customerReserve: 500, temporaryBoostEnds: new Date(TEMPORARY_INDEX_BOOST_END).toISOString(),
      fields: 'place IDs, expiring coordinates and first-party photo route only; Google content fetched live',
      paidRecords: 'never overwritten',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const auth = await verifySeedJob(token);
  if (!auth) return res.status(401).json({ error: 'Authorized indexing job required.' });
  try {
    const store = storage();
    const seed = createLondonSeeder({
      store,
      apiKey: process.env.GOOGLE_MAPS_API_KEY,
      consumeBudget: consumeDailyBudget,
      arrayUnion: admin.firestore.FieldValue.arrayUnion,
      planId: LONDON_SEED_PLAN, requirePhoto: true,
      dailyRequestLimit: () => discoveryDailyLimit(),
      customerReserve: 500, paceMs: auth.manual ? 1000 : 3000,
    });
    return res.status(200).json(await seed({ manual: auth.manual, maxRequests: 4 }));
  } catch {
    return res.status(503).json({ error: 'Indexing storage or provider unavailable.' });
  }
}
