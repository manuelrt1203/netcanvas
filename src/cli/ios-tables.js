// Terminal IOS : tables ARP et MAC, détail des interfaces (adresse MAC, état, débit).
import { kw, rest } from './engine.js';
import { pad, getEntry, linkOf } from './device.js';
import { arpRows, clearArp, clearMac, macRows } from '../net/tables.js';
import { macCisco, macOf } from '../net/mac.js';
import { buildTopology, isLoopbackName } from '../net/topology.js';
import { cidrToMask } from '../net/ip.js';
import { iosLongName } from '../export/cisco.js';

export function showArp(dev, doc) {
  const rows = [`${pad('Protocol', 10)}${pad('Address', 17)}${pad('Age (min)', 11)}${pad('Hardware Addr', 16)}${pad('Type', 7)}Interface`];
  for (const e of arpRows(dev, doc)) {
    const age = e.own ? '-' : String(Math.floor(e.age / 60));
    rows.push(`${pad('Internet', 10)}${pad(e.ip, 17)}${pad(age.padStart(8), 11)}${pad(macCisco(e.mac), 16)}${pad('ARPA', 7)}${iosLongName(e.iface)}`);
  }
  return [...rows, ''];
}

export function showMacTable(dev, doc) {
  const rows = macRows(dev, doc);
  return [
    '          Mac Address Table',
    '-------------------------------------------',
    '',
    `${pad('Vlan', 8)}${pad('Mac Address', 18)}${pad('Type', 12)}Ports`,
    `${pad('----', 8)}${pad('-----------', 18)}${pad('--------', 12)}-----`,
    ...rows.map((e) => `${String(e.vlan).padStart(4)}    ${pad(macCisco(e.mac), 18)}${pad('DYNAMIC', 12)}${e.port}`),
    `Total Mac Addresses for this criterion: ${rows.length}`,
    '',
  ];
}

// « show interfaces [nom] » : état, MAC, adresse, débit
export function showInterfaces(dev, doc, only) {
  const topo = buildTopology(doc);
  const ports = topo.ports.get(dev.id).filter((p) => p.media !== 'console' && p.media !== 'rs232').map((p) => p.name);
  const names = only ? [only] : ports;
  const out = [];
  for (const name of names) {
    const e = getEntry(dev, name) ?? {};
    const link = linkOf(doc, dev.id, e.parent ?? name);
    const up = isLoopbackName(name) || (!e.shutdown && link && topo.isUp(link));
    const status = e.shutdown ? 'administratively down' : up ? 'up' : 'down';
    const mac = macOf(dev, name);
    const bw = e.bandwidth ?? (/^Se/.test(name) ? 1544 : /^Fa/.test(name) ? 100000 : 1000000);
    out.push(`${iosLongName(name)} is ${status}, line protocol is ${up ? 'up' : 'down'}${up && dev.type === 'switch' ? ' (connected)' : ''}`);
    if (mac) out.push(`  Hardware is ${/^Se/.test(name) ? 'HD64570' : /^Fa/.test(name) ? 'Lance' : 'CN Gigabit Ethernet'}, address is ${macCisco(mac)} (bia ${macCisco(mac)})`);
    if (e.description) out.push(`  Description: ${e.description}`);
    if (e.ip && e.mask != null) out.push(`  Internet address is ${e.ip}/${e.mask}`);
    out.push(`  MTU 1500 bytes, BW ${bw} Kbit/sec, DLY ${/^Se/.test(name) ? 20000 : 10} usec,`);
    if (/^Se/.test(name)) out.push('  Encapsulation HDLC, loopback not set');
    else out.push('  Encapsulation ARPA, loopback not set');
  }
  return [...out, ''];
}

// Ajouts à « show » et à « clear »
export function tableShows(dev, parseInterfaces) {
  const isSwitch = dev.type === 'switch';
  const mac = kw('mac', 'MAC configuration', {
    children: [kw('address-table', 'MAC forwarding table', {
      run: (c) => c.out.push(...showMacTable(c.dev, c.doc)),
      children: [kw('dynamic', 'dynamic entry type', { run: (c) => c.out.push(...showMacTable(c.dev, c.doc)) })],
    })],
  });
  const legacy = kw('mac-address-table', 'MAC forwarding table', {
    run: (c) => c.out.push(...showMacTable(c.dev, c.doc)),
    children: [kw('dynamic', 'dynamic entry type', { run: (c) => c.out.push(...showMacTable(c.dev, c.doc)) })],
  });
  return [
    kw('arp', 'ARP table', { run: (c) => c.out.push(...showArp(c.dev, c.doc)) }),
    kw('interfaces', 'Interface status and configuration', {
      run: (c) => c.out.push(...showInterfaces(c.dev, c.doc)),
      children: [rest('ifname', 'WORD', 'Interface', (c) => {
        const r = parseInterfaces(c.args.ifname, c.dev);
        if (r.error) return c.out.push(r.error, '');
        return c.out.push(...showInterfaces(c.dev, c.doc, r.names[0]));
      })],
    }),
    ...(isSwitch ? [mac, legacy] : []),
  ];
}

export function tableClears(dev) {
  const isSwitch = dev.type === 'switch';
  const clearMacCmd = (word) => kw(word, 'MAC forwarding table', {
    run: (c) => c.effects.push({ type: 'runtime', update: clearMac(c.dev.id) }),
    children: [kw('dynamic', 'dynamic entry type', { run: (c) => c.effects.push({ type: 'runtime', update: clearMac(c.dev.id) }) })],
  });
  return [
    kw('arp-cache', 'Clear the entire ARP cache', { run: (c) => c.effects.push({ type: 'runtime', update: clearArp(c.dev.id) }) }),
    ...(isSwitch ? [kw('mac', 'MAC configuration', { children: [clearMacCmd('address-table')] }), clearMacCmd('mac-address-table')] : []),
  ];
}

export const ipArpShow = () => kw('arp', 'IP ARP table', { run: (c) => c.out.push(...showArp(c.dev, c.doc)) });
