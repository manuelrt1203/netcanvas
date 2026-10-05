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

// Rejoue des commandes dans le terminal d'un équipement
async function terminal(start, id) {
  const { runLine, shellFor } = await import('../cli/index.js');
  const { mergeLearned } = await import('./tables.js');
  const { runtimeOf } = await import('./runtime.js');
  const { simulatePing } = await import('./simulate.js');
  const state = { doc: start };
  const shell = shellFor(dev(start, id));
  const s = shell.newSession();
  state.run = (...lines) => lines.map((line) => {
    const r = runLine(shell, s, line, dev(state.doc, id), state.doc);
    if (r.device) state.doc = { ...state.doc, devices: state.doc.devices.map((d) => (d.id === id ? r.device : d)) };
    // Comme l'éditeur : un ping apprend les voisins (tables)
    for (const e of r.effects) {
      if (e.type === 'ping') state.doc = { ...state.doc, runtime: mergeLearned(runtimeOf(state.doc), simulatePing(state.doc, e.source, e.target, e.options).learned, state.doc) };
    }
    return r.output.join('\n');
  }).join('\n');
  return state;
}

test('IOS : configuration IPv6 au terminal, identique au formulaire', async () => {
  const blank = structuredClone(IPV6_DEMO);
  const r1 = dev(blank, 'r1').config;
  delete r1.ipv6Routing;
  delete r1.routes6;
  for (const i of r1.interfaces) for (const k of ['ipv6', 'prefix6', 'linkLocal']) delete i[k];
  const t = await terminal(blank, 'r1');
  t.run('enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface g0/0', 'ipv6 address 2001:DB8:ACAD:10::1/64', 'ipv6 address FE80::1 link-local',
    'interface g0/1', 'ipv6 address 2001:db8:acad:20::1/64', 'ipv6 address fe80::1 link-local',
    'interface se0/0/0', 'ipv6 address 2001:db8:acad:12::1/64', 'exit',
    'ipv6 route ::/0 2001:db8:acad:12::2', 'end');
  const mine = dev(t.doc, 'r1').config;
  const ref = dev(IPV6_DEMO, 'r1').config;
  assert.equal(mine.ipv6Routing, true);
  assert.deepEqual(mine.routes6, ref.routes6);
  assert.deepEqual(mine.interfaces.map((i) => [i.ipv6, i.prefix6, i.linkLocal]), ref.interfaces.map((i) => [i.ipv6, i.prefix6, i.linkLocal]));
  // Erreurs comme IOS
  t.run('configure terminal', 'interface g0/1');
  assert.match(t.run('ipv6 address 2001:db8:acad:10::5/64'), /% 2001:DB8:ACAD:10::\/64 overlaps with GigabitEthernet0\/0/);
  assert.match(t.run('ipv6 address fe80::9/64'), /must be configured with the link-local keyword/);
  t.run('exit');
  assert.match(t.run('ipv6 route 2001:db8:9::/64 fe80::2'), /Interface has to be specified for a link-local nexthop/);
  t.run('ipv6 route 2001:db8:9::/64 g0/1 fe80::2', 'end');
  assert.deepEqual(dev(t.doc, 'r1').config.routes6.at(-1), { network: '2001:db8:9::', prefix: 64, iface: 'G0/1', nextHop: 'fe80::2' });
  const run = t.run('show running-config');
  assert.match(run, /hostname R1\n!\nipv6 unicast-routing/);
  assert.match(run, /interface GigabitEthernet0\/0\n ip address 192\.168\.10\.1 255\.255\.255\.0\n ipv6 address FE80::1 link-local\n ipv6 address 2001:DB8:ACAD:10::1\/64/);
  assert.match(run, /ipv6 route ::\/0 2001:DB8:ACAD:12::2\nipv6 route 2001:DB8:9::\/64 GigabitEthernet0\/1 FE80::2/);
  // Le même texte, réimporté, redonne la même config
  const { importConfig } = await import('../cli/import.js');
  const fresh = structuredClone(blank);
  const back = importConfig(dev(fresh, 'r1'), fresh, run);
  assert.deepEqual(back.ignored.filter((l) => /ipv6/.test(l.text)), []);
  assert.deepEqual(back.device.config.routes6, dev(t.doc, 'r1').config.routes6);
  // Retrait
  t.run('configure terminal', 'no ipv6 route 2001:db8:9::/64 g0/1 fe80::2', 'interface g0/1', 'no ipv6 address', 'exit', 'no ipv6 unicast-routing', 'end');
  const c = dev(t.doc, 'r1').config;
  assert.equal(c.ipv6Routing, undefined);
  assert.equal(c.routes6.length, 1);
  assert.equal(c.interfaces.find((i) => i.name === 'G0/1').ipv6, undefined);
});

