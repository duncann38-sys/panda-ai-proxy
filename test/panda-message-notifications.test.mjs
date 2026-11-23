import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMessageNotification,
  buildMessageTest,
  validateMessageTest,
} from './.panda-message-notifications.js';

const token = 'android-device-fcm-token';
const now = Date.parse('2026-11-23T12:00:00Z');

test('message test requires opt-in and the same registered device token', () => {
  assert.equal(validateMessageTest({ messageNotificationsEnabled: false, fcmTokens: [token] }, token, now).status,
    'notifications_not_enabled');
  assert.equal(validateMessageTest({ messageNotificationsEnabled: true, fcmTokens: ['other-token'] }, token, now).status,
    'device_not_registered');
  assert.equal(validateMessageTest({ messageNotificationsEnabled: true, fcmTokens: [token] }, token, now).status,
    'ready');
});

test('message test respects a one-minute cooldown', () => {
  const result = validateMessageTest({
    messageNotificationsEnabled: true,
    fcmTokens: [token],
    lastPandaMessageTestAt: now - 30_000,
  }, token, now);
  assert.equal(result.status, 'test_cooldown');
  assert.equal(result.retryAfterSeconds, 30);
});

test('test alert uses the message channel, sound and vibration path', () => {
  const payload = buildMessageTest(token);
  assert.equal(payload.token, token);
  assert.equal(payload.android.notification.channelId, 'panda-messages');
  assert.equal(payload.android.notification.sound, 'default');
  assert.equal(payload.apns.payload.aps.sound, 'default');
  assert.equal(payload.data.type, 'PANDA_MESSAGE_TEST');
});

test('incoming alert opens the correct thread without exposing message text', () => {
  const payload = buildMessageNotification(token, 'Duncan', 'thread-1', 'message-1');
  assert.equal(payload.notification.title, 'Duncan sent you a message');
  assert.equal(payload.data.type, 'PANDA_MESSAGE');
  assert.equal(payload.data.threadId, 'thread-1');
  assert.equal(payload.data.messageId, 'message-1');
  assert.equal(payload.android.notification.channelId, 'panda-messages');
  assert.equal('text' in payload.data, false);
});
