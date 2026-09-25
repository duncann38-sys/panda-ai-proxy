import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedCacheExpiry,
  boundedInteger,
  cacheablePlacesResult,
  cacheableGeminiFunctionCall,
  clientFingerprint,
  compactConversation,
  consumeClientDailyBudget,
  consumeDailyBudget,
  configuredDailyLimit,
  placesMemoryEntry,
  readSharedGeminiCall,
  requestFingerprint,
  writeSharedGeminiCall,
} from '../api/_cost-controls.js';

test('successful empty searches remain cacheable but provider failures and budget denials do not', () => {
  assert.equal(cacheablePlacesResult({ venues: [], nextPageToken: null }), true);
  assert.equal(cacheablePlacesResult({ venues: [], providerFailed: true }), false);
  assert.equal(cacheablePlacesResult({ venues: [], budgetExceeded: true }), false);
});

test('Places memory entries preserve the provider or Firestore timestamp', () => {
  const result = { venues: [{ id: 'a' }], nextPageToken: 'next' };
  const sourceTimestamp = 1_000_000;
  const entry = placesMemoryEntry(result, sourceTimestamp);
  assert.equal(entry.ts, sourceTimestamp);
  assert.equal(entry.venues, result.venues);
  assert.equal(entry.nextPageToken, 'next');
  assert.equal(boundedCacheExpiry(sourceTimestamp + 29 * 60_000, 30 * 60_000, entry.ts, 30 * 60_000), sourceTimestamp + 30 * 60_000);
});

test('conversation compaction preserves the newest context and order', () => {
  const contents = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? 'model' : 'user',
    parts: [{ text: `message-${index}` }],
  }));
  assert.deepEqual(
    compactConversation(contents, { maxItems: 4, maxChars: 10_000 }),
    contents.slice(-4),
  );
});

test('conversation compaction applies a character budget without dropping the latest message', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'a'.repeat(30) }] },
    { role: 'model', parts: [{ text: 'b'.repeat(30) }] },
    { role: 'user', parts: [{ text: 'latest' }] },
  ];
  const compacted = compactConversation(contents, { maxItems: 10, maxChars: 90 });
  assert.equal(compacted.at(-1).parts[0].text, 'latest');
  assert.ok(compacted.length >= 1);
});

test('conversation compaction preserves complete user-led turns', () => {
  const contents = [
    { role: 'model', parts: [{ text: 'orphaned model preface' }] },
    { role: 'user', parts: [{ text: 'first question' }] },
    { role: 'model', parts: [{ functionCall: { name: 'find_places' } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'find_places', response: {} } }] },
    { role: 'model', parts: [{ text: 'first answer' }] },
    { role: 'user', parts: [{ text: 'latest question' }] },
    { role: 'model', parts: [{ text: 'latest answer' }] },
  ];
  const compacted = compactConversation(contents, { maxItems: 3, maxChars: 10_000 });
  assert.deepEqual(compacted, contents.slice(-2));
  assert.equal(compacted[0].role, 'user');
});

test('request fingerprints are stable and distinguish different requests', () => {
  const request = { contents: [{ role: 'user', parts: [{ text: 'Find dinner' }] }] };
  assert.equal(requestFingerprint(request), requestFingerprint(request));
  assert.notEqual(requestFingerprint(request), requestFingerprint({ ...request, location: { lat: 1 } }));
});

test('daily limits are opt-in positive integers', () => {
  assert.equal(configuredDailyLimit(undefined), null);
  assert.equal(configuredDailyLimit('0'), null);
  assert.equal(configuredDailyLimit('-1'), null);
  assert.equal(configuredDailyLimit('5000'), 5000);
});

test('disabled daily budgets do not require Firestore or block requests', async () => {
  assert.deepEqual(
    await consumeDailyBudget(null, 'gemini', undefined),
    { allowed: true, enabled: false },
  );
});

test('enabled daily budgets fail open when shared storage is unavailable', async () => {
  assert.deepEqual(
    await consumeDailyBudget(null, 'places', '5000'),
    { allowed: true, enabled: true, shared: false },
  );
});

