import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology } from './topology.js';
import { simulatePing } from './simulate.js';
import { validate } from './validate.js';
import { channelMismatch, formatVlanList, parseVlanList } from './switching.js';
import { runLine, shellFor } from '../cli/index.js';
import { importConfig } from '../cli/import.js';
import { ciscoConfigs } from '../export/cisco.js';
import { fromJSON, toJSON } from '../serialize.js';

// S1 et S2 reliés par deux câbles (Fa0/23, Fa0/24) en trunk.
// VLAN 10 : PC1 (S1) et PC2 (S2) ; VLAN 20 : PC3 (S1) et PC4 (S2) ; VLAN 1 : un hub avec PC5 et PC6 sur S1 Fa0/3, PC7 sur S2.
function lab() {
  const pc = (id, ip, x) => ({ id, type: 'pc', model: 'PC-PT', label: id.toUpperCase(), position: { x, y: 300 }, config: { ip, mask: 24, gateway: null } });
  const port = (link, name, extra) => ({ link, name, mode: 'access', vlan: 1, ...extra });
  return {
    format: 'netcanvas', version: 3, name: 'L2',
    devices: [
      { id: 's1', type: 'switch', model: '2960-24TT', label: 'S1', position: { x: 0, y: 0 }, config: { ports: [
        port('a', 'Fa0/23', { mode: 'trunk' }), port('b', 'Fa0/24', { mode: 'trunk' }),
        port('p1', 'Fa0/1', { vlan: 10 }), port('p3', 'Fa0/2', { vlan: 20 }), port('h', 'Fa0/3'),
      ], vlans: [{ id: 10, name: 'PROFS' }, { id: 20, name: 'ELEVES' }] } },
      { id: 's2', type: 'switch', model: '2960-24TT', label: 'S2', position: { x: 300, y: 0 }, config: { ports: [
        port('a', 'Fa0/23', { mode: 'trunk' }), port('b', 'Fa0/24', { mode: 'trunk' }),
        port('p2', 'Fa0/1', { vlan: 10 }), port('p4', 'Fa0/2', { vlan: 20 }), port('p7', 'Fa0/3'),
      ], vlans: [{ id: 10, name: 'PROFS' }, { id: 20, name: 'ELEVES' }] } },
      { id: 'hub', type: 'hub', model: 'Hub-PT', label: 'HUB', position: { x: 0, y: 200 }, config: {} },
      pc('pc1', '192.168.10.1', 0), pc('pc2', '192.168.10.2', 100), pc('pc3', '192.168.20.1', 200), pc('pc4', '192.168.20.2', 300),
      pc('pc5', '192.168.1.5', 400), pc('pc6', '192.168.1.6', 500), pc('pc7', '192.168.1.7', 600),
    ],
    links: [
      { id: 'a', source: 's1', target: 's2', cable: 'cross', sourceIface: 'Fa0/23', targetIface: 'Fa0/23' },
      { id: 'b', source: 's1', target: 's2', cable: 'cross', sourceIface: 'Fa0/24', targetIface: 'Fa0/24' },
      { id: 'p1', source: 'pc1', target: 's1', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/1' },
      { id: 'p3', source: 'pc3', target: 's1', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/2' },
      { id: 'h', source: 'hub', target: 's1', cable: 'cross', sourceIface: 'Port0', targetIface: 'Fa0/3' },
      { id: 'p5', source: 'pc5', target: 'hub', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Port1' },
      { id: 'p6', source: 'pc6', target: 'hub', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Port2' },
      { id: 'p2', source: 'pc2', target: 's2', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/1' },
      { id: 'p4', source: 'pc4', target: 's2', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/2' },
      { id: 'p7', source: 'pc7', target: 's2', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/3' },
    ],
  };
}
const portOf = (doc, sw, name) => doc.devices.find((d) => d.id === sw).config.ports.find((p) => p.name === name);
const both = (doc, name, patch) => ['s1', 's2'].forEach((s) => Object.assign(portOf(doc, s, name), patch));
const why = (r) => r.log.map((x) => x.text).join('\n');
const blocked = (doc, vlan = 1) => [...buildTopology(doc).stp.vlans.get(vlan).ports.values()].filter((p) => p.state === 'blocking').length;

function term(doc, id) {
  const shell = shellFor(doc.devices.find((d) => d.id === id));
  const s = shell.newSession();
  const state = { doc };
  state.run = (...lines) => lines.map((line) => {
    const r = runLine(shell, s, line, state.doc.devices.find((d) => d.id === id), state.doc);
    if (r.device) state.doc = { ...state.doc, devices: state.doc.devices.map((d) => (d.id === id ? r.device : d)) };
    return r.output.join('\n');
  }).join('\n');
  state.run('enable', 'configure terminal');
  return state;
}

test('listes de VLAN', () => {
  assert.deepEqual(parseVlanList('10,20,30-32'), [10, 20, 30, 31, 32]);
  assert.equal(parseVlanList('10-5'), null);
  assert.equal(formatVlanList([1, 2, 3, 5, 10, 11]), '1-3,5,10,11');
});

test('trunk : VLAN autorisés et VLAN natif', () => {
  const doc = lab();
  assert.equal(simulatePing(doc, 'pc3', '192.168.20.2').ok, true);
  // VLAN 20 retiré des deux trunks : PC3 ne joint plus PC4, le VLAN 10 passe toujours
  both(doc, 'Fa0/23', { allowedVlans: [1, 10] });
  both(doc, 'Fa0/24', { allowedVlans: [1, 10] });
  const r = simulatePing(doc, 'pc3', '192.168.20.2');
  assert.equal(r.ok, false);
  assert.match(why(r), /le VLAN 20 n'est pas autorisé sur ce trunk/, why(r));
  assert.equal(simulatePing(doc, 'pc1', '192.168.10.2').ok, true);

  // VLAN natif 99 des deux côtés : le VLAN 1 passe étiqueté, tout marche
  const nat = lab();
  both(nat, 'Fa0/23', { nativeVlan: 99 });
  both(nat, 'Fa0/24', { nativeVlan: 99 });
  assert.equal(simulatePing(nat, 'pc5', '192.168.1.7').ok, true);
  // Natif différent d'un côté seulement : le VLAN 1 et le VLAN 99 sont bloqués sur ce trunk
  const bad = lab();
  for (const n of ['Fa0/23', 'Fa0/24']) portOf(bad, 's1', n).nativeVlan = 99;
  const rb = simulatePing(bad, 'pc5', '192.168.1.7');
  assert.equal(rb.ok, false);
  assert.match(why(rb), /VLAN natifs différents/, why(rb));
  assert.equal(simulatePing(bad, 'pc1', '192.168.10.2').ok, true, 'le VLAN 10 étiqueté passe toujours');
  assert.ok(validate(bad).some((i) => /VLAN natif/i.test(i.text)), 'erreur expliquée dans les contrôles');
});

test('EtherChannel : deux câbles, un seul lien logique (plus de port bloqué)', () => {
  const doc = lab();
  assert.equal(blocked(doc), 1, 'sans EtherChannel, STP bloque un des deux câbles');
  portOf(doc, 's1', 'Fa0/23').channelGroup = 1; portOf(doc, 's1', 'Fa0/23').channelMode = 'active';
  portOf(doc, 's1', 'Fa0/24').channelGroup = 1; portOf(doc, 's1', 'Fa0/24').channelMode = 'active';
  portOf(doc, 's2', 'Fa0/23').channelGroup = 1; portOf(doc, 's2', 'Fa0/23').channelMode = 'passive';
  portOf(doc, 's2', 'Fa0/24').channelGroup = 1; portOf(doc, 's2', 'Fa0/24').channelMode = 'passive';
  const t = buildTopology(doc);
  assert.equal(t.channels.find((c) => c.device === 's1').state, 'up');
  assert.equal(blocked(doc), 0);
  assert.equal(simulatePing(doc, 'pc1', '192.168.10.2').ok, true);

  // passive des deux côtés : pas de canal, STP bloque à nouveau
  for (const n of ['Fa0/23', 'Fa0/24']) portOf(doc, 's1', n).channelMode = 'passive';
  const t2 = buildTopology(doc);
  assert.match(t2.channels[0].reason, /passive des deux côtés/);
  assert.equal(blocked(doc), 1);
  assert.ok(validate(doc).some((i) => /EtherChannel|Port-channel/.test(i.text)));

  // Un membre avec un autre VLAN d'accès : suspendu
  const inc = lab();
  for (const s of ['s1', 's2']) for (const n of ['Fa0/23', 'Fa0/24']) Object.assign(portOf(inc, s, n), { channelGroup: 2, channelMode: 'on' });
  Object.assign(portOf(inc, 's1', 'Fa0/24'), { mode: 'access', vlan: 10 });
  const ti = buildTopology(inc);
  assert.equal(ti.isUp('b'), false);
  assert.match(ti.status.get('b').reason, /suspendu.*Fa0\/24/);

  assert.equal(channelMismatch('on', 'active') !== null, true);
  assert.equal(channelMismatch('desirable', 'auto'), null);
  assert.match(channelMismatch('active', 'desirable'), /LACP.*PAgP/);
});

test('port-security : shutdown (err-disabled), restrict, adresses statiques', () => {
  const doc = lab();
  portOf(doc, 's1', 'Fa0/3').ps = { enabled: true, max: 1 };
  const t = buildTopology(doc);
  assert.equal(t.isUp('h'), false, 'deux PC derrière le hub, maximum 1 : port err-disabled');
  assert.match(t.status.get('h').reason, /err-disabled.*port-security/);
  const rs = simulatePing(doc, 'pc5', '192.168.1.7');
  assert.equal(rs.ok, false);
  assert.match(why(rs), /err-disabled/, why(rs));

  portOf(doc, 's1', 'Fa0/3').ps.max = 2;
  assert.equal(simulatePing(doc, 'pc6', '192.168.1.7').ok, true);

  // restrict : le premier appris passe, le second est jeté
  portOf(doc, 's1', 'Fa0/3').ps = { enabled: true, max: 1, violation: 'restrict' };
  assert.equal(buildTopology(doc).isUp('h'), true);
  assert.equal(simulatePing(doc, 'pc5', '192.168.1.7').ok, true);
  const r = simulatePing(doc, 'pc6', '192.168.1.7');
  assert.equal(r.ok, false);
  assert.match(why(r), /port-security restrict\) jette les trames/, why(r));

  // Adresse statique : seule la MAC de PC6 est autorisée
  const mac6 = buildTopology(doc).security.get('s1|h').seen.find((x) => x.label === 'PC6').mac;
  portOf(doc, 's1', 'Fa0/3').ps = { enabled: true, max: 1, violation: 'restrict', macs: [mac6] };
  assert.equal(simulatePing(doc, 'pc6', '192.168.1.7').ok, true);
  assert.equal(simulatePing(doc, 'pc5', '192.168.1.7').ok, false);
});

test('VTP : le client reçoit les VLAN du serveur, révision la plus haute', () => {
  const doc = lab();
  doc.devices.find((d) => d.id === 's1').config.vtp = { domain: 'LAB', mode: 'server', revision: 3 };
  const s2 = doc.devices.find((d) => d.id === 's2');
  s2.config.vtp = { domain: 'LAB', mode: 'client', revision: 0 };
  s2.config.vlans = [];
  assert.equal(simulatePing(doc, 'pc1', '192.168.10.2').ok, true, 'VLAN 10 appris du serveur');
  // Domaine différent : le client ne connaît pas le VLAN 10, son port est inactif
  s2.config.vtp.domain = 'AUTRE';
  const r = simulatePing(doc, 'pc1', '192.168.10.2');
  assert.equal(r.ok, false);
  assert.match(why(r), /S2 \(client VTP\) ne connaît pas le VLAN 10/, why(r));
  assert.ok(validate(doc).some((i) => /S2 Fa0\/1 inactif : client VTP sans VLAN 10/.test(i.text)));
  // Un client à la révision plus haute écrase la base du domaine (le piège classique)
  s2.config.vtp = { domain: 'LAB', mode: 'client', revision: 9 };
  const t = buildTopology(doc);
  assert.equal(t.vtp.get('s1').from, 's2');
  assert.equal(t.vlanExists('s1', 10), true, 'un serveur garde ses VLAN locaux');
  assert.equal(simulatePing(doc, 'pc1', '192.168.10.2').ok, false);
});

test('terminal IOS : trunk, port-security sticky, EtherChannel, VTP et show', () => {
  let t = term(lab(), 's1');
  t.run('interface fa0/23', 'switchport trunk allowed vlan 1,10', 'switchport trunk allowed vlan add 20', 'switchport trunk native vlan 99', 'exit');
  const p = portOf(t.doc, 's1', 'Fa0/23');
  assert.deepEqual(p.allowedVlans, [1, 10, 20]);
  assert.equal(p.nativeVlan, 99);
  assert.match(t.run('do show interfaces trunk'), /Fa0\/23 +on +802\.1q +trunking +99/);

  assert.match(t.run('interface fa0/23', 'switchport port-security'), /Command rejected: FastEthernet0\/23 is a trunk port/);
  t.run('interface fa0/3', 'switchport mode access', 'switchport port-security maximum 2', 'switchport port-security mac-address sticky', 'switchport port-security');
  const ps = portOf(t.doc, 's1', 'Fa0/3').ps;
  assert.equal(ps.stickyMacs.length, 2, 'les MAC de PC5 et PC6 sont apprises');
  assert.match(t.run('do show port-security address'), /SecureSticky +Fa0\/3/);
  assert.match(t.run('do show port-security interface fa0/3'), /Port Status +: Secure-up/);
  const run = t.run('do show running-config');
  assert.match(run, /interface FastEthernet0\/3\n switchport mode access\n switchport port-security maximum 2\n switchport port-security\n switchport port-security mac-address sticky\n switchport port-security mac-address sticky [0-9a-f.]+/);

  t = term(lab(), 's1');
  assert.match(t.run('interface range fa0/23 - 24', 'channel-group 1 mode active'), /Creating a port-channel interface Port-channel 1/);
  let u = term(t.doc, 's2');
  u.run('interface range fa0/23 - 24', 'channel-group 1 mode passive', 'end');
  assert.match(u.run('show etherchannel summary'), /1 +Po1\(SU\) +LACP +Fa0\/23\(P\) +Fa0\/24\(P\)/);
  // interface port-channel : les commandes vont à tous les membres
  u = term(u.doc, 's2');
  u.run('interface port-channel 1', 'switchport trunk native vlan 5', 'end');
  assert.equal(portOf(u.doc, 's2', 'Fa0/24').nativeVlan, 5);

  t = term(lab(), 's2');
  t.run('vtp domain LAB', 'vtp mode client');
  assert.match(t.run('vlan 30'), /VTP VLAN configuration not allowed when device is in CLIENT mode/);
  assert.match(t.run('do show vtp status'), /VTP Operating Mode +: Client\nVTP Domain Name +: LAB/);
  let s = term(t.doc, 's1');
  s.run('vtp domain LAB', 'vlan 30', 'name SERVEURS', 'exit');
  assert.equal(s.doc.devices.find((d) => d.id === 's1').config.vtp.revision, 2);
  const c = term(s.doc, 's2');
  assert.match(c.run('do show vlan brief'), /30 +SERVEURS/);
  assert.match(c.run('do show vtp status'), /reçue de S1 \(révision 2\)/);
});

test('export Cisco puis import : même config de switch (trunk, port-security, EtherChannel, VTP)', () => {
  const doc = lab();
  const s1 = doc.devices.find((d) => d.id === 's1');
  s1.config.vtp = { domain: 'LAB', mode: 'server', password: 'cisco', version: 2 };
  Object.assign(portOf(doc, 's1', 'Fa0/23'), { nativeVlan: 99, allowedVlans: [1, 10, 20, 99], channelGroup: 1, channelMode: 'desirable' });
  Object.assign(portOf(doc, 's1', 'Fa0/24'), { nativeVlan: 99, allowedVlans: [1, 10, 20, 99], channelGroup: 1, channelMode: 'desirable' });
  portOf(doc, 's1', 'Fa0/3').ps = { enabled: true, max: 2, violation: 'restrict', sticky: true, macs: ['0001.0002.0003'], stickyMacs: ['00aa.bbcc.ddee'], };
  const text = ciscoConfigs(doc).find((c) => c.id === 's1').text;
  const blank = { ...s1, config: { ports: s1.config.ports.map((p) => ({ link: p.link, name: p.name, mode: 'access', vlan: 1 })) } };
  const r = importConfig(blank, { ...doc, devices: doc.devices.map((d) => (d.id === 's1' ? blank : d)) }, text);
  assert.deepEqual(r.ignored.filter((x) => !/^(enable|configure|end|write)/.test(x.text)), []);
  const got = (n) => r.device.config.ports.find((p) => p.name === n);
  assert.deepEqual([got('Fa0/23').nativeVlan, got('Fa0/23').allowedVlans, got('Fa0/23').channelGroup, got('Fa0/23').channelMode], [99, [1, 10, 20, 99], 1, 'desirable']);
  assert.deepEqual(got('Fa0/3').ps, { enabled: true, max: 2, violation: 'restrict', sticky: true, macs: ['0001.0002.0003'], stickyMacs: ['00aa.bbcc.ddee'] });
  assert.deepEqual({ ...r.device.config.vtp, revision: undefined }, { domain: 'LAB', mode: 'server', password: 'cisco', version: 2, revision: undefined });

  // Le JSON garde tout
  const back = toJSON(fromJSON(doc).nodes, fromJSON(doc).edges, doc.name);
  const bp = back.devices.find((d) => d.id === 's1').config.ports.find((p) => p.name === 'Fa0/3');
  assert.equal(bp.ps.max, 2);
  assert.equal(back.devices.find((d) => d.id === 's1').config.vtp.domain, 'LAB');
});

test('démo campus : tout passe, EtherChannel monté ; le TP a ses deux pannes', async () => {
  const { CAMPUS_DEMO, TP_CAMPUS } = await import('../examples.js');
  const t = buildTopology(CAMPUS_DEMO);
  assert.equal(t.channels.find((c) => c.device === 'core').state, 'up');
  assert.equal(t.vtp.get('swb').from, 'core');
  for (const [from, to] of [['pa1', '192.168.10.21'], ['pa2', '192.168.20.21'], ['pb1', '192.168.10.11']]) {
    assert.equal(simulatePing(CAMPUS_DEMO, from, to).ok, true, `${from} -> ${to}`);
  }
  assert.deepEqual(validate(CAMPUS_DEMO).filter((i) => i.level === 'error'), []);
  assert.equal(simulatePing(TP_CAMPUS, 'pa1', '192.168.10.21').ok, false);
  assert.equal(simulatePing(TP_CAMPUS, 'pa2', '192.168.20.21').ok, false);
});
