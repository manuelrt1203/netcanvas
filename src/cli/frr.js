// Terminal FRRouting (vtysh 7.5.1, appliance FRR de GNS3). Syntaxe proche d'IOS mais pas identique :
//   ip address 10.0.0.1/24 (CIDR) ; router ospf (sans numéro) ; network 10.0.0.0/24 area 0 ;
//   ip route 0.0.0.0/0 10.0.0.254 ; router bgp 65001 + address-family ipv4 unicast ; interfaces eth0, eth1…, lo.
// Même configuration que les formulaires et les autres terminaux (config.interfaces, ospf, rip, bgp, ospf6…).
import { accept, arg, complete as treeComplete, execute as treeExecute, help as treeHelp, kw, parse, rest } from './engine.js';
import { dataPorts, ensureEntry, getEntry, linkOf, pad, ping, withDevice } from './device.js';
import { buildTopology, isLoopbackName } from '../net/topology.js';
import { cidrToWildcard, computeRouting, prefixText, wildcardToCidr } from '../net/routing.js';
import { formatIp, isBroadcastAddress, isNetworkAddress, isValidIp, networkOf, sameSubnet, splitCidr } from '../net/ip.js';
import { isValidIp6, normIp6 } from '../net/ip6.js';
import { routeText6 } from '../net/routing6.js';
import { traceroute } from '../net/traceroute.js';
import { hostname as ciscoHostname } from '../export/cisco.js';

const VERSION = '7.5.1';
const isIp = (t) => isValidIp(t);
const isNum = (min, max) => (t) => /^\d+$/.test(t) && Number(t) >= min && Number(t) <= max;
const isCidr = (t) => Boolean(splitCidr(t)) && t.includes('/');
const isArea = (t) => isNum(0, 4294967295)(t) || isValidIp(t);
const areaNum = (t) => (isValidIp(t) ? t.split('.').reduce((a, b) => a * 256 + Number(b), 0) : Number(t));
const areaDotted = (n) => formatIp(Number(n) >>> 0);
const isPrefix6 = (t) => /^[0-9a-f:]+\/\d{1,3}$/i.test(t) && isValidIp6(t.split('/')[0]) && Number(t.split('/')[1]) <= 128;
const liveDoc = (c) => withDevice(c.doc, c.dev);
const touch = (c) => { c.changed = true; };
const fail = (c, ...lines) => c.out.push(...lines, '');

export const frrHostname = (dev) => ciscoHostname(dev.label, dev.type);
// Interfaces Linux du routeur : ports eth0… et la loopback « lo »
const ifaceNames = (dev) => [...dataPorts(dev).map((p) => p.name), 'lo'];
const isIfName = (dev) => (t) => ifaceNames(dev).includes(t);

// --- Commandes communes ---------------------------------------------------------------------
const endCmd = () => kw('end', 'End current mode and change to enable mode', { run: (c) => { c.s.mode = 'priv'; } });
const exitTo = (mode) => kw('exit', 'Exit current mode and down to previous mode', { run: (c) => { c.s.mode = mode; } });

// --- show -------------------------------------------------------------------------------------
const CODES = [
  'Codes: K - kernel route, C - connected, S - static, R - RIP,',
  '       O - OSPF, I - IS-IS, B - BGP, E - EIGRP, N - NHRP,',
  '       T - Table, v - VNC, V - VNC-Direct, A - Babel, D - SHARP,',
  '       F - PBR, f - OpenFabric,',
  '       > - selected route, * - FIB route, q - queued, r - rejected, b - backup',
  '',
];
const UPTIME = '00:05:00';
const PROTO = { C: 'C', L: null, S: 'S', 'S*': 'S', R: 'R', B: 'B' };
const FILTER = { connected: 'C', static: 'S', ospf: 'O', rip: 'R', bgp: 'B' };

function routeLines(c, filter) {
  const rib = computeRouting(liveDoc(c)).ribs.get(c.dev.id) ?? new Map();
  const routes = [...rib.values()].sort((a, b) => a.net - b.net || a.mask - b.mask);
  const out = [];
  for (const r of routes) {
    const code = r.proto.startsWith('O') ? 'O' : r.proto in PROTO ? PROTO[r.proto] : r.proto[0];
    if (!code || (filter && FILTER[filter] !== code)) continue;
    const p = prefixText(r.net, r.mask);
    if (code === 'C') out.push(`C>* ${p} is directly connected, ${r.iface}, ${UPTIME}`);
    else out.push(`${code}>* ${p} [${r.ad}/${r.metric}] via ${r.nextHop}, ${r.iface}, weight 1, ${UPTIME}`);
  }
  return [...CODES, ...out, ''];
}

function route6Lines(c) {
  const rib = computeRouting(liveDoc(c)).ribs6.get(c.dev.id) ?? new Map();
  const out = [];
  for (const r of [...rib.values()].sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : a.prefix - b.prefix))) {
    const code = r.proto.startsWith('O') ? 'O' : r.proto in PROTO ? PROTO[r.proto] : r.proto[0];
    if (!code) continue;
    if (code === 'C') out.push(`C>* ${routeText6(r)} is directly connected, ${r.iface}, ${UPTIME}`);
    else out.push(`${code}>* ${routeText6(r)} [${r.ad}/${r.metric}] via ${r.nextHop ?? r.iface}, ${r.iface}, weight 1, ${UPTIME}`);
  }
  return [...CODES, ...out, ''];
}

function ifaceUp(dev, name, doc, topo) {
  const e = getEntry(dev, name);
  if (e?.shutdown) return false;
  if (isLoopbackName(name)) return true;
  const link = linkOf(doc, dev.id, name);
  return Boolean(link && topo.isUp(link));
}

function showIntBrief(c) {
  const doc = liveDoc(c);
  const topo = buildTopology(doc);
  const out = [`${pad('Interface', 16)}${pad('Status', 8)}${pad('VRF', 16)}Addresses`, `${pad('---------', 16)}${pad('------', 8)}${pad('---', 16)}---------`];
  for (const name of ifaceNames(c.dev)) {
    const e = getEntry(c.dev, name);
    const addrs = [e?.ip && isValidIp(e.ip) ? `${e.ip}/${e.mask}` : null, e?.ipv6 ? `${normIp6(e.ipv6) ?? e.ipv6}/${e.prefix6 ?? 64}` : null].filter(Boolean);
    out.push(`${pad(name, 16)}${pad(ifaceUp(c.dev, name, doc, topo) ? 'up' : 'down', 8)}${pad('default', 16)}${addrs[0] ?? ''}`.trimEnd());
    for (const a of addrs.slice(1)) out.push(`${' '.repeat(40)}+ ${a}`);
  }
  return [...out, ''];
}

