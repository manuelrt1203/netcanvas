import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, OSPF_DEMO } from '../examples.js';
import { simulatePing } from './simulate.js';
import { arpRows, macRows, mergeLearned, clearMac } from './tables.js';
import { macCisco, macColon, macOf, macWindows } from './mac.js';
import { runtimeOf } from './runtime.js';

const dev = (doc, id) => doc.devices.find((d) => d.id === id);
// Lance un ping et enregistre ce qu'il a appris, comme l'éditeur
function ping(doc, src, dst) {
  const r = simulatePing(doc, src, dst);
  return { r, doc: { ...doc, runtime: mergeLearned(runtimeOf(doc), r.learned, doc) } };
}
const at = (doc, time) => ({ ...doc, runtime: { ...runtimeOf(doc), time } });
const mac = (doc, id, ifName) => macCisco(macOf(dev(doc, id), ifName));

test('adresses MAC : stables, par interface, formats', () => {
  const m = macOf(dev(DEMO, 'r1'), 'G0/0');
  assert.deepEqual(m, macOf(dev(DEMO, 'r1'), 'G0/0'));
  assert.notDeepEqual(m, macOf(dev(DEMO, 'r1'), 'G0/1'));
  assert.match(macCisco(m), /^0001\.42[0-9a-f]{2}\.[0-9a-f]{4}$/);
  assert.match(macWindows(macOf(dev(DEMO, 'pc1'), 'Fa0')), /^00-e0-f7(-[0-9a-f]{2}){3}$/);
  assert.match(macColon(macOf(dev(OSPF_DEMO, 'r3'), 'ether1')), /^4C:5E:0C(:[0-9A-F]{2}){3}$/);
});

test('un ping inter-VLAN remplit les caches ARP et la table MAC du switch', () => {
  const { doc } = ping(structuredClone(DEMO), 'pc1', '192.168.20.10');
  assert.deepEqual(arpRows(dev(doc, 'pc1'), doc).map((e) => [e.ip, macCisco(e.mac)]), [['192.168.10.1', mac(doc, 'r1', 'G0/0')]]);
  const r1 = arpRows(dev(doc, 'r1'), doc).map((e) => [e.ip, macCisco(e.mac), e.iface, e.own ?? false]);
  // Pas d'entrée pour la liaison série Se0/0/0 (pas d'ARP en HDLC)
  assert.deepEqual(r1, [
    ['192.168.10.1', mac(doc, 'r1', 'G0/0'), 'G0/0', true],
    ['192.168.10.10', mac(doc, 'pc1', 'Fa0'), 'G0/0', false],
    ['192.168.20.1', mac(doc, 'r1', 'G0/1'), 'G0/1', true],
    ['192.168.20.10', mac(doc, 'pc3', 'Fa0'), 'G0/1', false],
  ]);
  assert.deepEqual(macRows(dev(doc, 'sw1'), doc).map((e) => [e.vlan, macCisco(e.mac), e.port]), [
    [10, mac(doc, 'pc1', 'Fa0'), 'Fa0/1'],
    [10, mac(doc, 'r1', 'G0/0'), 'Fa0/23'],
    [20, mac(doc, 'pc3', 'Fa0'), 'Fa0/3'],
    [20, mac(doc, 'r1', 'G0/1'), 'Fa0/24'],
  ]);
});

test('ARP en cache au ping suivant, puis vieillissement', () => {
  let { doc } = ping(structuredClone(DEMO), 'pc1', '192.168.20.10');
  const again = simulatePing(doc, 'pc1', '192.168.20.10');
  assert.ok(again.log.some((l) => l.text === 'ARP (en cache) : 192.168.10.1 est R1 (VLAN 10). Trame transmise.'));
  // Table MAC : 5 min ; ARP du PC : 2 min ; ARP du routeur : 4 h
  doc = at(doc, 150);
  assert.equal(arpRows(dev(doc, 'pc1'), doc).length, 0);
  assert.equal(macRows(dev(doc, 'sw1'), doc).length, 4);
  doc = at(doc, 301);
  assert.equal(macRows(dev(doc, 'sw1'), doc).length, 0);
  assert.ok(arpRows(dev(doc, 'r1'), doc).some((e) => e.ip === '192.168.10.10'));
  doc = at(doc, 14401);
  assert.ok(!arpRows(dev(doc, 'r1'), doc).some((e) => e.ip === '192.168.10.10'));
});

test('clear mac address-table : le switch réapprend au ping suivant', () => {
  let { doc } = ping(structuredClone(DEMO), 'pc1', '192.168.10.11');
  doc = { ...doc, runtime: clearMac('sw1')(doc.runtime) };
  assert.equal(macRows(dev(doc, 'sw1'), doc).length, 0);
  ({ doc } = ping(doc, 'pc1', '192.168.10.11'));
  assert.deepEqual(macRows(dev(doc, 'sw1'), doc).map((e) => e.port).sort(), ['Fa0/1', 'Fa0/2']);
});

test('mikrotik : cache ARP de 30 s', () => {
  let { doc } = ping(structuredClone(OSPF_DEMO), 'pc1', '172.16.3.10');
  assert.ok(arpRows(dev(doc, 'r3'), doc).some((e) => e.ip === '172.16.3.10' && !e.own));
  doc = at(doc, 31);
  assert.ok(!arpRows(dev(doc, 'r3'), doc).some((e) => e.ip === '172.16.3.10'));
});
