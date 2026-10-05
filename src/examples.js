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

// Switch niveau 3 : le 3560 route entre 3 VLAN (SVI + ip routing) et sort vers Internet par R1.
export const L3_DEMO = {
  format: 'netcanvas',
  version: 3,
  name: 'Démo : switch niveau 3 (SVI)',
  devices: [
    pc('pc1', 'PC Compta', '192.168.10.10', 24, '192.168.10.1', -160, 448),
    pc('pc2', 'PC Atelier', '192.168.20.10', 24, '192.168.20.1', 64, 448),
    pc('srv', 'Serveur', '192.168.30.10', 24, '192.168.30.1', 288, 448, 'Server-PT', 'server'),
    {
      id: 'sw', type: 'switch', model: '3560-24PS', label: 'SW-L3', position: { x: 64, y: 224 },
      config: {
        ports: [
          { link: 'd1', name: 'Fa0/1', mode: 'access', vlan: 10 },
          { link: 'd2', name: 'Fa0/2', mode: 'access', vlan: 20 },
          { link: 'd3', name: 'Fa0/3', mode: 'access', vlan: 30 },
          { link: 'd4', name: 'G0/1', mode: 'access', vlan: 99 },
        ],
        vlans: [{ id: 10, name: 'COMPTA' }, { id: 20, name: 'ATELIER' }, { id: 30, name: 'SERVEURS' }, { id: 99, name: 'UPLINK' }],
        interfaces: [
          { link: null, name: 'Vlan10', ip: '192.168.10.1', mask: 24 },
          { link: null, name: 'Vlan20', ip: '192.168.20.1', mask: 24 },
          { link: null, name: 'Vlan30', ip: '192.168.30.1', mask: 24 },
          { link: null, name: 'Vlan99', ip: '10.0.0.1', mask: 30 },
        ],
        ipRouting: true,
        routes: [{ network: '0.0.0.0', mask: 0, nextHop: '10.0.0.2' }],
      },
    },
    router('r1', 'R1', '2911', 64, 0, [['d4', 'G0/0', '10.0.0.2', 30], ['d5', 'G0/1', '203.0.113.1', 30]], {
      routes: [{ network: '192.168.0.0', mask: 16, nextHop: '10.0.0.1' }],
    }),
    { id: 'net', type: 'cloud', model: 'Cloud', label: 'Internet', position: { x: 384, y: 0 }, config: { ip: '203.0.113.2', mask: 30, gateway: '203.0.113.1' } },
  ],
  links: [
    link('d1', 'pc1', 'Fa0', 'sw', 'Fa0/1', 'straight', ['t', 'b']),
    link('d2', 'pc2', 'Fa0', 'sw', 'Fa0/2', 'straight', ['t', 'b']),
    link('d3', 'srv', 'Fa0', 'sw', 'Fa0/3', 'straight', ['t', 'b']),
    link('d4', 'r1', 'G0/0', 'sw', 'G0/1', 'straight', ['b', 't']),
    link('d5', 'r1', 'G0/1', 'net', 'Eth0', 'straight', ['r', 'l']),
  ],
};