const routerOf = (c) => computeRouting(liveDoc(c)).routers.get(c.dev.id);
const explain = (r, re) => (r?.issues ?? []).filter((i) => re.test(i.text)).map((i) => `% NetCanvas : ${i.text}`);

function showOspfNeighbor(c) {
  const r = routerOf(c);
  const out = ['', `${pad('Neighbor ID', 16)}${pad('Pri', 4)}${pad('State', 16)}${pad('Dead Time', 10)}${pad('Address', 16)}${pad('Interface', 33)}RXmtL RqstL DBsmL`];
  for (const n of r?.ospf.neighbors ?? []) {
    const state = n.p2p ? 'Full/-' : `Full/${n.role}`;
    out.push(`${pad(n.peer.ospf.routerId, 16)}${pad(1, 4)}${pad(state, 16)}${pad('35.000s', 10)}${pad(n.peerIface.ip, 16)}${pad(`${n.iface.name}:${n.iface.ip}`, 33)}0     0     0`);
  }
  return [...out, '', ...explain(r, /OSPF/)];
}

function showOspf6Neighbor(c) {
  const r = routerOf(c);
  const out = [`${pad('Neighbor ID', 16)}${pad('Pri', 4)}${pad('DeadTime', 9)}${pad('State/IfState', 19)}${pad('Duration', 9)}I/F[State]`];
  for (const n of r?.ospf6.neighbors ?? []) out.push(`${pad(n.peer.ospf6.routerId, 16)}${pad(1, 4)}${pad('00:00:35', 9)}${pad('Full/DR', 19)}${pad(UPTIME, 9)}${n.iface.name}[DR]`);
  return [...out, '', ...explain(r, /OSPFv3/)];
}

function showBgpSummary(c) {
  const r = routerOf(c);
  const b = c.dev.config?.bgp;
  if (!b?.asn) return ['% No BGP neighbors found', ''];
  const out = ['', 'IPv4 Unicast Summary:', `BGP router identifier ${r?.bgp.routerId ?? b.routerId ?? '0.0.0.0'}, local AS number ${b.asn} vrf-id 0`, 'BGP table version 1', '',
    `${pad('Neighbor', 16)}${pad('V', 10)}${pad('AS', 7)}MsgRcvd   MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd   PfxSnt`];
  for (const n of b.neighbors ?? []) {
    const s = r?.bgp.sessions?.find((x) => x.neighbor === n.ip);
    const up = s?.state === 'Established';
    const pfx = up ? r.bgp.adjIn?.get(s.peer.id)?.size ?? 0 : 0;
    out.push(`${pad(n.ip, 16)}${pad(4, 6)}${String(n.remoteAs).padStart(7)}${'12'.padStart(10)}${'12'.padStart(10)}${'0'.padStart(9)}    0    0 ${pad(up ? UPTIME : 'never', 8)} ${pad(up ? pfx : 'Active', 15)}${up ? (b.networks?.length ?? 0) : 0}`);
    if (!up && s?.reason) out.push(`% NetCanvas : ${s.reason}.`);
  }
  return [...out, '', `Total number of neighbors ${b.neighbors?.length ?? 0}`, ''];
}

function showRip(c) {
  const r = routerOf(c);
  if (!c.dev.config?.rip) return [''];
  const out = ['Codes: R - RIP, C - connected, S - Static, O - OSPF, B - BGP', 'Sub-codes:', '      (n) - normal, (s) - static, (d) - default, (r) - redistribute,', '      (i) - interface', '',
    '     Network            Next Hop         Metric From            Tag Time'];
  for (const e of r?.rip.table.values() ?? []) {
    const p = prefixText(e.net, e.mask);
    out.push(e.via ? `R(n) ${pad(p, 19)}${pad(e.via.nextHop, 17)}${pad(e.metric + 1, 7)}${pad(e.via.nextHop, 16)}0 02:55` : `C(i) ${pad(p, 19)}${pad('0.0.0.0', 17)}${pad(1, 7)}${pad('self', 16)}0`);
  }
  return [...out, '', ...explain(r, /RIP/)];
}

