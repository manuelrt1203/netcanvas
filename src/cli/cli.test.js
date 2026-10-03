import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BGP_DEMO, DEMO, OSPF_DEMO } from '../examples.js';
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
  assert.match(script, /\/routing ospf interface-template\nadd area=backbone-v2 networks=10\.0\.23\.0\/30\nadd area=backbone-v2 networks=172\.16\.3\.0\/24/);
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