// NAT/PAT : le LAN privé sort par l'adresse publique de R1 ; le serveur web local est publié en NAT statique.
// Le routeur du FAI ne connaît aucune adresse privée.
export const NAT_DEMO = {
  format: 'netcanvas',
  version: 3,
  name: 'Démo : NAT / PAT',
  devices: [
    pc('pc1', 'PC Maison', '192.168.1.10', 24, '192.168.1.1', -96, 448),
    pc('web', 'Serveur web local', '192.168.1.100', 24, '192.168.1.1', 192, 448, 'Server-PT', 'server'),
    sw('sw1', 'SW Maison', [['n1', 'Fa0/1'], ['n2', 'Fa0/2'], ['n3', 'Fa0/24']], 48, 256),
    {
      ...router('r1', 'R1 (box)', '2911', 48, 32, [
        ['n3', 'G0/0', '192.168.1.1', 24, { natInside: true }],
        ['n4', 'G0/1', '203.0.113.1', 29, { natOutside: true }],
      ], { routes: [{ network: '0.0.0.0', mask: 0, nextHop: '203.0.113.6' }] }),
    },
    router('isp', 'Routeur FAI', '2911', 384, 32, [['n4', 'G0/0', '203.0.113.6', 29], ['n5', 'G0/1', '198.51.100.1', 24]]),
    pc('srv', 'Serveur Internet', '198.51.100.10', 24, '198.51.100.1', 384, 256, 'Server-PT', 'server'),
  ],
  links: [
    link('n1', 'pc1', 'Fa0', 'sw1', 'Fa0/1', 'straight', ['t', 'b']),
    link('n2', 'web', 'Fa0', 'sw1', 'Fa0/2', 'straight', ['t', 'b']),
    link('n3', 'r1', 'G0/0', 'sw1', 'Fa0/24', 'straight', ['b', 't']),
    link('n4', 'r1', 'G0/1', 'isp', 'G0/0', 'cross', ['r', 'l']),
    link('n5', 'isp', 'G0/1', 'srv', 'Fa0', 'cross', ['b', 't']),
  ],
};
Object.assign(NAT_DEMO.devices.find((d) => d.id === 'r1').config, {
  acls: { 1: { type: 'standard', rules: [{ action: 'permit', src: { ip: '192.168.1.0', wildcard: '0.0.0.255' } }] } },
  nat: { statics: [{ local: '192.168.1.100', global: '203.0.113.5' }], dynamic: [{ acl: '1', iface: 'G0/1', overload: true }] },
});

// DHCP : R1 distribue le VLAN 10 ; le VLAN 20 passe par un relais (ip helper-address) vers le serveur du VLAN 30.
const dhcpPc = (id, label, x, y) => ({ id, type: 'pc', model: 'PC-PT', label, position: { x, y }, config: { ip: null, mask: null, gateway: null, dhcp: true } });
export const DHCP_DEMO = {
  format: 'netcanvas',
  version: 3,
  name: 'Démo : DHCP (serveur et relais)',
  devices: [
    dhcpPc('pc1', 'PC Profs 1', -192, 448),
    dhcpPc('pc2', 'PC Profs 2', -32, 448),
    dhcpPc('pc3', 'PC Élèves', 128, 448),
    {
      ...pc('srv', 'Serveur DHCP', '192.168.30.10', 24, '192.168.30.1', 288, 448, 'Server-PT', 'server'),
    },
    {
      id: 'sw1', type: 'switch', model: '2960-24TT', label: 'SW1', position: { x: 48, y: 256 },
      config: {
        ports: [
          { link: 'h1', name: 'Fa0/1', mode: 'access', vlan: 10 },
          { link: 'h2', name: 'Fa0/2', mode: 'access', vlan: 10 },
          { link: 'h3', name: 'Fa0/3', mode: 'access', vlan: 20 },
          { link: 'h4', name: 'Fa0/4', mode: 'access', vlan: 30 },
          { link: 'h5', name: 'G0/1', mode: 'trunk' },
        ],
        vlans: [{ id: 10, name: 'PROFS' }, { id: 20, name: 'ELEVES' }, { id: 30, name: 'SERVEURS' }],
      },
    },
    router('r1', 'R1', '2911', 48, 32, [
      ['h5', 'G0/0', null, null],
      [null, 'G0/0.10', '192.168.10.1', 24, { parent: 'G0/0', vlan: 10 }],
      [null, 'G0/0.20', '192.168.20.1', 24, { parent: 'G0/0', vlan: 20, helperAddress: '192.168.30.10' }],
      [null, 'G0/0.30', '192.168.30.1', 24, { parent: 'G0/0', vlan: 30 }],
    ]),
  ],
  links: [
    link('h1', 'pc1', 'Fa0', 'sw1', 'Fa0/1', 'straight', ['t', 'b']),
    link('h2', 'pc2', 'Fa0', 'sw1', 'Fa0/2', 'straight', ['t', 'b']),
    link('h3', 'pc3', 'Fa0', 'sw1', 'Fa0/3', 'straight', ['t', 'b']),
    link('h4', 'srv', 'Fa0', 'sw1', 'Fa0/4', 'straight', ['t', 'b']),
    link('h5', 'r1', 'G0/0', 'sw1', 'G0/1', 'straight', ['b', 't']),
  ],
};
DHCP_DEMO.devices.find((d) => d.id === 'r1').config.dhcp = {
  pools: [{ name: 'PROFS', network: '192.168.10.0', mask: 24, defaultRouter: '192.168.10.1', dns: '8.8.8.8' }],
  excluded: [['192.168.10.1', '192.168.10.9']],
};
DHCP_DEMO.devices.find((d) => d.id === 'srv').config.dhcp = {
  pools: [{ name: 'ELEVES', network: '192.168.20.0', mask: 24, defaultRouter: '192.168.20.1', dns: '8.8.8.8' }],
};

