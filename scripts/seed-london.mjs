// GitHub supplies its short-lived OIDC credentials; no copied API key is used.
import { verifySeedJob, SEED_SUBJECT, SEED_AUDIENCE } from '../api/_seed-job-auth.js';
const audience = SEED_AUDIENCE;
const backend = process.argv[2];
const scope = process.argv[3] || 'standard';
if (!backend || new URL(backend).protocol !== 'https:') throw new Error('Explicit HTTPS backend URL required.');
if (!['standard', 'focus-areas'].includes(scope)) throw new Error('Unsupported seed scope.');
async function token() {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', audience);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('GitHub job authentication unavailable.');
  const data = await response.json();
  return data.value;
}
let bearer;
let issued = 0;
const startedAt = Date.now();
let rateRetries = 0;
for (let chunk = 0; chunk < 500; chunk++) {
  if (Date.now() - startedAt >= 17 * 60 * 1000) {
    console.log('::notice::Run time bound reached. Saved London indexing can be continued by another run.');
    process.exit(0);
  }
  if (!bearer || Date.now() - issued > 180000) {
    bearer = await token(); issued = Date.now();
    // Log only validation outcomes, never the bearer or complete claims.
    const header = JSON.parse(Buffer.from(bearer.split('.')[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url'));
    console.log(JSON.stringify({ jobIdentity: {
      algorithm: header.alg,
      issuerMatches: claims.iss === 'https://token.actions.githubusercontent.com',
      audienceMatches: claims.aud === audience,
      repositoryMatches: claims.repository === 'duncann38-sys/panda-ai-proxy',
      branchMatches: claims.ref === 'refs/heads/main',
      subjectMatches: claims.sub === SEED_SUBJECT,
      repositoryIdMatches: claims.repository_id === '1332508666',
      ownerIdMatches: claims.repository_owner_id === '266837386',
      workflowMatches: claims.workflow_ref === 'duncann38-sys/panda-ai-proxy/.github/workflows/seed-london.yml@refs/heads/main',
      eventAllowed: ['schedule', 'workflow_dispatch'].includes(claims.event_name),
      lifetimeSeconds: claims.exp - claims.iat,
      secondsRemaining: Math.round(claims.exp - Date.now() / 1000),
      localVerificationPassed: Boolean(await verifySeedJob(bearer)),
    } }));
  }
  const response = await fetch(`${backend.replace(/\/$/, '')}/api/seed-london`, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }), signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) throw new Error(`Index job HTTP ${response.status}.`);
  const result = await response.json();
  console.log(JSON.stringify(result));
  if (['complete', 'outside_schedule_window', 'nothing_to_resume'].includes(result.status)) process.exit(0);
  if (result.status === 'quota_paused') {
    if (result.pauseReason === 'google_quota' && result.quota?.period === 'minute'
      && rateRetries < 12 && Date.now() - startedAt < 16 * 60 * 1000) {
      rateRetries++;
      const seconds = result.quota.retryAfterSeconds || 65;
      console.log(`::notice::Google minute quota reached. Waiting ${seconds}s before resuming saved progress.`);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      continue;
    }
    console.log('::notice::London indexing paused safely at a request allowance or Google quota. Completed pages are saved; the next scheduled attempt can resume.');
    process.exit(0);
  }
  if (!['running', 'busy'].includes(result.status)) {
    throw new Error(`Index paused: ${result.status}. Completed pages are saved; no emails or payments are triggered.`);
  }
  if (result.status === 'busy') await new Promise(resolve => setTimeout(resolve, 5000));
}
throw new Error('Index job exceeded its bounded chunk count; saved progress can resume.');
