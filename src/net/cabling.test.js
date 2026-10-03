import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO } from '../examples.js';
import { devicePorts } from './catalog.js';
import { autoCable, checkLink, expectedCopper, pickPorts } from './cabling.js';
import { simulatePing } from './simulate.js';
import { validate } from './validate.js';
import { upgrade } from '../serialize.js';

const clone = () => structuredClone(DEMO);
const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const link = (doc, id) => doc.links.find((l) => l.id === id);
const lastError = (r) => r.log.findLast((l) => l.level === 'error')?.text ?? '';
const names = (ports) => ports.map((p) => p.name);

test('catalogue : ports des modèles et des modules', () => {
  assert.deepEqual(names(devicePorts('2911')), ['G0/0', 'G0/1', 'G0/2', 'Console']);
  assert.deepEqual(names(devicePorts('1941', { 1: 'HWIC-2T' })), ['G0/0', 'G0/1', 'Se0/1/0', 'Se0/1/1', 'Console']);
  assert.deepEqual(names(devicePorts('ISR4321', { 2: 'NIM-1GE-CU-SFP' })), ['G0/0/0', 'G0/0/1', 'G0/2/0', 'Console']);
  // Module incompatible avec l'emplacement, ou emplacement inexistant : ignoré
  assert.deepEqual(names(devicePorts('2911', { 0: 'NIM-2T', 7: 'HWIC-2T' })), ['G0/0', 'G0/1', 'G0/2', 'Console']);
  assert.equal(devicePorts('2960-48TT').length, 51);
  assert.equal(devicePorts('PC-PT').find((p) => p.name === 'RS232').media, 'rs232');
});

test('câble droit ou croisé selon les équipements', () => {
  assert.equal(expectedCopper({ type: 'pc' }, { type: 'switch' }), 'straight');
  assert.equal(expectedCopper({ type: 'router' }, { type: 'switch' }), 'straight');
  assert.equal(expectedCopper({ type: 'pc' }, { type: 'hub' }), 'straight');
  assert.equal(expectedCopper({ type: 'pc' }, { type: 'pc' }), 'cross');
  assert.equal(expectedCopper({ type: 'router' }, { type: 'pc' }), 'cross');
  assert.equal(expectedCopper({ type: 'switch' }, { type: 'switch' }), 'cross');
  assert.equal(expectedCopper({ type: 'router' }, { type: 'cloud' }), null);
  // MikroTik : auto-MDI/MDIX, les deux câbles fonctionnent
  assert.equal(expectedCopper({ type: 'router', mdi: 'auto' }, { type: 'pc' }), null);
  const cu = { name: 'G0/0', media: 'copper' };
  assert.equal(autoCable({ type: 'router' }, cu, { type: 'cloud' }, cu), 'straight');
  assert.equal(autoCable({ type: 'router' }, { media: 'serial' }, { type: 'router' }, { media: 'serial' }), 'serial');
  assert.equal(autoCable({ type: 'pc' }, { media: 'rs232' }, { type: 'router' }, { media: 'console' }), 'console');
  assert.equal(autoCable({ type: 'router' }, { media: 'fiber' }, { type: 'switch' }, cu), null);
});