// Services : le serveur fait DNS et web, les PC l'utilisent comme serveur DNS ; une ACL laisse passer le web
// vers le serveur mais bloque le reste (dont le ping) depuis le VLAN 20
export const SERVICES_DEMO = (() => {
  const doc = structuredClone(DEMO);
  doc.name = 'Démo : DNS et web';
  const dev = (id) => doc.devices.find((d) => d.id === id);
  Object.assign(dev('srv').config, {
    services: {
      dns: { enabled: true, records: [{ name: 'www.entreprise.lan', ip: '172.16.0.10' }, { name: 'intranet.entreprise.lan', ip: '172.16.0.10' }] },
      http: { enabled: true, title: 'Intranet de l\'entreprise', body: 'Bienvenue sur le serveur web interne.' },
    },
  });
  for (const id of ['pc1', 'pc2', 'pc3']) dev(id).config.dns = '172.16.0.10';
  // R2 : depuis le VLAN 20, seulement DNS et web vers le serveur
  const r2 = dev('r2').config;
  r2.acls = {
    110: {
      type: 'extended',
      rules: [
        { action: 'permit', protocol: 'udp', src: { ip: '192.168.20.0', wildcard: '0.0.0.255' }, dst: { ip: '172.16.0.10', wildcard: '0.0.0.0' }, dstPort: 'eq domain' },
        { action: 'permit', protocol: 'tcp', src: { ip: '192.168.20.0', wildcard: '0.0.0.255' }, dst: { ip: '172.16.0.10', wildcard: '0.0.0.0' }, dstPort: 'eq www' },
        { action: 'deny', protocol: 'ip', src: { ip: '192.168.20.0', wildcard: '0.0.0.255' }, dst: { any: true } },
        { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true } },
      ],
    },
  };
  r2.interfaces.find((i) => i.name === 'G0/0').aclOut = '110';
  return doc;
})();

