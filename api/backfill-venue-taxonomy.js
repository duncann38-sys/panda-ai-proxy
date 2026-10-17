import admin from 'firebase-admin';
import { backfillVenueTaxonomyPage } from './_venue-taxonomy.js';
import { verifySeedJob, TAXONOMY_WORKFLOW } from './_seed-job-auth.js';

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const auth = await verifySeedJob(token);
  if (!auth?.manual || auth.workflowRef !== TAXONOMY_WORKFLOW) {
    return res.status(401).json({ error: 'Authorized manual taxonomy workflow required.' });
  }

  const mode = req.body?.mode;
  if (!['dry-run', 'apply'].includes(mode)) {
    return res.status(400).json({ error: 'Mode must be dry-run or apply.' });
  }

  try {
    return res.status(200).json(await backfillVenueTaxonomyPage(storage(), {
      apply: mode === 'apply',
      cursor: typeof req.body?.cursor === 'string' ? req.body.cursor : null,
      expectedCount: Number.isInteger(req.body?.expectedCount) ? req.body.expectedCount : null,
      pageSize: 200,
      documentIdField: admin.firestore.FieldPath.documentId(),
    }));
  } catch {
    return res.status(503).json({ error: 'Taxonomy backfill failed; existing documents were not deleted.' });
  }
}
