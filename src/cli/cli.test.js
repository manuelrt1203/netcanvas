import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BGP_DEMO, DEMO, DHCP_DEMO, L3_DEMO, NAT_DEMO, OSPF_DEMO, ROAS_DEMO } from '../examples.js';
import { computeLeases, withLeases } from '../net/dhcp.js';
import { runtimeOf } from '../net/runtime.js';
import { mergeLearned } from '../net/tables.js';
import { macCisco, macColon, macOf, macWindows } from '../net/mac.js';
import { runLine, shellFor } from './index.js';
import { validate } from '../net/validate.js';
import { simulatePing } from '../net/simulate.js';
import { deviceToData, toJSON } from '../serialize.js';

// Rejoue des commandes sur un équipement et renvoie la sortie + le document modifié
function session(doc, id) {
  const shell = shellFor(doc.devices.find((d) => d.id === id));
  const s = shell.newSession();
  const state = { doc, effects: [] };
  state.run = (...lines) => {
    const out = [];
    for (const line of lines) {
      const dev = state.doc.devices.find((d) => d.id === id);
      const r = runLine(shell, s, line, dev, state.doc);
      if (r.device) state.doc = { ...state.doc, devices: state.doc.devices.map((d) => (d.id === id ? r.device : d)) };
      state.effects.push(...r.effects);
      // Effets sur l'état d'exécution (baux, table NAT), comme le fait l'éditeur
      for (const e of r.effects) if (e.type === 'runtime') state.doc = { ...state.doc, runtime: e.update(runtimeOf(state.doc)) };
      out.push(...r.output);
    }
    return out.join('\n');
  };
  state.prompt = () => shell.prompt(s, state.doc.devices.find((d) => d.id === id));
  state.help = (line) => shell.help(s, line, state.doc.devices.find((d) => d.id === id)).join('\n');
  state.complete = (line) => shell.complete(s, line, state.doc.devices.find((d) => d.id === id));
  return state;
}

const clone = () => structuredClone(DEMO);
const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const iface = (doc, id, name) => (dev(doc, id).config.interfaces ?? dev(doc, id).config.ports).find((i) => i.name === name);

test('ios : modes, abréviations et invites', () => {
  const t = session(clone(), 'r1');
  assert.equal(t.prompt(), 'R1>');
  t.run('en');
  assert.equal(t.prompt(), 'R1#');
  t.run('conf t');
  assert.equal(t.prompt(), 'R1(config)#');
  t.run('int g0/0');
  assert.equal(t.prompt(), 'R1(config-if)#');
  t.run('exit', 'int range g0/0 - 1');
  assert.equal(t.prompt(), 'R1(config-if-range)#');
  assert.match(t.run('end'), /%SYS-5-CONFIG_I/);
  assert.equal(t.prompt(), 'R1#');
  t.run('disable');
  assert.equal(t.prompt(), 'R1>');
});

test('ios : erreurs au format Cisco', () => {
  const t = session(clone(), 'r1');
  t.run('enable', 'configure terminal');
  assert.equal(t.run('interface g0/0 extra'), '% Invalid interface type and number\n');
  assert.equal(t.run('ip route 10.0.0.0'), '% Incomplete command.\n');
  // le ^ est sous le premier caractère fautif, invite comprise
  assert.equal(t.run('hostname R1 trop'), `${' '.repeat('R1(config)#hostname R1 '.length)}^\n% Invalid input detected at '^' marker.\n`);
  t.run('end');
  assert.match(t.run('co'), /% Ambiguous command:  "co"/);
  assert.match(t.run('blabla'), /Translating "blabla"\.\.\.domain server/);
});

test('ios : aide « ? » et complétion Tab', () => {
  const t = session(clone(), 'r1');
  t.run('enable');
  assert.match(t.help('sh?'), /^show\n?/);
  assert.match(t.help('show ip ?'), /interface\s+IP interface status/);
  assert.match(t.help('show ip ?'), /route\s+IP routing table/);
  assert.equal(t.complete('conf'), 'configure ');
  assert.equal(t.complete('show ip int'), 'show ip interface ');
  assert.equal(t.complete('co'), 'co'); // ambigu (configure, copy) : rien n'est complété
});

test('ios : la config tapée est la même que celle des formulaires', () => {
  const t = session(clone(), 'r1');
  t.run('en', 'conf t', 'hostname Bordeaux', 'int g0/2', 'ip address 172.31.0.1 255.255.255.0', 'description Vers DMZ', 'shutdown', 'exit',
    'ip route 10.50.0.0 255.255.0.0 10.0.0.2', 'end');
  const d = dev(t.doc, 'r1');
  assert.equal(d.label, 'Bordeaux');
  // G0/2 n'a pas de câble : la config est gardée sur le port
  assert.deepEqual(iface(t.doc, 'r1', 'G0/2'), { link: null, name: 'G0/2', ip: '172.31.0.1', mask: 24, description: 'Vers DMZ', shutdown: true });
  assert.deepEqual(d.config.routes.at(-1), { network: '10.50.0.0', mask: 16, nextHop: '10.0.0.2' });
  // Données de l'éditeur, puis retour en JSON : rien n'est perdu
  const data = deviceToData(d, t.doc.links);
  assert.deepEqual(data.ifaces['G0/2'], { ip: '172.31.0.1', mask: 24, description: 'Vers DMZ', shutdown: true });
  const nodes = t.doc.devices.map((x) => ({ id: x.id, type: x.type, position: x.position, data: deviceToData(x, t.doc.links) }));
  const edges = t.doc.links.map((l) => ({ ...l, data: { cable: l.cable, sourceIface: l.sourceIface, targetIface: l.targetIface, dce: l.dce } }));
  const back = toJSON(nodes, edges, t.doc.name);
  assert.deepEqual(dev(back, 'r1').config.interfaces.find((i) => i.name === 'G0/2'), iface(t.doc, 'r1', 'G0/2'));
});

test('ios : refus réalistes (masque, réseau, chevauchement, DTE)', () => {
  const t = session(clone(), 'r1');
  t.run('en', 'conf t', 'int g0/2');
  assert.match(t.run('ip address 10.1.1.1 255.0.255.0'), /% Bad mask 0xFF00FF00 for address 10\.1\.1\.1/);
  assert.match(t.run('ip address 10.1.1.0 255.255.255.0'), /Bad mask \/24 for address 10\.1\.1\.0/);
  assert.match(t.run('ip address 192.168.10.200 255.255.255.0'), /% 192\.168\.10\.0 overlaps with GigabitEthernet0\/0/);
  t.run('exit');
  const r2 = session(t.doc, 'r2');
  r2.run('en', 'conf t', 'int se0/0/0');
  assert.match(r2.run('clock rate 64000'), /This command applies only to DCE interfaces/);
});

