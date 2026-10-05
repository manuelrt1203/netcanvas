// Terminal IOS : IPv6. Adresses d'interface (globale, EUI-64, link-local, ipv6 enable),
// ipv6 unicast-routing, ipv6 route, show ipv6 interface brief / route / neighbors, ping et traceroute IPv6.
import { arg, kw, rest } from './engine.js';
import { pad, withDevice } from './device.js';
import { isLinkLocal6, isValidIp6, networkLabel6, normIp6, sameSubnet6, splitPrefix6 } from '../net/ip6.js';
import { buildTopology } from '../net/topology.js';
import { computeRouting } from '../net/routing.js';
import { withLeases } from '../net/dhcp.js';
import { routeText6 } from '../net/routing6.js';
import { ndRows } from '../net/tables.js';
import { macCisco } from '../net/mac.js';
import { iosLongName } from '../export/cisco.js';
import { ospf6InterfaceCommand, ospf6RouterCommand, showOspf6Neighbor } from './ios-routing.js';
import { acl6ConfigCommands, showIpv6AccessLists, trafficFilterCommands } from './ios-acl.js';

const shortName = (n) => n.replace(/^G(?=\d)/, 'Gi');

const UP = (a) => String(a).toUpperCase();
const isPrefixed = (t) => splitPrefix6(t) !== null;
const isLinkLocalAddr = (t) => isValidIp6(t) && isLinkLocal6(t);

// --- Interface ----------------------------------------------------------------------------------
function setGlobal(c, forIfaces, eui64) {
  const { ip, prefix } = splitPrefix6(c.args.addr);
  if (isLinkLocal6(ip)) return c.out.push('% Link-local address must be configured with the link-local keyword', '');
  if (eui64 && prefix !== 64) return c.out.push(`% NetCanvas : EUI-64 demande un préfixe /64 (ici /${prefix}).`, '');
  // IOS refuse deux interfaces dans le même réseau IPv6
  for (const e of c.dev.config?.interfaces ?? []) {
    if (c.s.ifaces.includes(e.name) || !e.ipv6 || e.prefix6 == null) continue;
    const p = Math.min(e.prefix6, prefix);
    if (isValidIp6(e.ipv6) && sameSubnet6(e.ipv6, ip, p)) return c.out.push(`% ${UP(networkLabel6(ip, prefix))} overlaps with ${iosLongName(e.name)}`, '');
  }
  forIfaces(c, (e) => {
    Object.assign(e, { ipv6: ip, prefix6: prefix });
    if (eui64) e.eui64 = true;
    else delete e.eui64;
    delete e.ipv6Enable;
  });
}

function clearV6(e) {
  for (const k of ['ipv6', 'prefix6', 'eui64', 'linkLocal']) delete e[k];
}

// guard : sur un switch, seulement sur une interface VLAN
export function ipv6InterfaceCommands(forIfaces, guard = (run) => run) {
  const add = kw('ipv6', 'IPv6 interface subcommands', {
    children: [
      kw('address', 'Configure IPv6 address on interface', {
        children: [
          arg('addr', 'X:X:X:X::X/<0-128>', 'IPv6 prefix', isPrefixed, {
            run: guard((c) => setGlobal(c, forIfaces, false)),
            children: [kw('eui-64', 'Use eui-64 interface identifier', { run: guard((c) => setGlobal(c, forIfaces, true)) })],
          }),
          arg('ll', 'X:X:X:X::X', 'IPv6 link-local address', isLinkLocalAddr, {
            children: [kw('link-local', 'Use link-local address', {
              run: guard((c) => forIfaces(c, (e) => { e.linkLocal = normIp6(c.args.ll); delete e.ipv6Enable; })),
            })],
          }),
        ],
      }),
      kw('enable', 'Enable IPv6 on interface', { run: guard((c) => forIfaces(c, (e) => { if (!e.ipv6 && !e.linkLocal) e.ipv6Enable = true; })) }),
      ospf6InterfaceCommand(forIfaces),
      trafficFilterCommands(forIfaces).add,
      ...dhcp6InterfaceCommands(forIfaces, guard),
    ],
  });
  const remove = kw('ipv6', 'IPv6 interface subcommands', {
    children: [
      kw('address', 'Configure IPv6 address on interface', {
        run: guard((c) => forIfaces(c, clearV6)),
        children: [
          arg('addr', 'X:X:X:X::X/<0-128>', 'IPv6 prefix', isPrefixed, {
            run: guard((c) => forIfaces(c, (e) => { if (e.ipv6 && normIp6(e.ipv6) === splitPrefix6(c.args.addr).ip) for (const k of ['ipv6', 'prefix6', 'eui64']) delete e[k]; })),
            children: [kw('eui-64', '', { run: guard((c) => forIfaces(c, (e) => { for (const k of ['ipv6', 'prefix6', 'eui64']) delete e[k]; })) })],
          }),
          arg('ll', 'X:X:X:X::X', 'IPv6 link-local address', isLinkLocalAddr, {
            children: [kw('link-local', '', { run: guard((c) => forIfaces(c, (e) => { delete e.linkLocal; })) })],
          }),
        ],
      }),
      kw('enable', 'Enable IPv6 on interface', { run: guard((c) => forIfaces(c, (e) => { delete e.ipv6Enable; })) }),
      ospf6InterfaceCommand(forIfaces, true),
      trafficFilterCommands(forIfaces).remove,
      ...dhcp6InterfaceCommands(forIfaces, guard, true),
    ],
  });
  return { add, remove };
}