test('daily budgets reject calls after the configured shared limit', async () => {
  let count = 0;
  const store = {
    collection() {
      return { doc() { return {}; } };
    },
    async runTransaction(callback) {
      return callback({
        async get() {
          return { data: () => ({ geminiRequests: count }) };
        },
        set(_ref, value) {
          count = value.geminiRequests;
        },
      });
    },
  };
  assert.equal((await consumeDailyBudget(store, 'gemini', '2')).allowed, true);
  assert.equal((await consumeDailyBudget(store, 'gemini', '2')).allowed, true);
  const blocked = await consumeDailyBudget(store, 'gemini', '2');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.current, 2);
});

test('client fingerprints are stable without retaining raw network identifiers', () => {
  const req = {
    headers: {
      'x-forwarded-for': '192.0.2.20, 10.0.0.1',
      'user-agent': 'Panda Test',
    },
  };
  const fingerprint = clientFingerprint(req, 'test-salt');
  assert.equal(fingerprint, clientFingerprint(req, 'test-salt'));
  assert.equal(
    fingerprint,
    clientFingerprint({
      headers: {
        'x-forwarded-for': '192.0.2.20, 10.0.0.1',
        'user-agent': 'Rotated User Agent',
      },
    }, 'test-salt'),
  );
  assert.equal(fingerprint.includes('192.0.2.20'), false);
  assert.equal(clientFingerprint(req, ''), null);
});

test('per-client daily AI budgets reject only after the configured count', async () => {
  let count = 0;
  const store = {
    collection() {
      return { doc() { return {}; } };
    },
    async runTransaction(callback) {
      return callback({
        async get() {
          return { data: () => ({ aiRequests: count }) };
        },
        set(_ref, value) {
          count = value.aiRequests;
        },
      });
    },
  };
  assert.equal((await consumeClientDailyBudget(store, 'client', '1')).allowed, true);
  assert.equal((await consumeClientDailyBudget(store, 'client', '1')).allowed, false);
  const missingSalt = await consumeClientDailyBudget(store, null, '1');
  assert.equal(missingSalt.allowed, true);
  assert.equal(missingSalt.misconfigured, true);
});

test('bounded integers preserve defaults and clamp configured tool rounds', () => {
  assert.equal(boundedInteger(undefined, 2, 0, 2), 2);
  assert.equal(boundedInteger('0', 2, 0, 2), 0);
  assert.equal(boundedInteger('20', 2, 0, 2), 2);
});

test('shared cache promotion never extends the authoritative source lifetime', () => {
  const minute = 60_000;
  const sourceTimestamp = 1_000_000;
  const now = sourceTimestamp + 14 * minute;
  assert.equal(
    boundedCacheExpiry(now, 15 * minute, sourceTimestamp, 15 * minute),
    sourceTimestamp + 15 * minute,
  );
  assert.equal(
    boundedCacheExpiry(now, 5 * minute, sourceTimestamp, 30 * minute),
    now + 5 * minute,
  );
});

test('only function-call-only Gemini responses qualify for shared caching', () => {
  const functionCall = {
    ok: true,
    data: { candidates: [{ content: { parts: [{ functionCall: { name: 'find_places' } }] } }] },
  };
  const finalText = {
    ok: true,
    data: { candidates: [{ content: { parts: [{ text: 'Try this place.' }] } }] },
  };
  assert.equal(cacheableGeminiFunctionCall(functionCall), true);
  assert.equal(cacheableGeminiFunctionCall(finalText), false);
  assert.equal(cacheableGeminiFunctionCall({ ...functionCall, ok: false }), false);
});

test('shared Gemini cache reads fresh function calls and rejects expired entries', async () => {
  const docs = new Map();
  const store = {
    collection() {
      return {
        doc(key) {
          return {
            async get() {
              return {
                exists: docs.has(key),
                data: () => docs.get(key),
              };
            },
            async set(value) {
              docs.set(key, value);
            },
          };
        },
      };
    },
  };
  const result = {
    ok: true,
    status: 200,
    data: { candidates: [{ content: { parts: [{ functionCall: { name: 'find_places' } }] } }] },
  };
  assert.equal(await writeSharedGeminiCall(store, 'key', result, 1000), true);
  assert.deepEqual(await readSharedGeminiCall(store, 'key', 5000, 2000), result);
  assert.equal(await readSharedGeminiCall(store, 'key', 5000, 7000), null);

  docs.set('text-key', {
    ts: 1000,
    result: {
      ok: true,
      data: { candidates: [{ content: { parts: [{ text: 'private final answer' }] } }] },
    },
  });
  assert.equal(await readSharedGeminiCall(store, 'text-key', 5000, 2000), null);
});