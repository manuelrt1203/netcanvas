import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STP_DEMO, DEMO } from '../examples.js';
import { buildTopology } from './topology.js';
import { simulatePing } from './simulate.js';
import { validate } from './validate.js';
import { fromJSON, toJSON } from '../serialize.js';

const roles = (doc, vlan = 1) => Object.fromEntries([...buildTopology(doc).stp.vlans.get(vlan).ports]
  .filter(([, p]) => !/^Fa/.test(p.name)).map(([k, p]) => [k, `${p.role}/${p.state}`]));
const sw = (doc, id) => doc.devices.find((d) => d.id === id);

test('STP : root bridge par priorité, un seul port bloqué dans le triangle', () => {
  const t = buildTopology(STP_DEMO);
  const v1 = t.stp.vlans.get(1);
  assert.equal(v1.switches.get('sw1').isRoot, true);
  assert.equal(v1.switches.get('sw1').priority, 4097, '4096 + extension VLAN 1');
  assert.deepEqual(roles(STP_DEMO), {
    'sw1|a': 'designated/forwarding', 'sw1|c': 'designated/forwarding',
    'sw2|a': 'root/forwarding', 'sw2|b': 'designated/forwarding',
    'sw3|b': 'alternate/blocking', 'sw3|c': 'root/forwarding',
  });
  // Le voyant du câble SW Gauche – SW Droite est orange côté SW Droite
  assert.deepEqual(t.status.get('b').stpBlocked, [{ device: 'sw3', vlans: [1] }]);
  // Le ping passe par la racine (câble b bloqué)
  const r = simulatePing(STP_DEMO, 'pc1', '192.168.1.20');
  assert.equal(r.ok, true);
  assert.ok(!r.hops.some((h) => h.edge === 'b'));
});

test('STP : la priorité et le coût de port changent la racine et le port bloqué', () => {
  const doc = structuredClone(STP_DEMO);
  sw(doc, 'sw3').config.stp = { priority: { 1: 0 } };
  assert.equal(buildTopology(doc).stp.vlans.get(1).switches.get('sw3').isRoot, true);
  const r = roles(doc);
  assert.equal(Object.values(r).filter((x) => x.endsWith('blocking')).length, 1);
  assert.equal(r['sw3|b'], 'designated/forwarding');

  // Un coût élevé sur le port racine de SW Droite : il préfère passer par SW Gauche
  const cost = structuredClone(STP_DEMO);
  sw(cost, 'sw3').config.ports.find((p) => p.name === 'G0/2').stpCost = 100;
  const rc = roles(cost);
  assert.equal(rc['sw3|b'], 'root/forwarding');
  assert.equal(rc['sw3|c'], 'alternate/blocking');
});

test('STP désactivé : tempête de diffusion, erreur expliquée ; sans boucle, rien ne change', () => {
  const doc = structuredClone(STP_DEMO);
  for (const d of doc.devices.filter((x) => x.type === 'switch')) d.config.stp = { disabled: [1] };
  const r = simulatePing(doc, 'pc1', '192.168.1.20');
  assert.equal(r.ok, false);
  assert.match(r.log.at(-1).text, /^Tempête de diffusion dans le VLAN 1 : .*SW Cœur, SW Gauche, SW Droite/);
  assert.ok(validate(doc).some((i) => i.level === 'error' && /Boucle de switches sans STP dans le VLAN 1/.test(i.text)));
  // STP désactivé sur un seul switch : il relaie les BPDU comme des trames, les deux autres cassent la boucle
  const one = structuredClone(STP_DEMO);
  sw(one, 'sw2').config.stp = { disabled: [1] };
  const t1 = buildTopology(one);
  assert.deepEqual(t1.stp.storms, []);
  assert.equal([...t1.stp.vlans.get(1).ports.values()].filter((p) => p.state === 'blocking').length, 1);
  assert.equal(simulatePing(one, 'pc1', '192.168.1.20').ok, true);
  // Démo sans boucle : aucun port bloqué, aucune tempête
  const t = buildTopology(DEMO);
  assert.deepEqual(t.stp.storms, []);
  assert.ok([...t.stp.vlans.values()].every((v) => [...v.ports.values()].every((p) => p.state === 'forwarding')));
});

test('STP par VLAN (PVST+) : un VLAN en access ne forme pas de boucle', () => {
  const doc = structuredClone(STP_DEMO);
  // Le câble b passe en access VLAN 20 des deux côtés : la boucle n'existe plus dans le VLAN 1
  for (const id of ['sw2', 'sw3']) {
    const p = sw(doc, id).config.ports.find((x) => x.link === 'b');
    Object.assign(p, { mode: 'access', vlan: 20 });
  }
  const t = buildTopology(doc);
  assert.ok([...t.stp.vlans.get(1).ports.values()].every((p) => p.state === 'forwarding'));
  assert.ok(t.stp.vlans.has(20));
});

test("STP : config conservée par l'éditeur (JSON -> éditeur -> JSON)", () => {
  const doc = structuredClone(STP_DEMO);
  sw(doc, 'sw2').config.ports.find((p) => p.name === 'Fa0/1').portfast = true;
  sw(doc, 'sw2').config.ports.find((p) => p.name === 'G0/1').stpCost = 10;
  sw(doc, 'sw2').config.stp = { mode: 'rapid-pvst', disabled: [20], priority: { 1: 8192 } };
  const loaded = fromJSON(doc);
  const back = toJSON(loaded.nodes, loaded.edges, loaded.name);
  assert.deepEqual(sw(back, 'sw2').config.stp, sw(doc, 'sw2').config.stp);
  assert.deepEqual(sw(back, 'sw2').config.ports.find((p) => p.name === 'Fa0/1').portfast, true);
  assert.deepEqual(sw(back, 'sw2').config.ports.find((p) => p.name === 'G0/1').stpCost, 10);
});
