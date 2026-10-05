// Vérifie l'export Containerlab sur un vrai réseau Linux, sans Docker ni root :
// un namespace réseau par équipement (dans un namespace utilisateur), des paires veth pour les câbles,
// puis les commandes `exec` générées. Les pings réels doivent donner le même verdict que le simulateur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { BGP_DEMO, DEMO, DHCP_DEMO, IPV6_DEMO, OSPF6_DEMO, L3_DEMO, NAT_DEMO, OSPF_DEMO, ROAS_DEMO, STP_DEMO } from '../examples.js';
import { buildTopology } from '../net/topology.js';
import { isRouting, v6Forwarding } from '../net/topology.js';
import { simulatePing } from '../net/simulate.js';
import { clabCommands } from './containerlab.js';
import { withLeases } from '../net/dhcp.js';
import { interfaceTable } from './common.js';

const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

const probe = spawnSync('unshare', ['-rnm', 'sh', '-c', 'mount -t tmpfs none /run && mkdir -p /run/netns && ip netns add t && bridge -V'], { encoding: 'utf8' });
const skip = probe.status !== 0 && 'namespaces utilisateur indisponibles (unshare -rnm) ou iproute2 absent';
// En CI, ces tests doivent tourner : un « ignoré » silencieux masquerait une régression
if (skip && process.env.NETCANVAS_REQUIRE_NETNS) throw new Error(`Tests réseau réels impossibles : ${skip}\n${probe.stderr}`);