function showRunning(dev) {
  const c = dev.config ?? {};
  const out = ['Building configuration...', '', 'Current configuration:', '!', `frr version ${VERSION}`, 'frr defaults traditional', `hostname ${frrHostname(dev)}`];
  if (!c.ipv6Routing) out.push('no ipv6 forwarding');
  out.push('!');
  const routes = (c.routes ?? []).filter((r) => isValidIp(r.network) && r.mask !== null && r.mask !== undefined && isValidIp(r.nextHop));
  const routes6 = (c.routes6 ?? []).filter((r) => isValidIp6(r.network) && r.nextHop);
  for (const r of routes) out.push(`ip route ${r.network}/${r.mask} ${r.nextHop}`);
  for (const r of routes6) out.push(`ipv6 route ${normIp6(r.network)}/${r.prefix} ${r.nextHop}${r.iface ? ` ${r.iface}` : ''}`);
  if (routes.length || routes6.length) out.push('!');
  const o = c.ospf;
  const o6 = c.ospf6;
  for (const name of ifaceNames(dev)) {
    const e = getEntry(dev, name);
    const lines = [];
    if (e?.description) lines.push(` description ${e.description}`);
    if (e?.ip && isValidIp(e.ip)) lines.push(` ip address ${e.ip}/${e.mask}`);
    const area = o?.interfaces?.find((x) => x.name === name);
    if (area) lines.push(` ip ospf area ${area.area}`);
    if (e?.ospfCost) lines.push(` ip ospf cost ${e.ospfCost}`);
    if (e?.ipv6) lines.push(` ipv6 address ${normIp6(e.ipv6) ?? e.ipv6}/${e.prefix6 ?? 64}`);
    if (o6?.passive?.includes(name)) lines.push(' ipv6 ospf6 passive');
    if (e?.shutdown) lines.push(' shutdown');
    if (lines.length) out.push(`interface ${name}`, ...lines, '!');
  }
  const r = c.rip;
  if (r) {
    // Ordre de ripd 7.5 (vérifié sur un vrai FRR)
    out.push('router rip');
    if (r.defaultOriginate) out.push(' default-information originate');
    for (const x of r.prefixes ?? []) out.push(` network ${x.network}/${x.mask}`);
    for (const n of r.networks ?? []) out.push(` network ${n}/${classfulLen(n)}`);
    for (const name of r.interfaces ?? []) out.push(` network ${name}`);
    for (const name of r.passive ?? []) out.push(` passive-interface ${name}`);
    if (r.redistribute?.static) out.push(' redistribute static');
    if (r.redistribute?.connected) out.push(' redistribute connected');
    if (r.version && !r.versionDefault) out.push(` version ${r.version}`);
    out.push('!');
  }
  const b = c.bgp;
  if (b?.asn) {
    out.push(`router bgp ${b.asn}`);
    if (b.routerId) out.push(` bgp router-id ${b.routerId}`);
    for (const n of b.neighbors ?? []) {
      out.push(` neighbor ${n.ip} remote-as ${n.remoteAs}`);
      if (n.ebgpMultihop) out.push(` neighbor ${n.ip} ebgp-multihop ${n.ebgpMultihop}`);
      if (n.updateSource) out.push(` neighbor ${n.ip} update-source ${n.updateSource}`);
    }
    const af = [...(b.networks ?? []).map((x) => `  network ${x.network}/${x.mask}`), ...(b.neighbors ?? []).filter((n) => n.nextHopSelf).map((n) => `  neighbor ${n.ip} next-hop-self`)];
    if (af.length) out.push(' !', ' address-family ipv4 unicast', ...af, ' exit-address-family');
    out.push('!');
  }
  if (o) {
    out.push('router ospf');
    if (o.routerId) out.push(` ospf router-id ${o.routerId}`);
    for (const k of ['connected', 'static']) if (o.redistribute?.[k]) out.push(` redistribute ${k}`);
    for (const name of o.passive ?? []) out.push(` passive-interface ${name}`);
    for (const x of o.networks ?? []) out.push(` network ${x.network}/${wildcardToCidr(x.wildcard)} area ${x.area}`);
    if (o.defaultOriginate) out.push(` default-information originate${o.defaultOriginate === 'always' ? ' always' : ''}`);
    out.push('!');
  }
  if (o6) {
    out.push('router ospf6');
    if (o6.routerId) out.push(` ospf6 router-id ${o6.routerId}`);
    for (const k of ['connected', 'static']) if (o6.redistribute?.[k]) out.push(` redistribute ${k}`);
    for (const x of o6.interfaces ?? []) out.push(` interface ${x.name} area ${areaDotted(x.area)}`);
    out.push('!');
  }
  out.push('line vty', '!', 'end', '');
  return out;
}

// Réseau RIP « à la Cisco » (classful, sans masque) venu d'un formulaire : longueur de sa classe
const classfulLen = (n) => {
  const first = Number(n.split('.')[0]);
  return first < 128 ? 8 : first < 192 ? 16 : 24;
};

function pingCmd(c, target) {
  if (!isValidIp(target) && !isValidIp6(target)) return fail(c, `ping: ${target}: Name or service not known`);
  const r = ping(liveDoc(c), c.dev.id, target);
  c.effects.push({ type: 'ping', source: c.dev.id, target });
  const out = [`PING ${target} (${target}) 56(84) bytes of data.`];
  for (let i = 1; i <= 5; i++) out.push(r.ok ? `64 bytes from ${target}: icmp_seq=${i} ttl=${r.ttl} time=0.${400 + i * 37} ms` : `From ${c.dev.config?.interfaces?.find((e) => isValidIp(e.ip))?.ip ?? target} icmp_seq=${i} Destination Host Unreachable`);
  out.push('', `--- ${target} ping statistics ---`, `5 packets transmitted, ${r.ok ? 5 : 0} received, ${r.ok ? '0% packet loss' : '+5 errors, 100% packet loss'}, time 4006ms`);
  if (!r.ok && r.reason) out.push(`% NetCanvas : ${r.reason}`);
  return c.out.push(...out, '');
}

function tracerouteCmd(c, target) {
  if (!isValidIp(target) && !isValidIp6(target)) return fail(c, `${target}: Name or service not known`);
  const t = traceroute(liveDoc(c), c.dev.id, target);
  c.effects.push({ type: 'ping', source: c.dev.id, target });
  const out = [`traceroute to ${target} (${target}), 30 hops max, 60 byte packets`];
  for (const h of t.hops) out.push(` ${h.ttl}  ${h.ip ? `${h.ip} (${h.ip})  0.512 ms  0.488 ms  0.471 ms` : '* * *'}`);
  if (t.reason) out.push(`% NetCanvas : ${t.reason}`);
  return c.out.push(...out, '');
}

function showTree() {
  return kw('show', 'Show running system information', {
    children: [
      kw('running-config', 'running configuration (same as write terminal)', { run: (c) => c.out.push(...showRunning(c.dev)) }),
      kw('version', 'Displays zebra version', { run: (c) => c.out.push(`FRRouting ${VERSION} (${frrHostname(c.dev)}).`, 'Copyright 1996-2005 Kunihiro Ishiguro, et al.', '') }),
      kw('interface', 'Interface status and configuration', {
        children: [kw('brief', 'Interface summary', { run: (c) => c.out.push(...showIntBrief(c)) })],
        run: (c) => c.out.push(...showIntBrief(c)),
      }),
      kw('ip', 'IP information', {
        children: [
          kw('route', 'IP routing table', {
            run: (c) => c.out.push(...routeLines(c)),
            children: Object.keys(FILTER).map((f) => kw(f, `${f} routes`, { run: (c) => c.out.push(...routeLines(c, f)) })),
          }),
          kw('ospf', 'OSPF information', {
            children: [kw('neighbor', 'Neighbor list', { run: (c) => c.out.push(...showOspfNeighbor(c)) })],
          }),
          kw('rip', 'Show RIP routes', { run: (c) => c.out.push(...showRip(c)) }),
          kw('bgp', 'BGP information', {
            children: [kw('summary', 'Summary of BGP neighbor status', { run: (c) => c.out.push(...showBgpSummary(c)) })],
          }),
        ],
      }),
      kw('ipv6', 'IPv6 information', {
        children: [
          kw('route', 'IPv6 routing table', { run: (c) => c.out.push(...route6Lines(c)) }),
          kw('ospf6', 'Open Shortest Path First (OSPF) for IPv6', {
            children: [kw('neighbor', 'Neighbor list', { run: (c) => c.out.push(...showOspf6Neighbor(c)) })],
          }),
        ],
      }),
    ],
  });
}

