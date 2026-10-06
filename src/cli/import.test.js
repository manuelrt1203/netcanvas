import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMOS, DEMO } from '../examples.js';
import { shellFor } from './index.js';
import { analyzeInterfaces, importConfig, renameInterfaces } from './import.js';
import { isMikrotik } from '../net/catalog.js';

// Config affichée par le terminal : « show running-config » (IOS) ou « /export » (RouterOS)
function running(dev, doc) {
  const shell = shellFor(dev);
  const s = shell.newSession(dev);
  if (isMikrotik(dev)) return shell.run(s, '/export', structuredClone(dev), doc).out.join('\n');
  shell.run(s, 'enable', structuredClone(dev), doc);
  return shell.run(s, 'show running-config', structuredClone(dev), doc).out.join('\n');
}
const blank = (dev) => ({ ...dev, config: dev.type === 'switch' ? { ports: [] } : { interfaces: [], routes: [] } });

test('import : aller-retour exact de toutes les configs des démos (IOS et RouterOS)', () => {
  let count = 0;
  for (const { doc, label } of DEMOS) {
    for (const dev of doc.devices.filter((d) => d.type === 'router' || d.type === 'switch')) {
      const text = running(dev, doc);
      const empty = blank(dev);
      const docBlank = { ...doc, devices: doc.devices.map((d) => (d.id === dev.id ? empty : d)) };
      const r = importConfig(empty, docBlank, text);
      assert.deepEqual(r.ignored.filter((x) => !/bannière/.test(x.reason)), [], `${label} / ${dev.label}`);
      const docAfter = { ...doc, devices: doc.devices.map((d) => (d.id === dev.id ? r.device : d)) };
      assert.equal(running(r.device, docAfter), text, `${label} / ${dev.label}`);
      count++;
    }
  }
  assert.ok(count > 20, `${count} équipements testés`);
});

test('import : config collée depuis un vrai routeur (en-têtes, bannière, lignes non simulées)', () => {
  const r1 = DEMO.devices.find((d) => d.id === 'r1');
  const text = `Building configuration...

Current configuration : 1342 bytes
!
version 15.1
service timestamps debug datetime msec
hostname R1-Siege
!
banner motd ^C
  Accès réservé
^C
!
interface GigabitEthernet0/0
 description LAN Compta
 ip address 192.168.10.1 255.255.255.0
 duplex auto
 no shutdown
!
interface GigabitEthernet0/1
 ip address 192.168.20.1 255.255.255.0
!
crypto pki trustpoint TP-self-signed
ip route 0.0.0.0 0.0.0.0 10.0.0.2
router ospf 1
 network 192.168.10.0 0.0.0.255 area 0
line vty 0 4
 login local
end
`;
  const r = importConfig(blank(r1), DEMO, text);
  const c = r.device.config;
  assert.equal(r.device.label, 'R1-Siege');
  assert.deepEqual(c.interfaces.map((i) => [i.name, i.ip, i.mask, i.description ?? null]), [
    ['G0/0', '192.168.10.1', 24, 'LAN Compta'],
    ['G0/1', '192.168.20.1', 24, null],
  ]);
  assert.deepEqual(c.routes, [{ network: '0.0.0.0', mask: 0, nextHop: '10.0.0.2' }]);
  assert.deepEqual(c.ospf.networks, [{ network: '192.168.10.0', wildcard: '0.0.0.255', area: 0 }]);
  // « router ospf » puis « line vty » : on sort du sous-mode sans « exit », comme sur IOS
  const why = Object.fromEntries(r.ignored.map((x) => [x.text, x.reason]));
  // Lignes sans effet (service, duplex, crypto…) acceptées en silence, comme dans le terminal
  assert.deepEqual(Object.keys(why), ['banner motd ^C']);
  assert.equal(why['banner motd ^C'], 'bannière ignorée');
  assert.ok(r.applied >= 12);
  // Une vraie erreur est signalée avec son numéro de ligne
  const bad = importConfig(blank(r1), DEMO, 'interface GigabitEthernet0/0\n ip address 192.168.10.1 255.0.255.0\ninterface Serial9/9\n ip address 10.9.9.1 255.255.255.0\nip route 0.0.0.0 0.0.0.0 10.0.0.2\nip route 1.2.3.4 255.0.255.0 10.0.0.2');
  assert.deepEqual(bad.ignored.map((x) => [x.n, x.reason]), [
    [2, 'Bad mask 0xFF00FF00 for address 192.168.10.1'],
    [3, 'Invalid interface type and number'],
    [4, 'ignorée avec « interface Serial9/9 » (ligne refusée plus haut)'],
    [6, 'Inconsistent address and mask'],
  ]);
  assert.equal(bad.device.config.routes.length, 1, 'la suite est importée');
});