// Monte le réseau puis lance les pings ; renvoie { "src>ip": true|false }
// wait : secondes avant les pings (STP : écoute puis apprentissage) ; probes : commandes dont on veut la sortie
function runLab(doc, pings, { wait = 1, probes = [] } = {}) {
  const { table } = interfaceTable(doc);
  const commands = clabCommands(doc);
  const script = ['set -e', 'mount -t tmpfs none /run', 'mkdir -p /run/netns'];

  for (const d of doc.devices) {
    script.push(`ip netns add ${d.id}`, `ip -n ${d.id} link set lo up`);
    script.push(`ip netns exec ${d.id} sh -c 'echo ${isRouting(d) ? 1 : 0} > /proc/sys/net/ipv4/ip_forward'`);
    // IPv6 : comme les sysctls de l'export (forwarding des routeurs IPv6)
    script.push(`ip netns exec ${d.id} sh -c 'echo ${isRouting(d) && v6Forwarding(d) ? 1 : 0} > /proc/sys/net/ipv6/conf/all/forwarding'`);
  }
  doc.links.forEach((l, i) => {
    const a = table.get(l.source).find((r) => r.link === l.id);
    const b = table.get(l.target).find((r) => r.link === l.id);
    script.push(
      `ip link add va${i} type veth peer name vb${i}`,
      `ip link set va${i} netns ${l.source}`, `ip -n ${l.source} link set va${i} name eth${a.index + 1}`,
      `ip link set vb${i} netns ${l.target}`, `ip -n ${l.target} link set vb${i} name eth${b.index + 1}`,
    );
  });
  for (const d of doc.devices) {
    for (const c of commands.get(d.id)) script.push(`ip netns exec ${d.id} sh -c ${sh(c)}`);
  }
  script.push('set +e', `sleep ${wait}`); // laisse les bridges passer en forwarding
  for (const [key, ns, cmd] of probes) script.push(`echo "${key} $(ip netns exec ${ns} ${cmd} | tr '\n' ' ')"`);
  for (const [src, ip] of pings) {
    script.push(`ip netns exec ${src} ping -c1 -W1 ${ip} >/dev/null 2>&1 && echo "${src}>${ip} ok" || echo "${src}>${ip} ko"`);
  }

  const r = spawnSync('unshare', ['-rnm', 'sh', '-c', script.join('\n')], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(r.stdout.trim().split('\n').map((line) => {
    const [key, ...rest] = line.split(' ');
    const verdict = rest.join(' ');
    return [key, verdict === 'ok' ? true : verdict === 'ko' ? false : verdict];
  }));
}

function assertMatchesSimulator(doc, pings) {
  const real = runLab(doc, pings);
  for (const [src, ip, expected] of pings) {
    const simulated = simulatePing(doc, src, ip).ok;
    assert.equal(simulated, expected, `simulateur ${src} -> ${ip}`);
    assert.equal(real[`${src}>${ip}`], expected, `réseau Linux ${src} -> ${ip}`);
  }
}

test('containerlab : la démo fonctionne vraiment (VLAN, inter-VLAN, 2 routeurs)', { skip }, () => {
  assertMatchesSimulator(structuredClone(DEMO), [
    ['pc1', '192.168.10.11', true], // même VLAN
    ['pc1', '192.168.20.10', true], // inter-VLAN via R1
    ['pc3', '172.16.0.10', true], // R1 -> R2 -> serveur
    ['pc2', '203.0.113.2', true], // route par défaut jusqu'à Internet
  ]);
});

test('containerlab : un port dans le mauvais VLAN coupe vraiment le ping', { skip }, () => {
  const doc = structuredClone(DEMO);
  doc.devices.find((d) => d.id === 'sw1').config.ports.find((p) => p.link === 'l3').vlan = 10;
  assertMatchesSimulator(doc, [
    ['pc1', '192.168.10.11', true],
    ['pc1', '192.168.20.10', false], // PC Atelier isolé de sa passerelle
  ]);
});

test('containerlab : trunk 802.1Q entre deux switches', { skip }, () => {
  const host = (id, ip) => ({ id, type: 'pc', label: id, position: { x: 0, y: 0 }, config: { ip, mask: 24, gateway: null } });
  const doc = {
    format: 'netcanvas', version: 2, name: 'Trunk',
    devices: [
      host('pca', '10.0.10.1'), host('pcb', '10.0.10.2'), host('pcc', '10.0.10.3'),
      { id: 'swa', type: 'switch', label: 'SWA', position: { x: 0, y: 0 }, config: { ports: [
        { link: 'a', name: 'Fa0/1', mode: 'access', vlan: 10 },
        { link: 't', name: 'G0/1', mode: 'trunk' },
      ] } },
      { id: 'swb', type: 'switch', label: 'SWB', position: { x: 0, y: 0 }, config: { ports: [
        { link: 't', name: 'G0/1', mode: 'trunk' },
        { link: 'b', name: 'Fa0/1', mode: 'access', vlan: 10 },
        { link: 'c', name: 'Fa0/2', mode: 'access', vlan: 20 },
      ] } },
    ],
    links: [
      { id: 'a', source: 'pca', target: 'swa' },
      { id: 't', source: 'swa', target: 'swb' },
      { id: 'b', source: 'pcb', target: 'swb' },
      { id: 'c', source: 'pcc', target: 'swb' },
    ],
  };
  assertMatchesSimulator(doc, [
    ['pca', '10.0.10.2', true], // VLAN 10 traverse le trunk
    ['pca', '10.0.10.3', false], // même sous-réseau mais VLAN 20
  ]);
});

test('containerlab : OSPF 2 zones (routes calculées par NetCanvas, pings réels)', { skip }, () => {
  assertMatchesSimulator(structuredClone(OSPF_DEMO), [
    ['pc1', '172.16.3.10', true], // O IA via l'ABR
    ['pc1', '203.0.113.2', true], // O*E2 jusqu'à Internet
    ['pc1', '3.3.3.3', true], // loopback du MikroTik
  ]);
});

test('containerlab : BGP eBGP + iBGP (next-hop résolu par OSPF)', { skip }, () => {
  assertMatchesSimulator(structuredClone(BGP_DEMO), [
    ['pc1', '172.16.0.10', true],
    ['srv', '192.168.1.10', true],
  ]);
  // Sans next-hop-self, le simulateur et Linux tombent d'accord : plus de chemin
  const broken = structuredClone(BGP_DEMO);
  delete broken.devices.find((d) => d.id === 'r2').config.bgp.neighbors[0].nextHopSelf;
  assertMatchesSimulator(broken, [['pc1', '172.16.0.10', false]]);
});

test('containerlab : router-on-a-stick (sous-interfaces 802.1Q sur un trunk)', { skip }, () => {
  assertMatchesSimulator(structuredClone(ROAS_DEMO), [['pc1', '192.168.20.10', true], ['pc2', '192.168.10.1', true]]);
  const wrong = structuredClone(ROAS_DEMO);
  wrong.devices.find((d) => d.id === 'r1').config.interfaces.find((i) => i.name === 'G0/0.20').vlan = 30;
  assertMatchesSimulator(wrong, [['pc1', '192.168.20.10', false]]);
});

test('containerlab : switch niveau 3 (SVI sur bridge Linux, routage inter-VLAN)', { skip }, () => {
  assertMatchesSimulator(structuredClone(L3_DEMO), [
    ['pc1', '192.168.30.10', true],
    ['pc2', '203.0.113.2', true],
  ]);
  const noRouting = structuredClone(L3_DEMO);
  delete noRouting.devices.find((d) => d.id === 'sw').config.ipRouting;
  assertMatchesSimulator(noRouting, [['pc1', '192.168.30.10', false], ['pc1', '192.168.10.1', true]]);
});

test('containerlab : ACL Cisco et pare-feu MikroTik traduits en iptables', { skip }, () => {
  const acl = structuredClone(DEMO);
  const r1 = acl.devices.find((d) => d.id === 'r1');
  r1.config.acls = {
    10: { type: 'standard', rules: [{ action: 'deny', src: { ip: '192.168.10.0', wildcard: '0.0.0.255' } }, { action: 'permit', src: { any: true } }] },
    BLOQUE: { type: 'extended', rules: [{ action: 'deny', protocol: 'icmp', src: { any: true }, dst: { ip: '10.0.0.2', wildcard: '0.0.0.0' } }, { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true } }] },
  };
  r1.config.interfaces.find((i) => i.name === 'Se0/0/0').aclOut = '10';
  r1.config.interfaces.find((i) => i.name === 'G0/1').aclIn = 'BLOQUE';
  assertMatchesSimulator(acl, [
    ['pc1', '172.16.0.10', false], // ACL 10 en sortie
    ['pc3', '172.16.0.10', true], // BLOQUE laisse passer, puis ACL 10 laisse passer
    ['pc3', '10.0.0.2', false], // BLOQUE en entrée
  ]);

  const fw = structuredClone(OSPF_DEMO);
  fw.devices.find((d) => d.id === 'r3').config.firewall = [{ chain: 'forward', action: 'drop', protocol: 'icmp', src: '192.168.1.0/24', dst: '172.16.3.0/24' }];
  assertMatchesSimulator(fw, [['pc1', '172.16.3.10', false], ['pc1', '203.0.113.2', true]]);
});

