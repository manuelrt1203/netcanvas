import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, OSPF_DEMO } from '../examples.js';
import { aclTypeOf, evaluateAcl, parseAclLine, parseFirewallRule, ruleText } from './acl.js';
import { simulatePing } from './simulate.js';

const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const iface = (doc, id, name) => dev(doc, id).config.interfaces.find((i) => i.name === name);
const lastError = (r) => r.log.findLast((l) => l.level === 'error')?.text ?? '';
const acl = (type, ...lines) => ({ type, rules: lines.map((l) => parseAclLine(l, type).rule) });

test('acl : lecture de la syntaxe IOS', () => {
  assert.equal(aclTypeOf('10'), 'standard');
  assert.equal(aclTypeOf('150'), 'extended');
  assert.equal(aclTypeOf('BLOQUE'), null);
  assert.deepEqual(parseAclLine('deny 192.168.1.0 0.0.0.255', 'standard').rule, { action: 'deny', src: { ip: '192.168.1.0', wildcard: '0.0.0.255' } });
  assert.deepEqual(parseAclLine('permit 10.0.0.5', 'standard').rule.src, { ip: '10.0.0.5', wildcard: '0.0.0.0' });
  const ext = parseAclLine('deny tcp 192.168.1.0 0.0.0.255 host 10.0.0.5 eq 80', 'extended').rule;
  assert.equal(ruleText(ext, 'extended'), 'deny tcp 192.168.1.0 0.0.0.255 host 10.0.0.5 eq 80');
  assert.equal(ruleText(parseAclLine('permit ip any any', 'extended').rule, 'extended'), 'permit ip any any');
  assert.match(parseAclLine('deny icmp 10.0.0.0 any', 'extended').error, /source : wildcard attendu après 10\.0\.0\.0/);
  assert.match(parseAclLine('bloque any', 'standard').error, /« permit » ou « deny » attendu/);
  assert.match(parseAclLine('deny gre any any', 'extended').error, /protocole attendu/);
});

test('acl : première correspondance, TCP ignoré pour un ping, refus implicite', () => {
  const a = acl('extended', 'deny tcp any any eq 80', 'deny icmp 192.168.1.0 0.0.0.255 host 10.0.0.5', 'permit ip any any');
  assert.deepEqual(evaluateAcl(a, { src: '192.168.1.7', dst: '10.0.0.5' }), { permit: false, line: 20, text: 'deny icmp 192.168.1.0 0.0.0.255 host 10.0.0.5' });
  assert.deepEqual(evaluateAcl(a, { src: '192.168.2.7', dst: '10.0.0.5' }), { permit: true, line: 30, text: 'permit ip any any' });
  assert.equal(evaluateAcl(acl('standard', 'permit host 1.1.1.1'), { src: '2.2.2.2', dst: '3.3.3.3' }).line, null);
});

test('acl standard en sortie : le VLAN 10 ne sort plus vers R2', () => {
  const doc = structuredClone(DEMO);
  dev(doc, 'r1').config.acls = { 10: acl('standard', 'deny 192.168.10.0 0.0.0.255', 'permit any') };
  iface(doc, 'r1', 'Se0/0/0').aclOut = '10';
  const r = simulatePing(doc, 'pc1', '172.16.0.10');
  assert.ok(!r.ok);
  assert.equal(r.failedAt, 'r1');
  assert.equal(lastError(r), 'R1 : paquet 192.168.10.10 → 172.16.0.10 (ICMP) refusé en sortie de Se0/0/0 par l\'ACL 10, ligne 10 « deny 192.168.10.0 0.0.0.255 ».');
  const ok = simulatePing(doc, 'pc3', '172.16.0.10');
  assert.ok(ok.ok, lastError(ok));
  assert.ok(ok.log.some((l) => l.text === 'R1 : ACL 10 en sortie de Se0/0/0 : autorisé (ligne 20 « permit any »).'));
});

test('acl étendue en entrée, refus implicite, ACL inexistante', () => {
  const doc = structuredClone(DEMO);
  dev(doc, 'r1').config.acls = { BLOQUE_SRV: acl('extended', 'deny icmp 192.168.10.0 0.0.0.255 host 172.16.0.10') };
  iface(doc, 'r1', 'G0/0').aclIn = 'BLOQUE_SRV';
  assert.match(lastError(simulatePing(doc, 'pc1', '172.16.0.10')), /refusé en entrée de G0\/0 par l'ACL BLOQUE_SRV, ligne 10/);
  // Pas de « permit » : tout le reste tombe sur le refus implicite
  assert.match(lastError(simulatePing(doc, 'pc1', '203.0.113.2')), /par l'ACL BLOQUE_SRV, refus implicite à la fin de la liste/);
  iface(doc, 'r1', 'G0/0').aclIn = '199';
  const r = simulatePing(doc, 'pc1', '172.16.0.10');
  assert.ok(r.ok);
  assert.ok(r.log.some((l) => /l'ACL 199 appliquée en entrée de G0\/0 n'existe pas : tout passe/.test(l.text)));
});

test('acl : la réponse peut être bloquée au retour', () => {
  const doc = structuredClone(DEMO);
  dev(doc, 'r1').config.acls = { 11: acl('standard', 'deny 172.16.0.0 0.0.0.255', 'permit any') };
  iface(doc, 'r1', 'Se0/0/0').aclIn = '11';
  const r = simulatePing(doc, 'pc1', '172.16.0.10');
  assert.ok(!r.ok);
  assert.equal(r.log.at(-1).phase, 'reply');
  assert.match(lastError(r), /172\.16\.0\.10 → 192\.168\.10\.10 \(ICMP\) refusé en entrée de Se0\/0\/0/);
});

test('acl : le trafic émis par le routeur ne passe pas par son ACL de sortie', () => {
  const doc = structuredClone(DEMO);
  dev(doc, 'r1').config.acls = { 12: acl('standard', 'deny any') };
  iface(doc, 'r1', 'Se0/0/0').aclOut = '12';
  assert.ok(simulatePing(doc, 'r1', '172.16.0.10').ok);
  assert.ok(!simulatePing(doc, 'pc1', '172.16.0.10').ok);
});

test('mikrotik : pare-feu chain=forward et chain=input', () => {
  assert.match(parseFirewallRule('chain=output action=drop').error, /chain=forward ou chain=input/);
  const doc = structuredClone(OSPF_DEMO);
  dev(doc, 'r3').config.firewall = [
    parseFirewallRule('chain=forward action=drop protocol=icmp src-address=192.168.1.0/24 dst-address=172.16.3.0/24').rule,
    parseFirewallRule('chain=input action=drop in-interface=ether1 dst-address=3.3.3.3').rule,
  ];
  assert.match(lastError(simulatePing(doc, 'pc1', '172.16.3.10')), /R3 MikroTik : paquet 192\.168\.1\.10 → 172\.16\.3\.10 \(ICMP\) bloqué par le pare-feu, règle 0 « chain=forward action=drop protocol=icmp src-address=192\.168\.1\.0\/24 dst-address=172\.16\.3\.0\/24 »/);
  assert.match(lastError(simulatePing(doc, 'pc1', '3.3.3.3')), /bloqué par le pare-feu, règle 1/);
  assert.ok(simulatePing(doc, 'pc1', '203.0.113.2').ok); // rien ne bloque Internet
});