test('état d\'un câble : explications', () => {
  const end = (label, type, name, media) => ({ label, type, port: { name, media } });
  const pc = end('PC1', 'pc', 'Fa0', 'copper');

  assert.deepEqual(checkLink(pc, end('SW', 'switch', 'Fa0/1', 'copper'), 'straight'), { up: true, data: true, reason: null });
  assert.equal(checkLink(pc, end('PC2', 'pc', 'Fa0', 'copper'), 'straight').reason,
    'Câble droit entre PC1 et PC2 : deux PC se relient avec un câble croisé.');
  assert.equal(checkLink(end('R1', 'router', 'G0/0', 'copper'), end('Imp', 'printer', 'Fa0', 'copper'), 'straight').reason,
    'Câble droit entre R1 et Imp : un routeur et une imprimante se relient avec un câble croisé.');
  assert.match(checkLink(end('R1', 'router', 'G0/0/0', 'fiber'), end('SW', 'switch', 'G0/1', 'copper'), 'fiber').reason,
    /ne se branche pas sur SW G0\/1 \(port cuivre\)/);
  assert.match(checkLink({ label: 'R1', type: 'router', port: null, portName: 'G0/7' }, pc, 'cross').reason, /R1 n'a pas de port G0\/7/);

  const se = (label) => end(label, 'router', 'Se0/0/0', 'serial');
  assert.match(checkLink(se('R1'), se('R2'), 'serial', { dce: 'b' }).reason, /côté DCE \(R2 Se0\/0\/0\) n'a pas de clock rate/);
  assert.equal(checkLink(se('R1'), se('R2'), 'serial', { dce: 'a', clockRate: 64000 }).up, true);

  const console = checkLink(end('PC', 'pc', 'RS232', 'rs232'), end('R1', 'router', 'Console', 'console'), 'console');
  assert.deepEqual(console, { up: true, data: false, reason: null });
});

test('choix automatique des ports pour un nouveau câble', () => {
  const side = (label, type, model, modules) => ({ label, type, free: devicePorts(model, modules) });
  const r = pickPorts(side('PC', 'pc', 'PC-PT'), side('SW', 'switch', '2960-24TT'));
  assert.deepEqual([r.portA.name, r.portB.name, r.cable], ['Fa0', 'Fa0/1', 'straight']);

  assert.equal(pickPorts(side('R1', 'router', '1941'), side('R2', 'router', '1941'), 'serial').error,
    'Plus de port série libre sur R1 et R2. Ajoute un module, change de modèle ou retire un câble.');
  const s = pickPorts(side('R1', 'router', '1941', { 0: 'HWIC-2T' }), side('R2', 'router', '1941', { 1: 'HWIC-2T' }), 'serial');
  assert.deepEqual([s.portA.name, s.portB.name], ['Se0/0/0', 'Se0/1/0']);

  // Console : le sens du câble n'a pas d'importance
  const c = pickPorts(side('R1', 'router', '2911'), side('PC', 'pc', 'PC-PT'), 'console');
  assert.deepEqual([c.portA.name, c.portB.name, c.cable], ['Console', 'RS232', 'console']);
  assert.match(pickPorts(side('S', 'server', 'Server-PT'), side('R1', 'router', '2911'), 'console').error, /RS232/);
});

test('ping à travers la liaison série de la démo', () => {
  const r = simulatePing(clone(), 'pc1', '172.16.0.10');
  assert.ok(r.ok, lastError(r));
  assert.ok(r.log.some((l) => /Liaison série point à point : R2/.test(l.text)));
});

test('clock rate oublié : le ping échoue sur R1 avec l\'explication', () => {
  const doc = clone();
  delete dev(doc, 'r1').config.interfaces.find((i) => i.link === 'l6').clockRate;
  const r = simulatePing(doc, 'pc1', '172.16.0.10');
  assert.ok(!r.ok);
  assert.equal(r.failedAt, 'r1');
  assert.match(lastError(r), /le saut suivant 10\.0\.0\.2 est derrière Se0\/0\/0, qui est down\. .*n'a pas de clock rate/);
  assert.match(validate(doc).map((i) => i.text).join('\n'), /côté DCE \(R1 Se0\/0\/0\) n'a pas de clock rate/);

  // Sans route par défaut, c'est le réseau connecté lui-même qui est down
  dev(doc, 'r1').config.routes = [];
  const direct = simulatePing(doc, 'pc1', '10.0.0.2');
  assert.match(lastError(direct), /10\.0\.0\.0\/30 est sur Se0\/0\/0, mais l'interface est down/);
});

test('mauvais câble entre un PC et le switch : échec dès le PC', () => {
  const doc = clone();
  link(doc, 'l1').cable = 'cross';
  const r = simulatePing(doc, 'pc1', '192.168.10.11');
  assert.ok(!r.ok);
  assert.equal(r.failedAt, 'pc1');
  assert.equal(lastError(r), 'PC Compta : câble hors service. Câble croisé entre PC Compta et SW Étage : un PC et un switch se relient avec un câble droit.');
});

test('câble hors service au milieu du domaine de diffusion', () => {
  const doc = clone();
  link(doc, 'l2').cable = 'cross';
  const r = simulatePing(doc, 'pc1', '192.168.10.11');
  assert.ok(!r.ok);
  assert.match(lastError(r), /pas de réponse ARP.*câble SW Étage Fa0\/2 hors service/);
});

test('un port ne reçoit qu\'un câble', () => {
  const doc = clone();
  link(doc, 'l2').targetIface = 'Fa0/1';
  assert.match(validate(doc).map((i) => i.text).join('\n'), /SW Étage Fa0\/1 a déjà un câble/);
});

test('hub : répète les trames entre les PC', () => {
  const pc = (id, ip) => ({ id, type: 'pc', model: 'PC-PT', label: id, position: { x: 0, y: 0 }, config: { ip, mask: 24, gateway: null } });
  const doc = {
    format: 'netcanvas', version: 3, name: 'Hub',
    devices: [pc('a', '10.0.0.1'), pc('b', '10.0.0.2'), { id: 'h', type: 'hub', model: 'Hub-PT', label: 'Hub', position: { x: 0, y: 0 }, config: {} }],
    links: [
      { id: 'x', source: 'a', target: 'h', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Port0' },
      { id: 'y', source: 'b', target: 'h', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Port1' },
    ],
  };
  const r = simulatePing(doc, 'a', '10.0.0.2');
  assert.ok(r.ok, lastError(r));
  assert.deepEqual(r.hops.filter((h) => h.phase === 'request').map((h) => h.edge), ['x', 'y']);
});

test('câble console : ne transporte pas de trafic', () => {
  const doc = clone();
  doc.devices.push({ id: 'adm', type: 'pc', model: 'Laptop-PT', label: 'Admin', position: { x: 0, y: 0 }, config: { ip: '192.168.10.50', mask: 24, gateway: '192.168.10.1' } });
  doc.links.push({ id: 'c', source: 'adm', target: 'r1', cable: 'console', sourceIface: 'RS232', targetIface: 'Console' });
  assert.deepEqual(validate(doc).map((i) => i.text), ['Admin a une adresse IP mais aucun câble réseau n\'est branché sur sa carte.']);
  const r = simulatePing(doc, 'adm', '192.168.10.1');
  assert.equal(lastError(r), 'Admin n\'a qu\'un câble console : il sert à configurer, pas à transporter du trafic.');
});

test('migration v2 -> v3 : modèle, câbles et ports déduits', () => {
  const v2 = {
    format: 'netcanvas', version: 2, name: 'v2',
    devices: [
      { id: 'r1', type: 'router', label: 'R1', position: { x: 0, y: 0 }, config: { interfaces: [
        { link: 'a', name: 'G0/0', ip: '10.0.0.1', mask: 30 },
        { link: 'b', name: 'G0/1', ip: '10.0.1.1', mask: 24 },
      ], routes: [] } },
      { id: 'r2', type: 'router', label: 'R2', position: { x: 0, y: 0 }, config: { interfaces: [
        { link: 'a', name: 'G0/5', ip: '10.0.0.2', mask: 30 },
      ], routes: [] } },
      { id: 'sw', type: 'switch', label: 'SW', position: { x: 0, y: 0 }, config: { ports: [
        { link: 'b', name: 'Fa0/1', mode: 'access', vlan: 1 },
        { link: 'c', name: 'Fa0/2', mode: 'access', vlan: 1 },
      ] } },
      { id: 'pc', type: 'pc', label: 'PC', position: { x: 0, y: 0 }, config: { ip: '10.0.1.10', mask: 24, gateway: '10.0.1.1' } },
    ],
    links: [
      { id: 'a', source: 'r1', target: 'r2' },
      { id: 'b', source: 'r1', target: 'sw' },
      { id: 'c', source: 'pc', target: 'sw' },
    ],
  };
  const doc = upgrade(v2);
  assert.equal(doc.version, 3);
  assert.deepEqual(doc.devices.map((d) => d.model), ['2911', 'Router-PT', '2960-24TT', 'PC-PT']);
  assert.deepEqual(doc.links.map((l) => [l.cable, l.sourceIface, l.targetIface]), [
    ['cross', 'G0/0', 'G0/5'],
    ['straight', 'G0/1', 'Fa0/1'],
    ['straight', 'Fa0', 'Fa0/2'],
  ]);
  assert.deepEqual(validate(doc), []);
  assert.ok(simulatePing(doc, 'pc', '10.0.0.2').ok === false); // pas de route de retour sur R2, mais le câblage est bon
});
