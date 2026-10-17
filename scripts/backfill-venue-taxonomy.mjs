import { verifySeedJob, SEED_AUDIENCE, TAXONOMY_WORKFLOW } from '../api/_seed-job-auth.js';

const backend = process.argv[2];
const mode = process.argv[3] || 'dry-run';
if (!backend || new URL(backend).protocol !== 'https:') {
  throw new Error('An explicit HTTPS Panda backend URL is required.');
}
if (!['dry-run', 'apply'].includes(mode)) throw new Error('Mode must be dry-run or apply.');

async function getWorkflowToken() {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', SEED_AUDIENCE);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('GitHub workflow authentication unavailable.');
  return (await response.json()).value;
}

const token = await getWorkflowToken();
const localAuth = await verifySeedJob(token);
if (!localAuth?.manual || localAuth.workflowRef !== TAXONOMY_WORKFLOW) {
  throw new Error('This migration must run from the authorized manual taxonomy workflow.');
}

const total = {
  mode,
  documentsFound: null,
  pages: 0,
  documentsProcessed: 0,
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
const addCounts = (target, source = {}) => {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] || 0) + value;
};
const startedAt = Date.now();
let cursor = null;
let expectedCount = null;
let bearer = token;
let tokenIssuedAt = Date.now();

for (let page = 0; page < 100; page += 1) {
  if (Date.now() - startedAt > 17 * 60 * 1000) {
    throw new Error('Backfill reached its safe time limit; rerun is idempotent and resumes from the beginning.');
  }
  if (Date.now() - tokenIssuedAt > 180000) {
    bearer = await getWorkflowToken();
    tokenIssuedAt = Date.now();
  }
  const response = await fetch(`${backend.replace(/\/$/, '')}/api/backfill-venue-taxonomy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode, cursor, expectedCount }),
    signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) throw new Error(`Taxonomy backfill HTTP ${response.status}.`);
  const result = await response.json();
  if (expectedCount == null) {
    expectedCount = result.totalDocuments;
    total.documentsFound = expectedCount;
  }
  if (result.totalDocuments !== expectedCount || !['more', 'complete'].includes(result.status)) {
    throw new Error('Backfill page consistency check failed.');
  }
  total.pages += 1;
  total.documentsProcessed += result.pageDocuments || 0;
  total.documentsUpdated += result.documentsUpdated || 0;
  total.documentsSkippedNewerTaxonomy += result.documentsSkippedNewerTaxonomy || 0;
  addCounts(total.categoryTags, result.categoryTags);
  addCounts(total.cuisineTags, result.cuisineTags);
  addCounts(total.featureTags, result.featureTags);
  addCounts(total.verificationRequiredContexts, result.verificationRequiredContexts);
  addCounts(total.unknownContexts, result.unknownContexts);
  if (result.documentsAfterMigration != null) {
    total.documentsAfterMigration = result.documentsAfterMigration;
  }
  cursor = result.cursor;
  if (result.status === 'complete') {
    if (mode === 'apply' && total.documentsAfterMigration !== expectedCount) {
      throw new Error('The Firestore document-count preservation check did not pass.');
    }
    console.log(JSON.stringify(total));
    process.exit(0);
  }
  if (!cursor) throw new Error('Backfill returned another page without a safe cursor.');
}
throw new Error('Backfill exceeded its bounded page count; rerunning is safe and idempotent.');
