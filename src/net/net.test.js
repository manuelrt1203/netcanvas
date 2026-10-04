import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO } from '../examples.js';
import { simulatePing } from './simulate.js';
import { validate } from './validate.js';
import { cidrToMask, isBroadcastAddress, isNetworkAddress, networkLabel, parseIp, splitCidr } from './ip.js';

const clone = () => structuredClone(DEMO);
const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const lastError = (r) => r.log.findLast((l) => l.level === 'error')?.text ?? '';

test('ip : parsing et calculs de réseau', () => {
  assert.equal(parseIp('192.168.1.10'), 0xc0a8010a);
  assert.equal(parseIp('256.1.1.1'), null);
  assert.equal(parseIp('01.1.1.1'), null);
  assert.equal(networkLabel('192.168.1.130', 25), '192.168.1.128/25');
  assert.equal(cidrToMask(20), '255.255.240.0');
  assert.equal(cidrToMask(0), '0.0.0.0');
  assert.ok(isNetworkAddress('10.0.0.0', 30));
  assert.ok(isBroadcastAddress('10.0.0.3', 30));
  assert.ok(!isBroadcastAddress('10.0.0.1', 31));
  assert.deepEqual(splitCidr('172.16.0.10/24'), { ip: '172.16.0.10', cidr: 24 });
});

test('le schéma de démo est valide', () => {
  assert.deepEqual(validate(clone()), []);
});

test('ping dans le même VLAN : uniquement via le switch', () => {
  const r = simulatePing(clone(), 'pc1', '192.168.10.11');
  assert.ok(r.ok, lastError(r));
  assert.deepEqual(r.hops.filter((h) => h.phase === 'request').map((h) => h.edge), ['l1', 'l2']);
});

test('ping inter-VLAN via R1', () => {
  const r = simulatePing(clone(), 'pc1', '192.168.20.10');
  assert.ok(r.ok, lastError(r));
  assert.deepEqual(r.hops.filter((h) => h.phase === 'request').map((h) => h.edge), ['l1', 'l4', 'l5', 'l3']);
});

test('ping vers le serveur : 2 routeurs, routes statiques, TTL 62', () => {
  const r = simulatePing(clone(), 'pc1', '172.16.0.10');
  assert.ok(r.ok, lastError(r));
  assert.match(r.log.at(-1).text, /TTL 62/);
  assert.deepEqual(r.hops.filter((h) => h.phase === 'reply').map((h) => h.edge), ['l8', 'l7', 'l6', 'l4', 'l1']);
});

test('route de retour manquante sur R2 : la requête passe, la réponse échoue', () => {
  const doc = clone();
  dev(doc, 'r2').config.routes = [];
  const r = simulatePing(doc, 'pc1', '172.16.0.10');
  assert.ok(!r.ok);
  assert.equal(r.failedAt, 'r2');
  assert.equal(r.log.at(-1).phase, 'reply');
  assert.match(lastError(r), /aucune route vers 192\.168\.10\.10/);
});

test('mauvais VLAN : la passerelle ne répond pas à l’ARP', () => {
  const doc = clone();
  dev(doc, 'sw1').config.ports.find((p) => p.link === 'l3').vlan = 10;
  const r = simulatePing(doc, 'pc3', '192.168.20.1');
  assert.ok(!r.ok);
  assert.match(lastError(r), /pas de réponse ARP.*VLAN 10/);
});

test('pas de passerelle : échec immédiat sur le PC', () => {
  const doc = clone();
  dev(doc, 'pc1').config.gateway = '';
  const r = simulatePing(doc, 'pc1', '172.16.0.10');
  assert.ok(!r.ok);
  assert.equal(r.failedAt, 'pc1');
  assert.equal(r.hops.length, 0);
});

test('boucle de routage : TTL expiré', () => {
  const doc = clone();
  dev(doc, 'r2').config.routes.push({ network: '0.0.0.0', mask: 0, nextHop: '10.0.0.1' });
  const r = simulatePing(doc, 'pc1', '8.8.8.8');
  assert.ok(!r.ok);
  assert.match(lastError(r), /TTL expiré/);
});