test('ios : shutdown coupe le lien, show ip route et ping suivent', () => {
  const t = session(clone(), 'r1');
  t.run('en', 'conf t', 'int g0/1');
  assert.match(t.run('shutdown'), /GigabitEthernet0\/1, changed state to administratively down/);
  assert.match(validate(t.doc).map((i) => i.text).join('\n'), /R1 G0\/1 est désactivée \(shutdown\)/);
  t.run('end');
  assert.doesNotMatch(t.run('show ip route'), /192\.168\.20\.0/);
  assert.match(t.run('sh ip int br'), /GigabitEthernet0\/1\s+192\.168\.20\.1\s+YES manual administratively down down/);
  // Sans G0/1, R1 suit sa route par défaut vers R2, qui renvoie vers R1 : vraie boucle de routage
  const ping = t.run('ping 192.168.20.10');
  assert.match(ping, /\.\.\.\.\.\nSuccess rate is 0 percent \(0\/5\)\n% NetCanvas : R2 : TTL expiré/);
  assert.deepEqual(t.effects.at(-1), { type: 'ping', source: 'r1', target: '192.168.20.10' });
  t.run('conf t', 'int g0/1');
  assert.match(t.run('no shut'), /changed state to up\n%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0\/1, changed state to up/);
  t.run('end');
  assert.match(t.run('ping 192.168.20.10'), /!!!!!\nSuccess rate is 100 percent/);
});

test('ios : show ip route, cdp, running-config', () => {
  const t = session(clone(), 'r1');
  t.run('enable');
  const route = t.run('show ip route');
  assert.match(route, /Gateway of last resort is 10\.0\.0\.2 to network 0\.0\.0\.0/);
  assert.match(route, /^S\*   0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.0\.2$/m);
  assert.match(route, /^C    10\.0\.0\.0\/30 is directly connected, Serial0\/0\/0$/m);
  assert.match(route, /^L    192\.168\.10\.1\/32 is directly connected, GigabitEthernet0\/0$/m);
  assert.match(t.run('show cdp neighbors'), /^R2\s+Ser 0\/0\/0\s+165\s+R\s+2911\s+Ser 0\/0\/0$/m);
  const run = t.run('show running-config');
  assert.match(run, /interface Serial0\/0\/0\n ip address 10\.0\.0\.1 255\.255\.255\.252\n clock rate 64000\n!/);
  assert.match(run, /interface GigabitEthernet0\/2\n no ip address\n!/);
});

test('ios switch : VLAN, interface range, show vlan brief', () => {
  const t = session(clone(), 'sw1');
  t.run('en', 'conf t', 'vlan 30', 'name Invites', 'exit', 'int range fa0/5 - 6, fa0/8');
  assert.match(t.run('switchport access vlan 40'), /Creating vlan 40/);
  assert.match(t.run('ip address 1.1.1.1 255.0.0.0'), /% Invalid input detected/); // port de niveau 2
  t.run('end');
  const vlans = t.run('show vlan brief');
  assert.match(vlans, /^30   Invites\s+active\s*$/m);
  assert.match(vlans, /^40   VLAN0040\s+active    Fa0\/5, Fa0\/6, Fa0\/8$/m);
  assert.match(vlans, /Gig0\/1, Gig0\/2/);
  assert.deepEqual(iface(t.doc, 'sw1', 'Fa0/8'), { link: null, name: 'Fa0/8', mode: 'access', vlan: 40 });
  assert.deepEqual(dev(t.doc, 'sw1').config.vlans, [{ id: 30, name: 'Invites' }, { id: 40, name: 'VLAN0040' }]);
});

test('ios switch : mettre PC Atelier dans le mauvais VLAN casse le ping', () => {
  const t = session(clone(), 'sw1');
  t.run('en', 'conf t', 'int fa0/3', 'sw acc vlan 10', 'end');
  const r = simulatePing(t.doc, 'pc3', '192.168.20.1');
  assert.ok(!r.ok);
});

test('pc : ipconfig et ping façon Windows', () => {
  const t = session(clone(), 'pc3');
  assert.equal(t.prompt(), 'C:\\>');
  assert.match(t.run('ipconfig'), /IPv4 Address\.+: 192\.168\.20\.10\n {3}Subnet Mask\.+: 255\.255\.255\.0/);
  assert.match(t.run('ipconfig 192.168.20.77 255.255.255.0 192.168.10.1'), /Invalid gateway/);
  t.run('ipconfig 192.168.20.77 255.255.255.0 192.168.20.1');
  assert.deepEqual(dev(t.doc, 'pc3').config, { ip: '192.168.20.77', mask: 24, gateway: '192.168.20.1' });
  assert.match(t.run('ping 172.16.0.10'), /Reply from 172\.16\.0\.10: bytes=32 time<1ms TTL=62\n(?:.*\n){3}\nPing statistics/);
  const ko = t.run('ping 10.99.99.99 -n 2');
  assert.match(ko, /Request timed out\.\nRequest timed out\.\n\nPing statistics for 10\.99\.99\.99:\n {4}Packets: Sent = 2, Received = 0, Lost = 2 \(100% loss\),\n\nNetCanvas : R2 : aucune route vers 10\.99\.99\.99/);
});