// « show run » d'un c3640 de GNS3 (IOS 12.4) : un seul port FastEthernet, lignes par défaut de Dynamips
const C3640_R4 = `R4# show running-config
Building configuration...

Current configuration : 735 bytes
!
version 12.4
service timestamps debug datetime msec
no service password-encryption
!
hostname R4
!
boot-start-marker
boot-end-marker
!
no aaa new-model
memory-size iomem 5
no ip icmp rate-limit unreachable
ip cef
no ip domain lookup
ip tcp synwait-time 5
!
interface FastEthernet0/0
 ip address 192.168.14.4 255.255.255.0
 duplex auto
 speed auto
!
no ip http server
no ip http secure-server
ip route 0.0.0.0 0.0.0.0 192.168.14.1
!
control-plane
!
line con 0
 exec-timeout 0 0
 privilege level 15
 logging synchronous
line aux 0
 exec-timeout 0 0
 privilege level 15
 logging synchronous
line vty 0 4
 login
!
end
`;

test('import GNS3 : c3640 dans un 2911, modèle compatible ou interfaces renommées', () => {
  const r = { id: 'r', type: 'router', model: '2911', label: 'R', modules: {}, config: { interfaces: [], routes: [] } };
  const doc = { devices: [r], links: [] };
  const a = analyzeInterfaces(r, C3640_R4);
  assert.deepEqual(a.missing, ['Fa0/0']);
  // Le c3725 a deux ports intégrés (Fa0/0 et Fa0/1) : le « show run » en aurait listé deux
  assert.deepEqual(a.models.map((m) => [m.id, m.modules]), [['c3640', { 0: 'NM-1FE-TX' }], ['c7200', { 0: 'C7200-IO-FE' }]]);
  assert.deepEqual(a.mapping, { 'Fa0/0': 'G0/0' });

  const asIs = importConfig(r, doc, C3640_R4);
  assert.ok(asIs.ignored.some((x) => x.text === 'interface FastEthernet0/0'));

  const c3640 = { ...r, model: 'c3640', modules: a.models[0].modules };
  const viaModel = importConfig(c3640, { devices: [c3640], links: [] }, C3640_R4);
  assert.deepEqual(viaModel.ignored, []);
  assert.deepEqual(viaModel.device.config.interfaces.map((i) => [i.name, i.ip, i.mask]), [['Fa0/0', '192.168.14.4', 24]]);

  const viaRename = importConfig(r, doc, renameInterfaces(C3640_R4, a.mapping));
  assert.deepEqual(viaRename.ignored, []);
  assert.equal(viaRename.device.label, 'R4');
  assert.deepEqual(viaRename.device.config.interfaces.map((i) => [i.name, i.ip]), [['G0/0', '192.168.14.4']]);
  assert.deepEqual(viaRename.device.config.routes, [{ network: '0.0.0.0', mask: 0, nextHop: '192.168.14.1' }]);
});