// --- Modes ------------------------------------------------------------------------------------
function privTree() {
  return {
    children: [
      kw('configure', 'Configuration from vty interface', {
        children: [kw('terminal', 'Configuration terminal', { run: (c) => { c.s.mode = 'config'; } })],
        run: (c) => { c.s.mode = 'config'; },
      }),
      showTree(),
      kw('ping', 'Send echo messages', { children: [arg('target', 'WORD', 'Ping destination address or hostname', null, { run: (c) => pingCmd(c, c.args.target) })] }),
      kw('traceroute', 'Trace route to destination', { children: [arg('target', 'WORD', 'Trace route to destination address or hostname', null, { run: (c) => tracerouteCmd(c, c.args.target) })] }),
      kw('write', 'Write running configuration to memory, network, or terminal', {
        run: (c) => c.out.push('Note: this version of vtysh never writes vtysh.conf', 'Building Configuration...', 'Integrated configuration saved to /etc/frr/frr.conf', '[OK]', ''),
        children: [
          kw('memory', 'Write configuration to the file (same as write file)', { run: (c) => c.out.push('Note: this version of vtysh never writes vtysh.conf', 'Building Configuration...', 'Integrated configuration saved to /etc/frr/frr.conf', '[OK]', '') }),
          kw('terminal', 'Write to terminal', { run: (c) => c.out.push(...showRunning(c.dev)) }),
        ],
      }),
      kw('enable', 'Turn on privileged mode command', { run() {} }),
      kw('end', 'End current mode and change to enable mode', { run() {} }),
      kw('exit', 'Exit current mode and down to previous mode', { run: (c) => c.out.push('NetCanvas : vtysh fermé, rouvre le terminal pour continuer.', '') }),
    ],
  };
}

// Commandes globales sans effet sur la simulation (lignes d'un show running-config)
const NOOP_GLOBAL = [['frr', 'FRRouting global parameters'], ['log', 'Logging control'], ['service', 'Set up miscellaneous service'],
  ['password', 'Modify the terminal connection password'], ['line', 'Configure a terminal line'], ['agentx', 'SNMP AgentX protocol settings'],
  ['debug', 'Debugging functions']];

function configTree(dev) {
  const routeCmd = (add) => kw('route', 'Establish static routes', {
    children: [arg('prefix', 'A.B.C.D/M', 'IP destination prefix (e.g. 10.0.0.0/8)', isCidr, {
      children: [arg('gw', 'A.B.C.D', 'IP gateway address', isIp, {
        run: (c) => {
          const s = splitCidr(c.args.prefix);
          const network = formatIp(networkOf(s.ip, s.cidr));
          const list = (c.dev.config.routes ??= []);
          const same = (r) => r.network === network && Number(r.mask) === s.cidr && r.nextHop === c.args.gw;
          if (add && !list.some(same)) list.push({ network, mask: s.cidr, nextHop: c.args.gw });
          if (!add) c.dev.config.routes = list.filter((r) => !same(r));
          touch(c);
        },
      }), arg('ifname', 'INTERFACE', 'IP gateway interface name', isIfName(dev), {
        run: (c) => fail(c, '% NetCanvas : route vers une interface non simulée, donne l\'adresse de la passerelle (ip route 0.0.0.0/0 10.0.0.254).'),
      })],
    })],
  });
  const route6Cmd = (add) => kw('route', 'Establish static routes', {
    children: [arg('prefix', 'X:X::X:X/M', 'IPv6 prefix', isPrefix6, {
      children: [arg('gw', 'X:X::X:X', 'IPv6 gateway address', (t) => isValidIp6(t), {
        run: (c) => {
          const [net, len] = c.args.prefix.split('/');
          const network = normIp6(net);
          const list = (c.dev.config.routes6 ??= []);
          const same = (r) => normIp6(r.network) === network && Number(r.prefix) === Number(len) && normIp6(r.nextHop) === normIp6(c.args.gw);
          if (add && !list.some(same)) list.push({ network, prefix: Number(len), nextHop: c.args.gw });
          if (!add) c.dev.config.routes6 = list.filter((r) => !same(r));
          touch(c);
        },
        children: [arg('ifname', 'INTERFACE', 'IPv6 gateway interface name', isIfName(dev), {
          run: (c) => {
            const [net, len] = c.args.prefix.split('/');
            (c.dev.config.routes6 ??= []).push({ network: normIp6(net), prefix: Number(len), nextHop: c.args.gw, iface: c.args.ifname });
            touch(c);
          },
        })],
      })],
    })],
  });
  const routerKw = (add) => kw('router', 'Enable a routing process', {
    children: [
      kw('ospf', 'Start OSPF configuration', {
        run: (c) => {
          if (!add) { delete c.dev.config.ospf; return touch(c); }
          c.dev.config.ospf ??= { processId: 1, networks: [] };
          c.s.mode = 'router-ospf';
          touch(c);
        },
      }),
      kw('ospf6', 'Open Shortest Path First (OSPF) for IPv6', {
        run: (c) => {
          if (!add) { delete c.dev.config.ospf6; return touch(c); }
          c.dev.config.ospf6 ??= { processId: 1, interfaces: [] };
          c.s.mode = 'router-ospf6';
          touch(c);
        },
      }),
      kw('rip', 'Routing Information Protocol (RIP)', {
        run: (c) => {
          if (!add) { delete c.dev.config.rip; return touch(c); }
          // ripd envoie du RIPv2 par défaut (et accepte v1 et v2)
          c.dev.config.rip ??= { version: 2, versionDefault: true, interfaces: [] };
          c.s.mode = 'router-rip';
          touch(c);
        },
      }),
      kw('bgp', 'BGP information', {
        children: [arg('asn', '(1-4294967295)', 'Autonomous system number', isNum(1, 4294967295), {
          run: (c) => {
            const b = c.dev.config.bgp;
            if (!add) {
              if (b && Number(b.asn) === Number(c.args.asn)) delete c.dev.config.bgp;
              return touch(c);
            }
            if (b?.asn && Number(b.asn) !== Number(c.args.asn)) return fail(c, `BGP is already running; AS is ${b.asn}`);
            c.dev.config.bgp ??= { asn: Number(c.args.asn), neighbors: [], networks: [] };
            c.s.mode = 'router-bgp';
            touch(c);
          },
        })],
      }),
    ],
  });
  return {
    children: [
      kw('hostname', 'Set system\'s network name', {
        children: [arg('name', 'WORD', 'This system\'s network name', null, { run: (c) => { c.dev.label = c.args.name; touch(c); } })],
      }),
      kw('interface', 'Select an interface to configure', {
        children: [arg('ifname', 'IFNAME', 'Interface\'s name', null, {
          run: (c) => {
            if (!isIfName(c.dev)(c.args.ifname)) {
              return fail(c, `% NetCanvas : ${c.args.ifname} n'existe pas sur ${c.dev.label} (interfaces : ${ifaceNames(c.dev).join(', ')}).`);
            }
            ensureEntry(c.dev, c.args.ifname, c.doc);
            Object.assign(c.s, { mode: 'if', iface: c.args.ifname });
          },
        })],
      }),
      kw('ip', 'IP information', {
        children: [routeCmd(true), accept('forwarding', 'Turn on IP forwarding'), accept('prefix-list', 'Build a prefix list'), accept('protocol', 'Filter routing info exchanged between zebra and protocol'), accept('nht', 'Filter Next Hop tracking route resolution')],
      }),
      kw('ipv6', 'IPv6 information', {
        children: [
          route6Cmd(true),
          kw('forwarding', 'Turn on IPv6 forwarding', { run: (c) => { c.dev.config.ipv6Routing = true; touch(c); } }),
        ],
      }),
      routerKw(true),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('ip', 'IP information', { children: [routeCmd(false), accept('forwarding', 'Turn off IP forwarding')] }),
          kw('ipv6', 'IPv6 information', {
            children: [route6Cmd(false), kw('forwarding', 'Turn off IPv6 forwarding', { run: (c) => { delete c.dev.config.ipv6Routing; touch(c); } })],
          }),
          routerKw(false),
          ...NOOP_GLOBAL.map(([w, h]) => accept(w, h)),
        ],
      }),
      ...NOOP_GLOBAL.map(([w, h]) => accept(w, h)),
      kw('do', 'To run exec commands in config mode', { children: [rest('cmd', 'LINE', 'Exec command', (c) => runExec(c, c.args.cmd))] }),
      endCmd(),
      exitTo('priv'),
    ],
  };
}

