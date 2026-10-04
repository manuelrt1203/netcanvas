// Schéma de démonstration : 2 VLAN derrière R1, une liaison série /30 vers R2, un serveur et Internet derrière R2.
export const DEMO = {
  format: 'netcanvas',
  version: 3,
  name: 'Démo : 2 VLAN, 2 routeurs',
  devices: [
    { id: 'pc1', type: 'pc', model: 'PC-PT', label: 'PC Compta', position: { x: -48, y: 528 }, config: { ip: '192.168.10.10', mask: 24, gateway: '192.168.10.1' } },
    { id: 'pc2', type: 'pc', model: 'PC-PT', label: 'PC Compta 2', position: { x: 192, y: 528 }, config: { ip: '192.168.10.11', mask: 24, gateway: '192.168.10.1' } },
    { id: 'pc3', type: 'pc', model: 'PC-PT', label: 'PC Atelier', position: { x: 432, y: 528 }, config: { ip: '192.168.20.10', mask: 24, gateway: '192.168.20.1' } },
    {
      id: 'sw1', type: 'switch', model: '2960-24TT', label: 'SW Étage', position: { x: 192, y: 320 },
      config: {
        ports: [
          { link: 'l1', name: 'Fa0/1', mode: 'access', vlan: 10 },
          { link: 'l2', name: 'Fa0/2', mode: 'access', vlan: 10 },
          { link: 'l3', name: 'Fa0/3', mode: 'access', vlan: 20 },
          { link: 'l4', name: 'Fa0/23', mode: 'access', vlan: 10 },
          { link: 'l5', name: 'Fa0/24', mode: 'access', vlan: 20 },
        ],
      },
    },
    {
      id: 'r1', type: 'router', model: '2911', modules: { 0: 'HWIC-2T' }, label: 'R1', position: { x: 192, y: 64 },
      config: {
        interfaces: [
          { link: 'l4', name: 'G0/0', ip: '192.168.10.1', mask: 24 },
          { link: 'l5', name: 'G0/1', ip: '192.168.20.1', mask: 24 },
          { link: 'l6', name: 'Se0/0/0', ip: '10.0.0.1', mask: 30, clockRate: 64000 },
        ],
        routes: [{ network: '0.0.0.0', mask: 0, nextHop: '10.0.0.2' }],
      },
    },
    {
      id: 'r2', type: 'router', model: '2911', modules: { 0: 'HWIC-2T' }, label: 'R2', position: { x: 560, y: 64 },
      config: {
        interfaces: [
          { link: 'l6', name: 'Se0/0/0', ip: '10.0.0.2', mask: 30 },
          { link: 'l7', name: 'G0/0', ip: '172.16.0.1', mask: 24 },
          { link: 'l9', name: 'G0/1', ip: '203.0.113.1', mask: 30 },
        ],
        routes: [{ network: '192.168.0.0', mask: 16, nextHop: '10.0.0.1' }],
      },
    },
    {
      id: 'sw2', type: 'switch', model: '2960-24TT', label: 'SW Serveurs', position: { x: 560, y: 320 },
      config: {
        ports: [
          { link: 'l7', name: 'Fa0/24', mode: 'access', vlan: 1 },
          { link: 'l8', name: 'Fa0/1', mode: 'access', vlan: 1 },
        ],
      },
    },
    { id: 'srv', type: 'server', model: 'Server-PT', label: 'Serveur Web', position: { x: 560, y: 528 }, config: { ip: '172.16.0.10', mask: 24, gateway: '172.16.0.1' } },
    { id: 'net', type: 'cloud', model: 'Cloud', label: 'Internet', position: { x: 864, y: 64 }, config: { ip: '203.0.113.2', mask: 30, gateway: '203.0.113.1' } },
  ],
  links: [
    { id: 'l1', source: 'pc1', target: 'sw1', sourceHandle: 't', targetHandle: 'b', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/1' },
    { id: 'l2', source: 'pc2', target: 'sw1', sourceHandle: 't', targetHandle: 'b', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/2' },
    { id: 'l3', source: 'pc3', target: 'sw1', sourceHandle: 't', targetHandle: 'b', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/3' },
    { id: 'l4', source: 'r1', target: 'sw1', sourceHandle: 'b', targetHandle: 't', cable: 'straight', sourceIface: 'G0/0', targetIface: 'Fa0/23' },
    { id: 'l5', source: 'r1', target: 'sw1', sourceHandle: 'l', targetHandle: 'l', cable: 'straight', sourceIface: 'G0/1', targetIface: 'Fa0/24' },
    { id: 'l6', source: 'r1', target: 'r2', sourceHandle: 'r', targetHandle: 'l', cable: 'serial', sourceIface: 'Se0/0/0', targetIface: 'Se0/0/0', dce: 'source' },
    { id: 'l7', source: 'r2', target: 'sw2', sourceHandle: 'b', targetHandle: 't', cable: 'straight', sourceIface: 'G0/0', targetIface: 'Fa0/24' },
    { id: 'l8', source: 'sw2', target: 'srv', sourceHandle: 'b', targetHandle: 't', cable: 'straight', sourceIface: 'Fa0/1', targetIface: 'Fa0' },
    { id: 'l9', source: 'r2', target: 'net', sourceHandle: 'r', targetHandle: 'l', cable: 'straight', sourceIface: 'G0/1', targetIface: 'Eth0' },
  ],
};

// --- Démos de routage dynamique --------------------------------------------------------------
// Petits constructeurs pour garder les schémas lisibles
const pc = (id, label, ip, mask, gateway, x, y, model = 'PC-PT', type = 'pc') => ({
  id, type, model, label, position: { x, y }, config: { ip, mask, gateway },
});
const sw = (id, label, ports, x, y) => ({
  id, type: 'switch', model: '2960-24TT', label, position: { x, y },
  config: { ports: ports.map(([link, name]) => ({ link, name, mode: 'access', vlan: 1 })) },
});
const router = (id, label, model, x, y, interfaces, extra = {}) => ({
  id, type: 'router', model, label, position: { x, y }, modules: extra.modules ?? {},
  config: {
    interfaces: interfaces.map(([link, name, ip, mask, more]) => ({ link, name, ip, mask, ...more })),
    routes: extra.routes ?? [],
    ...(extra.ospf ? { ospf: extra.ospf } : {}),
    ...(extra.rip ? { rip: extra.rip } : {}),
    ...(extra.bgp ? { bgp: extra.bgp } : {}),
  },
});
const link = (id, source, sourceIface, target, targetIface, cable = 'straight', handles = ['b', 't']) => ({
  id, source, target, sourceHandle: handles[0], targetHandle: handles[1], cable, sourceIface, targetIface,
});
const net = (network, wildcard, area) => ({ network, wildcard, area });

// OSPF : R1 en zone 1, R2 ABR (zones 1 et 0), MikroTik R3 en zone 0 qui annonce la route par défaut vers Internet.
export const OSPF_DEMO = {
  format: 'netcanvas',
  version: 3,
  name: 'Démo : OSPF 2 zones (Cisco + MikroTik)',
  devices: [
    pc('pc1', 'PC LAN', '192.168.1.10', 24, '192.168.1.1', 0, 512),
    sw('sw1', 'SW LAN', [['a1', 'Fa0/1'], ['a2', 'Fa0/24']], 0, 320),
    router('r1', 'R1', '2911', 0, 96, [
      ['a2', 'G0/0', '192.168.1.1', 24], ['a3', 'G0/1', '10.0.12.1', 30], [null, 'Lo0', '1.1.1.1', 32],
    ], { ospf: { processId: 1, networks: [net('192.168.1.0', '0.0.0.255', 1), net('10.0.12.0', '0.0.0.3', 1), net('1.1.1.1', '0.0.0.0', 1)], passive: ['G0/0'] } }),
    router('r2', 'R2 (ABR)', '2911', 320, 96, [
      ['a3', 'G0/0', '10.0.12.2', 30], ['a4', 'G0/1', '10.0.23.1', 30], [null, 'Lo0', '2.2.2.2', 32],
    ], { ospf: { processId: 1, networks: [net('10.0.12.0', '0.0.0.3', 1), net('10.0.23.0', '0.0.0.3', 0), net('2.2.2.2', '0.0.0.0', 0)] } }),
    router('r3', 'R3 MikroTik', 'RB4011', 640, 96, [
      ['a4', 'ether1', '10.0.23.2', 30], ['a5', 'ether2', '172.16.3.1', 24], ['a7', 'ether3', '203.0.113.1', 30], [null, 'lo', '3.3.3.3', 32],
    ], {
      routes: [{ network: '0.0.0.0', mask: 0, nextHop: '203.0.113.2' }],
      ospf: { routerId: '3.3.3.3', networks: [net('10.0.23.0', '0.0.0.3', 0), net('172.16.3.0', '0.0.0.255', 0), net('3.3.3.3', '0.0.0.0', 0)], passive: ['ether2'], defaultOriginate: true },
    }),
    sw('sw3', 'SW Serveurs', [['a5', 'Fa0/24'], ['a6', 'Fa0/1']], 640, 320),
    pc('srv', 'Serveur', '172.16.3.10', 24, '172.16.3.1', 640, 512, 'Server-PT', 'server'),
    { id: 'net', type: 'cloud', model: 'Cloud', label: 'Internet', position: { x: 960, y: 96 }, config: { ip: '203.0.113.2', mask: 30, gateway: '203.0.113.1' } },
  ],
  links: [
    link('a1', 'pc1', 'Fa0', 'sw1', 'Fa0/1', 'straight', ['t', 'b']),
    link('a2', 'r1', 'G0/0', 'sw1', 'Fa0/24'),
    link('a3', 'r1', 'G0/1', 'r2', 'G0/0', 'cross', ['r', 'l']),
    link('a4', 'r2', 'G0/1', 'r3', 'ether1', 'cross', ['r', 'l']),
    link('a5', 'r3', 'ether2', 'sw3', 'Fa0/24'),
    link('a6', 'srv', 'Fa0', 'sw3', 'Fa0/1', 'straight', ['t', 'b']),
    link('a7', 'r3', 'ether3', 'net', 'Eth0', 'straight', ['r', 'l']),
  ],
};

// BGP : AS 65001 (R1, R2 en iBGP entre loopbacks, OSPF comme IGP) et AS 65002 (MikroTik R3) en eBGP.
export const BGP_DEMO = {
  format: 'netcanvas',
  version: 3,
  name: 'Démo : BGP eBGP + iBGP',
  devices: [
    pc('pc1', 'PC AS65001', '192.168.1.10', 24, '192.168.1.1', 0, 512),
    sw('sw1', 'SW AS65001', [['b1', 'Fa0/1'], ['b2', 'Fa0/24']], 0, 320),
    router('r1', 'R1 (AS 65001)', '2911', 0, 96, [
      ['b2', 'G0/0', '192.168.1.1', 24], ['b3', 'G0/1', '10.0.12.1', 30], [null, 'Lo0', '1.1.1.1', 32],
    ], {
      ospf: { processId: 1, networks: [net('10.0.12.0', '0.0.0.3', 0), net('1.1.1.1', '0.0.0.0', 0)] },
      bgp: { asn: 65001, neighbors: [{ ip: '2.2.2.2', remoteAs: 65001, updateSource: 'Lo0' }], networks: [{ network: '192.168.1.0', mask: 24 }] },
    }),
    router('r2', 'R2 (AS 65001)', '2911', 320, 96, [
      ['b3', 'G0/0', '10.0.12.2', 30], ['b4', 'G0/1', '10.0.23.1', 30], [null, 'Lo0', '2.2.2.2', 32],
    ], {
      ospf: { processId: 1, networks: [net('10.0.12.0', '0.0.0.3', 0), net('2.2.2.2', '0.0.0.0', 0)] },
      bgp: {
        asn: 65001,
        neighbors: [
          { ip: '1.1.1.1', remoteAs: 65001, updateSource: 'Lo0', nextHopSelf: true },
          { ip: '10.0.23.2', remoteAs: 65002 },
        ],
      },
    }),
    router('r3', 'R3 MikroTik (AS 65002)', 'CCR2004', 640, 96, [
      ['b4', 'ether1', '10.0.23.2', 30], ['b5', 'ether2', '172.16.0.1', 24],
    ], { bgp: { asn: 65002, neighbors: [{ ip: '10.0.23.1', remoteAs: 65001 }], networks: [{ network: '172.16.0.0', mask: 24 }] } }),
    sw('sw3', 'SW AS65002', [['b5', 'Fa0/24'], ['b6', 'Fa0/1']], 640, 320),
    pc('srv', 'Serveur AS65002', '172.16.0.10', 24, '172.16.0.1', 640, 512, 'Server-PT', 'server'),
  ],
  links: [
    link('b1', 'pc1', 'Fa0', 'sw1', 'Fa0/1', 'straight', ['t', 'b']),
    link('b2', 'r1', 'G0/0', 'sw1', 'Fa0/24'),
    link('b3', 'r1', 'G0/1', 'r2', 'G0/0', 'cross', ['r', 'l']),
    link('b4', 'r2', 'G0/1', 'r3', 'ether1', 'cross', ['r', 'l']),
    link('b5', 'r3', 'ether2', 'sw3', 'Fa0/24'),
    link('b6', 'srv', 'Fa0', 'sw3', 'Fa0/1', 'straight', ['t', 'b']),
  ],
};

// Router-on-a-stick : un seul câble trunk entre le switch et R1, une sous-interface par VLAN.
export const ROAS_DEMO = {
  format: 'netcanvas',
  version: 3,
  name: 'Démo : router-on-a-stick (802.1Q)',
  devices: [
    pc('pc1', 'PC Profs', '192.168.10.10', 24, '192.168.10.1', -96, 448),
    pc('pc2', 'PC Élèves', '192.168.20.10', 24, '192.168.20.1', 288, 448),
    {
      id: 'sw1', type: 'switch', model: '2960-24TT', label: 'SW1', position: { x: 96, y: 256 },
      config: {
        ports: [
          { link: 'c1', name: 'Fa0/1', mode: 'access', vlan: 10 },
          { link: 'c2', name: 'Fa0/2', mode: 'access', vlan: 20 },
          { link: 'c3', name: 'G0/1', mode: 'trunk' },
        ],
        vlans: [{ id: 10, name: 'PROFS' }, { id: 20, name: 'ELEVES' }],
      },
    },
    router('r1', 'R1', '2911', 96, 32, [
      ['c3', 'G0/0', null, null],
      [null, 'G0/0.10', '192.168.10.1', 24, { parent: 'G0/0', vlan: 10 }],
      [null, 'G0/0.20', '192.168.20.1', 24, { parent: 'G0/0', vlan: 20 }],
    ]),
  ],
  links: [
    link('c1', 'pc1', 'Fa0', 'sw1', 'Fa0/1', 'straight', ['t', 'b']),
    link('c2', 'pc2', 'Fa0', 'sw1', 'Fa0/2', 'straight', ['t', 'b']),
    link('c3', 'r1', 'G0/0', 'sw1', 'G0/1', 'straight', ['b', 't']),
  ],
};

export const DEMOS = [
  { id: 'vlan', label: '2 VLAN, 2 routeurs (statique)', doc: DEMO },
  { id: 'roas', label: 'Router-on-a-stick (802.1Q)', doc: ROAS_DEMO },
  { id: 'ospf', label: 'OSPF 2 zones (Cisco + MikroTik)', doc: OSPF_DEMO },
  { id: 'bgp', label: 'BGP eBGP + iBGP', doc: BGP_DEMO },
];