// Double pile : les mêmes réseaux en IPv6. PC Compta et PC Atelier en SLAAC (annonces RA de R1),
// les autres en statique, passerelle = link-local fe80::1 des routeurs
export const IPV6_DEMO = (() => {
  const doc = structuredClone(DEMO);
  doc.name = 'Démo : double pile IPv4 / IPv6';
  const dev = (id) => doc.devices.find((d) => d.id === id);
  const v6 = (id, name, ipv6, extra = {}) => Object.assign(dev(id).config.interfaces.find((i) => i.name === name), { ipv6, prefix6: 64, ...extra });
  Object.assign(dev('r1').config, { ipv6Routing: true, routes6: [{ network: '::', prefix: 0, nextHop: '2001:db8:acad:12::2' }] });
  v6('r1', 'G0/0', '2001:db8:acad:10::1', { linkLocal: 'fe80::1' });
  v6('r1', 'G0/1', '2001:db8:acad:20::1', { linkLocal: 'fe80::1' });
  v6('r1', 'Se0/0/0', '2001:db8:acad:12::1');
  Object.assign(dev('r2').config, { ipv6Routing: true, routes6: [{ network: '2001:db8:acad::', prefix: 48, nextHop: '2001:db8:acad:12::1' }] });
  v6('r2', 'Se0/0/0', '2001:db8:acad:12::2');
  v6('r2', 'G0/0', '2001:db8:acad:30::1', { linkLocal: 'fe80::1' });
  v6('r2', 'G0/1', '2001:db8:ffff::1');
  Object.assign(dev('pc1').config, { slaac: true });
  Object.assign(dev('pc2').config, { ipv6: '2001:db8:acad:10::11', prefix6: 64, gateway6: 'fe80::1' });
  Object.assign(dev('pc3').config, { slaac: true });
  Object.assign(dev('srv').config, { ipv6: '2001:db8:acad:30::10', prefix6: 64, gateway6: 'fe80::1' });
  Object.assign(dev('net').config, { ipv6: '2001:db8:ffff::2', prefix6: 64, gateway6: '2001:db8:ffff::1' });
  return doc;
})();

