import admin from 'firebase-admin';
import { verifySeedJob, TAXONOMY_WORKFLOW } from './_seed-job-auth.js';
import { ID_COLLECTION } from './_london-index.js';
import { discoveryDailyLimit } from './_index-budget.js';
import { consumeDailyBudget } from './_cost-controls.js';
import {
  selectTaxonomyVerificationSample,
  TAXONOMY_VERIFICATION_CATEGORIES,
  verifyTaxonomyDetailsBatch,
} from './_venue-taxonomy.js';

export const config = { maxDuration: 60 };

function storage() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Shared storage is unavailable.');
  if (!admin.apps.length) {
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (typeof account.private_key === 'string' && account.private_key.includes('\\n')) {
      account.private_key = account.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({ credential: admin.credential.cert(account) });
  }
  return admin.firestore();
}

function candidateCounts(candidates) {
  return Object.fromEntries(TAXONOMY_VERIFICATION_CATEGORIES.map(category => [
    category,
    candidates.filter(candidate => candidate.categories.includes(category)).length,
  ]));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const auth = await verifySeedJob(req.headers.authorization);
  if (!auth?.manual || auth.workflowRef !== TAXONOMY_WORKFLOW) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const mode = req.body?.mode;
  if (!['select', 'verify'].includes(mode)) return res.status(400).json({ error: 'invalid_mode' });

  let store;
  try {
    store = storage();
  } catch {
    return res.status(503).json({ error: 'shared_storage_unavailable' });
  }

  if (mode === 'select') {
    try {
      const snapshot = await store.collection(ID_COLLECTION).get();
      const selection = selectTaxonomyVerificationSample(snapshot.docs, { perCategory: 25 });
      return res.status(200).json({
        status: 'selected',
        candidateCount: selection.candidates.length,
        candidatesByCategory: candidateCounts(selection.candidates),
        candidates: selection.candidates,
        writes: 0,
        googleRequests: 0,
      });
    } catch {
      return res.status(503).json({ error: 'candidate_selection_failed' });
    }
  }

  if (!Array.isArray(req.body?.ids) || req.body.ids.length > 25) {
    return res.status(400).json({ error: 'invalid_batch' });
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return res.status(503).json({ error: 'google_places_key_unavailable' });
  }
  try {
    const result = await verifyTaxonomyDetailsBatch({
      ids: req.body.ids,
      store,
      apiKey: process.env.GOOGLE_MAPS_API_KEY,
      dailyLimit: discoveryDailyLimit(process.env),
      consumeBudget: consumeDailyBudget,
    });
    return res.status(200).json(result);
  } catch {
    return res.status(503).json({ error: 'verification_failed' });
  }
}