// --- Global -------------------------------------------------------------------------------------
// « ipv6 route ::/0 2001:db8::1 », « ipv6 route ::/0 Serial0/0/0 », « ipv6 route ::/0 G0/1 FE80::2 »
function parseRoute(text, parseIface) {
  const [dst, a, b] = text.trim().split(/\s+/);
  const p = splitPrefix6(dst ?? '');
  if (!p) return { error: '% Invalid input detected at prefix' };
  if (isValidIp6(a ?? '')) {
    if (isLinkLocal6(a)) return { error: '% Interface has to be specified for a link-local nexthop' };
    return { route: { network: p.ip, prefix: p.prefix, nextHop: normIp6(a) } };
  }
  const iface = a && parseIface(a);
  if (!iface) return { error: '% Invalid input detected at interface' };
  if (b && !isValidIp6(b)) return { error: '% Invalid next hop address' };
  return { route: { network: p.ip, prefix: p.prefix, iface, ...(b ? { nextHop: normIp6(b) } : {}) } };
}
const sameRoute = (r, x) => normIp6(r.network) === x.network && r.prefix === x.prefix && (r.nextHop ?? null) === (x.nextHop ?? null) && (r.iface ?? null) === (x.iface ?? null);

export function ipv6GlobalCommands(parseIface) {
  const add = kw('ipv6', 'Global IPv6 configuration commands', {
    children: [
      kw('unicast-routing', 'Enable unicast routing', { run: (c) => { c.dev.config.ipv6Routing = true; c.changed = true; } }),
      kw('router', 'Enable an IPV6 routing process', { children: [ospf6RouterCommand()] }),
      acl6ConfigCommands().add,
      dhcp6PoolCommand(),
      kw('route', 'Configure static routes', {
        children: [rest('spec', 'X:X:X:X::X/<0-128>', 'IPv6 prefix', (c) => {
          const r = parseRoute(c.args.spec, parseIface(c));
          if (r.error) return c.out.push(r.error, '');
          const routes = (c.dev.config.routes6 ?? []).filter((x) => !sameRoute(x, r.route));
          c.dev.config.routes6 = [...routes, r.route];
          c.changed = true;
        })],
      }),
    ],
  });
  const remove = kw('ipv6', 'Global IPv6 configuration commands', {
    children: [
      kw('unicast-routing', 'Enable unicast routing', { run: (c) => { delete c.dev.config.ipv6Routing; c.changed = true; } }),
      kw('router', 'Enable an IPV6 routing process', { children: [ospf6RouterCommand(true)] }),
      acl6ConfigCommands().remove,
      dhcp6PoolCommand(true),
      kw('route', 'Configure static routes', {
        children: [rest('spec', 'X:X:X:X::X/<0-128>', 'IPv6 prefix', (c) => {
          const r = parseRoute(c.args.spec, parseIface(c));
          if (r.error) return c.out.push(r.error, '');
          const routes = (c.dev.config.routes6 ?? []).filter((x) => !sameRoute(x, r.route));
          if (routes.length) c.dev.config.routes6 = routes;
          else delete c.dev.config.routes6;
          c.changed = true;
        })],
      }),
    ],
  });
  return { add, remove };
}

// --- Affichage ------------------------------------------------------------------------------------
const liveDoc = (c) => withLeases(withDevice(c.doc, c.dev));

function showIntBrief(c, names, state) {
  const doc = liveDoc(c);
  const topo = buildTopology(doc);
  const views = new Map(topo.l3Ifaces6(c.dev.id, { includeDown: true }).map((i) => [i.name, i]));
  const out = [];
  for (const name of names) {
    const [status, proto] = state(c.dev, name, doc, topo);
    out.push(`${pad(iosLongName(name), 27)}[${status}/${proto}]`);
    const v = views.get(name);
    if (!v) out.push('    unassigned');
    else for (const a of [v.linkLocal, v.ip].filter(Boolean)) out.push(`    ${UP(a)}`);
  }
  return [...out, ''];
}

