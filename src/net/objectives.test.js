import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMPUS_DEMO, DEMO, EIGRP_DEMO, IPV6_DEMO, NAT_DEMO, SERVICES_DEMO, STP_DEMO } from '../examples.js';
import { evaluateExercise } from './exercise.js';

// Évalue un seul objectif sur un schéma
const run = (doc, objective) => evaluateExercise({ ...doc, exercise: { title: 't', instructions: '', objectives: [{ id: 'o1', ...objective }] } })[0];
const clone = (doc) => structuredClone(doc);

test('DNS : nom résolu, mauvaise adresse attendue, nom inconnu', () => {
  assert.equal(run(SERVICES_DEMO, { type: 'dns', from: 'pc1', name: 'www.entreprise.lan' }).ok, true);
  assert.equal(run(SERVICES_DEMO, { type: 'dns', from: 'pc1', name: 'www.entreprise.lan', expect: '172.16.0.10' }).ok, true);
  const wrong = run(SERVICES_DEMO, { type: 'dns', from: 'pc1', name: 'www.entreprise.lan', expect: '10.9.9.9' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /172\.16\.0\.10, pas en 10\.9\.9\.9/);
  const unknown = run(SERVICES_DEMO, { type: 'dns', from: 'pc1', name: 'absent.entreprise.lan' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.why, /NXDOMAIN/);
  assert.equal(run(SERVICES_DEMO, { type: 'dns', from: 'pc1' }).ok, false); // paramètre manquant : pas de plantage
});

test('Web : page accessible, ou non quand le service est arrêté', () => {
  assert.equal(run(SERVICES_DEMO, { type: 'web', from: 'pc1', target: 'www.entreprise.lan' }).ok, true);
  assert.equal(run(SERVICES_DEMO, { type: 'web', from: 'pc1', target: 'http://172.16.0.10/' }).ok, true);
  const doc = clone(SERVICES_DEMO);
  doc.devices.find((d) => d.id === 'srv').config.services.http.enabled = false;
  const r = run(doc, { type: 'web', from: 'pc1', target: 'www.entreprise.lan' });
  assert.equal(r.ok, false);
  assert.ok(r.why);
});

test('NAT : le ping doit être traduit', () => {
  assert.equal(run(NAT_DEMO, { type: 'nat', from: 'pc1', to: '198.51.100.10' }).ok, true);
  // Vers un serveur du même réseau : le ping passe, mais sans NAT
  const local = run(NAT_DEMO, { type: 'nat', from: 'pc1', to: '192.168.1.100' });
  assert.equal(local.ok, false);
  assert.match(local.why, /aucune traduction NAT/);
  // Sans règle NAT, Internet n'est plus joignable
  const doc = clone(NAT_DEMO);
  const r1 = doc.devices.find((d) => d.id === 'r1');
  delete r1.config.natRules; delete r1.config.nat;
  assert.equal(run(doc, { type: 'nat', from: 'pc1', to: '198.51.100.10' }).ok, false);
});

test('RIP : route apprise (ou absente quand RIP manque)', () => {
  const doc = clone(EIGRP_DEMO);
  for (const d of doc.devices.filter((x) => x.type === 'router')) {
    delete d.config.eigrp;
    d.config.rip = { version: 2, networks: ['10.0.0.0', '192.168.1.0', '192.168.3.0'] };
  }
  assert.equal(run(doc, { type: 'ripRoute', router: 'r1', to: '192.168.3.0/24' }).ok, true);
  assert.equal(run(doc, { type: 'ripRoute', router: 'r1', to: '192.168.9.0/24' }).ok, false);
  delete doc.devices.find((d) => d.id === 'r3').config.rip;
  const r = run(doc, { type: 'ripRoute', router: 'r1', to: '192.168.3.0/24' });
  assert.equal(r.ok, false);
  assert.equal(r.where, 'r1');
});

test('EIGRP : voisinage', () => {
  assert.equal(run(EIGRP_DEMO, { type: 'eigrp', a: 'r1', b: 'r2' }).ok, true);
  assert.equal(run(EIGRP_DEMO, { type: 'eigrp', a: 'r2', b: 'r3' }).ok, true);
  const doc = clone(EIGRP_DEMO);
  doc.devices.find((d) => d.id === 'r2').config.eigrp.asn = 200;
  const r = run(doc, { type: 'eigrp', a: 'r1', b: 'r2' });
  assert.equal(r.ok, false);
  assert.equal(r.where, 'r1');
});

test('IPv6 : route présente (un résumé ou une route par défaut compte)', () => {
  assert.equal(run(IPV6_DEMO, { type: 'route6', router: 'r2', to: '2001:db8:acad:30::/64' }).ok, true);
  assert.equal(run(IPV6_DEMO, { type: 'route6', router: 'r2', to: '2001:db8:acad:10::/64' }).ok, true); // couvert par le /48 statique
  assert.equal(run(IPV6_DEMO, { type: 'route6', router: 'r1', to: '2001:db8:bbbb::/64' }).ok, true); // route par défaut ::/0
  const none = run(IPV6_DEMO, { type: 'route6', router: 'r2', to: '2001:db8:bbbb::/64' });
  assert.equal(none.ok, false);
  assert.equal(none.where, 'r2');
  assert.equal(run(IPV6_DEMO, { type: 'route6', router: 'r2', to: 'pas-une-adresse' }).ok, false);
});

test('Spanning Tree : root et port bloqué', () => {
  assert.equal(run(STP_DEMO, { type: 'stpRoot', switch: 'sw1', vlan: '1' }).ok, true);
  const notRoot = run(STP_DEMO, { type: 'stpRoot', switch: 'sw2', vlan: '1' });
  assert.equal(notRoot.ok, false);
  assert.match(notRoot.why, /SW Cœur/);
  assert.equal(run(STP_DEMO, { type: 'stpBlocked', switch: 'sw3', vlan: '1' }).ok, true);
  assert.equal(run(STP_DEMO, { type: 'stpBlocked', switch: 'sw1', vlan: '1' }).ok, false);
});

test('EtherChannel, VTP et port-security (campus)', () => {
  assert.equal(run(CAMPUS_DEMO, { type: 'etherchannel', a: 'core', b: 'swa' }).ok, true);
  assert.equal(run(CAMPUS_DEMO, { type: 'etherchannel', a: 'core', b: 'swb' }).ok, false);
  assert.equal(run(CAMPUS_DEMO, { type: 'vtp', switch: 'swb', vlan: '20' }).ok, true);
  const noVtp = run(CAMPUS_DEMO, { type: 'vtp', switch: 'swb', vlan: '77' });
  assert.equal(noVtp.ok, false);
  assert.match(noVtp.why, /VLAN 77/);
  assert.equal(run(CAMPUS_DEMO, { type: 'portSecurity', switch: 'swa' }).ok, false);
  const doc = clone(CAMPUS_DEMO);
  for (const p of doc.devices.find((d) => d.id === 'swa').config.ports) if (p.ps?.enabled) p.ps = { ...p.ps, max: 0 };
  assert.equal(run(doc, { type: 'portSecurity', switch: 'swa' }).ok, true);
});

test('ACL appliquée', () => {
  assert.equal(run(NAT_DEMO, { type: 'acl', router: 'r1', name: '1' }).ok, false); // ACL 1 sert au NAT, pas à une interface
  const doc = clone(NAT_DEMO);
  const r1 = doc.devices.find((d) => d.id === 'r1');
  r1.config.interfaces = (r1.config.interfaces ?? []).concat([{ name: 'G0/0', aclIn: '1' }]);
  const res = run(doc, { type: 'acl', router: 'r1', name: '1' });
  assert.equal(res.ok, true);
  assert.equal(run(doc, { type: 'acl', router: 'r1', name: '99' }).ok, false);
});

test('chaque type est décrit et ses paramètres connus', async () => {
  const { OBJECTIVES } = await import('./exercise.js');
  for (const [type, def] of Object.entries(OBJECTIVES)) {
    assert.ok(def.label && typeof def.check === 'function' && typeof def.describe === 'function', type);
    for (const [, kind] of def.params) assert.ok(['device', 'router', 'ip', 'text'].includes(kind), `${type} : ${kind}`);
  }
  assert.equal(Object.keys(OBJECTIVES).length, 21);
  assert.ok(DEMO);
});

test('barème : un objectif peut valoir plus de points, la note suit les poids', async () => {
  const { gradeSubmission } = await import('../exam.js');
  const doc = structuredClone(NAT_DEMO);
  // 2 objectifs : un ping qui réussit (poids 3) et un autre qui échoue (poids 1) -> 3 points sur 4 = 15/20
  const exercise = { title: 't', instructions: '', objectives: [
    { id: 'a', type: 'ping', from: 'pc1', to: '198.51.100.10', weight: 3 },
    { id: 'b', type: 'ping', from: 'pc1', to: '203.0.113.99', weight: 1 },
  ] };
  const template = { ...doc, exercise, settings: { duration: 60 } };
  const g = gradeSubmission({ student: 'Alice', doc, started_at: '2026-10-22T08:00:00Z', submitted_at: '2026-10-22T08:30:00Z' }, template);
  assert.deepEqual([g.score, g.total, g.points, g.max, g.note], [1, 2, 3, 4, 15]);
  assert.deepEqual(g.results.map((r) => r.weight), [3, 1]);
  const { gradesCsv } = await import('../exam.js');
  const csv = gradesCsv('T', [g]);
  assert.match(csv, /Durée \(min\);O1 \(×3\);O2\r\n/);
  assert.match(csv, /;3;0\r\n$/);
});
