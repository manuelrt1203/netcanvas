import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eui64Address, formatIp6, inPrefix6, isValidIp6, kindOf6, linkLocalOf, multicastMac6, networkLabel6, normIp6, parseIp6, solicitedNode6, splitPrefix6 } from './ip6.js';

test('IPv6 : lecture et écriture compressée (RFC 5952)', () => {
  assert.equal(normIp6('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.equal(normIp6('2001:db8:0:0:1:0:0:1'), '2001:db8::1:0:0:1');
  assert.equal(normIp6('2001:db8:0:1:1:1:1:1'), '2001:db8:0:1:1:1:1:1'); // un seul zéro : pas de ::
  assert.equal(normIp6('::'), '::');
  assert.equal(normIp6('::1'), '::1');
  assert.equal(normIp6('fe80::'), 'fe80::');
  assert.equal(normIp6('::ffff:192.0.2.1'), '::ffff:c000:201');
  for (const bad of ['2001:db8::1::2', '2001:db8:1', '12345::', 'g::1', '1:2:3:4:5:6:7:8:9', '', '192.168.1.1', 'fe80::1%eth0']) assert.equal(isValidIp6(bad), false, bad);
  assert.equal(formatIp6(parseIp6('1:0:0:2:0:0:0:3')), '1:0:0:2::3');
});

test('IPv6 : préfixes, catégories', () => {
  assert.equal(networkLabel6('2001:db8:acad:1::10', 64), '2001:db8:acad:1::/64');
  assert.equal(inPrefix6('2001:db8:acad:1::10', '2001:db8:acad::', 48), true);
  assert.equal(inPrefix6('2001:db8:acad:1::10', '2001:db8:acad:2::', 64), false);
  assert.deepEqual(splitPrefix6('2001:DB8:1::1/64'), { ip: '2001:db8:1::1', prefix: 64 });
  assert.equal(splitPrefix6('2001:db8::1/129'), null);
  assert.equal(kindOf6('fe80::1'), 'link-local');
  assert.equal(kindOf6('fd00::1'), 'unique-local');
  assert.equal(kindOf6('2001:db8::1'), 'global');
  assert.equal(kindOf6('ff02::1'), 'multicast');
});

test('IPv6 : EUI-64, link-local, nœud sollicité', () => {
  // Exemple classique Cisco : MAC 0050.7966.6801
  assert.equal(linkLocalOf('0050.7966.6801'), 'fe80::250:79ff:fe66:6801');
  assert.equal(eui64Address('2001:db8:acad:1::', '00:50:79:66:68:01'), '2001:db8:acad:1:250:79ff:fe66:6801');
  assert.equal(solicitedNode6('2001:db8::abcd:1234'), 'ff02::1:ffcd:1234');
  assert.equal(multicastMac6('ff02::1:ffcd:1234'), '3333.ffcd.1234');
});