const CODES = [
  'Codes: C - Connected, L - Local, S - Static, U - Per-user Static route',
  '       B - BGP, R - RIP, I1 - ISIS L1, I2 - ISIS L2',
  '       O - OSPF Intra, OI - OSPF Inter, OE1 - OSPF ext 1, OE2 - OSPF ext 2',
];
function showRoute(c) {
  const rib = computeRouting(liveDoc(c)).ribs6.get(c.dev.id) ?? new Map();
  const routes = [...rib.values()].sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : a.prefix - b.prefix));
  const out = [`IPv6 Routing Table - default - ${routes.length + 1} entries`, ...CODES];
  for (const r of routes) {
    const code = { 'S*': 'S', 'O IA': 'OI', 'O E2': 'OE2', 'O*E2': 'OE2' }[r.proto] ?? r.proto;
    out.push(`${pad(code, 4)}${UP(routeText6(r))} [${r.ad}/${r.metric}]`);
    if (r.proto === 'C') out.push(`     via ${iosLongName(r.iface)}, directly connected`);
    else if (r.proto === 'L') out.push(`     via ${iosLongName(r.iface)}, receive`);
    else out.push(`     via ${[r.nextHop && UP(r.nextHop), r.iface && !r.nextHop ? iosLongName(r.iface) : r.nextHop && isLinkLocal6(r.nextHop) ? iosLongName(r.iface) : null].filter(Boolean).join(', ')}`);
  }
  out.push('L   FF00::/8 [0/0]', '     via Null0, receive', '');
  return out;
}

function showNeighbors(c) {
  const rows = ndRows(c.dev, liveDoc(c));
  return [
    `${pad('IPv6 Address', 42)}${pad('Age', 4)}${pad('Link-layer Addr', 16)}${pad('State', 6)}Interface`,
    ...rows.map((r) => `${pad(UP(r.ip), 42)}${pad(Math.floor(r.age / 60), 4)}${pad(macCisco(r.mac), 16)}${pad(r.state, 6)}${shortName(r.iface)}`),
    '',
  ];
}

// show ipv6 … ; names(dev) : interfaces à lister, state : état IOS d'une interface
export function ipv6ShowCommand(names, state) {
  return kw('ipv6', 'IPv6 information', {
    children: [
      kw('interface', 'IPv6 interface status and configuration', {
        children: [kw('brief', 'Brief summary of IPv6 status and configuration', { run: (c) => c.out.push(...showIntBrief(c, names(c.dev), state)) })],
      }),
      kw('route', 'Show IPv6 route table entries', { run: (c) => c.out.push(...showRoute(c)) }),
      kw('neighbors', 'Show IPv6 neighbor cache entries', { run: (c) => c.out.push(...showNeighbors(c)) }),
      dhcp6ShowCommand(),
      kw('access-list', 'Summary of access lists', {
        run: (c) => c.out.push(...showIpv6AccessLists(c.dev)),
        children: [arg('name', 'WORD', 'Access list name', null, { run: (c) => c.out.push(...showIpv6AccessLists(c.dev, c.args.name)) })],
      }),
      kw('ospf', 'OSPF information', { children: [kw('neighbor', 'Neighbor list', { run: (c) => c.out.push(...showOspf6Neighbor(c.dev, liveDoc(c))) })] }),
    ],
  });
}

// --- DHCPv6 ---------------------------------------------------------------------------------------
// « ipv6 dhcp pool NOM » (address prefix, dns-server) ; interface : « ipv6 dhcp server NOM »,
// « ipv6 nd managed-config-flag » (M : adresse par DHCPv6) et « other-config-flag » (O : DNS par DHCPv6)
const isName = (t) => /^[A-Za-z0-9_-]+$/.test(t);
const poolOf = (c) => c.dev.config.dhcp6Pools[c.s.pool];

export function dhcp6InterfaceCommands(forIfaces, guard = (run) => run, remove = false) {
  const flag = (key) => guard((c) => forIfaces(c, (e) => { if (remove) delete e[key]; else e[key] = true; }));
  return [
    kw('dhcp', 'IPv6 DHCP interface subcommands', {
      children: [kw('server', 'Configure IPv6 DHCP server on this interface', {
        ...(remove ? { run: guard((c) => forIfaces(c, (e) => { delete e.dhcp6Server; })) } : {}),
        children: [arg('pool', 'WORD', 'Name of IPv6 DHCP pool', isName, {
          run: guard((c) => forIfaces(c, (e) => { if (remove) delete e.dhcp6Server; else e.dhcp6Server = c.args.pool; })),
        })],
      })],
    }),
    kw('nd', 'IPv6 interface Neighbor Discovery subcommands', {
      children: [
        kw('managed-config-flag', 'Hosts should use DHCP for address config', { run: flag('ndManaged') }),
        kw('other-config-flag', 'Hosts should use DHCP for non-address config', { run: flag('ndOther') }),
      ],
    }),
  ];
}

