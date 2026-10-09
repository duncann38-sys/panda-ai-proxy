import test from 'node:test';
import assert from 'node:assert/strict';
import { linksFromOfficialHtml, publicAddress } from '../api/_official-venue-links.js';

test('menu and external booking links come from official anchors, never guessed paths', () => {
  const links = linksFromOfficialHtml(`<a href="/food/menus.pdf">Our menu</a>
    <a href="https://www.sevenrooms.com/reservations/proof">Book a table</a>`, 'https://venue.example/');
  assert.equal(links.menuUrl, 'https://venue.example/food/menus.pdf');
  assert.equal(links.reservationUrl, 'https://www.sevenrooms.com/reservations/proof');
});
test('missing menu or reservation links remain explicitly unavailable', () => {
  assert.deepEqual(linksFromOfficialHtml('<a href="/">Home</a><a href="mailto:test@example.test">Menu</a>', 'https://venue.example/'),
    { menuUrl: null, reservationUrl: null });
});
test('private, local, mapped and reserved addresses cannot be crawled', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.2.3', '192.168.0.1', '169.254.169.254',
    '100.64.0.1', '::1', '::', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});
