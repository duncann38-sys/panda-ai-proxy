import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhotoFetch } from '../api/_photo-fetch.js';

const quota = unit => new Response(JSON.stringify({ error: { details: [{
  metadata: { quota_unit: unit, quota_metric: 'places.googleapis.com/GetPhotoMediaRequest',
    quota_limit: unit.includes('/d/') ? 'GetPhotoMediaRequestPerDayPerProject' : 'GetPhotoMediaRequestPerMinutePerProject' },
}] } }), { status: 429, headers: { 'Content-Type': 'application/json' } });

test('daily photo exhaustion returns immediately without spending more requests', async () => {
  let calls = 0;
  const fetchPhoto = createPhotoFetch({ fetchImpl: async () => { calls++; return quota('1/d/{project}'); } });
  assert.equal((await fetchPhoto('https://example.test')).status, 429);
  assert.equal(calls, 1);
});

test('temporary failures back off exponentially, then recover', async () => {
  let calls = 0, clock = 1000;
  const waits = [];
  const fetchPhoto = createPhotoFetch({
    fetchImpl: async () => new Response('', { status: ++calls < 3 ? 503 : 200 }),
    random: () => 0, now: () => clock, wait: async ms => { waits.push(ms); clock += ms; },
  });
  assert.equal((await fetchPhoto('https://example.test')).status, 200);
  assert.deepEqual(waits, [250, 500]);
  assert.equal(calls, 3);
});

test('short provider cooldown is respected and response remains readable', async () => {
  let calls = 0, clock = 1000;
  const waits = [];
  const fetchPhoto = createPhotoFetch({
    fetchImpl: async () => {
      calls++;
      if (calls > 1) return new Response('image');
      const response = quota('1/m/{project}');
      response.headers.set('Retry-After', '2');
      return response;
    },
    random: () => 0, now: () => clock, wait: async ms => { waits.push(ms); clock += ms; },
  });
  assert.equal(await (await fetchPhoto('https://example.test')).text(), 'image');
  assert.ok(waits.includes(2000));
});

test('long cooldown and exhausted retry allowance are not bypassed', async () => {
  let calls = 0;
  const fetchPhoto = createPhotoFetch({
    fetchImpl: async () => {
      calls++;
      const response = quota('1/m/{project}');
      response.headers.set('Retry-After', '60');
      return response;
    },
  });
  assert.equal((await fetchPhoto('https://example.test')).status, 429);
  assert.equal(calls, 1);
});

test('parallel requests are staggered and bounded to two upstream calls', async () => {
  let active = 0, peak = 0;
  const starts = [];
  const fetchPhoto = createPhotoFetch({ fetchImpl: async () => {
    starts.push(Date.now());
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 100));
    active--;
    return new Response('image');
  } });
  await Promise.all(Array.from({ length: 5 }, () => fetchPhoto('https://example.test')));
  assert.ok(peak <= 2);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 50);
});
