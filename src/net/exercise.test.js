import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, OSPF_DEMO, TP_INTERVLAN, TP_OSPF } from '../examples.js';
import { evaluateExercise, hintFor } from './exercise.js';

const status = (doc) => evaluateExercise(doc).map((r) => r.ok);
const withExercise = (doc, exercise) => ({ ...structuredClone(doc), exercise });

test('TP inter-VLAN : tout échoue au départ, tout passe une fois réparé', () => {
  assert.deepEqual(status(TP_INTERVLAN), [false, false, false, false]);
  assert.deepEqual(status(withExercise(DEMO, TP_INTERVLAN.exercise)), [true, true, true, true]);
});

test('TP inter-VLAN : indices progressifs', () => {
  const [r1, r2] = evaluateExercise(TP_INTERVLAN);
  assert.match(hintFor(r1, 1, TP_INTERVLAN), /pas encore atteint/);
  assert.equal(hintFor(r1, 2, TP_INTERVLAN), 'Regarde du côté de R1.');
  assert.match(hintFor(r1, 3, TP_INTERVLAN), /R1 : .*/);
  assert.equal(hintFor(r2, 2, TP_INTERVLAN), 'Regarde du côté de PC Atelier.');
  assert.match(hintFor(r2, 3, TP_INTERVLAN), /PC Atelier : pas de réponse ARP.*192\.168\.20\.254/);
  assert.equal(r1.text, 'PC Compta ping 192.168.20.10');
});

test('TP inter-VLAN : réparer une panne fait passer les objectifs concernés', () => {
  const doc = structuredClone(TP_INTERVLAN);
  doc.devices.find((d) => d.id === 'sw1').config.ports.find((p) => p.name === 'Fa0/24').vlan = 20;
  doc.devices.find((d) => d.id === 'pc3').config.gateway = '192.168.20.1';
  // inter-VLAN réparé ; le serveur et Internet restent injoignables (route de retour sur R2)
  assert.deepEqual(status(doc), [true, false, false, false]);
});

test('TP OSPF : pannes détectées, explications, solution', () => {
  const res = evaluateExercise(TP_OSPF);
  assert.deepEqual(res.map((r) => r.ok), [false, false, false, false]);
  assert.match(hintFor(res[0], 3, TP_OSPF), /zones différentes \(0 et 1\)/);
  assert.match(hintFor(res[1], 3, TP_OSPF), /passive/);
  assert.deepEqual(status(withExercise(OSPF_DEMO, TP_OSPF.exercise)), [true, true, true, true]);
});

test('objectifs : ping qui doit échouer, DHCP, BGP, route, paramètres incomplets', () => {
  const ex = { objectives: [
    { id: 'a', type: 'noPing', from: 'pc1', to: '192.168.10.11' },
    { id: 'b', type: 'route', router: 'r1', to: '10.0.0.0/8' },
    { id: 'c', type: 'route', router: 'r1', to: '172.16.0.10' },
    { id: 'd', type: 'dhcp', host: 'pc1' },
    { id: 'e', type: 'bgp', router: 'r1', neighbor: '10.0.0.2' },
    { id: 'f', type: 'ping' },
  ] };
  const res = evaluateExercise(withExercise(DEMO, ex));
  assert.deepEqual(res.map((r) => r.ok), [false, false, true, false, false, false]);
  assert.match(res[0].why, /joint encore 192\.168\.10\.11/);
  assert.match(res[3].why, /n'est pas configuré en DHCP/);
  assert.match(res[4].why, /n'a pas de « neighbor 10\.0\.0\.2 »/);
});
