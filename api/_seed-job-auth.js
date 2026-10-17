import { createPublicKey, verify } from 'node:crypto';

export const SEED_AUDIENCE = 'panda-london-seed';
const ISSUER = 'https://token.actions.githubusercontent.com';
const REPOSITORY = 'duncann38-sys/panda-ai-proxy';
const REPOSITORY_ID = '1332508666';
const OWNER_ID = '266837386';
// Pinned to this repository's GitHub OIDC customization settings:
// use_immutable_subject=true. Stable IDs prevent name-reuse impersonation.
export const SEED_SUBJECT = `repo:duncann38-sys@${OWNER_ID}/panda-ai-proxy@${REPOSITORY_ID}:ref:refs/heads/main`;
const WORKFLOW = `${REPOSITORY}/.github/workflows/seed-london.yml@refs/heads/main`;
let cachedKeys;
let cachedUntil = 0;
let lastKeyRefresh = -Infinity;

export async function verifySeedJob(token, { fetchImpl = fetch, now = Date.now } = {}) {
  try {
    if (typeof token !== 'string' || token.length > 16000) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const seconds = now() / 1000;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200
      || header.crit || claims.iss !== ISSUER || claims.aud !== SEED_AUDIENCE
      || claims.repository !== REPOSITORY || claims.ref !== 'refs/heads/main'
      || claims.repository_id !== REPOSITORY_ID || claims.repository_owner_id !== OWNER_ID
      || claims.sub !== SEED_SUBJECT
      || claims.workflow_ref !== WORKFLOW
      || !['schedule', 'workflow_dispatch'].includes(claims.event_name)
      || !Number.isFinite(claims.exp) || claims.exp <= seconds || claims.exp > seconds + 900
      || !Number.isFinite(claims.iat) || claims.iat > seconds + 30
      || claims.iat < seconds - 900
      || (claims.nbf != null && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 30))) return null;
    if (!cachedKeys || cachedUntil <= now() || !cachedKeys.some(key => key.kid === header.kid)) {
      if (cachedKeys && now() - lastKeyRefresh < 30000) return null;
      lastKeyRefresh = now();
      const response = await fetchImpl(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const body = await response.json();
      if (!Array.isArray(body.keys)) return null;
      cachedKeys = body.keys;
      cachedUntil = now() + 600000;
    }
    const key = cachedKeys.find(item => item.kid === header.kid && item.kty === 'RSA'
      && (!item.use || item.use === 'sig') && (!item.alg || item.alg === 'RS256'));
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) return null;
    return {
      manual: claims.event_name === 'workflow_dispatch',
      scheduled: claims.event_name === 'schedule',
      runId: claims.run_id,
    };
  } catch { return null; }
}
