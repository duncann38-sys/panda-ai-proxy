import assert from 'node:assert/strict';
import test from 'node:test';
import { parseServiceAccount } from '../api/_firebase-service-account.js';

const fake = {
  project_id: 'test-project', client_email: 'test@example.invalid',
  private_key: 'NOT_A_REAL_KEY\\nTEST_ONLY',
};

test('service-account JSON accepts official and SDK field names without changing secrets', () => {
  const parsed = parseServiceAccount(JSON.stringify(fake));
  assert.equal(parsed.project_id, fake.project_id);
  assert.equal(parsed.private_key, 'NOT_A_REAL_KEY\nTEST_ONLY');
  assert.equal(parseServiceAccount(JSON.stringify({
    projectId: fake.project_id, clientEmail: fake.client_email, privateKey: fake.private_key,
  })).client_email, fake.client_email);
  assert.equal(parseServiceAccount(JSON.stringify(JSON.stringify(fake))).project_id, fake.project_id);
  assert.equal(parseServiceAccount(JSON.stringify({ FIREBASE_SERVICE_ACCOUNT: fake })).project_id, fake.project_id);
});

test('bad credential diagnostics expose fixed field names, not input values', () => {
  assert.throws(() => parseServiceAccount(JSON.stringify({ project_id: 'DO_NOT_DISPLAY' })),
    error => error.code === 'FIREBASE_SERVICE_ACCOUNT_missing_fields_client_email_and_private_key' &&
      !error.message.includes('DO_NOT_DISPLAY'));
  assert.throws(() => parseServiceAccount(JSON.stringify({ apiKey: 'DO_NOT_DISPLAY', projectId: 'test' })),
    error => error.code === 'FIREBASE_SERVICE_ACCOUNT_contains_web_app_config_not_Admin_JSON');
  assert.throws(() => parseServiceAccount('{ DO_NOT_DISPLAY'),
    error => error.code === 'FIREBASE_SERVICE_ACCOUNT_invalid_JSON');
});