function runExec(c, line) {
  const err = treeExecute(privTree(), line, c, 0);
  if (err) c.out.push(...err.filter((l) => !/^\s*\^$/.test(l)));
}

function interfaceTree() {
  // Chaque ligne s'exécute sur une copie de l'équipement : l'entrée est (re)créée à la demande
  const entry = (c) => ensureEntry(c.dev, c.s.iface, c.doc);
  const ipAddress = kw('address', 'Set the IP address of an interface', {
    children: [arg('prefix', 'A.B.C.D/M', 'IP address (e.g. 10.0.0.1/8)', isCidr, {
      run: (c) => {
        const s = splitCidr(c.args.prefix);
        const lo = isLoopbackName(c.s.iface);
        if (!lo && s.cidr < 31 && (isNetworkAddress(s.ip, s.cidr) || isBroadcastAddress(s.ip, s.cidr))) {
          return fail(c, `% NetCanvas : ${c.args.prefix} est l'adresse de ${isNetworkAddress(s.ip, s.cidr) ? 'réseau' : 'diffusion'} du sous-réseau : choisis une adresse d'hôte.`);
        }
        const clash = (c.dev.config.interfaces ?? []).find((e) => e.name !== c.s.iface && isValidIp(e.ip) && !isLoopbackName(e.name) && sameSubnet(e.ip, s.ip, Math.min(e.mask, s.cidr)));
        if (clash && !lo) return fail(c, `% NetCanvas : ${c.args.prefix} chevauche ${clash.ip}/${clash.mask} de ${clash.name}.`);
        Object.assign(entry(c), { ip: s.ip, mask: s.cidr });
        touch(c);
      },
    })],
  });
  const ospfIf = (add) => kw('ospf', 'OSPF interface commands', {
    children: [
      kw('cost', 'Interface cost', {
        run: (c) => { if (!add) { delete entry(c).ospfCost; touch(c); } },
        children: [arg('cost', '(1-65535)', 'Cost', isNum(1, 65535), { run: (c) => { if (add) entry(c).ospfCost = Number(c.args.cost); else delete entry(c).ospfCost; touch(c); } })],
      }),
      kw('area', 'Enable OSPF on this interface', {
        run: (c) => {
          if (add) return fail(c, '% Command incomplete: ip ospf area');
          const o = c.dev.config.ospf;
          if (o) o.interfaces = (o.interfaces ?? []).filter((x) => x.name !== c.s.iface);
          touch(c);
        },
        children: [arg('area', '<A.B.C.D|(0-4294967295)>', 'OSPF area ID', isArea, {
          run: (c) => {
            const o = (c.dev.config.ospf ??= { processId: 1, networks: [] });
            if (add && o.networks?.length) {
              return fail(c, 'Please remove all network commands first.',
                '% NetCanvas : router ospf active déjà OSPF par des commandes « network ». Choisis une seule méthode.');
            }
            o.interfaces = (o.interfaces ?? []).filter((x) => x.name !== c.s.iface);
            if (add) o.interfaces.push({ name: c.s.iface, area: areaNum(c.args.area) });
            touch(c);
          },
        })],
      }),
      ...['hello-interval', 'dead-interval', 'network', 'priority', 'authentication'].map((w) => accept(w, '')),
    ],
  });
  const ipv6Address = kw('address', 'Set the IP address of an interface', {
    children: [arg('prefix', 'X:X::X:X/M', 'IPv6 address (e.g. 3ffe:506::1/48)', isPrefix6, {
      run: (c) => {
        const [ip, len] = c.args.prefix.split('/');
        Object.assign(entry(c), { ipv6: normIp6(ip), prefix6: Number(len) });
        touch(c);
      },
    })],
  });
  const ospf6If = (add) => kw('ospf6', 'Open Shortest Path First (OSPF) for IPv6', {
    children: [kw('passive', 'Passive interface; no adjacency will be formed on this interface', {
      run: (c) => {
        const o = (c.dev.config.ospf6 ??= { processId: 1, interfaces: [] });
        o.passive = add ? [...new Set([...(o.passive ?? []), c.s.iface])] : (o.passive ?? []).filter((x) => x !== c.s.iface);
        touch(c);
      },
    }), ...['cost', 'hello-interval', 'dead-interval', 'network', 'priority'].map((w) => accept(w, ''))],
  });
  return {
    children: [
      kw('ip', 'Interface Internet Protocol config commands', { children: [ipAddress, ospfIf(true), accept('rip', 'Routing Information Protocol')] }),
      kw('ipv6', 'Interface IPv6 config commands', { children: [ipv6Address, ospf6If(true), accept('nd', 'Interface IPv6 Neighbor Discovery subcommands')] }),
      kw('description', 'Interface specific description', { children: [rest('text', 'LINE', 'Characters describing this interface', (c) => { entry(c).description = c.args.text; touch(c); })] }),
      kw('shutdown', 'Shutdown the selected interface', { run: (c) => { entry(c).shutdown = true; touch(c); } }),
      accept('link-detect', 'Enable link detection on interface'),
      accept('bandwidth', 'Set bandwidth informational parameter'),
      accept('multicast', 'Set multicast flag to interface'),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('shutdown', 'Shutdown the selected interface', { run: (c) => { delete entry(c).shutdown; touch(c); } }),
          kw('description', 'Interface specific description', { run: (c) => { delete entry(c).description; touch(c); }, children: [rest('x', 'LINE', '', (c) => { delete entry(c).description; touch(c); })] }),
          kw('ip', 'Interface Internet Protocol config commands', {
            children: [kw('address', 'Set the IP address of an interface', {
              run: (c) => { Object.assign(entry(c), { ip: null, mask: null }); touch(c); },
              children: [arg('prefix', 'A.B.C.D/M', '', isCidr, { run: (c) => { Object.assign(entry(c), { ip: null, mask: null }); touch(c); } })],
            }), ospfIf(false)],
          }),
          kw('ipv6', 'Interface IPv6 config commands', {
            children: [kw('address', 'Set the IP address of an interface', {
              run: (c) => { delete entry(c).ipv6; delete entry(c).prefix6; touch(c); },
              children: [arg('prefix', 'X:X::X:X/M', '', isPrefix6, { run: (c) => { delete entry(c).ipv6; delete entry(c).prefix6; touch(c); } })],
            }), ospf6If(false)],
          }),
          accept('link-detect', ''),
        ],
      }),
      endCmd(),
      exitTo('config'),
    ],
  };
}

