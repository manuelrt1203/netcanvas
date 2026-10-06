import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLine, shellFor } from './index.js';
import { importConfig } from './import.js';
import { computeRouting } from '../net/routing.js';

const router = (id, model, label) => ({ id, type: 'router', model, label, modules: {}, config: { interfaces: [], routes: [] } });
// Comme le terminal de l'appli : chaque ligne s'exécute sur une copie, gardée si elle a changé
const session = (dev, doc) => {
  const sh = shellFor(dev);
  const s = sh.newSession(dev);
  return (line) => {
    const r = runLine(sh, s, line, dev, doc);
    if (r.device) {
      for (const k of Object.keys(dev)) delete dev[k];
      Object.assign(dev, r.device);
    }
    return r.output;
  };
};

// Commandes tapées dans NetCanvas, puis dans un vrai FRR 7.5.1 (image frrouting/frr:v7.5.1, vtysh -f)
const COMMANDS = `configure terminal
hostname R1
ipv6 forwarding
ip route 0.0.0.0/0 10.0.0.254
ip route 172.16.0.0/16 10.0.0.2
ipv6 route ::/0 2001:db8::ff
interface eth0
 description vers R2
 ip address 10.0.0.1/24
 ip ospf cost 20
 ipv6 address 2001:db8::1/64
interface eth1
 ip address 192.168.1.1/24
 shutdown
interface lo
 ip address 1.1.1.1/32
router rip
 version 2
 redistribute static
 network 10.0.0.0/24
 network eth1
 passive-interface eth1
router bgp 65001
 bgp router-id 1.1.1.1
 neighbor 10.0.0.2 remote-as 65002
 neighbor 10.0.0.3 remote-as 65001
 neighbor 10.0.0.3 update-source lo
 neighbor 10.0.0.9 remote-as 65009
 neighbor 10.0.0.9 ebgp-multihop 2
 address-family ipv4 unicast
  network 192.168.1.0/24
  neighbor 10.0.0.3 next-hop-self
 exit-address-family
router ospf
 ospf router-id 1.1.1.1
 redistribute static
 passive-interface eth1
 network 10.0.0.0/24 area 0
 default-information originate always
router ospf6
 ospf6 router-id 1.1.1.1
 interface eth0 area 0.0.0.0
end`;

// « show running-config » du vrai FRR 7.5.1 après ces commandes (seuls la version « 7.5.1_git » et le hostname changent)
const REAL_FRR = `Building configuration...

Current configuration:
!
frr version 7.5.1
frr defaults traditional
hostname R1
!
ip route 0.0.0.0/0 10.0.0.254
ip route 172.16.0.0/16 10.0.0.2
ipv6 route ::/0 2001:db8::ff
!
interface eth0
 description vers R2
 ip address 10.0.0.1/24
 ip ospf cost 20
 ipv6 address 2001:db8::1/64
!
interface eth1
 ip address 192.168.1.1/24
 shutdown
!
interface lo
 ip address 1.1.1.1/32
!
router rip
 network 10.0.0.0/24
 network eth1
 passive-interface eth1
 redistribute static
 version 2
!
router bgp 65001
 bgp router-id 1.1.1.1
 neighbor 10.0.0.2 remote-as 65002
 neighbor 10.0.0.3 remote-as 65001
 neighbor 10.0.0.3 update-source lo
 neighbor 10.0.0.9 remote-as 65009
 neighbor 10.0.0.9 ebgp-multihop 2
 !
 address-family ipv4 unicast
  network 192.168.1.0/24
  neighbor 10.0.0.3 next-hop-self
 exit-address-family
!
router ospf
 ospf router-id 1.1.1.1
 redistribute static
 passive-interface eth1
 network 10.0.0.0/24 area 0
 default-information originate always
!
router ospf6
 ospf6 router-id 1.1.1.1
 interface eth0 area 0.0.0.0
!
line vty
!
end
`;

test('FRR : show running-config identique à un vrai FRR 7.5.1', () => {
  const r1 = router('a', 'FRR', 'R1');
  const run = session(r1, { devices: [r1], links: [] });
  for (const line of COMMANDS.split('\n')) assert.deepEqual(run(line.trim()), [], line);
  assert.equal(run('show running-config').join('\n'), REAL_FRR);
});

test('FRR : import du show running-config (aller-retour exact)', () => {
  const r1 = router('a', 'FRR', 'R');
  const r = importConfig(r1, { devices: [r1], links: [] }, REAL_FRR);
  assert.deepEqual(r.ignored, []);
  assert.equal(r.device.label, 'R1');
  const run = session(r.device, { devices: [r.device], links: [] });
  assert.equal(run('show running-config').join('\n'), REAL_FRR);
});

test('FRR : syntaxe Cisco refusée avec l\'équivalent, OSPF avec un c3725, coût 10 par défaut', () => {
  const a = router('a', 'FRR', 'R1');
  const b = router('b', 'c3725', 'R2');
  const doc = { devices: [a, b], links: [{ id: 'l', source: 'a', sourceIface: 'eth0', target: 'b', targetIface: 'Fa0/0', cable: 'cross' }] };
  const run = session(a, doc);
  run('configure terminal');
  run('interface eth0');
  assert.deepEqual(run('ip address 10.0.0.1 255.255.255.0'), [
    '% Unknown command: ip address 10.0.0.1 255.255.255.0', '% NetCanvas : FRR attend la notation CIDR : ip address 10.0.0.1/24', '']);
  assert.deepEqual(run('ip address 10.0.0.1/24'), []);
  assert.deepEqual(run('interface lo'), []);
  assert.deepEqual(run('ip address 1.1.1.1/32'), []);
  assert.match(run('router ospf 1').join('\n'), /sans numéro de processus/);
  assert.deepEqual(run('router ospf'), []);
  assert.match(run('network 10.0.0.0 0.0.0.255 area 0').join('\n'), /network 10\.0\.0\.0\/24 area 0/);
  assert.deepEqual(run('network 10.0.0.0/24 area 0'), []);
  assert.deepEqual(run('network 1.1.1.1/32 area 0'), []);
  assert.match(run('interface Fa0/0').join('\n'), /n'existe pas sur R1/);
  // Les deux façons d'activer OSPF ne se mélangent pas (message d'ospfd)
  run('interface eth0');
  assert.equal(run('ip ospf area 0')[0], 'Please remove all network commands first.');
  run('end');

  const ios = shellFor(b);
  const t = ios.newSession(b);
  for (const l of ['enable', 'conf t', 'int fa0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shut', 'exit', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0']) ios.run(t, l, b, doc);
  assert.match(run('show ip ospf neighbor').join('\n'), /10\.0\.0\.2 +1 +Full\/\S+ +35\.000s +10\.0\.0\.2 +eth0:10\.0\.0\.1/);
  // 1.1.1.1/32 vu de R2 : coût de lo chez FRR (10) + Fa0/0 du c3725 (1)
  const lo = [...computeRouting(doc).ribs.get('b').values()].find((r) => r.mask === 32 && r.nextHop === '10.0.0.1');
  assert.equal(lo?.metric, 11);
  assert.match(run('show ip route').join('\n'), /C>\* 10\.0\.0\.0\/24 is directly connected, eth0/);
  assert.match(run('ping 10.0.0.2').join('\n'), /5 packets transmitted, 5 received, 0% packet loss/);
});
