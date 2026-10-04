import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMOS, DEMO } from '../examples.js';
import { shellFor } from './index.js';
import { importConfig } from './import.js';
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