test('trunk entre deux switches : le VLAN 10 traverse', () => {
  const doc = clone();
  // On insère SW3 entre SW1 et PC Compta 2, relié à SW1 par un trunk
  doc.devices.push({ id: 'sw3', type: 'switch', label: 'SW3', position: { x: 0, y: 0 }, config: {
    ports: [{ link: 'l2', name: 'Fa0/1', mode: 'access', vlan: 10 }, { link: 'lt', name: 'G0/1', mode: 'trunk' }],
  } });
  doc.links.find((l) => l.id === 'l2').target = 'sw3';
  doc.links.push({ id: 'lt', source: 'sw3', target: 'sw1' });
  dev(doc, 'sw1').config.ports.find((p) => p.link === 'l2').link = 'lt';
  dev(doc, 'sw1').config.ports.find((p) => p.link === 'lt').mode = 'trunk';

  const ok = simulatePing(doc, 'pc2', '192.168.10.1');
  assert.ok(ok.ok, lastError(ok));
  assert.deepEqual(ok.hops.filter((h) => h.phase === 'request').map((h) => h.edge), ['l2', 'lt', 'l4']);

  // Si le port de SW1 repasse en access, la trame étiquetée est jetée
  dev(doc, 'sw1').config.ports.find((p) => p.link === 'lt').mode = 'access';
  const ko = simulatePing(doc, 'pc2', '192.168.10.1');
  assert.ok(!ko.ok);
  assert.match(lastError(ko), /jette une trame étiquetée VLAN 10/);
});

test('validation : IP en double et passerelle hors réseau', () => {
  const doc = clone();
  dev(doc, 'pc2').config.ip = '192.168.10.10';
  dev(doc, 'pc3').config.gateway = '192.168.10.1';
  const texts = validate(doc).map((i) => i.text).join('\n');
  assert.match(texts, /192\.168\.10\.10 en double/);
  assert.match(texts, /PC Atelier : la passerelle 192\.168\.10\.1 est hors du réseau/);
});

test('aller-retour JSON -> éditeur -> JSON sans perte', async () => {
  const { fromJSON, toJSON } = await import('../serialize.js');
  const loaded = fromJSON(clone());
  const back = toJSON(loaded.nodes, loaded.edges, loaded.name);
  assert.deepEqual(back, DEMO);
});

test('aller-retour JSON : le TP (consigne, objectifs) est conservé', async () => {
  const { fromJSON, toJSON } = await import('../serialize.js');
  const { TP_INTERVLAN } = await import('../examples.js');
  const loaded = fromJSON(structuredClone(TP_INTERVLAN));
  assert.deepEqual(toJSON(loaded.nodes, loaded.edges, loaded.name, null, loaded.exercise), TP_INTERVLAN);
});

test('aller-retour JSON -> éditeur -> JSON : démos OSPF et BGP (routage, loopbacks, coûts)', async () => {
  const { fromJSON, toJSON } = await import('../serialize.js');
  const { OSPF_DEMO, BGP_DEMO } = await import('../examples.js');
  for (const demo of [OSPF_DEMO, BGP_DEMO]) {
    const doc = structuredClone(demo);
    doc.devices.find((d) => d.id === 'r2').config.interfaces[1].ospfCost = 7;
    doc.devices.find((d) => d.id === 'r2').config.interfaces[1].bandwidth = 1544;
    const loaded = fromJSON(doc);
    const back = toJSON(loaded.nodes, loaded.edges, loaded.name);
    for (const d of doc.devices) {
      const b = back.devices.find((x) => x.id === d.id);
      assert.deepEqual(b.config.ospf, d.config.ospf, `${d.id} ospf`);
      assert.deepEqual(b.config.bgp, d.config.bgp, `${d.id} bgp`);
      if (d.type === 'router') {
        const sortByName = (l) => [...l].sort((x, y) => x.name.localeCompare(y.name));
        assert.deepEqual(sortByName(b.config.interfaces), sortByName(d.config.interfaces), `${d.id} interfaces`);
      }
    }
  }
});

test('import d’un fichier v1', async () => {
  const { fromJSON } = await import('../serialize.js');
  const v1 = { format: 'netcanvas', version: 1, name: 'x',
    devices: [{ id: 'a', type: 'pc', label: 'PC 1', ip: '10.0.0.1', mask: 24, position: { x: 0, y: 0 } }],
    links: [{ id: 'l', source: 'a', target: 'a', sourcePort: 't', targetPort: 'b' }] };
  const { nodes, edges } = fromJSON(v1);
  assert.equal(nodes[0].data.ip, '10.0.0.1');
  assert.equal(edges[0].sourceHandle, 't');
});