test('containerlab : NAT/PAT et NAT statique (iptables -t nat)', { skip }, () => {
  assertMatchesSimulator(structuredClone(NAT_DEMO), [
    ['pc1', '198.51.100.10', true], // PAT
    ['srv', '203.0.113.5', true], // NAT statique entrant
    ['web', '198.51.100.10', true], // NAT statique sortant
  ]);
  const off = structuredClone(NAT_DEMO);
  for (const i of off.devices.find((d) => d.id === 'r1').config.interfaces) delete i.natInside;
  assertMatchesSimulator(off, [['pc1', '198.51.100.10', false]]);
});

test('containerlab : DHCP (baux calculés installés, relais compris)', { skip }, () => {
  // PC1 : 192.168.10.10 (pool de R1), PC3 : 192.168.20.2 (serveur via relais)
  assertMatchesSimulator(structuredClone(DHCP_DEMO), [['pc1', '192.168.20.2', true], ['pc3', '192.168.30.10', true]]);
});

test('containerlab : STP du noyau Linux, même port bloqué que NetCanvas, ping par la racine', { skip }, () => {
  const doc = structuredClone(STP_DEMO);
  const { table } = interfaceTable(doc);
  const topo = buildTopology(doc);
  const [[blockedKey]] = [...topo.stp.vlans.get(1).ports].filter(([, p]) => p.state === 'blocking');
  const [sw, link] = blockedKey.split('|');
  const eth = `eth${table.get(sw).find((r) => r.link === link).index + 1}`;
  const res = runLab(doc, [['pc1', '192.168.1.20']], {
    wait: 7,
    probes: doc.devices.filter((d) => d.type === 'switch').map((d) => [`stp-${d.id}`, d.id, 'bridge link show']),
  });
  assert.equal(res['pc1>192.168.1.20'], true);
  assert.equal(simulatePing(doc, 'pc1', '192.168.1.20').ok, true);
  // Un seul port bloqué dans tout le réseau, et c'est celui calculé par NetCanvas
  const blocking = Object.entries(res).filter(([k]) => k.startsWith('stp-'))
    .flatMap(([k, v]) => [...v.matchAll(/(eth\d+)@?\S*:.*?state blocking/g)].map((m) => `${k.slice(4)}|${m[1]}`));
  assert.deepEqual(blocking, [`${sw}|${eth}`]);
});