test('mikrotik : RouterOS (adresses, routes, interfaces, export)', () => {
  const doc = clone();
  doc.devices.push({ id: 'mk', type: 'router', model: 'hAP-ac2', label: 'MikroTik', position: { x: 0, y: 0 }, config: { interfaces: [], routes: [] } });
  // Câble croisé vers un switch : accepté grâce à l'auto-MDIX
  doc.links.push({ id: 'lm', source: 'mk', target: 'sw2', cable: 'cross', sourceIface: 'ether1', targetIface: 'Fa0/2' });
  const t = session(doc, 'mk');
  assert.equal(t.prompt(), '[admin@MikroTik] > ');
  t.run('/ip address add address=172.16.0.20/24 interface=ether1');
  assert.match(t.run('/ip address print'), /^ 0   172\.16\.0\.20\/24     172\.16\.0\.0      ether1$/m);
  assert.match(t.run('/ip address add address=10.0.0.1/24 interface=ether9'), /input does not match any value of interface/);
  assert.match(t.run('/ping 192.168.10.10 count=1'), /timeout\n.*packet-loss=100%\nNetCanvas : MikroTik : aucune route vers 192\.168\.10\.10/);
  t.run('/ip route add dst-address=0.0.0.0/0 gateway=172.16.0.1');
  assert.match(t.run('/ping 192.168.10.10 count=1'), /56  62 1ms\n.*sent=1 received=1 packet-loss=0%/);
  assert.match(t.run('/ip route print'), /^ 0 As   0\.0\.0\.0\/0\s+172\.16\.0\.1\s+1$/m);
  assert.match(t.run('/ip route remove 1'), /cannot remove dynamic route/);

  // Navigation, abréviations, complétion
  t.run('/ip addr');
  assert.equal(t.prompt(), '[admin@MikroTik] /ip address> ');
  assert.match(t.run('pr'), /172\.16\.0\.20\/24/);
  t.run('..');
  assert.equal(t.prompt(), '[admin@MikroTik] /ip> ');
  assert.equal(t.complete('/sys'), '/system ');
  assert.match(t.run('/foo'), /bad command name foo \(line 1 column 2\)/);

  t.run('/interface disable ether1', '/system identity set name=MK-Lyon');
  assert.equal(dev(t.doc, 'mk').label, 'MK-Lyon');
  assert.match(t.run('/interface print'), /^ 0  X  ether1/m);
  assert.equal(t.run('/export'), [
    '# NetCanvas : export RouterOS',
    '# model = MikroTik hAP ac²',
    '/interface ethernet',
    'set [ find default-name=ether1 ] disabled=yes',
    '/ip address',
    'add address=172.16.0.20/24 interface=ether1 network=172.16.0.0',
    '/ip route',
    'add dst-address=0.0.0.0/0 gateway=172.16.0.1',
    '/system identity',
    'set name="MK-Lyon"',
    '',
  ].join('\n'));
});

test('pas de terminal pour Internet ni le hub', () => {
  assert.equal(shellFor({ type: 'cloud' }), null);
  assert.equal(shellFor({ type: 'hub' }), null);
});

// === Routage dynamique dans les terminaux ==========================================================
const strip = (doc, ids, proto) => {
  const copy = structuredClone(doc);
  for (const id of ids) delete dev(copy, id).config[proto];
  return copy;
};

test('ios ospf : configuration tapée à la main sur R1 et R2, puis show', () => {
  let doc = strip(OSPF_DEMO, ['r1', 'r2'], 'ospf');
  assert.ok(!simulatePing(doc, 'pc1', '172.16.3.10').ok);
  const r1 = session(doc, 'r1');
  r1.run('en', 'conf t', 'router ospf 1', 'network 192.168.1.0 0.0.0.255 area 1', 'network 10.0.12.0 0.0.0.3 area 1',
    'network 1.1.1.1 0.0.0.0 area 1', 'passive-interface g0/0', 'end');
  const r2 = session(r1.doc, 'r2');
  r2.run('en', 'conf t', 'int g0/0', 'ip ospf 1 area 1', 'exit', 'router ospf 1', 'network 10.0.23.0 0.0.0.3 area 0', 'network 2.2.2.2 0.0.0.0 area 0', 'end');
  doc = r2.doc;
  assert.deepEqual(dev(doc, 'r2').config.ospf.interfaces, [{ name: 'G0/0', area: 1 }]);
  assert.ok(simulatePing(doc, 'pc1', '172.16.3.10').ok);

  const show = session(doc, 'r1');
  show.run('en');
  assert.match(show.run('show ip ospf neighbor'), /^2\.2\.2\.2\s+1\s+FULL\/DR\s+00:00:35\s+10\.0\.12\.2\s+GigabitEthernet0\/1$/m);
  assert.match(show.run('show ip route'), /^O IA 172\.16\.3\.0\/24 \[110\/3\] via 10\.0\.12\.2, 00:05:00, GigabitEthernet0\/1$/m);
  assert.match(show.run('show ip route ospf'), /^O\*E2 0\.0\.0\.0\/0 \[110\/1\] via 10\.0\.12\.2/m);
  assert.doesNotMatch(show.run('show ip route ospf'), /directly connected/);
  const run = show.run('show running-config');
  assert.match(run, /router ospf 1\n log-adjacency-changes\n passive-interface GigabitEthernet0\/0\n network 192\.168\.1\.0 0\.0\.0\.255 area 1/);
  assert.match(run, /interface Loopback0\n ip address 1\.1\.1\.1 255\.255\.255\.255\n!/);
  assert.match(show.run('show ip ospf interface brief'), /^Gi0\/1\s+1\s+1\s+10\.0\.12\.1\/30\s+1\s+BDR\s+1\/1$/m);
});

