import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimited, resetRateLimitForTests } from '../api/_guard.js';

function request(ip) {
  return { headers: { 'x-forwarded-for': ip }, socket: {} };
}

function uniqueIp(index) {
  return `198.51.${Math.floor(index / 250)}.${index % 250}`;
}

test('high-cardinality traffic never resets an active client allowance', () => {
  resetRateLimitForTests();
  const first = request('192.0.2.1');
  for (let count = 0; count < 15; count += 1) {
    assert.equal(rateLimited(first), false);
  }
  for (let index = 2; index <= 5000; index += 1) {
    assert.equal(rateLimited(request(uniqueIp(index))), false);
  }
  assert.equal(rateLimited(request('203.0.113.1')), true);
  assert.equal(rateLimited(first), true);
  resetRateLimitForTests();
});

test('new clients are admitted immediately after saturated windows expire', () => {
  resetRateLimitForTests();
  const start = 1_000_000;
  for (let index = 1; index <= 5000; index += 1) {
    assert.equal(rateLimited(request(uniqueIp(index)), start), false);
  }
  assert.equal(rateLimited(request('203.0.113.50'), start), true);
  assert.equal(rateLimited(request('203.0.113.50'), start + 60_001), false);
  resetRateLimitForTests();
});