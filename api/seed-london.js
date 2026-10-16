import admin from 'firebase-admin';
import { consumeDailyBudget } from './_cost-controls.js';
import { createLondonSeeder } from './_london-index.js';
import { verifySeedJob } from './_seed-job-auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({
      service: 'panda-london-index', version: 1,
      schedule: 'Sunday 03:00 Europe/London; daily resume if incomplete',
      tasks: 126, pagesPerTask: 1, maxRequestsPerChunk: 4,
      fields: 'place IDs and expiring coordinates only',
      paidRecords: 'never overwritten',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const auth = await verifySeedJob(token);
  if (!auth) return res.status(401).json({ error: 'Authorized indexing job required.' });
  try {
    if (!admin.apps.length) {
      const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
      account.private_key = account.private_key.replace(/\\n/g, '\n');
      admin.initializeApp({ credential: admin.credential.cert(account) });
    }
    const seed = createLondonSeeder({
      store: admin.firestore(),
      apiKey: process.env.GOOGLE_MAPS_API_KEY,
      consumeBudget: consumeDailyBudget,
      arrayUnion: admin.firestore.FieldValue.arrayUnion,
    });
    return res.status(200).json(await seed({ manual: auth.manual, maxRequests: 4 }));
  } catch {
    return res.status(503).json({ error: 'Indexing storage or provider unavailable.' });
  }
}
