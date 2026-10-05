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
