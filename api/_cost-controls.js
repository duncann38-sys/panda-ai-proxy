import { createHash } from 'node:crypto';

const DEFAULT_MAX_CONVERSATION_ITEMS = 24;
const DEFAULT_MAX_CONVERSATION_CHARS = 60_000;
const SAFE_METRIC_FIELDS = new Set([
  'areaHash', 'category', 'count', 'elements', 'layer', 'modelCount',
  'openNow', 'page', 'responseType', 'scope', 'status',
]);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function contentSize(content) {
  try {
    return JSON.stringify(content).length;
  } catch {
    return 0;
  }
}

function startsUserTurn(content) {
  return content?.role === 'user'
    && Array.isArray(content.parts)
    && content.parts.some((part) => typeof part?.text === 'string');
}

export function compactConversation(
  contents,
  {
    maxItems = positiveInteger(process.env.PANDA_MAX_CONVERSATION_ITEMS, DEFAULT_MAX_CONVERSATION_ITEMS),
    maxChars = positiveInteger(process.env.PANDA_MAX_CONVERSATION_CHARS, DEFAULT_MAX_CONVERSATION_CHARS),
  } = {},
) {
  if (!Array.isArray(contents)) return [];
  const turns = [];
  for (const item of contents) {
    if (startsUserTurn(item)) turns.push([item]);
    else if (turns.length) turns[turns.length - 1].push(item);
  }
  if (!turns.length) return [];

  const selectedTurns = [];
  let itemCount = 0;
  let chars = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnChars = turn.reduce((sum, item) => sum + contentSize(item), 0);
    const fits = itemCount + turn.length <= maxItems && chars + turnChars <= maxChars;
    if (selectedTurns.length && !fits) break;
    selectedTurns.unshift(turn);
    itemCount += turn.length;
    chars += turnChars;
  }
  return selectedTurns.flat();
}

export function requestFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

export function clientFingerprint(req, salt = process.env.PANDA_CLIENT_HASH_SALT || '') {
  if (!salt) return null;
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const address = forwarded || req?.socket?.remoteAddress || 'unknown';
  return requestFingerprint({ address, salt });
}

export function recordCostEvent(event, fields = {}) {
  if (process.env.PANDA_USAGE_METRICS !== 'true') return;
  const safeEvent = typeof event === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(event)
    ? event
    : 'unknown_event';
  const safeFields = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!SAFE_METRIC_FIELDS.has(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      safeFields[key] = value;
    } else if (typeof value === 'string' && value.length <= 128) {
      safeFields[key] = value;
    }
  }
  console.info(JSON.stringify({
    type: 'panda_cost',
    event: safeEvent,
    timestamp: new Date().toISOString(),
    ...safeFields,
  }));
}

export function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function boundedCacheExpiry(now, localTtlMs, sourceTimestamp, sourceTtlMs) {
  return Math.min(now + localTtlMs, Number(sourceTimestamp) + sourceTtlMs);
}

export function placesMemoryEntry(result, sourceTimestamp) {
  return {
    ts: sourceTimestamp,
    venues: result.venues,
    nextPageToken: result.nextPageToken || null,
  };
}

export function cacheablePlacesResult(result) {
  return !result.providerFailed && !result.budgetExceeded;
}

export function cacheableGeminiFunctionCall(result) {
  if (!result?.ok) return false;
  const parts = result.data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || !parts.some((part) => part?.functionCall)) return false;
  return !parts.some((part) => typeof part?.text === 'string' && part.text.trim());
}

export async function readSharedGeminiCall(store, key, ttlMs, now = Date.now()) {
  if (!store) return null;
  try {
    const snapshot = await store.collection('gemini_function_cache_v1').doc(key).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    if (
      !data
      || now - Number(data.ts || 0) >= ttlMs
      || !cacheableGeminiFunctionCall(data.result)
    ) return null;
    return data.result;
  } catch {
    return null;
  }
}

export async function writeSharedGeminiCall(store, key, result, now = Date.now()) {
  if (!store || !cacheableGeminiFunctionCall(result)) return false;
  try {
    await store.collection('gemini_function_cache_v1').doc(key).set({
      ts: now,
      result,
    });
    return true;
  } catch {
    return false;
  }
}

export function configuredDailyLimit(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function consumeDailyBudget(store, kind, configuredLimit, now = new Date()) {
  const limit = configuredDailyLimit(configuredLimit);
  if (!limit) return { allowed: false, enabled: false, reason: 'not_configured' };
  if (!store) return { allowed: false, enabled: true, shared: false, reason: 'storage_unavailable' };

  const day = now.toISOString().slice(0, 10);
  const fields = {
    places: 'placesRequests',
    gemini: 'geminiRequests',
    photos: 'photoRequests',
    routes: 'routesRequests',
  };
  const field = fields[kind];
  if (!field) return { allowed: false, enabled: true, shared: false, reason: 'invalid_budget_kind' };
  const ref = store.collection('panda_usage_budgets_v1').doc(day);

  try {
    return await store.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const rawCurrent = snapshot.data()?.[field];
      const current = rawCurrent === undefined ? 0 : Number(rawCurrent);
      if (!Number.isSafeInteger(current) || current < 0) {
        return { allowed: false, enabled: true, shared: true, reason: 'counter_invalid' };
      }
      if (current >= limit) {
        return { allowed: false, enabled: true, shared: true, current, limit, reason: 'limit' };
      }
      const next = current + 1;
      transaction.set(ref, { day, updatedAt: Date.now(), [field]: next }, { merge: true });
      return { allowed: true, enabled: true, shared: true, current: next, limit };
    });
  } catch {
    return { allowed: false, enabled: true, shared: false, reason: 'storage_unavailable' };
  }
}

export async function consumeClientDailyBudget(
  store,
  clientKey,
  configuredLimit,
  now = new Date(),
) {
  const limit = configuredDailyLimit(configuredLimit);
  if (!limit) return { allowed: false, enabled: false, reason: 'not_configured' };
  if (!clientKey) return { allowed: false, enabled: true, shared: false, reason: 'client_fingerprint_unavailable' };
  if (!store) return { allowed: false, enabled: true, shared: false, reason: 'storage_unavailable' };

  const day = now.toISOString().slice(0, 10);
  const ref = store.collection('panda_client_budgets_v1').doc(`${day}_${clientKey}`);
  try {
    return await store.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const rawCurrent = snapshot.data()?.aiRequests;
      const current = rawCurrent === undefined ? 0 : Number(rawCurrent);
      if (!Number.isSafeInteger(current) || current < 0) {
        return { allowed: false, enabled: true, shared: true, reason: 'counter_invalid' };
      }
      if (current >= limit) {
        return { allowed: false, enabled: true, shared: true, current, limit, reason: 'limit' };
      }
      const next = current + 1;
      transaction.set(ref, {
        day,
        updatedAt: Date.now(),
        aiRequests: next,
      }, { merge: true });
      return { allowed: true, enabled: true, shared: true, current: next, limit };
    });
  } catch {
    return { allowed: false, enabled: true, shared: false, reason: 'storage_unavailable' };
  }
}