test('IOS : show ipv6, ping et traceroute IPv6', async () => {
  const t = await terminal(structuredClone(IPV6_DEMO), 'r1');
  t.run('enable');
  const brief = t.run('show ipv6 interface brief');
  assert.match(brief, /GigabitEthernet0\/0\s+\[up\/up\]\n    FE80::1\n    2001:DB8:ACAD:10::1/);
  assert.match(brief, /GigabitEthernet0\/2\s+\[down\/down\]\n    unassigned/);
  const route = t.run('show ipv6 route');
  assert.match(route, /S   ::\/0 \[1\/0\]\n     via 2001:DB8:ACAD:12::2/);
  assert.match(route, /C   2001:DB8:ACAD:10::\/64 \[0\/0\]\n     via GigabitEthernet0\/0, directly connected/);
  assert.match(route, /L   2001:DB8:ACAD:10::1\/128 \[0\/0\]\n     via GigabitEthernet0\/0, receive/);
  assert.match(t.run('ping 2001:db8:acad:30::10'), /!!!!!/);
  assert.match(t.run('ping ipv6 2001:db8:dead::1'), /Success rate is 0 percent[\s\S]*R2 : aucune route IPv6 vers 2001:db8:dead::1/);
  // Dans la /48 mais sans réseau : R1 (route par défaut) et R2 (route /48) se renvoient le paquet
  assert.match(t.run('ping 2001:db8:acad:99::1'), /R2 : Hop Limit expiré, le paquet tourne en boucle/);
  assert.match(t.run('traceroute ipv6 2001:db8:ffff::2'), /1 2001:db8:acad:12::2[\s\S]*2 2001:db8:ffff::2/);
  // Un ping sur Ethernet remplit le cache des voisins (pas de NDP sur la liaison série)
  t.run('ping 2001:db8:acad:10::11');
  assert.match(t.run('show ipv6 neighbors'), /2001:DB8:ACAD:10::11\s+0\s+00e0\.[0-9a-f]{4}\.[0-9a-f]{4}\s+REACH Gi0\/0/);
});

test('Export Cisco : IPv6 des routeurs et des PC', async () => {
  const { ciscoConfigs } = await import('../export/cisco.js');
  const out = ciscoConfigs(IPV6_DEMO);
  const r1 = out.find((x) => x.id === 'r1').text;
  assert.match(r1, /ipv6 unicast-routing/);
  assert.match(r1, /interface GigabitEthernet0\/0\n description [^\n]+\n ip address 192\.168\.10\.1 255\.255\.255\.0\n ipv6 address FE80::1 link-local\n ipv6 address 2001:DB8:ACAD:10::1\/64/);
  assert.match(r1, /ipv6 route ::\/0 2001:DB8:ACAD:12::2/);
  assert.match(out.find((x) => x.id === 'pc1').text, /IPv6 : Automatic \(SLAAC\)/);
  assert.match(out.find((x) => x.id === 'pc2').text, /IPv6 Address    : 2001:db8:acad:10::11\/64\n  IPv6 Gateway    : fe80::1/);
  const gns3 = ciscoConfigs(IPV6_DEMO, { target: 'gns3' });
  assert.match(gns3.find((x) => x.id === 'pc1').text, /ip auto/);
});

