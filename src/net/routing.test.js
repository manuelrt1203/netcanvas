import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BGP_DEMO, DEMO, OSPF_DEMO } from '../examples.js';
import { classful, computeRouting, prefixText, wildcardToCidr } from './routing.js';
import { simulatePing } from './simulate.js';
import { validate } from './validate.js';

const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const lastError = (r) => r.log.findLast((l) => l.level === 'error')?.text ?? '';
// Table d'un routeur sous forme lisible : « O IA 172.16.3.0/24 [110/3] via 10.0.12.2 »
const table = (doc, id) => [...computeRouting(doc).ribs.get(id).values()]
  .filter((r) => r.proto !== 'C' && r.proto !== 'L')
  .map((r) => `${r.proto} ${prefixText(r.net, r.mask)} [${r.ad}/${r.metric}] via ${r.nextHop}`)
  .sort();
const issues = (doc) => computeRouting(doc).issues.map((i) => i.text).join('\n');

test('outils : wildcard et réseau par classe', () => {
  assert.equal(wildcardToCidr('0.0.0.255'), 24);
  assert.equal(wildcardToCidr('0.0.0.3'), 30);
  assert.equal(wildcardToCidr('0.255.0.255'), null);
  assert.deepEqual(classful('10.1.2.3'), { net: 0x0a000000, mask: 8 });
  assert.deepEqual(classful('172.16.5.1'), { net: 0xac100000, mask: 16 });
  assert.deepEqual(classful('192.168.1.7'), { net: 0xc0a80100, mask: 24 });
});

test('statique seule : la démo historique fonctionne toujours', () => {
  assert.deepEqual(table(DEMO, 'r1'), ['S* 0.0.0.0/0 [1/0] via 10.0.0.2']);
  assert.ok(simulatePing(DEMO, 'pc1', '172.16.0.10').ok);
});

// === OSPF ===========================================================================
test('ospf : intra-zone, inter-zones, externe par défaut (E2)', () => {
  assert.deepEqual(table(OSPF_DEMO, 'r1'), [
    'O IA 10.0.23.0/30 [110/2] via 10.0.12.2',
    'O IA 172.16.3.0/24 [110/3] via 10.0.12.2',
    'O IA 2.2.2.2/32 [110/2] via 10.0.12.2',
    'O IA 3.3.3.3/32 [110/3] via 10.0.12.2',
    'O*E2 0.0.0.0/0 [110/1] via 10.0.12.2',
  ]);
  assert.ok(table(OSPF_DEMO, 'r2').includes('O 192.168.1.0/24 [110/2] via 10.0.12.1'));
  assert.equal(issues(OSPF_DEMO), '');
  const r = simulatePing(OSPF_DEMO, 'pc1', '172.16.3.10');
  assert.ok(r.ok, lastError(r));
  assert.ok(r.log.some((l) => l.text === 'R1 : route OSPF inter-zones 172.16.3.0/24 via 10.0.12.2 (G0/1), coût 3.'));
  assert.ok(simulatePing(OSPF_DEMO, 'pc1', '203.0.113.2').ok);
});

test('ospf : voisins, DR et router-id', () => {
  const rt = computeRouting(OSPF_DEMO);
  const r2 = rt.routers.get('r2').ospf;
  assert.equal(r2.routerId, '2.2.2.2'); // plus grande loopback
  assert.deepEqual(r2.neighbors.map((n) => [n.peer.id, n.area, n.role]), [['r1', 1, 'BDR'], ['r3', 0, 'DR']]);
  assert.equal(rt.routers.get('r3').ospf.routerId, '3.3.3.3'); // router-id configuré
});

test('ospf : le coût suit la bande passante (série = 64, « ip ospf cost »)', () => {
  const doc = structuredClone(OSPF_DEMO);
  dev(doc, 'r2').config.interfaces.find((i) => i.name === 'G0/1').bandwidth = 1544;
  assert.ok(table(doc, 'r2').includes('O 172.16.3.0/24 [110/65] via 10.0.23.2'));
  dev(doc, 'r2').config.interfaces.find((i) => i.name === 'G0/1').ospfCost = 10;
  assert.ok(table(doc, 'r2').includes('O 172.16.3.0/24 [110/11] via 10.0.23.2'));
});

