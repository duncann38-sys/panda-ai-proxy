import { verifySeedJob, SEED_AUDIENCE } from '../api/_seed-job-auth.js';
const backend = process.argv[2];
if (!backend || new URL(backend).protocol !== 'https:') throw new Error('Explicit HTTPS backend URL required.');
async function getJobToken() {
  const requestUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  requestUrl.searchParams.set('audience', SEED_AUDIENCE);
  const response = await fetch(requestUrl, {
    headers: { Authorization: 'Bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('GitHub schedule authentication unavailable.');
  return (await response.json()).value;
}
const token = await getJobToken();
if (!await verifySeedJob(token)) throw new Error('GitHub schedule identity verification failed.');
const response = await fetch(backend.replace(/\/$/, '') + '/api/new-openings-weekly', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: '{}',
  signal: AbortSignal.timeout(55_000),
});
const result = await response.json().catch(() => ({}));
console.log(JSON.stringify({ status: result.status || 'unavailable', deliveredUsers: result.deliveredUsers || 0,
  sentTokens: result.sentTokens || 0, invalidTokens: result.invalidTokens || 0, skippedUsers: result.skippedUsers || 0, sendFailures: result.sendFailures || 0 }));
if (!response.ok) throw new Error('Panda weekly openings job returned HTTP ' + response.status + '.');
if (!['complete', 'outside_schedule_window', 'already_running_or_sent'].includes(result.status)) {
  throw new Error('Panda weekly openings job did not complete: ' + String(result.status || 'unknown'));
}
