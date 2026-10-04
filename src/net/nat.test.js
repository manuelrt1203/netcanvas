import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAT_DEMO, OSPF_DEMO } from '../examples.js';
import { simulatePing } from './simulate.js';
import { validate } from './validate.js';

const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const iface = (doc, id, name) => dev(doc, id).config.interfaces.find((i) => i.name === name);
const texts = (r) => r.log.map((l) => l.text);
const lastError = (r) => r.log.findLast((l) => l.level === 'error')?.text ?? '';

test('PAT : le LAN privé sort par l\'adresse publique de R1, la réponse revient', () => {
  assert.deepEqual(validate(NAT_DEMO), []);
  const r = simulatePing(NAT_DEMO, 'pc1', '198.51.100.10');
  assert.ok(r.ok, lastError(r));
  assert.ok(texts(r).includes('R1 (box) : NAT, source 192.168.1.10 traduite en 203.0.113.1 (PAT (overload) sur G0/1, ACL 1).'));
  assert.ok(texts(r).includes('Serveur Internet : 203.0.113.1 est hors de son réseau 198.51.100.0/24, envoi à la passerelle 198.51.100.1.'));
  assert.ok(texts(r).includes('R1 (box) : NAT, destination 203.0.113.1 traduite en 192.168.1.10 (retour de la traduction 192.168.1.10 ↔ 203.0.113.1).'));
});

test('sans NAT : le FAI ne connaît pas l\'adresse privée, explication', () => {
  const doc = structuredClone(NAT_DEMO);
  delete iface(doc, 'r1', 'G0/0').natInside;
  const r = simulatePing(doc, 'pc1', '198.51.100.10');
  assert.ok(!r.ok);
  assert.equal(r.failedAt, 'isp');
  assert.match(lastError(r), /Routeur FAI : aucune route vers 192\.168\.1\.10 .*Piste : 192\.168\.1\.10 est une adresse privée : elle ne circule pas sur Internet\. Il faut la traduire \(NAT\/PAT\)/);
  assert.match(validate(doc).map((i) => i.text).join('\n'), /R1 \(box\) : NAT configuré mais aucune interface « ip nat inside »/);
});

test('NAT statique : le serveur local est joignable depuis Internet par 203.0.113.5', () => {
  const r = simulatePing(NAT_DEMO, 'srv', '203.0.113.5');
  assert.ok(r.ok, lastError(r));
  assert.ok(texts(r).includes('R1 (box) : NAT, destination 203.0.113.5 traduite en 192.168.1.100 (NAT statique 203.0.113.5 → 192.168.1.100).'));
  // Et il sort avec son adresse publique fixe
  const out = simulatePing(NAT_DEMO, 'web', '198.51.100.10');
  assert.ok(texts(out).includes('R1 (box) : NAT, source 192.168.1.100 traduite en 203.0.113.5 (NAT statique 192.168.1.100 → 203.0.113.5).'));
});

test('NAT : ACL qui ne couvre pas le LAN, ACL absente', () => {
  const doc = structuredClone(NAT_DEMO);
  dev(doc, 'r1').config.acls['1'].rules[0].src.ip = '192.168.2.0';
  assert.ok(!simulatePing(doc, 'pc1', '198.51.100.10').ok);
  delete dev(doc, 'r1').config.acls;
  assert.match(validate(doc).map((i) => i.text).join('\n'), /R1 \(box\) : la règle NAT utilise l'ACL 1, qui n'existe pas/);
});

test('mikrotik : masquerade vers Internet', () => {
  const doc = structuredClone(OSPF_DEMO);
  dev(doc, 'r3').config.natRules = [{ chain: 'srcnat', action: 'masquerade', outIface: 'ether3' }];
  const r = simulatePing(doc, 'pc1', '203.0.113.2');
  assert.ok(r.ok, lastError(r));
  assert.ok(texts(r).includes('R3 MikroTik : NAT, source 192.168.1.10 traduite en 203.0.113.1 (masquerade sur ether3).'));
});
