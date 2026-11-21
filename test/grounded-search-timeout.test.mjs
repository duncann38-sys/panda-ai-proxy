import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const handler = readFileSync(new URL('../api/panda-ai.js', import.meta.url), 'utf8');
const vercelConfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('live Google-grounded lookups get enough time without slowing ordinary chat', () => {
  assert.match(
    handler,
    /const timeoutMs=Number\.isInteger\(options\.timeoutMs\)\s*\?Math\.max\(6500,Math\.min\(15_000,options\.timeoutMs\)\)\s*:6500;/,
  );
  assert.match(handler, /signal:AbortSignal\.timeout\(timeoutMs\)/);
  assert.equal([...handler.matchAll(/timeoutMs:15_000/g)].length, 4);
  assert.equal(vercelConfig.functions['api/panda-ai.js'].maxDuration, 60);
});