// Triangle de switches : STP bloque un port pour casser la boucle (SW Cœur est root bridge)
const trunk = (name) => ({ name, mode: 'trunk' });
export const STP_DEMO = {
  format: 'netcanvas',
  version: 3,
  name: 'Démo : STP (triangle de switches)',
  devices: [
    { id: 'sw1', type: 'switch', model: '2960-24TT', label: 'SW Cœur', position: { x: 320, y: 48 },
      config: { ports: [{ link: 'a', ...trunk('G0/1') }, { link: 'c', ...trunk('G0/2') }], stp: { priority: { 1: 4096 } } } },
    { id: 'sw2', type: 'switch', model: '2960-24TT', label: 'SW Gauche', position: { x: 96, y: 288 },
      config: { ports: [{ link: 'a', ...trunk('G0/1') }, { link: 'b', ...trunk('G0/2') }, { link: 'h1', name: 'Fa0/1', mode: 'access', vlan: 1 }] } },
    { id: 'sw3', type: 'switch', model: '2960-24TT', label: 'SW Droite', position: { x: 544, y: 288 },
      config: { ports: [{ link: 'b', ...trunk('G0/1') }, { link: 'c', ...trunk('G0/2') }, { link: 'h2', name: 'Fa0/1', mode: 'access', vlan: 1 }] } },
    { id: 'pc1', type: 'pc', model: 'PC-PT', label: 'PC A', position: { x: 96, y: 496 }, config: { ip: '192.168.1.10', mask: 24, gateway: '' } },
    { id: 'pc2', type: 'pc', model: 'PC-PT', label: 'PC B', position: { x: 544, y: 496 }, config: { ip: '192.168.1.20', mask: 24, gateway: '' } },
  ],
  links: [
    { id: 'a', source: 'sw1', target: 'sw2', sourceHandle: 'l', targetHandle: 't', cable: 'cross', sourceIface: 'G0/1', targetIface: 'G0/1' },
    { id: 'b', source: 'sw2', target: 'sw3', sourceHandle: 'r', targetHandle: 'l', cable: 'cross', sourceIface: 'G0/2', targetIface: 'G0/1' },
    { id: 'c', source: 'sw1', target: 'sw3', sourceHandle: 'r', targetHandle: 't', cable: 'cross', sourceIface: 'G0/2', targetIface: 'G0/2' },
    { id: 'h1', source: 'pc1', target: 'sw2', sourceHandle: 't', targetHandle: 'b', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/1' },
    { id: 'h2', source: 'pc2', target: 'sw3', sourceHandle: 't', targetHandle: 'b', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/1' },
  ],
};

// --- TP prêts à l'emploi : un réseau en panne et des objectifs vérifiés en direct --------------
const broken = (doc, name, exercise, breakIt) => {
  const copy = structuredClone(doc);
  copy.name = name;
  breakIt(copy);
  copy.exercise = exercise;
  return copy;
};
const devOf = (doc, id) => doc.devices.find((d) => d.id === id);

export const TP_INTERVLAN = broken(DEMO, 'TP : inter-VLAN en panne', {
  title: 'Réparer le réseau de l\'entreprise',
  instructions: [
    'Le service Atelier (VLAN 20) n\'arrive plus à joindre le reste du réseau, et le serveur web ne répond plus à personne.',
    'Trouve et corrige les pannes, sans changer le plan d\'adressage. Utilise le ping, le traceroute, les tables et le terminal.',
  ].join('\n'),
  objectives: [
    { id: 'o1', type: 'ping', from: 'pc1', to: '192.168.20.10' },
    { id: 'o2', type: 'ping', from: 'pc3', to: '172.16.0.10' },
    { id: 'o3', type: 'ping', from: 'pc1', to: '203.0.113.2' },
    { id: 'o4', type: 'route', router: 'r2', to: '192.168.10.0/24' },
  ],
}, (d) => {
  devOf(d, 'pc3').config.gateway = '192.168.20.254'; // mauvaise passerelle
  devOf(d, 'sw1').config.ports.find((p) => p.name === 'Fa0/24').vlan = 10; // port du routeur dans le mauvais VLAN
  devOf(d, 'r2').config.routes = []; // route de retour oubliée
});

export const TP_OSPF = broken(OSPF_DEMO, 'TP : OSPF ne monte pas', {
  title: 'Faire converger OSPF',
  instructions: [
    'Les trois routeurs doivent échanger leurs routes par OSPF (R1 en zone 1, R2 ABR, R3 MikroTik en zone 0).',
    'Le LAN doit joindre le serveur et Internet. Aucune route statique n\'est autorisée sur R1 et R2.',
  ].join('\n'),
  objectives: [
    { id: 'o1', type: 'ospf', a: 'r1', b: 'r2' },
    { id: 'o2', type: 'ospf', a: 'r2', b: 'r3' },
    { id: 'o3', type: 'ping', from: 'pc1', to: '172.16.3.10' },
    { id: 'o4', type: 'ping', from: 'pc1', to: '203.0.113.2' },
  ],
}, (d) => {
  devOf(d, 'r1').config.ospf.networks[1].area = 0; // zone fausse côté R1
  devOf(d, 'r2').config.ospf.passive = ['G0/1']; // interface vers R3 passive
  delete devOf(d, 'r3').config.ospf.defaultOriginate; // route par défaut non annoncée
});

export const DEMOS = [
  { id: 'vlan', label: '2 VLAN, 2 routeurs (statique)', doc: DEMO },
  { id: 'roas', label: 'Router-on-a-stick (802.1Q)', doc: ROAS_DEMO },
  { id: 'l3', label: 'Switch niveau 3 (SVI, ip routing)', doc: L3_DEMO },
  { id: 'nat', label: 'NAT / PAT (box, FAI, serveur publié)', doc: NAT_DEMO },
  { id: 'dhcp', label: 'DHCP (serveur et relais)', doc: DHCP_DEMO },
  { id: 'stp', label: 'STP (triangle de switches)', doc: STP_DEMO },
  { id: 'services', label: 'DNS et web (ACL par port)', doc: SERVICES_DEMO },
  { id: 'ipv6', label: 'Double pile IPv4 / IPv6', doc: IPV6_DEMO },
  { id: 'tp-vlan', label: 'TP : inter-VLAN en panne (3 pannes)', doc: TP_INTERVLAN },
  { id: 'tp-ospf', label: 'TP : OSPF ne monte pas (3 pannes)', doc: TP_OSPF },
  { id: 'ospf', label: 'OSPF 2 zones (Cisco + MikroTik)', doc: OSPF_DEMO },
  { id: 'bgp', label: 'BGP eBGP + iBGP', doc: BGP_DEMO },
];