test('PC : ipconfig, ipv6config, ping et tracert IPv6', async () => {
  const t = await terminal(structuredClone(IPV6_DEMO), 'pc1');
  const ip = t.run('ipconfig');
  assert.match(ip, /Link-local IPv6 Address\.+: FE80::2E0:F7FF:FE[0-9A-F:]+\n   IPv6 Address\.+: 2001:DB8:ACAD:10:2E0:F7FF:FE[0-9A-F:]+\n   IPv4 Address\.+: 192\.168\.10\.10/);
  assert.match(ip, /Default Gateway\.+: FE80::1\n {37}192\.168\.10\.1/);
  assert.match(t.run('ipv6config'), /Autoconfiguration\.+: Enabled/);
  assert.match(t.run('ping 2001:db8:acad:30::10'), /Reply from 2001:DB8:ACAD:30::10: bytes=32 time<1ms TTL=62/);
  assert.match(t.run('tracert 2001:db8:ffff::2'), /1   <1 ms     <1 ms     <1 ms     2001:db8:acad:10::1[\s\S]*Trace complete/);
  // Passage en statique au terminal = même config que le formulaire
  t.run('ipv6config 2001:DB8:ACAD:10::50/64 fe80::1');
  assert.deepEqual(['slaac', 'ipv6', 'prefix6', 'gateway6'].map((k) => dev(t.doc, 'pc1').config[k]), [undefined, '2001:db8:acad:10::50', 64, 'fe80::1']);
  assert.match(t.run('ipv6config 2001:db8:acad:10::50/64 2001:db8:acad:99::1'), /Invalid gateway/);
  assert.match(t.run('ipv6config /autoconfig'), /IPv6 Address\.+: 2001:DB8:ACAD:10:2E0:F7FF:FE[0-9A-F:]+\/64 \(annonce RA, passerelle FE80::1\)/);
});

test('MikroTik : /ipv6 address, route, settings, neighbor ; RA actives par défaut', async () => {
  const { OSPF_DEMO } = await import('../examples.js');
  const { withLeases } = await import('./dhcp.js');
  const doc = structuredClone(OSPF_DEMO);
  dev(doc, 'srv').config.slaac = true;
  const t = await terminal(doc, 'r3');
  t.run('/ipv6 address add address=2001:db8:3::1/64 interface=ether2', '/ipv6 address add address=fe80::1/64 interface=ether2',
    '/ipv6 address add address=2001:db8:23::/64 eui-64=yes interface=ether1', '/ipv6 route add dst-address=::/0 gateway=fe80::2%ether1');
  const e2 = dev(t.doc, 'r3').config.interfaces.find((i) => i.name === 'ether2');
  assert.deepEqual([e2.ipv6, e2.prefix6, e2.linkLocal], ['2001:db8:3::1', 64, 'fe80::1']);
  assert.deepEqual(dev(t.doc, 'r3').config.routes6, [{ network: '::', prefix: 0, nextHop: 'fe80::2', iface: 'ether1' }]);
  assert.match(t.run('/ipv6 address add address=2001:db8:3::9/64 interface=ether3'), /overlaps with ether2/);
  // SLAAC : le MikroTik annonce sans réglage (forward=yes par défaut)
  const srv = dev(withLeases(t.doc), 'srv').config.slaac6;
  assert.match(srv.ip, /^2001:db8:3:0:2e0:f7ff:fe/);
  assert.equal(srv.gateway, 'fe80::1');
  assert.match(t.run(`/ping ${srv.ip} count=1`), /received=1/);
  assert.match(t.run('/ipv6 neighbor print'), new RegExp(`${srv.ip.replace(/:/g, ':')}\\s+ether2\\s+00:E0:F7:[0-9A-F:]+\\s+reachable`));
  const addr = t.run('/ipv6 address print');
  assert.match(addr, /1\s+G 2001:db8:3::1\/64\s+ether2\s+yes/);
  assert.match(addr, /G 2001:db8:23:0:4e5e:cff:fe[0-9a-f:]+\/64\s+ether1/);
  assert.match(addr, / L fe80::1\/64\s+ether2/);
  assert.match(addr, /DL fe80::4e5e:cff:fe[0-9a-f:]+\/64\s+ether1/);
  const routes = t.run('/ipv6 route print');
  assert.match(routes, /0\s+As ::\/0\s+fe80::2%ether1\s+1/);
  assert.match(routes, /DAc 2001:db8:3::\/64\s+ether2\s+0/);
  assert.match(t.run('/ipv6 route remove 1'), /cannot remove dynamic route/);
  // Export puis import : même config
  const exported = t.run('/export');
  assert.match(exported, /\/ipv6 address\nadd address=2001:db8:23::\/64 eui-64=yes interface=ether1\nadd address=fe80::1\/64 advertise=no interface=ether2\nadd address=2001:db8:3::1\/64 interface=ether2\n\/ipv6 route\nadd dst-address=::\/0 gateway=fe80::2%ether1/);
  const { importConfig } = await import('../cli/import.js');
  const fresh = structuredClone(OSPF_DEMO);
  const back = importConfig(dev(fresh, 'r3'), fresh, exported);
  assert.deepEqual(back.ignored.filter((l) => /ipv6|eui/.test(l.text)), []);
  assert.deepEqual(back.device.config.routes6, dev(t.doc, 'r3').config.routes6);
  // forward=no : plus de routage ni d'annonce
  t.run('/ipv6 settings set forward=no');
  assert.match(dev(withLeases(t.doc), 'srv').config.slaacError, /n'envoie pas d'annonces RA/);
  assert.match(t.run('/ipv6 settings print'), /forward: no/);
});

