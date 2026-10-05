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

test('IPv6 : SLAAC (préfixe annoncé + EUI-64, passerelle link-local) et ses échecs', async () => {
  const { withLeases } = await import('./dhcp.js');
  const live = withLeases(IPV6_DEMO);
  const s = dev(live, 'pc1').config.slaac6;
  assert.match(s.ip, /^2001:db8:acad:10:2e0:f7ff:fe/);
  assert.deepEqual([s.prefix, s.gateway, s.router, s.iface], [64, 'fe80::1', 'r1', 'G0/0']);
  const off = structuredClone(IPV6_DEMO);
  dev(off, 'r1').config.ipv6Routing = false;
  assert.match(dev(withLeases(off), 'pc1').config.slaacError, /R1 a une adresse IPv6 sur ce réseau mais n'envoie pas d'annonces RA/);
  const p48 = structuredClone(IPV6_DEMO);
  dev(p48, 'r1').config.interfaces[0].prefix6 = 56;
  assert.match(dev(withLeases(p48), 'pc1').config.slaacError, /R1 annonce 2001:db8:acad::\/56 : SLAAC demande un préfixe \/64/);
  assert.ok(validate(off).some((i) => /PC Compta n'obtient pas d'adresse IPv6 automatique/.test(i.text)));
});

test('IPv6 : ping de bout en bout (NDP, passerelle link-local, routes statiques)', async () => {
  const { simulatePing } = await import('./simulate.js');
  const r = simulatePing(IPV6_DEMO, 'pc1', '2001:db8:acad:30::10');
  assert.equal(r.ok, true);
  assert.equal(r.ttl, 62);
  const texts = r.log.map((l) => l.text);
  assert.ok(texts.includes("PC Compta : 2001:db8:acad:30::10 est hors de son réseau 2001:db8:acad:10::/64, envoi à la passerelle fe80::1 (apprise par l'annonce RA)."));
  assert.ok(texts.includes('R1 : route statique par défaut IPv6 ::/0 via 2001:db8:acad:12::2 (Se0/0/0).'));
  // Trames : NS au multicast nœud sollicité, NA, puis ICMPv6 128 dans de l'IPv6 (0x86DD)
  const ns = r.frames.find((f) => f.kind === 'nd-ns');
  assert.match(ns.summary, /Neighbor Solicitation \(multicast ff02::1:ff00:1\) : qui a fe80::1/);
  assert.equal(ns.layers[0].fields[0][1], '3333.ff00.0001');
  const echo = r.frames.find((f) => f.kind === 'icmp');
  assert.deepEqual(echo.layers.map((l) => l.name), ['Ethernet II', '802.1Q', 'IPv6', 'ICMPv6'].filter((n) => echo.layers.some((l) => l.name === n)));
  assert.equal(echo.layers.find((l) => l.name === 'ICMPv6').fields[0][1], '128 (echo request)');
  assert.equal(echo.layers[0].fields[2][1], '0x86DD (IPv6)');
  // Ping de la passerelle link-local : réponse par la même interface
  assert.equal(simulatePing(IPV6_DEMO, 'pc2', 'fe80::1').ok, true);
  // Écriture non compressée acceptée
  assert.equal(simulatePing(IPV6_DEMO, 'pc2', '2001:0db8:acad:0030:0000:0000:0000:0010').ok, true);
});

test('IPv6 : pannes expliquées', async () => {
  const { simulatePing } = await import('./simulate.js');
  const why = (doc, s, d) => simulatePing(doc, s, d).log.findLast((l) => l.level === 'error')?.text;
  let doc = structuredClone(IPV6_DEMO);
  dev(doc, 'r2').config.ipv6Routing = false;
  assert.match(why(doc, 'pc2', '2001:db8:acad:30::10'), /R2 reçoit un paquet IPv6 pour 2001:db8:acad:30::10 mais le routage IPv6 n'est pas activé/);
  doc = structuredClone(IPV6_DEMO);
  dev(doc, 'r2').config.routes6 = [];
  assert.match(why(doc, 'pc2', '2001:db8:acad:30::10'), /R2 : aucune route IPv6 vers 2001:db8:acad:10::11/);
  doc = structuredClone(IPV6_DEMO);
  dev(doc, 'pc2').config.gateway6 = 'fe80::99';
  assert.match(why(doc, 'pc2', '2001:db8:acad:30::10'), /pas de réponse NDP \(Neighbor Advertisement\), aucun équipement ne possède fe80::99/);
  doc = structuredClone(IPV6_DEMO);
  delete dev(doc, 'pc2').config.gateway6;
  assert.match(why(doc, 'pc2', '2001:db8:acad:30::10'), /aucune passerelle IPv6 n'est configurée/);
  doc = structuredClone(IPV6_DEMO);
  Object.assign(dev(doc, 'pc2').config, { ipv6: undefined, gateway6: undefined });
  assert.match(why(doc, 'pc2', '2001:db8:acad:30::10'), /n'a pas d'adresse IPv6 globale \(seulement sa link-local fe80::/);
  // L'IPv4 n'est pas touché par la config IPv6
  assert.equal(simulatePing(IPV6_DEMO, 'pc1', '172.16.0.10').ok, true);
});

test('IPv6 : traceroute', async () => {
  const { traceroute } = await import('./traceroute.js');
  const t = traceroute(IPV6_DEMO, 'pc1', '2001:db8:ffff::2');
  assert.deepEqual(t.hops.map((h) => h.ip), ['2001:db8:acad:10::1', '2001:db8:acad:12::2', '2001:db8:ffff::2']);
  assert.equal(t.ok, true);
});
