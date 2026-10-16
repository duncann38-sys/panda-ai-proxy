import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const module = await readFile(new URL('../api/_venue-photos.js', import.meta.url), 'utf8');
const source = module.slice(module.indexOf('export async function getVenuePhotoImage'))
  .replace(/^export /, '');
const makeImageLoader = (metadata, provider) => new Function(
  'getVenuePhotos', 'fetch', 'apiKey', 'requestError',
  `${source}\nreturn getVenuePhotoImage;`,
)(metadata, provider, () => 'unit-only', (message, status) => Object.assign(new Error(message), { status }));
const picture = () => new Response(new Uint8Array([255, 216, 255, 217]),
  { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

test('expired Google photo references are refreshed once before retrying the image', async () => {
  const options = [];
  const urls = [];
  const load = makeImageLoader(async (_id, refresh) => {
    options.push(refresh);
    return [{ name: refresh?.invalidReference ? 'places/example/photos/new' : 'places/example/photos/expired' }];
  }, async url => {
    urls.push(url);
    return urls.length === 1 ? new Response('', { status: 400 }) : picture();
  });
  const result = await load('example', 0);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.body.length, 4);
  assert.deepEqual(options[1], { refresh: true, invalidReference: true });
  assert.match(urls[1], /photos\/new\/media/);
});

test('photo quota errors are not bypassed with repeated metadata or image requests', async () => {
  let calls = 0;
  const load = makeImageLoader(async () => [{ name: 'places/example/photos/current' }],
    async () => { calls++; return new Response('', { status: 429 }); });
  await assert.rejects(load('example', 0), { status: 429 });
  assert.equal(calls, 1);
});

test('a removed photo reports unavailable rather than retrying indefinitely', async () => {
  let metadataCalls = 0;
  const load = makeImageLoader(async () => ++metadataCalls === 1
    ? [{ name: 'places/example/photos/removed' }] : [],
  async () => new Response('', { status: 404 }));
  await assert.rejects(load('example', 0), { status: 404 });
  assert.equal(metadataCalls, 2);
});