test('ospf : zones différentes, pas d\'adjacence, explication dans le ping', () => {
  const doc = structuredClone(OSPF_DEMO);
  dev(doc, 'r1').config.ospf.networks[1].area = 0;
  assert.match(issues(doc), /OSPF : pas d'adjacence R1 G0\/1 ↔ R2 \(ABR\) G0\/0 : zones différentes \(0 et 1\)\./);
  const r = simulatePing(doc, 'pc1', '172.16.3.10');
  assert.ok(!r.ok);
  assert.match(lastError(r), /R1 : aucune route vers 172\.16\.3\.10 .*Piste : OSPF : pas d'adjacence R1 G0\/1 ↔ R2 \(ABR\) G0\/0 : zones différentes/);
  assert.match(validate(doc).map((i) => i.text).join('\n'), /zones différentes/);
});

test('ospf : passive-interface, network manquant, router-id en double', () => {
  const passive = structuredClone(OSPF_DEMO);
  dev(passive, 'r2').config.ospf.passive = ['G0/0'];
  assert.match(issues(passive), /pas d'adjacence R1 G0\/1 ↔ R2 \(ABR\) G0\/0 : G0\/0 de R2 \(ABR\) est passive/);

  const missing = structuredClone(OSPF_DEMO);
  dev(missing, 'r2').config.ospf.networks.shift();
  assert.match(issues(missing), /G0\/0 de R2 \(ABR\) n'est couverte par aucune commande « network »/);

  const dup = structuredClone(OSPF_DEMO);
  dev(dup, 'r2').config.ospf.routerId = '1.1.1.1';
  assert.match(issues(dup), /router-id 1\.1\.1\.1 en double \(R1, R2 \(ABR\)\)/);
});

test('ospf : une zone qui ne touche pas la zone 0 reste isolée', () => {
  const doc = structuredClone(OSPF_DEMO);
  // R2 n'a plus d'interface en zone 0 : la zone 1 et la zone 2 ne s'échangent rien
  dev(doc, 'r2').config.ospf.networks = [{ network: '10.0.12.0', wildcard: '0.0.0.3', area: 1 }, { network: '10.0.23.0', wildcard: '0.0.0.3', area: 2 }];
  for (const n of dev(doc, 'r3').config.ospf.networks) n.area = 2;
  assert.ok(!table(doc, 'r1').some((r) => r.includes('172.16.3.0')));
  assert.ok(table(doc, 'r2').includes('O 172.16.3.0/24 [110/2] via 10.0.23.2')); // l'ABR, lui, a les deux zones
});

test('ospf : default-information originate sans route par défaut', () => {
  const doc = structuredClone(OSPF_DEMO);
  dev(doc, 'r3').config.routes = [];
  assert.ok(!table(doc, 'r1').some((r) => r.startsWith('O*E2')));
  assert.match(issues(doc), /« default-information originate » sans route par défaut/);
  dev(doc, 'r3').config.ospf.defaultOriginate = 'always';
  assert.ok(table(doc, 'r1').includes('O*E2 0.0.0.0/0 [110/1] via 10.0.12.2'));
});

test('ospf : redistribute static -> E2 20', () => {
  const doc = structuredClone(OSPF_DEMO);
  dev(doc, 'r3').config.routes.push({ network: '198.51.100.0', mask: 24, nextHop: '203.0.113.2' });
  dev(doc, 'r3').config.ospf.redistribute = { static: true };
  assert.ok(table(doc, 'r1').includes('O E2 198.51.100.0/24 [110/20] via 10.0.12.2'));
});

// === RIP ============================================================================
function ripChain() {
  const doc = structuredClone(OSPF_DEMO);
  for (const id of ['r1', 'r2', 'r3']) {
    delete dev(doc, id).config.ospf;
    dev(doc, id).config.rip = { version: 2, networks: ['192.168.1.0', '10.0.0.0', '172.16.0.0'] };
  }
  dev(doc, 'r3').config.rip.defaultOriginate = true;
  return doc;
}

test('rip : nombre de sauts, route par défaut, ping', () => {
  const doc = ripChain();
  assert.deepEqual(table(doc, 'r1'), [
    'R 10.0.23.0/30 [120/1] via 10.0.12.2',
    'R 172.16.3.0/24 [120/2] via 10.0.12.2',
    'R* 0.0.0.0/0 [120/2] via 10.0.12.2',
  ]);
  assert.ok(simulatePing(doc, 'pc1', '172.16.3.10').ok);
  assert.ok(simulatePing(doc, 'pc1', '203.0.113.2').ok);
});

test('rip : passive, version différente, version 1', () => {
  const passive = ripChain();
  dev(passive, 'r2').config.rip.passive = ['G0/1'];
  assert.ok(!table(passive, 'r3').some((r) => r.includes('192.168.1.0')));
  assert.match(issues(passive), /RIP : R2 \(ABR\) G0\/1 → R3 MikroTik ether1 : rien n'est envoyé, G0\/1 est passive/);

  const version = ripChain();
  dev(version, 'r1').config.rip.version = 1;
  assert.match(issues(version), /versions différentes \(1 et 2\)/);
  assert.match(issues(version), /RIP version 1 n'envoie pas les masques/);
});

test('distance administrative : OSPF (110) préféré à RIP (120)', () => {
  const doc = structuredClone(OSPF_DEMO);
  for (const id of ['r1', 'r2', 'r3']) dev(doc, id).config.rip = { version: 2, networks: ['192.168.1.0', '10.0.0.0', '172.16.0.0'] };
  assert.ok(table(doc, 'r1').includes('O IA 172.16.3.0/24 [110/3] via 10.0.12.2'));
  assert.ok(!table(doc, 'r1').some((r) => r.startsWith('R ')));
});

// === BGP ============================================================================
test('bgp : eBGP + iBGP entre loopbacks, next-hop-self, ping de bout en bout', () => {
  const rt = computeRouting(BGP_DEMO);
  assert.deepEqual(rt.routers.get('r2').bgp.sessions.map((s) => [s.neighbor, s.state]), [['1.1.1.1', 'Established'], ['10.0.23.2', 'Established']]);
  assert.deepEqual(table(BGP_DEMO, 'r1'), ['B 172.16.0.0/24 [200/0] via 2.2.2.2', 'O 2.2.2.2/32 [110/2] via 10.0.12.2']);
  assert.ok(table(BGP_DEMO, 'r2').includes('B 172.16.0.0/24 [20/0] via 10.0.23.2'));
  assert.deepEqual(table(BGP_DEMO, 'r3'), ['B 192.168.1.0/24 [20/0] via 10.0.23.1']);
  const r = simulatePing(BGP_DEMO, 'pc1', '172.16.0.10');
  assert.ok(r.ok, lastError(r));
  assert.ok(r.log.some((l) => /R1 \(AS 65001\) : route BGP 172\.16\.0\.0\/24 via 2\.2\.2\.2 \(G0\/1\), AS_PATH 65002, next-hop 2\.2\.2\.2 résolu par route OSPF via 10\.0\.12\.2/.test(l.text)));
  assert.equal(issues(BGP_DEMO), '');
});

test('bgp : update-source oublié, la session iBGP ne monte pas', () => {
  const doc = structuredClone(BGP_DEMO);
  delete dev(doc, 'r1').config.bgp.neighbors[0].updateSource;
  assert.match(issues(doc), /BGP : session R1 \(AS 65001\) → 2\.2\.2\.2 \(AS 65001\) down : R2 \(AS 65001\) attend R1 \(AS 65001\) sur 1\.1\.1\.1, mais la session part de 10\.0\.12\.1 : ajoute « neighbor 2\.2\.2\.2 update-source Lo0 » sur R1/);
  assert.ok(!simulatePing(doc, 'pc1', '172.16.0.10').ok);
});

test('bgp : sans next-hop-self, le next-hop externe est injoignable en iBGP', () => {
  const doc = structuredClone(BGP_DEMO);
  delete dev(doc, 'r2').config.bgp.neighbors[0].nextHopSelf;
  const rt = computeRouting(doc);
  const path = rt.routers.get('r1').bgp.table.get(`${0xac100000}/24`)[0];
  assert.equal(path.nextHop, '10.0.23.2');
  assert.equal(path.valid, false);
  assert.match(issues(doc), /R1 \(AS 65001\) reçoit 172\.16\.0\.0\/24 avec le next-hop 10\.0\.23\.2, injoignable.*next-hop-self/);
  const r = simulatePing(doc, 'pc1', '172.16.0.10');
  assert.match(lastError(r), /aucune route vers 172\.16\.0\.10/);
});

test('bgp : remote-as faux, eBGP non direct, network absent de la table', () => {
  const wrongAs = structuredClone(BGP_DEMO);
  dev(wrongAs, 'r3').config.bgp.neighbors[0].remoteAs = 65009;
  assert.match(issues(wrongAs), /« remote-as 65009 » mais R2 \(AS 65001\) est dans l'AS 65001/);

  const multihop = structuredClone(BGP_DEMO);
  dev(multihop, 'r3').config.routes = [{ network: '2.2.2.2', mask: 32, nextHop: '10.0.23.1' }];
  dev(multihop, 'r3').config.bgp.neighbors[0].ip = '2.2.2.2';
  assert.match(issues(multihop), /eBGP vers 2\.2\.2\.2, qui n'est pas directement connecté : ajoute « neighbor 2\.2\.2\.2 ebgp-multihop 2 »/);

  const noRoute = structuredClone(BGP_DEMO);
  dev(noRoute, 'r3').config.bgp.networks = [{ network: '172.16.0.0', mask: 16 }];
  assert.match(issues(noRoute), /R3 MikroTik \(AS 65002\) n'annonce pas 172\.16\.0\.0\/16 : cette route exacte n'est pas dans sa table/);
});

test('bgp : pas de relais iBGP vers iBGP (full mesh nécessaire)', () => {
  const doc = structuredClone(BGP_DEMO);
  // R4 dans l'AS 65001, en iBGP avec R1 seulement : il n'apprend pas ce que R1 tient de R2 en iBGP
  doc.devices.push({ id: 'r4', type: 'router', model: '2911', label: 'R4', position: { x: 0, y: 0 }, modules: {},
    config: { interfaces: [{ link: 'b7', name: 'G0/0', ip: '10.0.14.2', mask: 30 }], routes: [],
      bgp: { asn: 65001, neighbors: [{ ip: '10.0.14.1', remoteAs: 65001 }] } } });
  dev(doc, 'r1').config.interfaces.push({ link: 'b7', name: 'G0/2', ip: '10.0.14.1', mask: 30 });
  dev(doc, 'r1').config.bgp.neighbors.push({ ip: '10.0.14.2', remoteAs: 65001 });
  doc.links.push({ id: 'b7', source: 'r1', target: 'r4', cable: 'cross', sourceIface: 'G0/2', targetIface: 'G0/0' });
  const r4 = table(doc, 'r4');
  assert.ok(r4.some((r) => r.startsWith('B 192.168.1.0/24'))); // annoncé par R1 lui-même
  assert.ok(!r4.some((r) => r.includes('172.16.0.0'))); // appris en iBGP par R1 : non relayé
});

test('bgp : boucle d\'AS rejetée', () => {
  const doc = structuredClone(BGP_DEMO);
  dev(doc, 'r3').config.bgp.networks.push({ network: '10.0.23.0', mask: 30 });
  // R2 ne renvoie pas à R3 ce qui vient de l'AS 65002
  const r2 = computeRouting(doc).routers.get('r2').bgp;
  assert.ok(r2.table.has(`${0x0a001700}/30`));
  assert.ok(!computeRouting(doc).routers.get('r3').bgp.table.get(`${0x0a001700}/30`)?.some((p) => p.asPath.includes(65002)));
});

test('EIGRP : métrique composite (bande passante minimale + délais), adjacences et pannes expliquées', async () => {
  const { EIGRP_DEMO } = await import('../examples.js');
  const { simulatePing } = await import('./simulate.js');
  const { validate } = await import('./validate.js');
  const r = computeRouting(EIGRP_DEMO);
  const route = (id, p) => [...r.ribs.get(id).values()].find((x) => `${prefixText(x.net, x.mask)}` === p);
  // Valeurs d'un vrai IOS : détour Gigabit (3328) préféré à la série directe (2170112)
  const r1 = route('r1', '192.168.3.0/24');
  assert.deepEqual([r1.proto, r1.ad, r1.metric, r1.nextHop, r1.iface], ['D', 90, 3328, '10.0.12.2', 'G0/1']);
  assert.equal(route('r2', '10.0.13.0/30').metric, 2170112);
  assert.deepEqual(validate(EIGRP_DEMO).filter((i) => /EIGRP/.test(i.text)), []);
  const ping = simulatePing(EIGRP_DEMO, 'pc1', '192.168.3.10');
  assert.equal(ping.ok, true);
  assert.ok(ping.log.some((l) => l.text === 'R1 Siège : route EIGRP 192.168.3.0/24 via 10.0.12.2 (G0/1), métrique 3328.'));
  // R2 en panne (AS différent) : seule la série reste
  const doc = structuredClone(EIGRP_DEMO);
  doc.devices.find((d) => d.id === 'r2').config.eigrp.asn = 200;
  const r2 = computeRouting(doc);
  const via = [...r2.ribs.get('r1').values()].find((x) => prefixText(x.net, x.mask) === '192.168.3.0/24');
  assert.deepEqual([via.nextHop, via.metric], ['10.0.13.2', 2170112]); // 256 × (10⁷/1544 + 2000 + 1)
  assert.ok(validate(doc).some((i) => /EIGRP : pas de voisin R1 Siège G0\/1 ↔ R2 Transit G0\/0 : numéros d'AS différents \(100 et 200\)/.test(i.text)));
  // Délai augmenté sur un lien Gigabit : la métrique suit
  const slow = structuredClone(EIGRP_DEMO);
  slow.devices.find((d) => d.id === 'r1').config.interfaces.find((i) => i.name === 'G0/1').delay = 9000; // 256 × (10 + 9002) > 2170112
  const v = [...computeRouting(slow).ribs.get('r1').values()].find((x) => prefixText(x.net, x.mask) === '192.168.3.0/24');
  assert.equal(v.nextHop, '10.0.13.2', 'délai énorme sur G0/1 : la série redevient meilleure');
  // Redistribution d'une route statique : D EX, AD 170
  const ex = structuredClone(EIGRP_DEMO);
  const r3 = ex.devices.find((d) => d.id === 'r3').config;
  r3.routes = [{ network: '0.0.0.0', mask: 0, nextHop: '192.168.3.254' }];
  r3.eigrp.redistribute = { static: true };
  const def = computeRouting(ex).ribs.get('r1').get('0/0');
  assert.deepEqual([def.proto, def.ad], ['D EX', 170]);
});

test('EIGRP au terminal IOS : configuration, show, running-config et réimport', async () => {
  const { EIGRP_DEMO } = await import('../examples.js');
  const { runLine, shellFor } = await import('../cli/index.js');
  const { importConfig } = await import('../cli/import.js');
  let doc = structuredClone(EIGRP_DEMO);
  delete doc.devices.find((d) => d.id === 'r2').config.eigrp;
  const r2 = () => doc.devices.find((d) => d.id === 'r2');
  const shell = shellFor(r2());
  const s = shell.newSession();
  const run = (...lines) => lines.map((line) => {
    const res = runLine(shell, s, line, r2(), doc);
    if (res.device) doc = { ...doc, devices: doc.devices.map((d) => (d.id === 'r2' ? res.device : d)) };
    return res.output.join('\n');
  }).join('\n');
  run('enable', 'configure terminal', 'router eigrp 100', 'network 10.0.0.0', 'no auto-summary', 'end');
  assert.deepEqual(r2().config.eigrp, { asn: 100, networks: [{ network: '10.0.0.0' }] });
  assert.match(run('show ip eigrp neighbors'), /EIGRP-IPv4 Neighbors for AS\(100\)[\s\S]*0   10\.0\.12\.1\s+Gi0\/0[\s\S]*1   10\.0\.23\.2\s+Gi0\/1/);
  assert.match(run('show ip route eigrp'), /D    192\.168\.1\.0\/24 \[90\/3072\] via 10\.0\.12\.1/);
  assert.match(run('show ip eigrp topology'), /P 192\.168\.3\.0\/24, 1 successors, FD is 3072\n        via 10\.0\.23\.2 \(3072\/2816\), GigabitEthernet0\/1/);
  run('configure terminal', 'interface g0/1', 'delay 200', 'end');
  const conf = run('show running-config');
  assert.match(conf, /interface GigabitEthernet0\/1\n[^!]*delay 200/);
  assert.match(conf, /router eigrp 100\n network 10\.0\.0\.0\n no auto-summary/);
  const fresh = structuredClone(EIGRP_DEMO);
  delete fresh.devices.find((d) => d.id === 'r2').config.eigrp;
  const back = importConfig(fresh.devices.find((d) => d.id === 'r2'), fresh, conf).device.config;
  assert.deepEqual(back.eigrp, r2().config.eigrp);
  assert.equal(back.interfaces.find((i) => i.name === 'G0/1').delay, 200);
});