test('import GNS3 : renommage dans tout le texte (routes, passive-interface, sous-interfaces)', () => {
  const text = 'interface Serial0/0\n ip address 10.0.0.1 255.255.255.252\ninterface FastEthernet1/0.10\nrouter ospf 1\n passive-interface FastEthernet1/0\nip route 0.0.0.0 0.0.0.0 Serial0/0';
  assert.equal(renameInterfaces(text, { 'Se0/0': 'Se0/0/0', 'Fa1/0': 'G0/1' }),
    'interface Serial0/0/0\n ip address 10.0.0.1 255.255.255.252\ninterface GigabitEthernet0/1.10\nrouter ospf 1\n passive-interface GigabitEthernet0/1\nip route 0.0.0.0 0.0.0.0 Serial0/0/0');
});

test('import : aller-retour exact en RouterOS 6.49 (MikroTik des démos passés en CHR 6.49)', () => {
  let count = 0;
  for (const { doc: demo, label } of DEMOS) {
    const doc = { ...demo, devices: demo.devices.map((d) => (isMikrotik(d) ? { ...d, model: 'CHR-6.49' } : d)) };
    for (const dev of doc.devices.filter(isMikrotik)) {
      const text = running(dev, doc);
      const empty = blank(dev);
      const docBlank = { ...doc, devices: doc.devices.map((d) => (d.id === dev.id ? empty : d)) };
      const r = importConfig(empty, docBlank, text);
      assert.deepEqual(r.ignored, [], `${label} / ${dev.label}`);
      const docAfter = { ...doc, devices: doc.devices.map((d) => (d.id === dev.id ? r.device : d)) };
      assert.equal(running(r.device, docAfter), text, `${label} / ${dev.label}`);
      count++;
    }
  }
  assert.ok(count >= 4, `${count} MikroTik testés`);
});

// « show run » d'un c3725 de GNS3 : 2 ports intégrés + NM-1FE-TX dans les slots 1 et 2, bloc archive
const C3725_R7 = `R7#show run
Building configuration...

Current configuration : 1058 bytes
!
version 12.4
service timestamps debug datetime msec
service timestamps log datetime msec
no service password-encryption
!
hostname R7
!
boot-start-marker
boot-end-marker
!
no aaa new-model
memory-size iomem 5
no ip icmp rate-limit unreachable
ip cef
!
no ip domain lookup
!         
multilink bundle-name authenticated
!
archive   
 log config
  hidekeys
! 
ip tcp synwait-time 5
!
interface FastEthernet0/0
 no ip address
 shutdown
 duplex auto
 speed auto
!
interface FastEthernet0/1
 no ip address
 shutdown
 duplex auto
 speed auto
!         
interface FastEthernet1/0
 no ip address
 shutdown
 duplex auto
 speed auto
!
interface FastEthernet2/0
 no ip address
 shutdown
 duplex auto
 speed auto
!
ip forward-protocol nd
!
no ip http server
no ip http secure-server
!
no cdp log mismatch duplex
!
control-plane
!
line con 0
 exec-timeout 0 0
 privilege level 15
 logging synchronous
line aux 0
 exec-timeout 0 0
 privilege level 15
 logging synchronous
line vty 0 4
 login    
!
!
end
`;

test('import GNS3 : c3725 reconnu à ses ports, lignes par défaut (archive, cdp, forward-protocol) acceptées', () => {
  const r = { id: 'r', type: 'router', model: '2911', label: 'R', modules: {}, config: { interfaces: [], routes: [] } };
  const a = analyzeInterfaces(r, C3725_R7);
  assert.deepEqual(a.missing, ['Fa0/0', 'Fa0/1', 'Fa1/0', 'Fa2/0']);
  assert.deepEqual(a.models[0], { id: 'c3725', label: 'Cisco 3725 (GNS3)', modules: { 1: 'NM-1FE-TX', 2: 'NM-1FE-TX' } });
  const dev = { ...r, model: 'c3725', modules: a.models[0].modules };
  const res = importConfig(dev, { devices: [dev], links: [] }, C3725_R7);
  assert.deepEqual(res.ignored, []);
  assert.equal(res.device.label, 'R7');
});
