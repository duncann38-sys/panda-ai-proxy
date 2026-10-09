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
test('Nordic menu and table-booking anchors are supported without inventing URLs', () => {
  assert.deepEqual(linksFromOfficialHtml('<a href="/meny.pdf">Meny</a><a href="/boka-bord">Boka bord</a>',
    'https://venue.example/'), {
    menuUrl: 'https://venue.example/meny.pdf',
    reservationUrl: 'https://venue.example/boka-bord',
  });
});
test('shared-brand links prefer the named venue instead of the first branch', () => {
  const html = '<a href="https://www.sevenrooms.com/reservations/brinkleyskitchen">Book a table at Brinkley’s Kitchen</a>'
    + '<a href="https://www.sevenrooms.com/reservations/brinkleys">Book a table at Brinkley’s</a>';
  assert.equal(linksFromOfficialHtml(html, 'https://venue.example/', 'Brinkley’s').reservationUrl,
    'https://www.sevenrooms.com/reservations/brinkleys');
  assert.equal(linksFromOfficialHtml(html, 'https://venue.example/', 'Brinkley’s Kitchen').reservationUrl,
    'https://www.sevenrooms.com/reservations/brinkleyskitchen');
});
test('private, local, mapped and reserved addresses cannot be crawled', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.2.3', '192.168.0.1', '169.254.169.254',
    '100.64.0.1', '::1', '::', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});