// Commandes partagées par router ospf / ospf6 / rip
const redistribute = (key, add) => kw('redistribute', 'Redistribute information from another routing protocol', {
  children: ['static', 'connected'].map((p) => kw(p, `${p === 'static' ? 'Statically configured' : 'Connected'} routes`, {
    run: (c) => {
      const o = c.dev.config[key];
      o.redistribute = { ...o.redistribute, [p]: add };
      if (!add) delete o.redistribute[p];
      touch(c);
    },
  })),
});
const passive = (key, add) => kw('passive-interface', 'Suppress routing updates on an interface', {
  children: [arg('ifname', 'IFNAME', 'Interface\'s name', null, {
    run: (c) => {
      if (!isIfName(c.dev)(c.args.ifname)) return fail(c, `% NetCanvas : ${c.args.ifname} n'existe pas sur ce routeur.`);
      const o = c.dev.config[key];
      o.passive = add ? [...new Set([...(o.passive ?? []), c.args.ifname])] : (o.passive ?? []).filter((x) => x !== c.args.ifname);
      touch(c);
    },
  })],
});
const defaultInfo = (key, add) => kw('default-information', 'Control distribution of default information', {
  children: [kw('originate', 'Distribute a default route', {
    run: (c) => { if (add) c.dev.config[key].defaultOriginate = c.dev.config[key].defaultOriginate === 'always' ? 'always' : true; else delete c.dev.config[key].defaultOriginate; touch(c); },
    children: [kw('always', 'Always advertise default route', { run: (c) => { if (add) c.dev.config[key].defaultOriginate = 'always'; else delete c.dev.config[key].defaultOriginate; touch(c); } })],
  })],
});
// « ospf router-id X » (forme affichée par show run) ou « router-id X »
const routerId = (key, word) => {
  const id = kw('router-id', 'router-id for the OSPF process', {
    children: [arg('id', 'A.B.C.D', 'OSPF router-id in IP address format', isIp, { run: (c) => { c.dev.config[key].routerId = c.args.id; touch(c); } })],
  });
  return word === 'router-id' ? id : kw(word, 'OSPF specific commands', { children: [id] });
};
const routerTail = () => [accept('log-adjacency-changes', 'Log changes in adjacency state'), accept('auto-cost', 'Calculate OSPF interface cost according to bandwidth'), accept('timers', 'Adjust routing timers'), endCmd(), exitTo('config')];

function ospfTree() {
  const network = (add) => kw('network', 'Enable routing on an IP network', {
    children: [arg('prefix', 'A.B.C.D/M', 'OSPF network prefix', isCidr, {
      children: [kw('area', 'Set the OSPF area ID', {
        children: [arg('area', '<A.B.C.D|(0-4294967295)>', 'OSPF area ID', isArea, {
          run: (c) => {
            const o = c.dev.config.ospf;
            const s = splitCidr(c.args.prefix);
            const network = formatIp(networkOf(s.ip, s.cidr));
            const same = (x) => x.network === network && wildcardToCidr(x.wildcard) === s.cidr;
            // ospfd refuse de mélanger « network » et « ip ospf area » (deux façons d'activer OSPF)
            if (add && o.interfaces?.length) {
              return fail(c, 'Please remove all ip ospf area x.x.x.x commands first.',
                `% NetCanvas : ${o.interfaces.map((x) => x.name).join(', ')} active déjà OSPF par « ip ospf area ». Choisis une seule méthode : network dans router ospf, ou ip ospf area sur chaque interface.`);
            }
            if (add && (o.networks ?? []).some((x) => same(x) && Number(x.area) !== areaNum(c.args.area))) {
              return fail(c, 'There is already same network statement.');
            }
            o.networks = (o.networks ?? []).filter((x) => !same(x));
            if (add) o.networks.push({ network, wildcard: cidrToWildcard(s.cidr), area: areaNum(c.args.area) });
            touch(c);
          },
        })],
      })],
    })],
  });
  return {
    children: [
      routerId('ospf', 'ospf'), routerId('ospf', 'router-id'),
      network(true), passive('ospf', true), redistribute('ospf', true), defaultInfo('ospf', true),
      kw('no', 'Negate a command or set its defaults', {
        children: [network(false), passive('ospf', false), redistribute('ospf', false), defaultInfo('ospf', false),
          kw('ospf', 'OSPF specific commands', { children: [kw('router-id', 'router-id for the OSPF process', { run: (c) => { delete c.dev.config.ospf.routerId; touch(c); } })] })],
      }),
      ...routerTail(),
    ],
  };
}

