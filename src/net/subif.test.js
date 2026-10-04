import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROAS_DEMO } from '../examples.js';
import { simulatePing } from './simulate.js';
import { validate } from './validate.js';
import { computeRouting, prefixText } from './routing.js';

const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const lastError = (r) => r.log.findLast((l) => l.level === 'error')?.text ?? '';
const sub = (doc, name) => dev(doc, 'r1').config.interfaces.find((i) => i.name === name);

test('router-on-a-stick : routage inter-VLAN par un seul trunk', () => {
  const r = simulatePing(ROAS_DEMO, 'pc1', '192.168.20.10');
  assert.ok(r.ok, lastError(r));
  // PC1 -> SW1 -> R1 (trunk) -> SW1 (trunk) -> PC2
  assert.deepEqual(r.hops.filter((h) => h.phase === 'request').map((h) => h.edge), ['c1', 'c3', 'c3', 'c2']);
  assert.ok(r.log.some((l) => l.text === 'R1 : 192.168.20.0/24 est connecté sur G0/0.20.'));
  assert.deepEqual(validate(ROAS_DEMO), []);
  const rib = [...computeRouting(ROAS_DEMO).ribs.get('r1').values()].filter((x) => x.proto === 'C').map((x) => `${prefixText(x.net, x.mask)} ${x.iface}`);
  assert.deepEqual(rib.sort(), ['192.168.10.0/24 G0/0.10', '192.168.20.0/24 G0/0.20']);
});

test('router-on-a-stick : mauvais VLAN sur la sous-interface', () => {
  const doc = structuredClone(ROAS_DEMO);
  sub(doc, 'G0/0.20').vlan = 30;
  const r = simulatePing(doc, 'pc2', '192.168.20.1');
  assert.ok(!r.ok);
  assert.match(lastError(r), /pas de réponse ARP.*R1 n'a pas de sous-interface pour le VLAN 20 sur G0\/0/);
});

test('router-on-a-stick : port du switch en access au lieu de trunk', () => {
  const doc = structuredClone(ROAS_DEMO);
  dev(doc, 'sw1').config.ports[2] = { link: 'c3', name: 'G0/1', mode: 'access', vlan: 1 };
  const r = simulatePing(doc, 'pc1', '192.168.20.10');
  assert.ok(!r.ok);
  assert.match(lastError(r), /pas de réponse ARP/);
});

test('router-on-a-stick : sous-interface en shutdown', () => {
  const doc = structuredClone(ROAS_DEMO);
  sub(doc, 'G0/0.20').shutdown = true;
  assert.match(lastError(simulatePing(doc, 'pc1', '192.168.20.10')), /192\.168\.20\.0\/24 est sur G0\/0\.20, mais l'interface est down\. R1 G0\/0\.20 est désactivée \(shutdown\)\./);
});

test('router-on-a-stick : contrôles (VLAN en double, IP en double)', () => {
  const doc = structuredClone(ROAS_DEMO);
  sub(doc, 'G0/0.20').vlan = 10;
  sub(doc, 'G0/0.20').ip = '192.168.10.1';
  const texts = validate(doc).map((i) => i.text).join('\n');
  assert.match(texts, /G0\/0\.10 et G0\/0\.20 utilisent le même VLAN 10 sur G0\/0/);
  assert.match(texts, /Adresse 192\.168\.10\.1 en double/);
});
