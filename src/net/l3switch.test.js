import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L3_DEMO } from '../examples.js';
import { simulatePing } from './simulate.js';
import { validate } from './validate.js';
import { traceroute } from './traceroute.js';
import { fromJSON, toJSON } from '../serialize.js';

const sw = (doc) => doc.devices.find((d) => d.id === 'sw');
const lastError = (r) => r.log.findLast((l) => l.level === 'error')?.text ?? '';

test('switch niveau 3 : routage inter-VLAN par les SVI', () => {
  assert.deepEqual(validate(L3_DEMO), []);
  const r = simulatePing(L3_DEMO, 'pc1', '192.168.30.10');
  assert.ok(r.ok, lastError(r));
  assert.ok(r.log.some((l) => l.text === 'SW-L3 : 192.168.30.0/24 est connecté sur Vlan30.'));
  // La trame entre et ressort par le switch, sans passer par R1
  assert.deepEqual(r.hops.filter((h) => h.phase === 'request').map((h) => h.edge), ['d1', 'd3']);
  assert.deepEqual(traceroute(L3_DEMO, 'pc1', '192.168.30.10').hops.map((h) => h.ip), ['192.168.10.1', '192.168.30.10']);
});

test('switch niveau 3 : route par défaut vers R1 puis Internet', () => {
  const r = simulatePing(L3_DEMO, 'pc2', '203.0.113.2');
  assert.ok(r.ok, lastError(r));
  assert.deepEqual(traceroute(L3_DEMO, 'pc2', '203.0.113.2').hops.map((h) => h.ip), ['192.168.20.1', '10.0.0.2', '203.0.113.2']);
});

test('switch niveau 3 : sans « ip routing », explication', () => {
  const doc = structuredClone(L3_DEMO);
  delete sw(doc).config.ipRouting;
  const r = simulatePing(doc, 'pc1', '192.168.30.10');
  assert.ok(!r.ok);
  assert.match(lastError(r), /SW-L3 reçoit un paquet pour 192\.168\.30\.10 mais le routage IP n'est pas activé \(« ip routing »\)/);
});

test('switch de niveau 2 avec des SVI : il ne route pas', () => {
  const doc = structuredClone(L3_DEMO);
  sw(doc).model = '2960-24TT';
  assert.match(lastError(simulatePing(doc, 'pc1', '192.168.30.10')), /ne route pas \(un 2960-24 est un switch de niveau 2/);
  // Mais il répond lui-même sur son interface VLAN (administration)
  assert.ok(simulatePing(doc, 'pc1', '192.168.10.1').ok);
});

test('SVI down : aucun port actif dans le VLAN', () => {
  const doc = structuredClone(L3_DEMO);
  sw(doc).config.ports.find((p) => p.name === 'Fa0/3').vlan = 10; // plus personne dans le VLAN 30
  assert.match(validate(doc).map((i) => i.text).join('\n'), /SW-L3 Vlan30 est down : aucun port actif n'est dans le VLAN 30\./);
  // Sans Vlan30, la route par défaut part vers R1, qui renvoie vers le switch : boucle
  assert.match(lastError(simulatePing(doc, 'pc1', '192.168.30.10')), /TTL expiré/);
  // Sans route par défaut, l'explication pointe la SVI down
  delete sw(doc).config.routes;
  assert.match(lastError(simulatePing(doc, 'pc1', '192.168.30.10')), /192\.168\.30\.0\/24 est sur Vlan30, mais l'interface est down\. Aucun port actif du switch n'est dans le VLAN 30\./);
});

test('switch de niveau 2 : administration par une SVI et ip default-gateway', () => {
  const doc = structuredClone(L3_DEMO);
  const s = sw(doc);
  s.model = '2960-24TT';
  delete s.config.ipRouting;
  s.config.interfaces = [{ link: null, name: 'Vlan10', ip: '192.168.10.2', mask: 24 }];
  doc.devices.find((d) => d.id === 'pc1').config.gateway = null;
  assert.match(lastError(simulatePing(doc, 'sw', '203.0.113.2')), /aucune passerelle par défaut \(« ip default-gateway »\)/);
});

test('switch niveau 3 : aller-retour JSON -> éditeur -> JSON', () => {
  const { nodes, edges, name } = fromJSON(structuredClone(L3_DEMO));
  const back = toJSON(nodes, edges, name);
  assert.deepEqual(back.devices.find((d) => d.id === 'sw').config, sw(L3_DEMO).config);
});
