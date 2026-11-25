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
  recordCostEvent,
  writeSharedGeminiCall,
} from '../api/_cost-controls.js';

function createBudgetStore(initialRows = {}) {
  const rows = new Map(Object.entries(initialRows));
  return {
    rows,
    collection(name) {
      return { doc: id => ({ collection: name, id }) };
    },
    async runTransaction(callback) {
      return callback({
        async get(ref) {
          return { data: () => rows.get(`${ref.collection}/${ref.id}`) || {} };
        },
        set(ref, value) {
          const key = `${ref.collection}/${ref.id}`;
          rows.set(key, { ...(rows.get(key) || {}), ...value });
        },
      });
    },
  };
}

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

test('configured daily limits must be positive integers', () => {
  assert.equal(configuredDailyLimit(undefined), null);
  assert.equal(configuredDailyLimit('0'), null);
  assert.equal(configuredDailyLimit('-1'), null);
  assert.equal(configuredDailyLimit('500x'), null);
  assert.equal(configuredDailyLimit('1.5'), null);
  assert.equal(configuredDailyLimit('9007199254740992'), null);
  assert.equal(configuredDailyLimit('5000'), 5000);
});

test('missing daily budget configuration fails closed', async () => {
  assert.deepEqual(
    await consumeDailyBudget(null, 'gemini', undefined),
    { allowed: false, enabled: false, reason: 'not_configured' },
  );
});

test('configured daily budgets fail closed when shared storage is unavailable', async () => {
  assert.deepEqual(
    await consumeDailyBudget(null, 'places', '5000'),
    { allowed: false, enabled: true, shared: false, reason: 'storage_unavailable' },
  );
});

test('daily budgets fail closed when the Firestore transaction throws', async () => {
  const store = {
    collection() { return { doc() { return {}; } }; },
    async runTransaction() { throw new Error('private storage detail'); },
  };
  assert.deepEqual(
    await consumeDailyBudget(store, 'photos', '5000'),
    { allowed: false, enabled: true, shared: false, reason: 'storage_unavailable' },
  );
});

test('daily budgets fail closed on malformed shared counters', async () => {
  const store = createBudgetStore({
    'panda_usage_budgets_v1/2026-01-02': { placesRequests: -1 },
  });
  assert.deepEqual(
    await consumeDailyBudget(store, 'places', '5000', new Date('2026-01-02T12:00:00Z')),
    { allowed: false, enabled: true, shared: true, reason: 'counter_invalid' },
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
  assert.equal(blocked.reason, 'limit');
});

test('photo media has its own shared daily counter', async () => {
  let count = 0;
  const store = {
    collection() {
      return { doc() { return {}; } };
    },
    async runTransaction(callback) {
      return callback({
        async get() { return { data: () => ({ photoRequests: count }) }; },
        set(_ref, value) { count = value.photoRequests; },
      });
    },
  };
  assert.equal((await consumeDailyBudget(store, 'photos', '1')).allowed, true);
  const blocked = await consumeDailyBudget(store, 'photos', '1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'limit');
});

test('Google Routes requests use an independent shared daily counter', async () => {
  const store = createBudgetStore();
  assert.equal((await consumeDailyBudget(store, 'routes', '2')).allowed, true);
  assert.equal((await consumeDailyBudget(store, 'routes', '2')).allowed, true);
  assert.deepEqual(
    await consumeDailyBudget(store, 'routes', '2'),
    { allowed: false, enabled: true, shared: true, current: 2, limit: 2, reason: 'limit' },
  );
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

test('usage metrics discard unapproved fields such as prompts and coordinates', () => {
  const oldEnabled = process.env.PANDA_USAGE_METRICS;
  const oldInfo = console.info;
  let output = '';
  process.env.PANDA_USAGE_METRICS = 'true';
  console.info = value => { output = value; };
  try {
    recordCostEvent('banging_directory_search', {
      scope: 'regional',
      query: 'private prompt',
      latitude: 51.5,
      clientIp: '192.0.2.1',
    });
  } finally {
    console.info = oldInfo;
    if (oldEnabled === undefined) delete process.env.PANDA_USAGE_METRICS;
    else process.env.PANDA_USAGE_METRICS = oldEnabled;
  }
  const event = JSON.parse(output);
  assert.equal(event.scope, 'regional');
  assert.equal('query' in event, false);
  assert.equal('latitude' in event, false);
  assert.equal('clientIp' in event, false);
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
  assert.equal(missingSalt.allowed, false);
  assert.equal(missingSalt.reason, 'client_fingerprint_unavailable');
  assert.deepEqual(
    await consumeClientDailyBudget(store, 'client', undefined),
    { allowed: false, enabled: false, reason: 'not_configured' },
  );
});

test('per-client budgets fail closed when Firestore is unavailable', async () => {
  const store = {
    collection() { return { doc() { return {}; } }; },
    async runTransaction() { throw new Error('private storage detail'); },
  };
  assert.deepEqual(
    await consumeClientDailyBudget(store, 'client', '10'),
    { allowed: false, enabled: true, shared: false, reason: 'storage_unavailable' },
  );
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