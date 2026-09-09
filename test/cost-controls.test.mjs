import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactConversation,
  consumeDailyBudget,
  configuredDailyLimit,
  requestFingerprint,
} from '../api/_cost-controls.js';

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