test('containerlab : IPv6 sur un vrai réseau (SLAAC calculé, passerelle link-local, routes IPv6)', { skip }, () => {
  const doc = structuredClone(IPV6_DEMO);
  assertMatchesSimulator(doc, [
    ['pc1', '2001:db8:acad:30::10', true], // SLAAC -> fe80::1 (R1) -> série -> R2 -> serveur
    ['pc2', '2001:db8:ffff::2', true], // route par défaut IPv6 jusqu'à Internet
    ['pc3', '2001:db8:acad:10::11', true], // inter-VLAN en IPv6
    ['pc2', '2001:db8:dead::1', false], // aucune route sur R2
  ]);
});

test('containerlab : routage IPv6 coupé sur R2 = ping IPv6 perdu, IPv4 intact', { skip }, () => {
  const doc = structuredClone(IPV6_DEMO);
  doc.devices.find((d) => d.id === 'r2').config.ipv6Routing = false;
  assertMatchesSimulator(doc, [
    ['pc2', '2001:db8:acad:30::10', false],
    ['pc2', '172.16.0.10', true],
  ]);
});

test('containerlab : OSPFv3 (routes calculées, sauts suivants link-local) sur un vrai réseau', { skip }, () => {
  const doc = structuredClone(OSPF6_DEMO);
  const srv = withLeases(doc).devices.find((d) => d.id === 'srv').config.slaac6.ip;
  assertMatchesSimulator(doc, [
    ['pc1', srv, true], // zone 1 -> ABR -> zone 0 (MikroTik)
    ['pc1', '2001:db8:f::2', true], // route par défaut annoncée par OSPFv3 (O*E2)
    ['pc1', '2001:db8:ffff::3', true], // loopback /128 du MikroTik
    ['pc1', '192.168.1.1', true], // IPv4 toujours là
  ]);
});

test('containerlab : ACL IPv6 (ip6tables) et piège NDP du « deny ipv6 any any » explicite', { skip }, () => {
  const any = { any: true };
  const doc = structuredClone(IPV6_DEMO);
  const r2 = doc.devices.find((d) => d.id === 'r2').config;
  r2.acls6 = { SERVEUR: { rules: [{ action: 'deny', protocol: 'icmp', src: { prefix: '2001:db8:acad:20::', len: 64 }, dst: any, icmpType: 'echo-request' }, { action: 'permit', protocol: 'ipv6', src: any, dst: any }] } };
  r2.interfaces.find((i) => i.name === 'G0/0').aclOut6 = 'SERVEUR';
  assertMatchesSimulator(doc, [
    ['pc3', '2001:db8:acad:30::10', false], // VLAN 20 refusé par l'ACL IPv6
    ['pc2', '2001:db8:acad:30::10', true], // VLAN 10 autorisé
    ['pc3', '172.16.0.10', true], // l'IPv4 passe toujours
  ]);
  // deny explicite en entrée de R1 G0/0 : plus de NDP, même vers la passerelle
  const trap = structuredClone(IPV6_DEMO);
  const r1 = trap.devices.find((d) => d.id === 'r1').config;
  r1.acls6 = { IN: { rules: [{ action: 'permit', protocol: 'icmp', src: any, dst: any, icmpType: 'echo-request' }, { action: 'deny', protocol: 'ipv6', src: any, dst: any }] } };
  r1.interfaces.find((i) => i.name === 'G0/0').aclIn6 = 'IN';
  assertMatchesSimulator(trap, [
    ['pc2', '2001:db8:acad:30::10', false],
    ['pc3', '2001:db8:acad:30::10', true], // VLAN 20 : autre interface, pas d'ACL
  ]);
});
