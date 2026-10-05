import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IPV6_DEMO } from '../examples.js';
import { buildTopology } from './topology.js';
import { validate } from './validate.js';
import { fromJSON, toJSON } from '../serialize.js';

const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const v6Issues = (doc) => validate(doc).map((i) => i.text).filter((t) => /IPv6|link-local|EUI-64/.test(t));

test('IPv6 : vue des interfaces (globale, link-local manuelle ou EUI-64)', () => {
  const topo = buildTopology(IPV6_DEMO);
  const r1 = topo.l3Ifaces6('r1');
  assert.deepEqual(r1.map((i) => [i.name, i.ip, i.prefix, i.linkLocal.startsWith('fe80::')]), [
    ['G0/0', '2001:db8:acad:10::1', 64, true], ['G0/1', '2001:db8:acad:20::1', 64, true], ['Se0/0/0', '2001:db8:acad:12::1', 64, true],
  ]);
  assert.equal(r1[0].linkLocal, 'fe80::1');
  assert.match(r1[2].linkLocal, /^fe80::201:42ff:fe[0-9a-f]{2}:[0-9a-f]{1,4}$/); // EUI-64 d'une MAC Cisco 0001.42xx.xxxx
  const pc2 = topo.l3Ifaces6('pc2')[0];
  assert.equal(pc2.ip, '2001:db8:acad:10::11');
  assert.equal(pc2.gateway, 'fe80::1');
  assert.match(pc2.linkLocal, /^fe80::2e0:f7ff:fe/);
  // EUI-64 : préfixe + identifiant tiré de la MAC
  const doc = structuredClone(IPV6_DEMO);
  Object.assign(dev(doc, 'r2').config.interfaces.find((i) => i.name === 'G0/1'), { ipv6: '2001:db8:ffff::', eui64: true });
  const eui = buildTopology(doc).l3Ifaces6('r2').find((i) => i.name === 'G0/1');
  assert.match(eui.ip, /^2001:db8:ffff:0:201:42ff:fe/);
});

test('IPv6 : contrôles en direct', () => {
  assert.deepEqual(v6Issues(IPV6_DEMO), []);
  const doc = structuredClone(IPV6_DEMO);
  const r1 = dev(doc, 'r1').config;
  r1.ipv6Routing = false;
  r1.interfaces[0].ipv6 = 'fe80::5';
  r1.interfaces[1].ipv6 = '2001:db8:acad:12::9';
  r1.interfaces[2].eui64 = true;
  r1.interfaces[2].prefix6 = 48;
  r1.routes6.push({ network: '2001:db8:1::', prefix: 64, nextHop: 'fe80::2' });
  dev(doc, 'pc2').config.gateway6 = '2001:db8:acad:99::1';
  dev(doc, 'srv').config.ipv6 = '2001:db8:ffff::2';
  const t = v6Issues(doc).join('\n');
  assert.match(t, /R1 G0\/0 : fe80::5 est une link-local/);
  assert.match(t, /R1 Se0\/0\/0 : EUI-64 demande un préfixe \/64 \(ici \/48\)/);
  assert.match(t, /R1 : G0\/1 et Se0\/0\/0 sont dans le même réseau IPv6 2001:db8:acad::\/48/);
  assert.match(t, /R1 a des adresses IPv6 sur 2 interfaces mais le routage IPv6 n'est pas activé/);
  assert.match(t, /route IPv6 2001:db8:1::\/64 : le saut suivant fe80::2 est une link-local, il faut préciser l'interface/);
  assert.match(t, /PC Compta 2 : la passerelle IPv6 2001:db8:acad:99::1 n'est ni une link-local ni dans le réseau 2001:db8:acad:10::\/64/);
  assert.match(t, /Adresse IPv6 2001:db8:ffff::2 en double : Serveur Web, Internet/);
});

test('IPv6 : sérialisation aller-retour', () => {
  const { nodes, edges } = fromJSON(IPV6_DEMO);
  const back = toJSON(nodes, edges);
  for (const id of ['r1', 'r2']) {
    assert.equal(dev(back, id).config.ipv6Routing, true);
    assert.deepEqual(dev(back, id).config.routes6, dev(IPV6_DEMO, id).config.routes6);
    assert.deepEqual(dev(back, id).config.interfaces.map((i) => [i.ipv6, i.prefix6, i.linkLocal]), dev(IPV6_DEMO, id).config.interfaces.map((i) => [i.ipv6, i.prefix6, i.linkLocal]));
  }
  assert.equal(dev(back, 'pc1').config.slaac, true);
  assert.deepEqual([dev(back, 'pc2').config.ipv6, dev(back, 'pc2').config.prefix6, dev(back, 'pc2').config.gateway6], ['2001:db8:acad:10::11', 64, 'fe80::1']);
});