function ospf6Tree() {
  const iface = (add) => kw('interface', 'Enable routing on an IPv6 interface', {
    children: [arg('ifname', 'IFNAME', 'Interface name', null, {
      children: [kw('area', 'Specify the OSPF6 area ID', {
        children: [arg('area', 'A.B.C.D', 'OSPF6 area ID in IPv4 address notation', isArea, {
          run: (c) => {
            if (!isIfName(c.dev)(c.args.ifname)) return fail(c, `% NetCanvas : ${c.args.ifname} n'existe pas sur ce routeur.`);
            const o = c.dev.config.ospf6;
            o.interfaces = (o.interfaces ?? []).filter((x) => x.name !== c.args.ifname);
            if (add) o.interfaces.push({ name: c.args.ifname, area: areaNum(c.args.area) });
            touch(c);
          },
        })],
      })],
    })],
  });
  return {
    children: [
      routerId('ospf6', 'ospf6'), routerId('ospf6', 'router-id'),
      iface(true), redistribute('ospf6', true),
      kw('no', 'Negate a command or set its defaults', { children: [iface(false), redistribute('ospf6', false)] }),
      ...routerTail(),
    ],
  };
}

function ripTree() {
  const network = (add) => kw('network', 'Enable routing on an IP network', {
    children: [
      arg('prefix', 'A.B.C.D/M', 'IP prefix <network>/<length>, e.g., 35.0.0.0/8', isCidr, {
        run: (c) => {
          const r = c.dev.config.rip;
          const s = splitCidr(c.args.prefix);
          const network = formatIp(networkOf(s.ip, s.cidr));
          const same = (x) => x.network === network && Number(x.mask) === s.cidr;
          r.prefixes = (r.prefixes ?? []).filter((x) => !same(x));
          if (add) r.prefixes.push({ network, mask: s.cidr });
          touch(c);
        },
      }),
      arg('ifname', 'WORD', 'Interface name', null, {
        run: (c) => {
          if (!isIfName(c.dev)(c.args.ifname)) return fail(c, `% NetCanvas : ${c.args.ifname} n'existe pas sur ce routeur.`);
          const r = c.dev.config.rip;
          r.interfaces = add ? [...new Set([...(r.interfaces ?? []), c.args.ifname])] : (r.interfaces ?? []).filter((x) => x !== c.args.ifname);
          touch(c);
        },
      }),
    ],
  });
  return {
    children: [
      network(true), passive('rip', true), redistribute('rip', true), defaultInfo('rip', true),
      kw('version', 'Set routing protocol version', {
        children: [arg('v', '(1-2)', 'version', isNum(1, 2), { run: (c) => { Object.assign(c.dev.config.rip, { version: Number(c.args.v) }); delete c.dev.config.rip.versionDefault; touch(c); } })],
      }),
      kw('no', 'Negate a command or set its defaults', {
        children: [network(false), passive('rip', false), redistribute('rip', false), defaultInfo('rip', false),
          kw('version', 'Set routing protocol version', { run: (c) => { Object.assign(c.dev.config.rip, { version: 2, versionDefault: true }); touch(c); } })],
      }),
      ...routerTail(),
    ],
  };
}

function bgpNeighbor(add, af = false) {
  const neighbor = (c) => c.dev.config.bgp.neighbors?.find((n) => n.ip === c.args.peer);
  const need = (c, fn) => {
    const n = neighbor(c);
    if (!n) return fail(c, `% Specify remote-as or peer-group commands first`);
    fn(n);
    return touch(c);
  };
  const nextHopSelf = kw('next-hop-self', 'Disable the next hop calculation for this neighbor', { run: (c) => need(c, (n) => { if (add) n.nextHopSelf = true; else delete n.nextHopSelf; }) });
  const children = af ? [nextHopSelf, accept('activate', 'Enable the Address Family for this Neighbor'), accept('route-map', ''), accept('soft-reconfiguration', '')] : [
    kw('remote-as', 'Specify a BGP neighbor', {
      children: [arg('as', '(1-4294967295)', 'AS number', isNum(1, 4294967295), {
        run: (c) => {
          const b = c.dev.config.bgp;
          const n = neighbor(c);
          if (add && n) n.remoteAs = Number(c.args.as);
          else if (add) (b.neighbors ??= []).push({ ip: c.args.peer, remoteAs: Number(c.args.as) });
          else b.neighbors = (b.neighbors ?? []).filter((x) => x.ip !== c.args.peer);
          touch(c);
        },
      })],
    }),
    nextHopSelf,
    kw('update-source', 'Source of routing updates', {
      run: (c) => { if (!add) need(c, (n) => delete n.updateSource); },
      children: [arg('src', '<A.B.C.D|IFNAME>', 'Interface name or address', null, {
        run: (c) => need(c, (n) => {
          if (!add) return void delete n.updateSource;
          const byIp = (c.dev.config.interfaces ?? []).find((e) => e.ip === c.args.src)?.name;
          n.updateSource = byIp ?? c.args.src;
        }),
      })],
    }),
    kw('ebgp-multihop', 'Allow EBGP neighbors not on directly connected networks', {
      run: (c) => need(c, (n) => { if (add) n.ebgpMultihop = 255; else delete n.ebgpMultihop; }),
      children: [arg('ttl', '(1-255)', 'maximum hop count', isNum(1, 255), { run: (c) => need(c, (n) => { if (add) n.ebgpMultihop = Number(c.args.ttl); else delete n.ebgpMultihop; }) })],
    }),
    accept('activate', ''), accept('description', 'Neighbor specific description'), accept('timers', ''), accept('password', ''),
  ];
  return kw('neighbor', 'Specify neighbor router', {
    children: [arg('peer', 'A.B.C.D', 'Neighbor address', isIp, {
      // « no neighbor X » : retire le voisin
      ...(add || af ? {} : { run: (c) => { c.dev.config.bgp.neighbors = (c.dev.config.bgp.neighbors ?? []).filter((n) => n.ip !== c.args.peer); touch(c); } }),
      children,
    })],
  });
}

function bgpNetwork(add) {
  return kw('network', 'Specify a network to announce via BGP', {
    children: [arg('prefix', 'A.B.C.D/M', 'IPv4 prefix', isCidr, {
      run: (c) => {
        const b = c.dev.config.bgp;
        const s = splitCidr(c.args.prefix);
        const network = formatIp(networkOf(s.ip, s.cidr));
        b.networks = (b.networks ?? []).filter((x) => !(x.network === network && Number(x.mask) === s.cidr));
        if (add) b.networks.push({ network, mask: s.cidr });
        touch(c);
      },
    })],
  });
}

