import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('shared luxury pool, two-hour proofs, Premium separation and planner reuse', async () => {
  if (typeof vm.SourceTextModule !== 'function') {
    const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)],
      { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    return;
  }
  const records = new Map();
  const counters = { searches: 0, matrices: 0, walks: 0 };
  let available = true;
  const doc = (collection, key) => ({
    path: `${collection}/${key}`,
    async get() { return { exists: records.has(this.path), data: () => records.get(this.path) }; },
    async set(value) { records.set(this.path, value); },
  });
  const store = {
    collection: name => ({ doc: key => doc(name, key) }),
    runTransaction: callback => callback({
      get: ref => ref.get(), set: (ref, value) => records.set(ref.path, value),
      delete: ref => records.delete(ref.path),
    }),
  };
  const fixture = (id, extra = {}) => ({
    id, name: id, address: 'London, UK', latitude: 51.49, longitude: -0.14,
    category: 'Fine Dining Restaurant', rating: 4.7, ratingCount: 1000, price: '££££',
    photoNames: [{ name: `places/${id}/photos/one`, attribution: 'Provider' }], ...extra,
  });
  const live = {
    db: () => available ? store : null,
    readSharedCache: async (collection, key, ttl) => {
      if (!available) return null;
      const value = records.get(`${collection}/${createHash('sha256').update(key).digest('base64url')}`);
      return value && Date.now() - value.ts < ttl ? { value: value.value, ts: value.ts } : null;
    },
    searchVenueListings: async query => {
      counters.searches++;
      return Array.from({ length: 20 }, (_, index) => fixture(`${query}:${index}`));
    },
    getVenueProfile: async id => fixture(id),
    getBangingTransitDurations: async (_origin, destinations) => {
      counters.matrices++;
      assert(destinations.length <= 50);
      return destinations.map((_, index) => index === 0 ? 116 : index === 1 ? null : 45);
    },
    getWalkingRoute: async () => { counters.walks++; return { durationMinutes: 5 }; },
  };
  const context = vm.createContext({
    console, process: { env: {} }, Date, Map, Set, Error, Promise, Number, Math, String,
    setTimeout, clearTimeout, AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ venues: [
      { place_id: 'ChIJpremium01', tier: 'banging' },
      { place_id: 'ChIJpremium02', tier: 'banging' },
      { place_id: 'ChIJdiscovery', tier: 'discovery' },
    ] }) }),
  });
  const modules = new Map();
  async function load(path) {
    if (modules.has(path)) return modules.get(path);
    let module;
    if (path.endsWith('_venue-live.js')) {
      module = new vm.SyntheticModule(Object.keys(live), function () {
        for (const [name, value] of Object.entries(live)) this.setExport(name, value);
      }, { context, identifier: path });
    } else if (path === 'node:crypto') {
      const crypto = await import('node:crypto');
      module = new vm.SyntheticModule(['createHash', 'randomUUID'], function () {
        this.setExport('createHash', crypto.createHash); this.setExport('randomUUID', crypto.randomUUID);
      }, { context, identifier: path });
    } else module = new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'),
      { context, identifier: path });
    modules.set(path, module);
    await module.link(specifier => load(specifier === 'node:crypto' ? specifier : `../api/${specifier.split('/').pop()}`));
    await module.evaluate();
    return module;
  }
  const directory = (await load('../api/_banging-directory.js')).namespace;
  const origin = { latitude: 51.483, longitude: -0.144 };
  const result = await directory.getBangingDirectory(origin, ['ChIJpremium01', 'ChIJpremium02', 'ChIJdiscovery']);
  assert(result.results.length >= 40);
  assert(result.results.every(venue => venue.bangingTransitMinutes <= 120 && venue.luxurySource && venue.bangingVerifiedAt));
  assert.equal(Object.hasOwn(result.premiumJourneys, 'ChIJdiscovery'), false);
  assert.equal(counters.searches, 15);
  const before = { ...counters };
  await Promise.all(Array.from({ length: 5 }, () => directory.getBangingDirectory(origin, ['ChIJpremium01', 'ChIJpremium02'])));
  assert.deepEqual(counters, before);
  await directory.getBangingDirectory({ ...origin, latitude: 51.484 }, ['ChIJpremium01', 'ChIJpremium02']);
  assert.equal(counters.searches, before.searches);
  assert.equal(counters.matrices, before.matrices);
  assert.equal(counters.walks, before.walks + 1);
  assert.equal(directory.withinTransitLimit(115, 5), true);
  assert.equal(directory.withinTransitLimit(116, 5), false);
  assert.equal(directory.withinTransitLimit(null, 0), false);
  const planner = (await load('../api/_planner-directory.js')).namespace;
  const pool = await planner.getPlannerPool({ origin, area: '', mode: 'lunch', budget: 4, wide: false });
  assert(pool.results.length > 3);
  const count = counters.searches;
  await planner.getPlannerPool({ origin, area: '', mode: 'lunch', budget: 4, wide: false });
  assert.equal(counters.searches, count);
  const wider = await planner.getPlannerPool({ origin, area: '', mode: 'lunch', budget: 4, wide: true });
  assert(wider.results.length >= pool.results.length);
  const curation = (await load('../api/_banging-curation.js')).namespace;
  assert(curation.luxuryEvidence(fixture('fine')));
  assert.equal(curation.luxuryEvidence(fixture('ordinary expensive', { category: 'Pub' })), null);
  assert(curation.luxuryEvidence(fixture('core', { name: 'CORE by Clare Smyth', category: 'Restaurant' })));
  assert.equal(curation.luxuryEvidence(fixture('fake other city', {
    name: 'CORE by Clare Smyth', category: 'Restaurant', latitude: 53.48, address: 'Manchester',
  })), null);
  available = false;
  const last = counters.searches;
  await assert.rejects(directory.getBangingDirectory({ latitude: 53.48, longitude: -2.2 }),
    /Shared Banging storage is unavailable/);
  assert.equal(counters.searches, last);
});