export function dhcp6PoolCommand(remove = false) {
  return kw('dhcp', 'Configure IPv6 DHCP', {
    children: [kw('pool', 'Configure IPv6 DHCP pool', {
      children: [arg('name', 'WORD', 'DHCP pool name', isName, {
        run: (c) => {
          const pools = (c.dev.config.dhcp6Pools ??= {});
          if (remove) {
            delete pools[c.args.name];
            if (!Object.keys(pools).length) delete c.dev.config.dhcp6Pools;
          } else {
            pools[c.args.name] ??= {};
            c.s.mode = 'dhcp6-pool';
            c.s.pool = c.args.name;
          }
          c.changed = true;
        },
      })],
    })],
  });
}

export function dhcp6PoolTree(common) {
  return {
    children: [
      kw('address', 'Configure address assignment', {
        children: [kw('prefix', 'IPv6 prefix', {
          children: [arg('prefix', 'X:X:X:X::X/<0-128>', 'IPv6 prefix', isPrefixed, {
            run: (c) => {
              const p = splitPrefix6(c.args.prefix);
              Object.assign(poolOf(c), { prefix: normIp6(networkLabel6(p.ip, p.prefix).split('/')[0]), len: p.prefix });
              c.changed = true;
            },
            children: [rest('x', 'lifetime', 'Configure prefix lifetimes', (c) => {
              const p = splitPrefix6(c.args.prefix);
              Object.assign(poolOf(c), { prefix: normIp6(networkLabel6(p.ip, p.prefix).split('/')[0]), len: p.prefix });
              c.changed = true;
            })],
          })],
        })],
      }),
      kw('dns-server', 'DNS servers', {
        children: [arg('ip', 'X:X:X:X::X', 'DNS server address', isValidIp6, { run: (c) => { poolOf(c).dns = normIp6(c.args.ip); c.changed = true; } })],
      }),
      kw('domain-name', 'Domain name to complete unqualified host names', { children: [rest('x', 'WORD', 'Domain name', () => {})] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('address', '', { children: [kw('prefix', '', { run: (c) => { delete poolOf(c).prefix; delete poolOf(c).len; c.changed = true; }, children: [rest('x', 'X:X:X:X::X/<0-128>', '', (c) => { delete poolOf(c).prefix; delete poolOf(c).len; c.changed = true; })] })] }),
          kw('dns-server', '', { run: (c) => { delete poolOf(c).dns; c.changed = true; }, children: [rest('x', 'X:X:X:X::X', '', (c) => { delete poolOf(c).dns; c.changed = true; })] }),
        ],
      }),
      kw('exit', 'Exit from DHCPv6 configuration mode', { run: (c) => { c.s.mode = 'config'; } }),
      ...common,
    ],
  };
}

function showDhcp6(c, what) {
  const doc = liveDoc(c);
  const pools = Object.entries(c.dev.config?.dhcp6Pools ?? {});
  const bindings = doc.devices.filter((d) => d.config?.slaac6?.how === 'dhcp6' && d.config.slaac6.router === c.dev.id);
  if (what === 'pool') {
    return [...pools.flatMap(([name, p]) => {
      const n = bindings.filter((b) => (c.dev.config.interfaces ?? []).some((i) => i.dhcp6Server === name && i.name === b.config.slaac6.iface)).length;
      return [`DHCPv6 pool: ${name}`, ...(p.prefix ? [`  Address allocation prefix: ${UP(p.prefix)}/${p.len} valid 172800 preferred 86400 (${n} in use, 0 conflicts)`] : []),
        ...(p.dns ? [`  DNS server: ${UP(p.dns)}`] : []), `  Active clients: ${n}`];
    }), ''];
  }
  return [...bindings.flatMap((b) => [`Client: ${b.label}`, `  Interface : ${iosLongName(b.config.slaac6.iface)}`, `  IA NA: IA ID 0x00040001, T1 43200, T2 69120`,
    `    Address: ${UP(b.config.slaac6.ip)}`, '      preferred lifetime 86400, valid lifetime 172800']), ''];
}
export const dhcp6ShowCommand = () => kw('dhcp', 'IPv6 DHCP', {
  children: [
    kw('pool', 'DHCPv6 pools', { run: (c) => c.out.push(...showDhcp6(c, 'pool')) }),
    kw('binding', 'DHCPv6 bindings', { run: (c) => c.out.push(...showDhcp6(c, 'binding')) }),
  ],
});