test('ios ospf : zone fausse, show ip ospf neighbor explique', () => {
  const t = session(structuredClone(OSPF_DEMO), 'r1');
  t.run('en', 'conf t', 'router ospf 1', 'no network 10.0.12.0 0.0.0.3 area 1', 'network 10.0.12.0 0.0.0.3 area 0', 'end');
  const out = t.run('show ip ospf neighbor');
  assert.doesNotMatch(out, /FULL/);
  assert.match(out, /% NetCanvas : OSPF : pas d'adjacence R1 G0\/1 ↔ R2 \(ABR\) G0\/0 : zones différentes \(0 et 1\)\./);
  assert.match(t.run('ping 172.16.3.10'), /% NetCanvas : R1 : aucune route vers 172\.16\.3\.10.*Piste : OSPF/);
});

test('ios ospf : coût d\'interface, refus d\'un 2e processus, wildcard invalide', () => {
  const t = session(structuredClone(OSPF_DEMO), 'r2');
  t.run('en', 'conf t', 'int g0/1', 'bandwidth 1544', 'exit');
  assert.match(t.run('do show ip route ospf'), /172\.16\.3\.0\/24 \[110\/65\]/);
  t.run('int g0/1', 'ip ospf cost 7', 'exit');
  assert.match(t.run('do show ip route ospf'), /172\.16\.3\.0\/24 \[110\/8\]/);
  assert.match(t.run('router ospf 9'), /un seul processus OSPF/);
  t.run('router ospf 1');
  assert.equal(t.prompt(), 'R2-ABR(config-router)#');
  assert.match(t.run('network 10.9.0.0 0.255.0.255 area 0'), /% OSPF: Invalid wildcard mask/);
});

test('ios rip : network ramené à sa classe, version, passive', () => {
  let doc = strip(OSPF_DEMO, ['r1', 'r2', 'r3'], 'ospf');
  for (const id of ['r1', 'r2']) {
    const t = session(doc, id);
    t.run('en', 'conf t', 'router rip', 'version 2', 'network 10.0.12.0', 'network 192.168.1.0', 'network 10.0.23.0', 'no auto-summary', 'end');
    doc = t.doc;
  }
  assert.deepEqual(dev(doc, 'r1').config.rip, { networks: ['10.0.0.0', '192.168.1.0'], version: 2, autoSummary: false });
  const t = session(doc, 'r2');
  t.run('en');
  assert.match(t.run('show ip route rip'), /^R    192\.168\.1\.0\/24 \[120\/1\] via 10\.0\.12\.1, 00:05:00, GigabitEthernet0\/0$/m);
  assert.match(t.run('show ip protocols'), /Routing Protocol is "rip"\n.*\n  Default version control: send version 2, receive version 2/);
});

test('ios bgp : erreurs puis session établie', () => {
  const t = session(strip(BGP_DEMO, ['r1'], 'bgp'), 'r1');
  t.run('en', 'conf t', 'router bgp 65001');
  assert.match(t.run('neighbor 2.2.2.2 update-source lo0'), /% Specify remote-as or peer-group commands first/);
  t.run('neighbor 2.2.2.2 remote-as 65001', 'network 192.168.1.0 mask 255.255.255.0');
  assert.match(t.run('do show ip bgp summary'), /2\.2\.2\.2\s+4\s+65001.*never\s+Active\n\n% NetCanvas : 2\.2\.2\.2 : .*update-source Lo0/);
  t.run('neighbor 2.2.2.2 update-source loopback 0', 'end');
  assert.match(t.run('show ip bgp summary'), /2\.2\.2\.2\s+4\s+65001\s+12\s+12\s+3\s+0\s+0\s+00:05:00 1/);
  const table = t.run('show ip bgp');
  assert.match(table, /^\*>i172\.16\.0\.0\/24    2\.2\.2\.2\s+0\s+100\s+0 65002 i$/m);
  assert.match(table, /^\*> 192\.168\.1\.0\/24   0\.0\.0\.0\s+0\s+32768 i$/m);
  assert.match(t.run('show ip route bgp'), /^B    172\.16\.0\.0\/24 \[200\/0\] via 2\.2\.2\.2, 00:05:00$/m);
  assert.match(t.run('show running-config'), /router bgp 65001\n bgp log-neighbor-changes\n neighbor 2\.2\.2\.2 remote-as 65001\n neighbor 2\.2\.2\.2 update-source Loopback0\n network 192\.168\.1\.0 mask 255\.255\.255\.0/);
  assert.match(t.run('conf t', 'router bgp 65009'), /BGP is already running; AS is 65001/);
});

test('mikrotik : OSPF en RouterOS v7, adjacence avec un Cisco', () => {
  const t = session(strip(OSPF_DEMO, ['r3'], 'ospf'), 'r3');
  assert.ok(!simulatePing(t.doc, 'pc1', '172.16.3.10').ok);
  t.run('/routing ospf instance add name=default-v2 router-id=3.3.3.3 originate-default=if-installed',
    '/routing ospf area add name=backbone-v2 area-id=0.0.0.0 instance=default-v2',
    '/routing ospf interface-template add networks=10.0.23.0/30 area=backbone-v2',
    '/routing ospf interface-template add networks=172.16.3.0/24 area=backbone-v2 passive');
  assert.ok(simulatePing(t.doc, 'pc1', '172.16.3.10').ok);
  assert.ok(simulatePing(t.doc, 'pc1', '203.0.113.2').ok); // route par défaut annoncée
  assert.match(t.run('/routing ospf neighbor print'), /0  D instance=default-v2 area=backbone-v2 address=10\.0\.23\.1 router-id=2\.2\.2\.2 state="Full"/);
  assert.match(t.run('/ip route print'), /DAo  192\.168\.1\.0\/24\s+10\.0\.23\.1\s+110/);
  assert.match(t.run('/routing ospf interface-template add networks=10.9.0.0/24 area=zone9'), /input does not match any value of area/);
  const script = t.run('/export');
  assert.match(script, /\/routing ospf instance\nadd name=default-v2 version=2 router-id=3\.3\.3\.3 originate-default=if-installed/);
  assert.match(script, /\/routing ospf interface-template\nadd area=backbone-v2 interfaces=ether2 passive\nadd area=backbone-v2 networks=10\.0\.23\.0\/30\nadd area=backbone-v2 networks=172\.16\.3\.0\/24/);
});

test('mikrotik : BGP en RouterOS v7 avec un Cisco (eBGP)', () => {
  const t = session(strip(BGP_DEMO, ['r3'], 'bgp'), 'r3');
  t.run('/routing bgp connection add name=toR2 as=65002 remote.address=10.0.23.1 remote.as=65001 local.role=ebgp output.network=bgp-networks');
  assert.match(t.run('/routing bgp session print'), /0 E remote\.address=10\.0\.23\.1 \.as=65001 \.id=2\.2\.2\.2 local\.as=65002 prefix-count=1/);
  assert.ok(!simulatePing(t.doc, 'pc1', '172.16.0.10').ok); // rien n'est encore annoncé
  t.run('/ip firewall address-list add list=bgp-networks address=172.16.0.0/24');
  assert.deepEqual(dev(t.doc, 'r3').config.bgp.networks, [{ network: '172.16.0.0', mask: 24 }]);
  assert.ok(simulatePing(t.doc, 'pc1', '172.16.0.10').ok);
  assert.match(t.run('/ip route print'), /DAb  192\.168\.1\.0\/24\s+10\.0\.23\.1\s+20/);
  t.run('/routing bgp connection remove 0', '/routing bgp connection add name=bad as=65002 remote.address=10.0.23.1 remote.as=64999');
  assert.match(t.run('/routing bgp session print'), /NetCanvas : « remote-as 64999 » mais R2 \(AS 65001\) est dans l'AS 65001/);
});

test('ios : router-on-a-stick tapé à la main', () => {
  const doc = structuredClone(ROAS_DEMO);
  dev(doc, 'r1').config.interfaces = [{ link: 'c3', name: 'G0/0', ip: null, mask: null }];
  assert.ok(!simulatePing(doc, 'pc1', '192.168.20.10').ok);
  const t = session(doc, 'r1');
  t.run('en', 'conf t', 'int g0/0', 'no shut');
  assert.match(t.run('encapsulation dot1Q 10'), /only allowed on subinterfaces/);
  t.run('int g0/0.10');
  assert.equal(t.prompt(), 'R1(config-if)#');
  assert.match(t.run('ip address 192.168.10.1 255.255.255.0'), /only allowed if that/);
  t.run('encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0', 'int g0/0.20', 'encap dot1q 20', 'ip add 192.168.20.1 255.255.255.0', 'end');
  assert.deepEqual(iface(t.doc, 'r1', 'G0/0.20'), { link: null, name: 'G0/0.20', parent: 'G0/0', ip: '192.168.20.1', mask: 24, vlan: 20 });
  assert.ok(simulatePing(t.doc, 'pc1', '192.168.20.10').ok);
  assert.match(t.run('show ip interface brief'), /GigabitEthernet0\/0\.10\s+192\.168\.10\.1\s+YES manual up\s+up/);
  assert.match(t.run('show running-config'), /interface GigabitEthernet0\/0\.20\n encapsulation dot1Q 20\n ip address 192\.168\.20\.1 255\.255\.255\.0\n!/);
  assert.match(t.run('show ip route connected'), /C    192\.168\.20\.0\/24 is directly connected, GigabitEthernet0\/0\.20/);
});

test('mikrotik : router-on-a-stick en RouterOS (/interface vlan)', () => {
  const doc = structuredClone(ROAS_DEMO);
  const r1 = dev(doc, 'r1');
  r1.model = 'hAP-ac2';
  r1.config.interfaces = [];
  doc.links.find((l) => l.id === 'c3').sourceIface = 'ether2';
  const t = session(doc, 'r1');
  t.run('/interface vlan add name=vlan10 vlan-id=10 interface=ether2', '/interface vlan add name=vlan20 vlan-id=20 interface=ether2');
  assert.match(t.run('/interface vlan add name=x vlan-id=10 interface=ether2'), /vlan-id 10 already used on ether2/);
  t.run('/ip address add address=192.168.10.1/24 interface=vlan10', '/ip address add address=192.168.20.1/24 interface=vlan20');
  assert.ok(simulatePing(t.doc, 'pc1', '192.168.20.10').ok);
  assert.match(t.run('/interface vlan print'), / 1   vlan20\s+1500\s+20\s+ether2/);
  assert.match(t.run('/export'), /\/interface vlan\nadd interface=ether2 name=vlan10 vlan-id=10\nadd interface=ether2 name=vlan20 vlan-id=20\n\/ip address\nadd address=192\.168\.10\.1\/24 interface=vlan10/);
});

test('ios switch niveau 3 : interface vlan, ip routing, route par défaut', () => {
  const doc = structuredClone(L3_DEMO);
  Object.assign(dev(doc, 'sw').config, { interfaces: [] });
  delete dev(doc, 'sw').config.ipRouting;
  delete dev(doc, 'sw').config.routes;
  const t = session(doc, 'sw');
  t.run('en', 'conf t', 'int fa0/1');
  assert.match(t.run('ip address 1.1.1.1 255.0.0.0'), /% Invalid input detected/);
  for (const [v, ip] of [[10, '192.168.10.1'], [20, '192.168.20.1'], [30, '192.168.30.1'], [99, '10.0.0.1']]) {
    t.run(`int vlan ${v}`, `ip address ${ip} 255.255.255.${v === 99 ? 252 : 0}`);
  }
  t.run('exit');
  assert.ok(!simulatePing(t.doc, 'pc1', '192.168.30.10').ok); // pas encore « ip routing »
  t.run('ip routing', 'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'end');
  assert.ok(simulatePing(t.doc, 'pc1', '192.168.30.10').ok);
  assert.ok(simulatePing(t.doc, 'pc1', '203.0.113.2').ok);
  assert.match(t.run('show ip interface brief'), /^Vlan30\s+192\.168\.30\.1\s+YES manual up\s+up$/m);
  assert.match(t.run('show ip route'), /^S\*   0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.0\.2$/m);
  assert.match(t.run('show running-config'), /interface Vlan10\n ip address 192\.168\.10\.1 255\.255\.255\.0\n!/);
  assert.match(t.run('show running-config'), /ip routing\n!\nip route 0\.0\.0\.0 0\.0\.0\.0 10\.0\.0\.2/);
});

test('ios switch niveau 2 : ip routing refusé, ip default-gateway', () => {
  const t = session(structuredClone(DEMO), 'sw1');
  t.run('en', 'conf t');
  assert.match(t.run('ip routing'), /switch de niveau 2, il ne route pas/);
  t.run('ip default-gateway 192.168.10.1', 'int vlan 10', 'ip address 192.168.10.2 255.255.255.0', 'end');
  assert.equal(dev(t.doc, 'sw1').config.defaultGateway, '192.168.10.1');
  assert.ok(simulatePing(t.doc, 'sw1', '172.16.0.10').ok); // administration à distance du switch
  assert.match(t.run('show ip route'), /Invalid input|Default gateway/);
});

test('ios : ACL numérotées et nommées, access-group, show access-lists', () => {
  const t = session(structuredClone(DEMO), 'r1');
  t.run('en', 'conf t');
  assert.match(t.run('access-list 10 deny 192.168.10.0 any'), /% Invalid input detected : texte en trop/);
  t.run('access-list 10 deny 192.168.10.0 0.0.0.255', 'access-list 10 permit any');
  t.run('ip access-list extended BLOQUE_SRV');
  assert.equal(t.prompt(), 'R1(config-ext-nacl)#');
  t.run('remark pas de ping vers le serveur', 'deny icmp any host 172.16.0.10', 'permit ip any any', 'exit');
  t.run('int se0/0/0', 'ip access-group 10 out', 'int g0/1', 'ip access-group BLOQUE_SRV in', 'end');
  assert.match(simulatePing(t.doc, 'pc1', '172.16.0.10').log.at(-1).text, /refusé en sortie de Se0\/0\/0 par l'ACL 10/);
  assert.match(simulatePing(t.doc, 'pc3', '172.16.0.10').log.at(-1).text, /refusé en entrée de G0\/1 par l'ACL BLOQUE_SRV, ligne 10 « deny icmp any host 172\.16\.0\.10 »/);
  assert.ok(simulatePing(t.doc, 'pc3', '10.0.0.2').ok);

  assert.equal(t.run('show access-lists'), [
    'Standard IP access list 10',
    '    10 deny 192.168.10.0, wildcard bits 0.0.0.255',
    '    20 permit any',
    'Extended IP access list BLOQUE_SRV',
    '    10 deny icmp any host 172.16.0.10',
    '    20 permit ip any any',
    '',
  ].join('\n'));
  const run = t.run('show running-config');
  assert.match(run, /interface Serial0\/0\/0\n ip address 10\.0\.0\.1 255\.255\.255\.252\n ip access-group 10 out\n clock rate 64000/);
  assert.match(run, /access-list 10 deny 192\.168\.10\.0 0\.0\.0\.255\naccess-list 10 permit any\nip access-list extended BLOQUE_SRV\n remark pas de ping vers le serveur\n deny icmp any host 172\.16\.0\.10/);

  t.run('conf t', 'ip access-list extended BLOQUE_SRV', 'no 10', 'end');
  assert.ok(simulatePing(t.doc, 'pc3', '172.16.0.10').ok);
  t.run('conf t', 'int se0/0/0', 'no ip access-group 10 out', 'end');
  assert.ok(simulatePing(t.doc, 'pc1', '172.16.0.10').ok);
});

test('mikrotik : pare-feu /ip firewall filter', () => {
  const t = session(structuredClone(OSPF_DEMO), 'r3');
  assert.match(t.run('/ip firewall filter add chain=output action=drop'), /failure: chain=forward ou chain=input attendu/);
  t.run('/ip firewall filter add chain=forward action=drop protocol=icmp src-address=192.168.1.0/24 dst-address=172.16.3.0/24');
  assert.match(simulatePing(t.doc, 'pc1', '172.16.3.10').log.at(-1).text, /bloqué par le pare-feu, règle 0/);
  t.run('/ip firewall filter add chain=forward action=accept src-address=192.168.1.10 place-before=0');
  assert.match(t.run('/ip firewall filter print'), / 0 {3}chain=forward action=accept src-address=192\.168\.1\.10\n 1 {3}chain=forward action=drop/);
  assert.ok(simulatePing(t.doc, 'pc1', '172.16.3.10').ok); // la règle accept passe avant
  assert.match(t.run('/export'), /\/ip firewall filter\nadd chain=forward action=accept src-address=192\.168\.1\.10\nadd chain=forward action=drop protocol=icmp/);
});

test('ios : NAT/PAT et NAT statique tapés à la main', () => {
  const doc = structuredClone(NAT_DEMO);
  const r1 = dev(doc, 'r1');
  delete r1.config.nat;
  delete r1.config.acls;
  for (const i of r1.config.interfaces) { delete i.natInside; delete i.natOutside; }
  assert.ok(!simulatePing(doc, 'pc1', '198.51.100.10').ok);
  const t = session(doc, 'r1');
  t.run('en', 'conf t', 'access-list 1 permit 192.168.1.0 0.0.0.255',
    'ip nat inside source list 1 interface g0/1 overload', 'ip nat inside source static 192.168.1.100 203.0.113.5',
    'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside', 'end');
  assert.deepEqual(dev(t.doc, 'r1').config.nat, { statics: [{ local: '192.168.1.100', global: '203.0.113.5' }], dynamic: [{ acl: '1', overload: true, iface: 'G0/1' }] });
  assert.ok(simulatePing(t.doc, 'pc1', '198.51.100.10').ok);
  assert.ok(simulatePing(t.doc, 'srv', '203.0.113.5').ok);
  assert.match(t.run('show ip nat translations'), /---  203\.0\.113\.5\s+192\.168\.1\.100\s+---/);
  const run = t.run('show running-config');
  assert.match(run, /interface GigabitEthernet0\/0\n ip address 192\.168\.1\.1 255\.255\.255\.0\n ip nat inside\n!/);
  assert.match(run, /ip nat inside source list 1 interface GigabitEthernet0\/1 overload\nip nat inside source static 192\.168\.1\.100 203\.0\.113\.5/);
  t.run('conf t', 'ip nat pool PUBLIC 203.0.113.2 203.0.113.4 netmask 255.255.255.248', 'no ip nat inside source list 1', 'ip nat inside source list 1 pool PUBLIC overload', 'end');
  const r = simulatePing(t.doc, 'pc1', '198.51.100.10');
  assert.ok(r.ok);
  assert.ok(r.log.some((l) => /source 192\.168\.1\.10 traduite en 203\.0\.113\.2 \(pool PUBLIC \(overload\), ACL 1\)/.test(l.text)));
});

test('mikrotik : NAT (masquerade et dst-nat)', () => {
  const t = session(structuredClone(OSPF_DEMO), 'r3');
  assert.match(t.run('/ip firewall nat add chain=srcnat action=dst-nat'), /impossible dans chain=srcnat/);
  t.run('/ip firewall nat add chain=srcnat action=masquerade out-interface=ether3',
    '/ip firewall nat add chain=dstnat action=dst-nat dst-address=203.0.113.1 to-addresses=172.16.3.10 in-interface=ether3');
  const r = simulatePing(t.doc, 'net', '203.0.113.1');
  assert.ok(r.ok);
  assert.ok(r.log.some((l) => /destination 203\.0\.113\.1 traduite en 172\.16\.3\.10 \(dst-nat 203\.0\.113\.1 → 172\.16\.3\.10\)/.test(l.text)));
  assert.match(t.run('/export'), /\/ip firewall nat\nadd chain=srcnat action=masquerade out-interface=ether3\nadd chain=dstnat action=dst-nat dst-address=203\.0\.113\.1 in-interface=ether3 to-addresses=172\.16\.3\.10/);
});

test('ios : serveur DHCP et relais tapés à la main', () => {
  const doc = structuredClone(DHCP_DEMO);
  delete dev(doc, 'r1').config.dhcp;
  delete iface(doc, 'r1', 'G0/0.20').helperAddress;
  assert.ok(computeLeases(doc).leases.get('pc1').error);
  const t = session(doc, 'r1');
  t.run('en', 'conf t', 'ip dhcp excluded-address 192.168.10.1 192.168.10.9', 'ip dhcp pool PROFS');
  assert.equal(t.prompt(), 'R1(dhcp-config)#');
  t.run('network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1', 'dns-server 8.8.8.8', 'exit',
    'int g0/0.20', 'ip helper-address 192.168.30.10', 'end');
  const { leases } = computeLeases(t.doc);
  assert.equal(leases.get('pc1').ip, '192.168.10.10');
  assert.equal(leases.get('pc3').ip, '192.168.20.2');
  assert.match(t.run('show ip dhcp binding'), /^192\.168\.10\.10\s+PC Profs 1\s+J\+1 00:00:00\s+Automatic$/m);
  assert.doesNotMatch(t.run('show ip dhcp binding'), /192\.168\.20\.2/); // servi par le serveur, pas par R1
  const run = t.run('show running-config');
  assert.match(run, /interface GigabitEthernet0\/0\.20\n encapsulation dot1Q 20\n ip address 192\.168\.20\.1 255\.255\.255\.0\n ip helper-address 192\.168\.30\.10/);
  assert.match(run, /ip dhcp excluded-address 192\.168\.10\.1 192\.168\.10\.9\nip dhcp pool PROFS\n network 192\.168\.10\.0 255\.255\.255\.0\n default-router 192\.168\.10\.1\n dns-server 8\.8\.8\.8/);
});

test('pc : ipconfig avec bail, APIPA, /release et /renew', () => {
  const t = session(structuredClone(DHCP_DEMO), 'pc1');
  assert.match(t.run('ipconfig'), /IPv4 Address\.+: 192\.168\.10\.10\n.*\n {3}Default Gateway\.+: 192\.168\.10\.1\n {3}DHCP Enabled\.+: Yes\n {3}DNS Servers\.+: 8\.8\.8\.8/);
  assert.match(t.run('ipconfig /release'), /IP Address\.+: 0\.0\.0\.0/);
  assert.deepEqual(t.doc.runtime.released, ['pc1']);
  assert.equal(dev(withLeases(t.doc), 'pc1').config.ip, null);
  assert.match(t.run('ipconfig'), /pas de bail DHCP, adresse libérée par « ipconfig \/release »/);
  assert.match(t.run('ipconfig /renew'), /IPv4 Address\.+: 192\.168\.10\.10/);
  assert.deepEqual(t.doc.runtime.released, []);
  t.run('ipconfig 192.168.10.50 255.255.255.0 192.168.10.1');
  assert.deepEqual(dev(t.doc, 'pc1').config, { ip: '192.168.10.50', mask: 24, gateway: '192.168.10.1' });

  const broken = structuredClone(DHCP_DEMO);
  delete iface(broken, 'r1', 'G0/0.20').helperAddress;
  const p3 = session(broken, 'pc3');
  assert.match(p3.run('ipconfig'), /Autoconfiguration IPv4 Address\.\.: 169\.254\.\d+\.\d+[\s\S]*NetCanvas : pas de bail DHCP, R1 G0\/0\.20 n'a ni pool DHCP/);
});

test('mikrotik : serveur DHCP en RouterOS', () => {
  const doc = structuredClone(OSPF_DEMO);
  dev(doc, 'srv').config = { ip: null, mask: null, gateway: null, dhcp: true };
  const t = session(doc, 'r3');
  t.run('/ip pool add name=serveurs ranges=172.16.3.100-172.16.3.200');
  assert.match(t.run('/ip dhcp-server add interface=ether9x address-pool=serveurs'), /input does not match any value of interface/);
  t.run('/ip dhcp-server add interface=ether2 address-pool=serveurs name=dhcp1',
    '/ip dhcp-server network add address=172.16.3.0/24 gateway=172.16.3.1 dns-server=1.1.1.1');
  assert.equal(computeLeases(t.doc).leases.get('srv').ip, '172.16.3.100');
  assert.match(t.run('/ip dhcp-server lease print'), / 0 {3}172\.16\.3\.100\s+Serveur\s+bound  expires-after=1 j/);
  assert.ok(simulatePing(t.doc, 'pc1', '172.16.3.100').ok);
  assert.match(t.run('/export'), /\/ip pool\nadd name=serveurs ranges=172\.16\.3\.100-172\.16\.3\.200\n\/ip dhcp-server\nadd address-pool=serveurs interface=ether2 name=dhcp1\n\/ip dhcp-server network\nadd address=172\.16\.3\.0\/24 dns-server=1\.1\.1\.1 gateway=172\.16\.3\.1/);
});

test('ios : table NAT persistante, expiration, clear ; bail et clear ip dhcp binding', () => {
  // Les traductions d'un ping restent 60 s dans la table
  const ping = simulatePing(NAT_DEMO, 'pc1', '198.51.100.10');
  assert.equal(ping.natAdded.length, 1);
  let doc = { ...structuredClone(NAT_DEMO), runtime: { time: 10, leases: {}, released: [], nat: ping.natAdded } };
  const t = session(doc, 'r1');
  t.run('en');
  assert.match(t.run('show ip nat translations'), /^icmp 203\.0\.113\.1:1\s+192\.168\.1\.10:1\s+198\.51\.100\.10:1\s+198\.51\.100\.10:1$/m);
  t.doc = { ...t.doc, runtime: { ...t.doc.runtime, time: 61 } };
  assert.doesNotMatch(t.run('show ip nat translations'), /icmp/); // expirée
  t.doc = { ...t.doc, runtime: { ...t.doc.runtime, time: 10 } };
  t.run('clear ip nat translation *');
  assert.deepEqual(t.doc.runtime.nat, []);

  // Un ping non sollicité depuis Internet ne traverse pas le PAT, même avec une entrée active
  doc = { ...structuredClone(NAT_DEMO), runtime: { time: 10, leases: {}, released: [], nat: ping.natAdded } };
  assert.ok(!simulatePing(doc, 'srv', '203.0.113.1').log.some((l) => /traduite en 192\.168\.1\.10/.test(l.text)));

  const d = session(structuredClone(DHCP_DEMO), 'r1');
  d.run('en', 'conf t', 'ip dhcp pool PROFS', 'lease 0 2 30', 'end');
  assert.equal(dev(d.doc, 'r1').config.dhcp.pools[0].leaseTime, 9000);
  assert.match(d.run('show ip dhcp pool'), /Lease\s+: 2 h 30 min/);
  d.doc = { ...d.doc, runtime: withLeases(d.doc).runtime };
  assert.equal(Object.keys(d.doc.runtime.leases).length, 3);
  d.run('clear ip dhcp binding 192.168.10.10');
  assert.deepEqual(Object.keys(d.doc.runtime.leases).sort(), ['pc2', 'pc3']);
  d.run('clear ip dhcp binding *');
  assert.deepEqual(Object.keys(d.doc.runtime.leases), ['pc3']); // servi par le serveur du VLAN 30, pas par R1
});

// Lance un ping et enregistre ce qu'il a appris (ARP, MAC), comme l'éditeur
const pingAndLearn = (doc, src, dst) => {
  const r = simulatePing(doc, src, dst);
  return { ...doc, runtime: mergeLearned(runtimeOf(doc), r.learned, doc) };
};

test('tables : show arp, show mac address-table, show interfaces, clear (IOS)', () => {
  const doc = pingAndLearn(structuredClone(DEMO), 'pc1', '192.168.20.10');
  const mac = (id, i) => macCisco(macOf(dev(doc, id), i));
  const r1 = session(doc, 'r1');
  r1.run('en');
  const arp = r1.run('show ip arp');
  assert.match(arp, new RegExp(`^Internet  192\\.168\\.10\\.1 +- +${mac('r1', 'G0/0').replace(/\./g, '\\.')}  ARPA   GigabitEthernet0/0$`, 'm'));
  assert.match(arp, new RegExp(`^Internet  192\\.168\\.10\\.10 +0 +${mac('pc1', 'Fa0').replace(/\./g, '\\.')}  ARPA   GigabitEthernet0/0$`, 'm'));
  assert.doesNotMatch(arp, /Serial/);
  assert.equal(r1.run('show arp'), arp);
  const ifs = r1.run('show interfaces g0/0');
  assert.match(ifs, new RegExp(`^GigabitEthernet0/0 is up, line protocol is up\n  Hardware is CN Gigabit Ethernet, address is ${mac('r1', 'G0/0').replace(/\./g, '\\.')} \\(bia `));
  assert.match(ifs, /Internet address is 192\.168\.10\.1\/24/);
  r1.run('clear arp-cache');
  assert.doesNotMatch(r1.run('show ip arp'), /192\.168\.10\.10/);

  const sw = session(doc, 'sw1');
  sw.run('en');
  const table = sw.run('show mac address-table');
  assert.match(table, new RegExp(`^  10    ${mac('pc1', 'Fa0').replace(/\./g, '\\.')}    DYNAMIC     Fa0/1$`, 'm'));
  assert.match(table, /Total Mac Addresses for this criterion: 4/);
  assert.equal(sw.run('show mac-address-table'), table);
  sw.run('clear mac address-table dynamic');
  assert.match(sw.run('show mac address-table'), /criterion: 0/);
});

test('tables : arp -a sur le PC, /ip arp print sur MikroTik', () => {
  let doc = pingAndLearn(structuredClone(DEMO), 'pc1', '192.168.20.10');
  const pc = session(doc, 'pc1');
  assert.match(pc.run('arp -a'), new RegExp(`Interface: 192\\.168\\.10\\.10 --- 0x2\n  Internet Address      Physical Address      Type\n  192\\.168\\.10\\.1 +${macWindows(macOf(dev(doc, 'r1'), 'G0/0'))} +dynamic`));
  pc.run('arp -d');
  assert.match(pc.run('arp -a'), /No ARP Entries Found/);

  doc = pingAndLearn(structuredClone(OSPF_DEMO), 'pc1', '172.16.3.10');
  const mk = session(doc, 'r3');
  assert.match(mk.run('/ip arp print'), new RegExp(`DC 172\\.16\\.3\\.10 +${macColon(macOf(dev(doc, 'srv'), 'Fa0'))} +ether2`));
  assert.match(mk.run('/interface print'), new RegExp(`ether1 +ether +1500 +${macColon(macOf(dev(doc, 'r3'), 'ether1'))}`));
});

test('RouterOS 6.49 (CHR de GNS3) : syntaxe v6 du routage, OSPF avec un Cisco, export v6, aide sur la v7', () => {
  const mk = (id, model, label) => ({ id, type: 'router', model, label, modules: {}, config: { interfaces: [], routes: [] } });
  const a = mk('a', 'CHR-6.49', 'MK6');
  const b = mk('b', '2911', 'R2');
  const doc = { devices: [a, b], links: [{ id: 'l', source: 'a', sourceIface: 'ether1', target: 'b', targetIface: 'G0/0', cable: 'cross' }] };
  const sh = shellFor(a);
  const s = sh.newSession(a);
  const run = (l, dev = a, sess = s, shell = sh) => shell.run(sess, l, dev, doc).out;
  for (const l of ['/ip address add address=10.0.0.1/24 interface=ether1', '/ip address add address=192.168.1.1/24 interface=ether2',
    '/routing ospf instance set default router-id=1.1.1.1', '/routing ospf network add network=10.0.0.0/24 area=backbone',
    '/routing ospf network add network=192.168.1.0/24 area=backbone', '/routing ospf interface add interface=ether2 passive=yes',
    '/routing bgp instance set default as=65001', '/routing bgp peer add remote-address=10.0.0.2 remote-as=65002 nexthop-choice=force-self',
    '/routing bgp network add network=192.168.1.0/24', '/routing rip network add network=192.168.1.0/24']) {
    assert.deepEqual(run(l), [], l);
  }
  assert.deepEqual(a.config.ospf.networks.map((x) => x.network), ['10.0.0.0', '192.168.1.0']);
  assert.deepEqual(a.config.ospf.passive, ['ether2']);
  assert.deepEqual(a.config.bgp.neighbors, [{ ip: '10.0.0.2', remoteAs: 65002, name: 'peer1', nextHopSelf: true }]);
  assert.deepEqual(a.config.rip.interfaces, ['ether2']);

  const ios = shellFor(b);
  const t = ios.newSession(b);
  for (const l of ['enable', 'conf t', 'int g0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shut', 'exit', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0']) run(l, b, t, ios);
  assert.match(run('/routing ospf neighbor print').join('\n'), /router-id=10\.0\.0\.2 address=10\.0\.0\.2 interface=ether1 state="Full"/);

  const exp = run('/export').join('\n');
  assert.match(exp, /\/routing ospf network\nadd area=backbone network=10\.0\.0\.0\/24\nadd area=backbone network=192\.168\.1\.0\/24/);
  assert.match(exp, /\/routing bgp instance\nset default as=65001/);
  assert.match(exp, /\/routing bgp peer\nadd name=peer1 remote-address=10\.0\.0\.2 remote-as=65002 nexthop-choice=force-self/);
  assert.match(exp, /\/routing rip network\nadd network=192\.168\.1\.0\/24/);
  assert.doesNotMatch(exp, /interface-template|connection/);

  // Syntaxe v7 sur une 6.49 (et l'inverse) : refusée, avec l'équivalent
  assert.match(run('/routing ospf interface-template add networks=10.0.0.0/24').join('\n'), /bad command name interface-template[\s\S]*Sur la 6\.49 : \/routing ospf network add/);
  const v7 = mk('c', 'CHR', 'MK7');
  assert.match(sh.run(sh.newSession(v7), '/routing ospf network add network=10.0.0.0/24', v7, doc).out.join('\n'), /En v7 : \/routing ospf interface-template/);
});
