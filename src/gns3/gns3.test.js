import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { crc32, readZip, writeZip } from './zip.js';
import { dynamipsPorts, fromGns3, gns3Files, readGns3, toGns3Project } from './gns3.js';
import { buildTopology } from '../net/topology.js';
import { computeRouting } from '../net/routing.js';

// Zip compressé (deflate), avec descripteurs de données et tailles à 0 dans les en-têtes locaux, comme GNS3
function deflateZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = enc.encode(f.data);
    const data = new Uint8Array(deflateRawSync(raw));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x08, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc32(raw), 4);
    desc.writeUInt32LE(data.length, 8);
    desc.writeUInt32LE(raw.length, 12);
    parts.push(local, name, data, desc);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + data.length + 16;
  }
  const size = central.reduce((s, p) => s + p.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

const node = (node_id, name, node_type, properties = {}, extra = {}) => ({ node_id, name, node_type, properties, x: 0, y: 0, ...extra });
const link = (a, ap, an, b, bp, bn) => ({ link_id: `${a}-${b}`, nodes: [{ node_id: a, adapter_number: ap, port_number: an }, { node_id: b, adapter_number: bp, port_number: bn }] });

const PROJECT = {
  type: 'topology', name: 'TP OSPF', revision: 9, version: '2.2.44',
  topology: {
    nodes: [
      node('r1', 'R1', 'dynamips', { platform: 'c3725', slot0: 'GT96100-FE', slot1: 'NM-1FE-TX', wic0: 'WIC-2T', dynamips_id: 1 }, { x: -200, y: -50 }),
      node('r2', 'R2', 'dynamips', { platform: 'c7200', slot0: 'C7200-IO-FE', slot1: 'PA-2FE-TX', dynamips_id: 2 }, { x: 100, y: -50 }),
      node('chr', 'CHR', 'qemu', { hda_disk_image: 'chr-6.49.19.img' }, { x: 300, y: 100 }),
      node('sw', 'Switch1', 'ethernet_switch', {
        ports_mapping: [
          { name: 'Ethernet0', port_number: 0, type: 'access', vlan: 10 },
          { name: 'Ethernet1', port_number: 1, type: 'access', vlan: 10 },
          { name: 'Ethernet2', port_number: 2, type: 'dot1q', vlan: 1 },
        ],
      }, { x: -200, y: 150 }),
      node('pc1', 'PC1', 'vpcs', {}, { x: -300, y: 300 }),
      node('fr', 'FR', 'frame_relay_switch'),
    ],
    links: [
      link('r1', 0, 16, 'r2', 0, 0), // Serial0/0 (WIC) <-> Fa0/0 : impossible en vrai, mais teste le calcul du port
      link('r1', 0, 0, 'sw', 0, 2),
      link('pc1', 0, 0, 'sw', 0, 0),
      link('r2', 1, 1, 'chr', 2, 0),
      link('r1', 0, 17, 'fr', 0, 0),
    ],
  },
};

const R1_CFG = `!
version 12.4
hostname R1
!
interface FastEthernet0/0
 ip address 192.168.10.1 255.255.255.0
 duplex auto
!
interface Serial0/0
 ip address 10.0.0.1 255.255.255.252
!
router ospf 1
 network 192.168.10.0 0.0.0.255 area 0
!
end
`;

test('ports Dynamips : intégrés, NM, WIC (16 × (n+1) + port)', () => {
  const ports = dynamipsPorts('c3725', { 1: 'NM-1FE-TX', wic0: 'WIC-2T', wic1: 'WIC-1T' });
  const at = (a, p) => ports.find((x) => x.adapter === a && x.port === p)?.name;
  assert.equal(at(0, 0), 'Fa0/0');
  assert.equal(at(0, 1), 'Fa0/1');
  assert.equal(at(1, 0), 'Fa1/0');
  assert.equal(at(0, 16), 'Se0/0');
  assert.equal(at(0, 17), 'Se0/1');
  assert.equal(at(0, 32), 'Se0/2');
  const c7200 = dynamipsPorts('c7200', { 0: 'C7200-IO-2FE', 3: 'PA-4T+' });
  assert.deepEqual(c7200.map((p) => `${p.adapter}/${p.port}=${p.name}`), ['0/0=Fa0/0', '0/1=Fa0/1', '3/0=Se3/0', '3/1=Se3/1', '3/2=Se3/2', '3/3=Se3/3']);
});

test('zip : écriture puis lecture', async () => {
  const bytes = writeZip([{ name: 'a.txt', data: 'bonjour' }, { name: 'd/b.bin', data: new Uint8Array([1, 2, 3]) }]);
  const files = readZip(bytes);
  assert.equal(new TextDecoder().decode(await files.get('a.txt')()), 'bonjour');
  assert.deepEqual([...(await files.get('d/b.bin')())], [1, 2, 3]);
});

test('import d\'un projet portable GNS3 (zip deflate) : équipements, ports, VLAN, configs', async () => {
  const zip = deflateZip([
    { name: 'project.gns3', data: JSON.stringify(PROJECT) },
    { name: 'project-files/dynamips/r1/configs/i1_startup-config.cfg', data: R1_CFG },
    { name: 'project-files/vpcs/pc1/startup.vpc', data: 'set pcname PC1\nip 192.168.10.10 192.168.10.1 24\n' },
  ]);
  const { doc, warnings, configs } = await readGns3(zip);
  assert.equal(doc.name, 'TP OSPF');
  assert.equal(configs, 2);
  const by = (label) => doc.devices.find((d) => d.label === label);
  assert.equal(by('R1').model, 'c3725');
  assert.deepEqual(by('R1').modules, { 1: 'NM-1FE-TX', wic0: 'WIC-2T' });
  assert.equal(by('R2').model, 'c7200');
  assert.equal(by('CHR').model, 'CHR-6.49');
  assert.equal(by('Switch1').model, '2960-24TT');
  assert.equal(by('PC1').type, 'pc');
  assert.equal(by('FR'), undefined);
  assert.ok(warnings.some((w) => /FR .*frame_relay_switch/.test(w)));

  const ifaces = (a, b) => doc.links.find((l) => l.source === by(a).id && l.target === by(b).id);
  assert.equal(ifaces('R1', 'R2').sourceIface, 'Se0/0');
  assert.equal(ifaces('R1', 'R2').targetIface, 'Fa0/0');
  assert.equal(ifaces('R1', 'Switch1').targetIface, 'Fa0/3');
  assert.equal(ifaces('R1', 'Switch1').cable, 'straight');
  assert.equal(ifaces('R2', 'CHR').sourceIface, 'Fa1/1');
  assert.equal(ifaces('R2', 'CHR').targetIface, 'ether3');

  const sw = by('Switch1').config;
  assert.deepEqual(sw.ports.find((p) => p.name === 'Fa0/1'), { link: ifaces('PC1', 'Switch1').id, name: 'Fa0/1', mode: 'access', vlan: 10 });
  assert.equal(sw.ports.find((p) => p.name === 'Fa0/3').mode, 'trunk');
  assert.deepEqual(sw.vlans, [{ id: 10, name: 'VLAN0010' }]);

  // Configs : R1 (startup-config) et PC1 (startup.vpc)
  const r1 = by('R1').config;
  assert.equal(r1.interfaces.find((i) => i.name === 'Fa0/0').ip, '192.168.10.1');
  assert.equal(r1.interfaces.find((i) => i.name === 'Se0/0').ip, '10.0.0.1');
  assert.ok(r1.ospf);
  assert.deepEqual([by('PC1').config.ip, by('PC1').config.mask, by('PC1').config.gateway], ['192.168.10.10', 24, '192.168.10.1']);
  assert.ok(warnings.some((w) => /^CHR : la config d'une machine virtuelle/.test(w)));
});

test('import d\'un .gns3 seul : topologie, et conseil pour avoir les configs', async () => {
  const { doc, warnings, configs } = await readGns3(new TextEncoder().encode(JSON.stringify(PROJECT)));
  assert.equal(configs, 0);
  assert.equal(doc.devices.length, 5);
  assert.ok(warnings.some((w) => /Export portable project/.test(w)));
  await assert.rejects(readGns3(new TextEncoder().encode('{"format":"netcanvas"}')), /pas un projet GNS3/);
});

// Schéma NetCanvas : 2911 -- switch -- PC, 2911 -- c3725 (WIC série), c3725 -- CHR, Internet
const DOC = {
  format: 'netcanvas', version: 3, name: 'Labo é',
  devices: [
    { id: 'r1', type: 'router', model: '2911', modules: { 0: 'HWIC-2T' }, label: 'R1', position: { x: 0, y: 0 }, config: { interfaces: [
      { link: 'l1', name: 'G0/0', ip: '192.168.1.1', mask: 24 }, { link: 'l3', name: 'Se0/0/0', ip: '10.0.0.1', mask: 30, clockRate: 64000 },
    ], routes: [] } },
    { id: 'r2', type: 'router', model: 'c3725', modules: { wic0: 'WIC-2T' }, label: 'R2', position: { x: 300, y: 0 }, config: { interfaces: [
      { link: 'l3', name: 'Se0/1', ip: '10.0.0.2', mask: 30 }, { link: 'l4', name: 'Fa0/1', ip: '10.0.1.1', mask: 30 },
    ], routes: [{ network: '192.168.1.0', mask: 24, nextHop: '10.0.0.1' }] } },
    { id: 'chr', type: 'router', model: 'CHR', modules: {}, label: 'CHR', position: { x: 600, y: 0 }, config: { interfaces: [{ link: 'l4', name: 'ether2', ip: '10.0.1.2', mask: 30 }], routes: [] } },
    { id: 's1', type: 'switch', model: '2960-24TT', label: 'S1', position: { x: 0, y: 200 }, config: { ports: [
      { link: 'l1', name: 'Fa0/1', mode: 'access', vlan: 20 }, { link: 'l2', name: 'Fa0/2', mode: 'access', vlan: 20 },
    ], vlans: [{ id: 20, name: 'PROFS' }] } },
    { id: 'pc', type: 'pc', model: 'PC-PT', label: 'PC 1', position: { x: 0, y: 400 }, config: { ip: '192.168.1.10', mask: 24, gateway: '192.168.1.1' } },
  ],
  links: [
    { id: 'l1', source: 'r1', target: 's1', cable: 'straight', sourceIface: 'G0/0', targetIface: 'Fa0/1' },
    { id: 'l2', source: 'pc', target: 's1', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/2' },
    { id: 'l3', source: 'r1', target: 'r2', cable: 'serial', sourceIface: 'Se0/0/0', targetIface: 'Se0/1', dce: 'source' },
    { id: 'l4', source: 'r2', target: 'chr', cable: 'cross', sourceIface: 'Fa0/1', targetIface: 'ether2' },
  ],
};

test('export .gns3project : nœuds, slots, ports, configs de démarrage', () => {
  let n = 0;
  const { files, project, warnings } = gns3Files(DOC, () => `id-${++n}`);
  const nodes = Object.fromEntries(project.topology.nodes.map((x) => [x.name, x]));
  assert.equal(nodes.R1.node_type, 'dynamips');
  assert.equal(nodes.R1.properties.platform, 'c7200');
  assert.equal(nodes.R2.properties.platform, 'c3725');
  assert.equal(nodes.R2.properties.slot0, 'GT96100-FE');
  assert.equal(nodes.R2.properties.wic0, 'WIC-2T');
  assert.equal(nodes.CHR.node_type, 'qemu');
  assert.equal(nodes.S1.node_type, 'ethernet_switch');
  assert.deepEqual(nodes.S1.properties.ports_mapping.slice(0, 2).map((p) => [p.type, p.vlan]), [['access', 20], ['access', 20]]);
  assert.equal(nodes['PC-1'].node_type, 'vpcs');

  const ep = (name) => project.topology.links.map((l) => l.nodes.find((e) => e.node_id === nodes[name].node_id)).filter(Boolean);
  // c3725 : Se0/1 = WIC 0 port 1 -> adapter 0, port 17 ; Fa0/1 -> 0/1 ; CHR ether2 -> adapter 1
  assert.deepEqual(ep('R2').map((e) => `${e.adapter_number}/${e.port_number}`).sort(), ['0/1', '0/17']);
  assert.deepEqual(ep('CHR').map((e) => e.adapter_number), [1]);

  const cfg = (name) => files.find((f) => f.name.startsWith(`project-files/dynamips/${nodes[name].node_id}/`)).data;
  assert.match(cfg('R2'), /interface Serial0\/1\n description Vers R1 Serial1\/0\n ip address 10\.0\.0\.2 255\.255\.255\.252/);
  assert.match(cfg('R1'), /interface FastEthernet0\/0/);
  assert.match(files.find((f) => f.name === `project-files/vpcs/${nodes['PC-1'].node_id}/startup.vpc`).data, /^set pcname PC-1\nip 192\.168\.1\.10 192\.168\.1\.1 24\n/);
  assert.ok(warnings.some((w) => /R1 .*c7200/.test(w)));
  assert.ok(warnings.some((w) => /CHR : GNS3 ne précharge pas/.test(w)));
});

test('aller-retour NetCanvas -> GNS3 -> NetCanvas : même routage', async () => {
  const back = (await readGns3(toGns3Project(DOC))).doc;
  const by = (label) => back.devices.find((d) => d.label === label);
  assert.equal(by('R2').model, 'c3725');
  assert.deepEqual(by('R2').modules, { wic0: 'WIC-2T' });
  assert.equal(by('R1').model, 'c7200');
  assert.equal(by('PC-1').config.ip, '192.168.1.10');
  // R2 garde sa route statique et ses deux réseaux connectés
  const rib = computeRouting(back, buildTopology(back)).ribs.get(by('R2').id);
  const prefixes = [...rib.values()].map((r) => `${r.proto} ${r.net >>> 0}/${r.mask}`);
  assert.ok(prefixes.some((p) => p.startsWith('S ')), prefixes.join(', '));
  assert.ok([...rib.values()].filter((r) => r.proto === 'C').length >= 2);
});
