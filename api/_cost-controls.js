import { createHash } from 'node:crypto';

const DEFAULT_MAX_CONVERSATION_ITEMS = 24;
const DEFAULT_MAX_CONVERSATION_CHARS = 60_000;

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

export function compactConversation(
  contents,
  {
    maxItems = positiveInteger(process.env.PANDA_MAX_CONVERSATION_ITEMS, DEFAULT_MAX_CONVERSATION_ITEMS),
    maxChars = positiveInteger(process.env.PANDA_MAX_CONVERSATION_CHARS, DEFAULT_MAX_CONVERSATION_CHARS),
  } = {},
) {
  if (!Array.isArray(contents)) return [];
  const selected = [];
  let chars = 0;
  for (let index = contents.length - 1; index >= 0 && selected.length < maxItems; index -= 1) {
    const item = contents[index];
    const size = contentSize(item);
    if (selected.length && chars + size > maxChars) break;
    selected.unshift(item);
    chars += size;
  }
  return selected;
}

export function requestFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

export function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function boundedCacheExpiry(now, localTtlMs, sourceTimestamp, sourceTtlMs) {
  return Math.min(now + localTtlMs, Number(sourceTimestamp) + sourceTtlMs);
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
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function consumeDailyBudget(store, kind, configuredLimit, now = new Date()) {
  const limit = configuredDailyLimit(configuredLimit);
  if (!limit) return { allowed: true, enabled: false };
  if (!store) return { allowed: true, enabled: true, shared: false };

  const day = now.toISOString().slice(0, 10);
  const field = kind === 'places' ? 'placesRequests' : 'geminiRequests';
  const ref = store.collection('panda_usage_budgets_v1').doc(day);

  try {
    return await store.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = Number(snapshot.data()?.[field] || 0);
      if (current >= limit) {
        return { allowed: false, enabled: true, shared: true, current, limit };
      }
      const next = current + 1;
      transaction.set(ref, { day, updatedAt: Date.now(), [field]: next }, { merge: true });
      return { allowed: true, enabled: true, shared: true, current: next, limit };
    });
  } catch {
    // Availability wins if Firestore has a transient problem. Provider-side
    // quotas remain the final hard stop.
    return { allowed: true, enabled: true, shared: false };
  }
}