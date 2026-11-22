import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEW_OPENINGS_TEST_COOLDOWN_MS,
  buildSingleDeviceTestMessage,
  validateSingleDeviceTest,
} from '../api/new-openings-notifications.js';

const now = Date.parse('2026-11-22T12:00:00Z');
const token = 'registered-device-token';
const optedInUser = { newOpeningsPushEnabled: true, fcmTokens: [token] };

test('test delivery requires opt-in and the same account’s registered device token', () => {
  assert.equal(validateSingleDeviceTest(optedInUser, token, now).status, 'ready');
  assert.equal(validateSingleDeviceTest({ ...optedInUser, newOpeningsPushEnabled: false }, token, now).status, 'notifications_not_enabled');
  assert.equal(validateSingleDeviceTest(optedInUser, 'another-users-token', now).status, 'device_not_registered');
  assert.equal(validateSingleDeviceTest(optedInUser, 'bad token', now).status, 'invalid_device_token');
});

test('one-device test is rate limited per account', () => {
  const user = { ...optedInUser, lastNewOpeningsTestAt: now - NEW_OPENINGS_TEST_COOLDOWN_MS + 1_000 };
  const decision = validateSingleDeviceTest(user, token, now);
  assert.equal(decision.status, 'test_cooldown');
  assert.equal(decision.retryAfterSeconds, 1);
});

test('test message targets exactly one registered device and opens New Openings', () => {
  const message = buildSingleDeviceTestMessage(token);
  assert.equal(message.token, token);
  assert.equal('tokens' in message, false);
  assert.equal(message.data.type, 'NEW_OPENINGS_WEEKLY_TEST');
  assert.equal(message.data.deepLink, 'panda-mobile://new-restaurants');
});