function bgpTree() {
  return {
    children: [
      kw('bgp', 'BGP information', {
        children: [
          kw('router-id', 'Override configured router identifier', { children: [arg('id', 'A.B.C.D', 'Manually configured router identifier', isIp, { run: (c) => { c.dev.config.bgp.routerId = c.args.id; touch(c); } })] }),
          ...['log-neighbor-changes', 'ebgp-requires-policy', 'default', 'bestpath', 'network'].map((w) => accept(w, '')),
        ],
      }),
      bgpNeighbor(true),
      bgpNetwork(true), // accepté hors address-family, comme vtysh (rangé dans ipv4 unicast)
      kw('address-family', 'Enter Address Family command mode', {
        children: [kw('ipv4', 'Address Family', {
          run: (c) => { c.s.mode = 'bgp-af'; },
          children: [kw('unicast', 'Address Family modifier', { run: (c) => { c.s.mode = 'bgp-af'; } })],
        })],
      }),
      kw('no', 'Negate a command or set its defaults', {
        children: [bgpNeighbor(false), bgpNetwork(false), kw('bgp', 'BGP information', {
          children: [kw('router-id', '', { run: (c) => { delete c.dev.config.bgp.routerId; touch(c); }, children: [arg('id', 'A.B.C.D', '', isIp, { run: (c) => { delete c.dev.config.bgp.routerId; touch(c); } })] }),
            ...['log-neighbor-changes', 'ebgp-requires-policy', 'default', 'bestpath', 'network'].map((w) => accept(w, ''))],
        })],
      }),
      accept('timers', 'Adjust routing timers'),
      endCmd(),
      exitTo('config'),
    ],
  };
}

function bgpAfTree() {
  return {
    children: [
      bgpNetwork(true), bgpNeighbor(true, true), accept('redistribute', 'Redistribute information from another routing protocol'),
      kw('no', 'Negate a command or set its defaults', { children: [bgpNetwork(false), bgpNeighbor(false, true)] }),
      kw('exit-address-family', 'Exit from Address Family configuration mode', { run: (c) => { c.s.mode = 'router-bgp'; } }),
      endCmd(),
      exitTo('router-bgp'),
    ],
  };
}

const TREES = { priv: privTree, config: configTree, if: interfaceTree, 'router-ospf': ospfTree, 'router-ospf6': ospf6Tree, 'router-rip': ripTree, 'router-bgp': bgpTree, 'bgp-af': bgpAfTree };
const SUFFIX = { priv: '#', config: '(config)#', if: '(config-if)#', 'router-ospf': '(config-router)#', 'router-ospf6': '(config-ospf6)#', 'router-rip': '(config-router)#', 'router-bgp': '(config-router)#', 'bgp-af': '(config-router-af)#' };
// Modes parents : vtysh essaie une commande inconnue dans le mode du dessus (c'est ce qui permet de coller une config)
const PARENT = { if: 'config', 'router-ospf': 'config', 'router-ospf6': 'config', 'router-rip': 'config', 'router-bgp': 'config', 'bgp-af': 'router-bgp' };

// Message d'erreur de vtysh : « % Unknown command: … » (pas de marqueur ^)
function vtyError(p, line) {
  if (p.error === 'ambiguous') return [`% Ambiguous command: ${line.trim()}`, ''];
  if (p.error === 'invalid') return [`% Unknown command: ${line.trim()}`, ...hint(line), ''];
  if (!p.node.run) return [`% Command incomplete: ${line.trim()}`, ''];
  return null;
}

// Syntaxe Cisco sur FRR : on donne l'équivalent (la particularité de NetCanvas)
function hint(line) {
  const t = line.trim();
  const mask = /^ip address (\S+) (\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (mask) {
    const len = mask[2].split('.').map(Number).reduce((a, b) => a + (b >>> 0).toString(2).replace(/0/g, '').length, 0);
    return [`% NetCanvas : FRR attend la notation CIDR : ip address ${mask[1]}/${len}`];
  }
  if (/^ip route \S+ \d+\.\d+\.\d+\.\d+ /.test(t)) return ['% NetCanvas : FRR attend la notation CIDR : ip route 0.0.0.0/0 10.0.0.254'];
  if (/^network \S+ \d+\.\d+\.\d+\.\d+ area/.test(t)) return ['% NetCanvas : FRR attend la notation CIDR, sans masque inverse : network 10.0.0.0/24 area 0'];
  if (/^router (ospf|rip) \d+/.test(t)) return ['% NetCanvas : sur FRR, « router ospf » se tape sans numéro de processus.'];
  if (/^(no )?shut/.test(t) || /^interface (fa|gi|se|eth?)\S*\d+\/\d+/i.test(t)) return ['% NetCanvas : les interfaces FRR s\'appellent eth0, eth1… (et lo pour la loopback).'];
  return [];
}

export const frr = {
  banner: (dev) => ['', 'Hello, this is FRRouting (version 7.5.1).', 'Copyright 1996-2005 Kunihiro Ishiguro, et al.', '',
    `NetCanvas : vtysh simulé sur ${dev.label}. « ? » pour l'aide, Tab pour compléter.`, ''],
  newSession: () => ({ mode: 'priv', iface: null }),
  prompt: (s, dev) => `${frrHostname(dev)}${SUFFIX[s.mode]} `,

  run(s, line, dev, doc) {
    const ctx = { s, dev, doc, out: [], effects: [], changed: false };
    if (!line.trim()) return ctx;
    dev.config ??= {};
    // Commande inconnue dans un sous-mode : essayée dans les modes parents
    for (let mode = s.mode; mode; mode = PARENT[mode]) {
      const tree = TREES[mode](dev);
      const p = parse(tree, line);
      if (p.error === 'invalid' && PARENT[mode]) continue;
      const err = vtyError(p, line);
      if (err) {
        ctx.out.push(...err);
        return ctx;
      }
      if (mode !== s.mode) s.mode = mode;
      treeExecute(tree, line, ctx, 0);
      return ctx;
    }
    ctx.out.push(`% Unknown command: ${line.trim()}`, ...hint(line), '');
    return ctx;
  },

  help: (s, line, dev) => treeHelp(TREES[s.mode](dev), line),
  complete: (s, line, dev) => treeComplete(TREES[s.mode](dev), line),
};

// Script de configuration (export GNS3 / frr.conf) : le show running-config sans en-tête
export function frrConfig(dev) {
  return showRunning(dev).slice(3);
}