test('OSPFv3 : routes inter-zones et externe, sauts suivants link-local, pannes expliquées', async () => {
  const { OSPF6_DEMO } = await import('../examples.js');
  const { computeRouting } = await import('./routing.js');
  const { routeText6 } = await import('./routing6.js');
  const { simulatePing } = await import('./simulate.js');
  const { withLeases } = await import('./dhcp.js');
  const routes = (doc, id) => [...computeRouting(withLeases(doc)).ribs6.get(id).values()].map((r) => `${r.proto} ${routeText6(r)}`);
  const r1 = routes(OSPF6_DEMO, 'r1');
  assert.ok(r1.includes('O IA 2001:db8:3:1::/64'));
  assert.ok(r1.includes('O*E2 ::/0'));
  const def = [...computeRouting(withLeases(OSPF6_DEMO)).ribs6.get('r1').values()].find((r) => r.prefix === 0);
  assert.match(def.nextHop, /^fe80::/);
  assert.equal(def.iface, 'G0/1');
  const srv = dev(withLeases(OSPF6_DEMO), 'srv').config.slaac6.ip;
  assert.equal(simulatePing(OSPF6_DEMO, 'pc1', srv).ok, true);
  assert.equal(simulatePing(OSPF6_DEMO, 'pc1', '2001:db8:f::2').ok, true);
  assert.deepEqual(validate(OSPF6_DEMO).filter((i) => /OSPF/.test(i.text)), []);
  // Zone différente d'un côté : plus d'adjacence, explication
  const bad = structuredClone(OSPF6_DEMO);
  dev(bad, 'r2').config.ospf6.interfaces.find((x) => x.name === 'G0/1').area = 2;
  assert.ok(validate(bad).some((i) => /OSPFv3 : pas d'adjacence R2 \(ABR\) G0\/1 ↔ R3 MikroTik ether1 : zones différentes \(2 et 0\)/.test(i.text)));
  assert.ok(!routes(bad, 'r1').includes('O*E2 ::/0'));
  // Sans aucune adresse IPv4 ni router-id : OSPFv3 ne démarre pas
  const norid = structuredClone(OSPF6_DEMO);
  for (const i of dev(norid, 'r1').config.interfaces) i.ip = null;
  assert.ok(validate(norid).some((i) => /R1 : OSPFv3 ne démarre pas, aucun router-id/.test(i.text)));
});

test('OSPFv3 au terminal : IOS et MikroTik, show, export et réimport', async () => {
  const { OSPF6_DEMO } = await import('../examples.js');
  const { importConfig } = await import('../cli/import.js');
  // IOS : reconstruire R1 au terminal
  const blank = structuredClone(OSPF6_DEMO);
  delete dev(blank, 'r1').config.ospf6;
  const t = await terminal(blank, 'r1');
  t.run('enable', 'configure terminal', 'ipv6 router ospf 1', 'passive-interface g0/0', 'exit',
    'interface g0/0', 'ipv6 ospf 1 area 1', 'interface g0/1', 'ipv6 ospf 1 area 1', 'interface lo0', 'ipv6 ospf 1 area 1', 'end');
  assert.deepEqual(dev(t.doc, 'r1').config.ospf6, dev(OSPF6_DEMO, 'r1').config.ospf6);
  assert.match(t.run('show ipv6 ospf neighbor'), /OSPFv3 Router with ID \(1\.1\.1\.1\)[\s\S]*2\.2\.2\.2\s+1\s+FULL\/DR\s+00:00:35\s+3\s+GigabitEthernet0\/1/);
  assert.match(t.run('show ipv6 route'), /OI  2001:DB8:3:1::\/64 \[110\/3\]\n     via FE80::[0-9A-F:]+, GigabitEthernet0\/1/);
  const run = t.run('show running-config');
  assert.match(run, /interface GigabitEthernet0\/1\n ip address 10\.0\.12\.1 255\.255\.255\.252\n ipv6 enable\n ipv6 ospf 1 area 1/);
  assert.match(run, /ipv6 router ospf 1\n passive-interface GigabitEthernet0\/0\n!/);
  const fresh = structuredClone(blank);
  const back = importConfig(dev(fresh, 'r1'), fresh, run);
  assert.deepEqual(back.ignored.filter((l) => /ipv6/.test(l.text)), []);
  const sorted = (o) => ({ ...o, interfaces: [...o.interfaces].sort((a, b) => a.name.localeCompare(b.name)) });
  assert.deepEqual(sorted(back.device.config.ospf6), sorted(dev(OSPF6_DEMO, 'r1').config.ospf6));
  // MikroTik : export /routing ospf version=3, réimporté à l'identique
  const m = await terminal(structuredClone(OSPF6_DEMO), 'r3');
  const exported = m.run('/export');
  assert.match(exported, /\/routing ospf instance\nadd name=default-v3 version=3 router-id=3\.3\.3\.3 originate-default=if-installed\n\/routing ospf area\nadd area-id=0\.0\.0\.0 instance=default-v3 name=backbone-v3\n\/routing ospf interface-template\nadd area=backbone-v3 interfaces=ether1\nadd area=backbone-v3 interfaces=ether2 passive/);
  assert.match(m.run('/routing ospf neighbor print'), /instance=default-v3 area=backbone-v3 address=fe80::[0-9a-f:]+%ether1 router-id=2\.2\.2\.2 state="Full"/);
  const bare = structuredClone(OSPF6_DEMO);
  delete dev(bare, 'r3').config.ospf6;
  const mk = importConfig(dev(bare, 'r3'), bare, exported).device.config.ospf6;
  const ref = dev(OSPF6_DEMO, 'r3').config.ospf6;
  assert.deepEqual([mk.routerId, mk.defaultOriginate, mk.interfaces, mk.passive], [ref.routerId, ref.defaultOriginate, ref.interfaces, ref.passive]);
});

test('DNS : enregistrements AAAA, IPv6 préférée par un PC qui a une adresse IPv6', async () => {
  const { resolveName, httpGet } = await import('./services.js');
  const doc = structuredClone(IPV6_DEMO);
  Object.assign(dev(doc, 'srv').config, {
    services: { dns: { enabled: true, records: [{ name: 'www.lan', ip: '172.16.0.10' }, { name: 'www.lan', ip: '2001:db8:acad:30::10' }] }, http: { enabled: true, title: 'Intranet' } },
  });
  dev(doc, 'pc1').config.dns = '172.16.0.10';
  dev(doc, 'pc3').config.dns = '172.16.0.10';
  const r = resolveName(doc, 'pc1', 'www.lan');
  assert.equal(r.ip, '2001:db8:acad:30::10');
  assert.deepEqual(r.addresses, ['2001:db8:acad:30::10', '172.16.0.10']);
  assert.match(r.query.frames.find((f) => f.kind === 'udp' && f.phase === 'reply').layers.at(-1).fields[0][1], /www\.lan A 172\.16\.0\.10, www\.lan AAAA 2001:db8:acad:30::10/);
  // La page web arrive en IPv6
  const web = httpGet(doc, 'pc1', 'http://www.lan');
  assert.equal(web.ok, true);
  assert.ok(web.result.frames.some((f) => f.layers.some((l) => l.name === 'IPv6')));
  // Sans IPv6 globale, le PC prend l'enregistrement A
  const v4only = structuredClone(doc);
  delete dev(v4only, 'pc3').config.slaac;
  assert.equal(resolveName(v4only, 'pc3', 'www.lan').ip, '172.16.0.10');
  assert.deepEqual(validate(doc).filter((i) => /DNS/.test(i.text)), []);
});

test('ACL IPv6 : syntaxe, évaluation, fin implicite (NDP autorisé)', async () => {
  const { parseAcl6Line, rule6Text, evaluateAcl6, blocksNdp } = await import('./acl6.js');
  const r = parseAcl6Line('deny icmp 2001:DB8:ACAD:20::/64 host 2001:db8:acad:30::10 echo-request');
  assert.deepEqual(r.rule, { action: 'deny', protocol: 'icmp', src: { prefix: '2001:db8:acad:20::', len: 64 }, dst: { prefix: '2001:db8:acad:30::10', len: 128 }, icmpType: 'echo-request' });
  assert.equal(rule6Text(r.rule), 'deny icmp 2001:db8:acad:20::/64 host 2001:db8:acad:30::10 echo-request');
  assert.match(parseAcl6Line('permit ip any any').error, /ipv6, icmp, tcp ou udp/);
  assert.match(parseAcl6Line('permit icmp any any eq 80').error, /tcp ou udp/);
  assert.match(parseAcl6Line('permit ipv6 2001:db8::1 any').error, /préfixe/);
  const acl = { rules: [r.rule, parseAcl6Line('permit tcp any any eq www').rule] };
  const pkt = { src: '2001:db8:acad:20::5', dst: '2001:db8:acad:30::10', proto: 'icmp', icmpType: 'echo-request' };
  assert.deepEqual(evaluateAcl6(acl, pkt).line, 10);
  assert.equal(evaluateAcl6(acl, { ...pkt, src: '2001:db8:acad:10::5' }).text, 'deny ipv6 any any (refus implicite)');
  assert.equal(evaluateAcl6(acl, { ...pkt, proto: 'tcp', dport: 80 }).permit, true);
  assert.equal(evaluateAcl6(acl, { ...pkt, icmpType: 'nd-ns' }).permit, true);
  assert.equal(blocksNdp({ rules: [parseAcl6Line('deny ipv6 any any').rule] }), 10);
  assert.equal(blocksNdp({ rules: [parseAcl6Line('permit icmp any any nd-na').rule, parseAcl6Line('deny ipv6 any any').rule] }), null);
});

test('ACL IPv6 dans la simulation : refus, NDP bloqué par un deny explicite, IPv4 non touché', async () => {
  const { simulatePing } = await import('./simulate.js');
  const why = (doc, s, d) => simulatePing(doc, s, d).log.findLast((l) => l.level === 'error')?.text;
  const doc = structuredClone(IPV6_DEMO);
  const r2 = dev(doc, 'r2').config;
  r2.acls6 = { SERVEUR: { rules: [{ action: 'deny', protocol: 'icmp', src: { prefix: '2001:db8:acad:20::', len: 64 }, dst: { any: true }, icmpType: 'echo-request' }, { action: 'permit', protocol: 'ipv6', src: { any: true }, dst: { any: true } }] } };
  r2.interfaces.find((i) => i.name === 'G0/0').aclOut6 = 'SERVEUR';
  assert.match(why(doc, 'pc3', '2001:db8:acad:30::10'), /R2 : paquet 2001:db8:acad:20:[0-9a-f:]+ → 2001:db8:acad:30::10 \(ICMPv6\) refusé en sortie de G0\/0 par l'ACL IPv6 SERVEUR, ligne 10 « deny icmp 2001:db8:acad:20::\/64 any echo-request »/);
  assert.equal(simulatePing(doc, 'pc1', '2001:db8:acad:30::10').ok, true);
  assert.equal(simulatePing(doc, 'pc3', '172.16.0.10').ok, true); // l'ACL IPv6 ne filtre pas l'IPv4
  // Piège : « deny ipv6 any any » écrit en entrée de R1 G0/0 bloque aussi NDP
  const trap = structuredClone(IPV6_DEMO);
  const r1 = dev(trap, 'r1').config;
  r1.acls6 = { IN: { rules: [{ action: 'permit', protocol: 'icmp', src: { any: true }, dst: { any: true }, icmpType: 'echo-request' }, { action: 'deny', protocol: 'ipv6', src: { any: true }, dst: { any: true } }] } };
  r1.interfaces.find((i) => i.name === 'G0/0').aclIn6 = 'IN';
  assert.match(why(trap, 'pc2', '2001:db8:acad:30::10'), /R1 : la ligne 20 de l'ACL IPv6 IN \(en entrée de G0\/0\) refuse tout, y compris la découverte des voisins \(Neighbor Solicitation\)/);
  assert.ok(validate(trap).some((i) => /ACL IPv6 IN.*bloque aussi la découverte des voisins/.test(i.text)));
});

test('ACL IPv6 au terminal IOS, pare-feu IPv6 MikroTik, exports', async () => {
  const t = await terminal(structuredClone(IPV6_DEMO), 'r2');
  t.run('enable', 'configure terminal', 'ipv6 access-list SERVEUR', 'deny icmp 2001:db8:acad:20::/64 any echo-request', 'permit ipv6 any any', 'exit',
    'interface g0/0', 'ipv6 traffic-filter SERVEUR out', 'end');
  const c = dev(t.doc, 'r2').config;
  assert.equal(c.acls6.SERVEUR.rules.length, 2);
  assert.equal(c.interfaces.find((i) => i.name === 'G0/0').aclOut6, 'SERVEUR');
  assert.match(t.run('show ipv6 access-list'), /IPv6 access list SERVEUR\n    deny icmp 2001:DB8:ACAD:20::\/64 any echo-request sequence 10\n    permit ipv6 any any sequence 20/);
  const run = t.run('show running-config');
  assert.match(run, /ipv6 traffic-filter SERVEUR out/);
  assert.match(run, /ipv6 access-list SERVEUR\n deny icmp 2001:DB8:ACAD:20::\/64 any echo-request\n permit ipv6 any any/);
  const { importConfig } = await import('../cli/import.js');
  const fresh = structuredClone(IPV6_DEMO);
  const back = importConfig(dev(fresh, 'r2'), fresh, run).device.config;
  assert.deepEqual(back.acls6, c.acls6);
  assert.equal(back.interfaces.find((i) => i.name === 'G0/0').aclOut6, 'SERVEUR');
  t.run('configure terminal', 'ipv6 access-list SERVEUR', 'no sequence 10', 'end');
  assert.equal(dev(t.doc, 'r2').config.acls6.SERVEUR.rules.length, 1);
  // MikroTik : /ipv6 firewall filter
  const { OSPF6_DEMO } = await import('../examples.js');
  const m = await terminal(structuredClone(OSPF6_DEMO), 'r3');
  m.run('/ipv6 firewall filter add chain=forward action=drop protocol=icmpv6 src-address=2001:db8:1:1::/64');
  assert.match(m.run('/ipv6 firewall filter add chain=forward action=drop src-address=10.0.0.0/8'), /adresse IPv6 attendue/);
  assert.deepEqual(dev(m.doc, 'r3').config.firewall6, [{ chain: 'forward', action: 'drop', protocol: 'icmpv6', src: '2001:db8:1:1::/64' }]);
  const { simulatePing } = await import('./simulate.js');
  const { withLeases } = await import('./dhcp.js');
  const srv = dev(withLeases(m.doc), 'srv').config.slaac6.ip;
  assert.match(simulatePing(m.doc, 'pc1', srv).log.at(-1).text, /bloqué par le pare-feu IPv6, règle 0 « chain=forward action=drop protocol=icmpv6 src-address=2001:db8:1:1::\/64 »/);
  assert.match(m.run('/export'), /\/ipv6 firewall filter\nadd chain=forward action=drop protocol=icmpv6 src-address=2001:db8:1:1::\/64/);
  // Containerlab : ip6tables, et ports traduits (IPv4 aussi)
  const { clabCommands } = await import('../export/containerlab.js');
  assert.ok(clabCommands(t.doc).get('r2').includes('ip6tables -A acl6-SERVEUR -j DROP'));
  assert.ok(clabCommands(m.doc).get('r3').includes('ip6tables -A FORWARD -p ipv6-icmp -s 2001:db8:1:1::/64 -j DROP'));
  const { SERVICES_DEMO } = await import('../examples.js');
  assert.ok(clabCommands(SERVICES_DEMO).get('r2').includes('iptables -A acl-110 -p tcp -s 192.168.20.0/24 --dport 80 -d 172.16.0.10/32 -j RETURN'));
});

test('DHCPv6 : stateful (M), stateless (O), erreurs expliquées, terminal IOS', async () => {
  const { withLeases } = await import('./dhcp.js');
  const { resolveName } = await import('./services.js');
  const doc = structuredClone(IPV6_DEMO);
  const r1 = dev(doc, 'r1').config;
  r1.dhcp6Pools = { VLAN10: { prefix: '2001:db8:acad:10::', len: 64, dns: '2001:db8:acad:30::10' }, VLAN20: { dns: '2001:db8:acad:30::10' } };
  Object.assign(r1.interfaces.find((i) => i.name === 'G0/0'), { ndManaged: true, dhcp6Server: 'VLAN10' });
  Object.assign(r1.interfaces.find((i) => i.name === 'G0/1'), { ndOther: true, dhcp6Server: 'VLAN20' });
  Object.assign(dev(doc, 'srv').config, { services: { dns: { enabled: true, records: [{ name: 'www.lan', ip: '2001:db8:acad:30::10' }] } } });
  const live = withLeases(doc);
  const pc1 = dev(live, 'pc1').config.slaac6;
  // M=1 : première adresse libre du pool (::1 est déjà celle de R1)
  assert.deepEqual([pc1.how, pc1.ip, pc1.gateway, pc1.dns], ['dhcp6', '2001:db8:acad:10::2', 'fe80::1', '2001:db8:acad:30::10']);
  // O=1 : SLAAC + DNS
  const pc3 = dev(live, 'pc3').config.slaac6;
  assert.equal(pc3.how, 'slaac');
  assert.match(pc3.ip, /^2001:db8:acad:20:2e0:f7ff:fe/);
  assert.equal(pc3.dns, '2001:db8:acad:30::10');
  // Le DNS reçu par DHCPv6 sert vraiment (requête DNS en IPv6)
  const r = resolveName(doc, 'pc3', 'www.lan');
  assert.equal(r.ok, true);
  assert.ok(r.query.frames.some((f) => f.layers.some((l) => l.name === 'IPv6')));
  assert.deepEqual(validate(doc).filter((i) => /DHCPv6|DNS/.test(i.text)), []);
  // M=1 sans serveur : pas d'adresse, raison donnée ; contrôle côté routeur
  const bad = structuredClone(doc);
  delete dev(bad, 'r1').config.interfaces.find((i) => i.name === 'G0/0').dhcp6Server;
  assert.match(dev(withLeases(bad), 'pc1').config.slaacError, /R1 G0\/0 annonce M=1 \(adresse par DHCPv6\) mais n'a pas de serveur DHCPv6/);
  assert.ok(validate(bad).some((i) => /R1 G0\/0 : le drapeau M est annoncé mais aucun serveur DHCPv6/.test(i.text)));
  // Terminal IOS : même config, show ipv6 dhcp binding
  const blank = structuredClone(IPV6_DEMO);
  const t = await terminal(blank, 'r1');
  t.run('enable', 'configure terminal', 'ipv6 dhcp pool VLAN10', 'address prefix 2001:db8:acad:10::/64 lifetime 172800 86400', 'dns-server 2001:db8:acad:30::10', 'exit',
    'interface g0/0', 'ipv6 nd managed-config-flag', 'ipv6 dhcp server VLAN10', 'end');
  assert.deepEqual(dev(t.doc, 'r1').config.dhcp6Pools, { VLAN10: r1.dhcp6Pools.VLAN10 });
  assert.match(t.run('show ipv6 dhcp binding'), /Client: PC Compta\n  Interface : GigabitEthernet0\/0[\s\S]*Address: 2001:DB8:ACAD:10::2/);
  assert.match(t.run('show ipv6 dhcp pool'), /DHCPv6 pool: VLAN10\n  Address allocation prefix: 2001:DB8:ACAD:10::\/64[^\n]*\(1 in use/);
  const run = t.run('show running-config');
  assert.match(run, /ipv6 dhcp pool VLAN10\n address prefix 2001:DB8:ACAD:10::\/64\n dns-server 2001:DB8:ACAD:30::10/);
  assert.match(run, / ipv6 nd managed-config-flag\n ipv6 dhcp server VLAN10/);
  const { importConfig } = await import('../cli/import.js');
  const fresh = structuredClone(IPV6_DEMO);
  const back = importConfig(dev(fresh, 'r1'), fresh, run).device.config;
  assert.deepEqual(back.dhcp6Pools, dev(t.doc, 'r1').config.dhcp6Pools);
  assert.equal(back.interfaces.find((i) => i.name === 'G0/0').dhcp6Server, 'VLAN10');
});
