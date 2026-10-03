// Terminal IOS : routage dynamique (router ospf / rip / bgp) et commandes show associées.
import { accept, arg, kw, rest } from './engine.js';
import { pad } from './device.js';
import { computeRouting, prefixText, wildcardToCidr } from '../net/routing.js';
import { cidrToMask, formatIp, isValidIp, networkOf } from '../net/ip.js';
import { iosLongName } from '../export/cisco.js';
import { parseInterfaces } from './ios.js';

const isIp = (t) => isValidIp(t);
const isNum = (min, max) => (t) => /^\d+$/.test(t) && Number(t) >= min && Number(t) <= max;
// Zone : « 0 » ou « 0.0.0.0 »
const isArea = (t) => isNum(0, 4294967295)(t) || isValidIp(t);
const areaNum = (t) => (isValidIp(t) ? t.split('.').reduce((a, b) => a * 256 + Number(b), 0) : Number(t));
const long = iosLongName;
const UPTIME = '00:05:00';

// --- show ---------------------------------------------------------------------------------
const CODES = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2',
  '       * - candidate default, U - per-user static route, o - ODR',
];

const FILTERS = { connected: /^[CL]$/, static: /^S/, ospf: /^O/, rip: /^R/, bgp: /^B$/ };

export function showIpRoute(dev, doc, filter = null) {
  const rib = computeRouting(doc).ribs.get(dev.id) ?? new Map();
  const routes = [...rib.values()].filter((r) => !filter || FILTERS[filter].test(r.proto)).sort((a, b) => a.net - b.net || a.mask - b.mask);
  if (filter) return [...routes.map(formatRoute), ''];
  const def = rib.get('0/0');
  const lines = routes.map(formatRoute);
  return [
    ...CODES, '',
    def ? `Gateway of last resort is ${def.nextHop} to network 0.0.0.0` : 'Gateway of last resort is not set',
    '', ...lines, '',
  ];
}

function formatRoute(r) {
  const code = pad(r.proto, 5);
  const p = prefixText(r.net, r.mask);
  if (r.proto === 'C' || r.proto === 'L') return `${code}${p} is directly connected, ${long(r.iface)}`;
  if (r.proto.startsWith('S')) return `${code}${p} [${r.ad}/${r.metric}] via ${r.nextHop}`;
  if (r.proto === 'B') return `${code}${p} [${r.ad}/${r.metric}] via ${r.nextHop}, ${UPTIME}`;
  return `${code}${p} [${r.ad}/${r.metric}] via ${r.nextHop}, ${UPTIME}, ${long(r.iface)}`;
}

export const routeFilters = () => Object.keys(FILTERS).map((f) => kw(f, `${f} routes`, { run: (c) => c.out.push(...showIpRoute(c.dev, c.doc, f)) }));

const routerOf = (dev, doc) => computeRouting(doc).routers.get(dev.id);
const explain = (r, re) => (r?.issues ?? []).filter((i) => re.test(i.text)).map((i) => `% NetCanvas : ${i.text}`);

export function showOspfNeighbor(dev, doc) {
  const r = routerOf(dev, doc);
  const rows = [`${pad('Neighbor ID', 16)}${pad('Pri', 6)}${pad('State', 16)}${pad('Dead Time', 12)}${pad('Address', 16)}Interface`];
  for (const n of r?.ospf.neighbors ?? []) {
    const state = n.p2p ? 'FULL/  -' : `FULL/${n.role}`;
    rows.push(`${pad(n.peer.ospf.routerId, 16)}${pad(n.p2p ? 0 : 1, 6)}${pad(state, 16)}${pad('00:00:35', 12)}${pad(n.peerIface.ip, 16)}${long(n.iface.name)}`);
  }
  return [...rows, '', ...explain(r, /^OSPF/), ...(r?.issues.some((i) => /^OSPF/.test(i.text)) ? [''] : [])];
}

export function showOspfInterfaceBrief(dev, doc) {
  const r = routerOf(dev, doc);
  const rows = [`${pad('Interface', 13)}${pad('PID', 6)}${pad('Area', 16)}${pad('IP Address/Mask', 19)}${pad('Cost', 6)}${pad('State', 6)}Nbrs F/C`];
  for (const x of r?.ospf.ifaces ?? []) {
    const nbrs = r.ospf.neighbors.filter((n) => n.iface.name === x.iface.name).length;
    const p2p = r.peers.some((p) => p.iface.name === x.iface.name && p.p2p);
    const state = x.iface.loopback ? 'LOOP' : p2p ? 'P2P' : nbrs ? (r.ospf.neighbors.some((n) => n.iface.name === x.iface.name && n.role === 'DR') ? 'BDR' : 'DR') : 'DR';
    const short = long(x.iface.name).replace(/^(\w\w)\w*?(\d)/, '$1$2');
    rows.push(`${pad(short, 13)}${pad(dev.config.ospf.processId ?? 1, 6)}${pad(x.area, 16)}${pad(`${x.iface.ip}/${x.iface.mask}`, 19)}${pad(x.cost, 6)}${pad(state, 6)}${nbrs}/${nbrs}`);
  }
  return [...rows, ''];
}

export function showIpProtocols(dev, doc) {
  const r = routerOf(dev, doc);
  const c = dev.config ?? {};
  const out = [];
  if (c.ospf) {
    out.push(`Routing Protocol is "ospf ${c.ospf.processId ?? 1}"`, `  Router ID ${r.ospf.routerId}`, '  Routing for Networks:');
    for (const n of c.ospf.networks ?? []) out.push(`    ${n.network} ${n.wildcard} area ${n.area}`);
    if (c.ospf.passive?.length) out.push('  Passive Interface(s):', ...c.ospf.passive.map((p) => `    ${long(p)}`));
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    for (const n of r.ospf.neighbors) out.push(`    ${pad(n.peer.ospf.routerId, 16)}${pad(110, 14)}${UPTIME}`);
    out.push('  Distance: (default is 110)', '');
  }
  if (c.rip) {
    const v = c.rip.version;
    out.push('Routing Protocol is "rip"', '  Sending updates every 30 seconds, next due in 12 seconds',
      `  Default version control: send version ${v ?? 1}, receive ${v ? `version ${v}` : 'any version'}`,
      `  Automatic network summarization is ${c.rip.autoSummary ? '' : 'not '}in effect`, '  Routing for Networks:',
      ...(c.rip.networks ?? []).map((n) => `\t${n}`));
    if (c.rip.passive?.length) out.push('  Passive Interface(s):', ...c.rip.passive.map((p) => `    ${long(p)}`));
    out.push('  Distance: (default is 120)', '');
  }
  if (c.bgp?.asn) {
    out.push(`Routing Protocol is "bgp ${c.bgp.asn}"`, '  IGP synchronization is disabled', '  Neighbor(s):', '    Address          FiltIn FiltOut DistIn DistOut Weight RouteMap');
    for (const n of c.bgp.neighbors ?? []) out.push(`    ${n.ip}`);
    out.push('  Distance: external 20 internal 200 local 200', '');
  }
  if (!out.length) out.push('');
  return out;
}

export function showBgpSummary(dev, doc) {
  const r = routerOf(dev, doc);
  if (!r?.bgp.enabled) return ['% BGP not active', ''];
  const rows = [
    `BGP router identifier ${r.bgp.routerId}, local AS number ${r.bgp.asn}`,
    `BGP table version is ${r.bgp.table.size + 1}, main routing table version ${r.bgp.table.size + 1}`,
    `${r.bgp.table.size} network entries using ${r.bgp.table.size * 132} bytes of memory`,
    '',
    `${pad('Neighbor', 16)}${pad('V', 5)}${pad('AS', 6)}${pad('MsgRcvd', 8)}${pad('MsgSent', 10)}${pad('TblVer', 7)}${pad('InQ', 5)}${pad('OutQ', 5)}${pad('Up/Down', 9)}State/PfxRcd`,
  ];
  for (const s of r.bgp.sessions) {
    const up = s.state === 'Established';
    const pfx = up ? [...(r.bgp.adjIn?.get(s.peer.id)?.size ? [r.bgp.adjIn.get(s.peer.id).size] : [0])][0] : 'Active';
    rows.push(`${pad(s.neighbor, 16)}${pad(4, 5)}${pad(s.remoteAs, 6)}${pad(up ? 12 : 0, 8)}${pad(up ? 12 : 0, 10)}${pad(up ? r.bgp.table.size + 1 : 0, 7)}${pad(0, 5)}${pad(0, 5)}${pad(up ? UPTIME : 'never', 9)}${pfx}`);
  }
  const down = r.bgp.sessions.filter((s) => s.state !== 'Established');
  return [...rows, '', ...down.map((s) => `% NetCanvas : ${s.neighbor} : ${s.reason}.`), ...(down.length ? [''] : [])];
}

export function showBgp(dev, doc) {
  const r = routerOf(dev, doc);
  if (!r?.bgp.enabled) return ['% BGP not active', ''];
  const rows = [
    `BGP table version is ${r.bgp.table.size + 1}, local router ID is ${r.bgp.routerId}`,
    'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal,',
    '              r RIB-failure, S Stale',
    'Origin codes: i - IGP, e - EGP, ? - incomplete',
    '',
    `   ${pad('Network', 17)}${pad('Next Hop', 20)}${'Metric'.padStart(6)} ${'LocPrf'.padStart(6)} ${'Weight'.padStart(6)} Path`,
  ];
  const entries = [...r.bgp.table.values()].flat().sort((a, b) => a.net - b.net || a.mask - b.mask || Number(b.best) - Number(a.best));
  for (const p of entries) {
    const status = `${p.valid ? '*' : ' '}${p.best ? '>' : ' '}${!p.local && !p.ebgp ? 'i' : ' '}`;
    const locPrf = !p.local && !p.ebgp ? '100' : '';
    rows.push(`${status}${pad(prefixText(p.net, p.mask), 17)}${pad(p.nextHop, 20)}${'0'.padStart(6)} ${locPrf.padStart(6)} ${String(p.local ? 32768 : 0).padStart(6)} ${[...p.asPath, p.origin ?? 'i'].join(' ')}`);
  }
  return [...rows, '', ...explain(r, /^BGP : .* (n'annonce|reçoit)/), ''];
}

export const routingShows = () => [
  kw('ospf', 'OSPF information', {
    run: (c) => {
      const r = routerOf(c.dev, c.doc);
      c.out.push(...(r?.ospf.enabled ? [` Routing Process "ospf ${c.dev.config.ospf.processId ?? 1}" with ID ${r.ospf.routerId}`, ` Number of areas in this router is ${r.ospf.areas.length}`, ''] : ['%OSPF: No router process', '']));
    },
    children: [
      kw('neighbor', 'Neighbor list', { run: (c) => c.out.push(...showOspfNeighbor(c.dev, c.doc)) }),
      kw('interface', 'Interface information', { children: [kw('brief', 'Brief summary of OSPF interfaces', { run: (c) => c.out.push(...showOspfInterfaceBrief(c.dev, c.doc)) })] }),
      kw('database', 'Database summary', { run: (c) => c.out.push('% NetCanvas : la base LSDB n\'est pas affichée (SPF calculé directement).', '') }),
    ],
  }),
  kw('bgp', 'BGP information', {
    run: (c) => c.out.push(...showBgp(c.dev, c.doc)),
    children: [kw('summary', 'Summary of BGP neighbor status', { run: (c) => c.out.push(...showBgpSummary(c.dev, c.doc)) })],
  }),
  kw('protocols', 'IP routing protocol process parameters and statistics', { run: (c) => c.out.push(...showIpProtocols(c.dev, c.doc)) }),
  kw('rip', 'IP RIP show commands', {
    children: [kw('database', 'IP RIP database', {
      run: (c) => {
        const r = routerOf(c.dev, c.doc);
        for (const e of r?.rip.table.values() ?? []) {
          c.out.push(`${prefixText(e.net, e.mask)}    ${e.metric === 0 ? 'directly connected' : `[${e.metric}] via ${e.via.nextHop}, ${long(e.via.iface)}`}`);
        }
        c.out.push('');
      },
    })],
  }),
];

// --- config ---------------------------------------------------------------------------------
const ospfOf = (c) => (c.dev.config.ospf ??= { processId: c.s.process ?? 1, networks: [] });
const ripOf = (c) => (c.dev.config.rip ??= { networks: [] });
const bgpOf = (c) => c.dev.config.bgp;
const touch = (c) => { c.changed = true; };

// passive-interface G0/0 : nom court stocké, comme dans le reste de la config
function passive(get, add) {
  return kw('passive-interface', 'Suppress routing updates on an interface', {
    children: [rest('ifname', 'WORD', 'Interface name', (c) => {
      const r = parseInterfaces(c.args.ifname, c.dev);
      if (r.error) return c.out.push(r.error, '');
      const conf = get(c);
      const list = new Set(conf.passive ?? []);
      for (const n of r.names) (add ? list.add(n) : list.delete(n));
      conf.passive = [...list];
      touch(c);
    })],
  });
}

const leaveRouter = () => kw('exit', 'Exit from routing protocol configuration mode', { run: (c) => { c.s.mode = 'config'; } });

export function ospfTree(common) {
  const network = (add) => kw('network', 'Enable routing on an IP network', {
    children: [arg('net', 'A.B.C.D', 'Network number', isIp, {
      children: [arg('wc', 'A.B.C.D', 'OSPF wild card bits', isIp, {
        children: [kw('area', 'Set the OSPF area ID', {
          children: [arg('area', '<0-4294967295>', 'OSPF area ID as a decimal value', isArea, {
            run: (c) => {
              const cidr = wildcardToCidr(c.args.wc);
              if (cidr === null) return c.out.push('% OSPF: Invalid wildcard mask', '');
              const o = ospfOf(c);
              const area = areaNum(c.args.area);
              const network = formatIp(networkOf(c.args.net, cidr));
              const same = (n) => n.network === network && n.wildcard === c.args.wc;
              const existing = (o.networks ??= []).find(same);
              if (add) {
                if (existing && Number(existing.area) !== area) return c.out.push(`% OSPF: "network ${network} ${c.args.wc} area ${existing.area}" is already configured`, '');
                if (!existing) o.networks.push({ network, wildcard: c.args.wc, area });
              } else o.networks = o.networks.filter((n) => !same(n));
              touch(c);
            },
          })],
        })],
      })],
    })],
  });
  const defaultInfo = (add) => kw('default-information', 'Control distribution of default information', {
    children: [kw('originate', 'Distribute a default route', {
      run: (c) => { ospfOf(c).defaultOriginate = add ? true : undefined; touch(c); },
      children: add ? [kw('always', 'Always advertise default route', { run: (c) => { ospfOf(c).defaultOriginate = 'always'; touch(c); } })] : [],
    })],
  });
  const redistribute = (add) => kw('redistribute', 'Redistribute information from another routing protocol', {
    children: ['static', 'connected'].map((p) => kw(p, `${p === 'static' ? 'Static' : 'Connected'} routes`, {
      run: (c) => { (ospfOf(c).redistribute ??= {})[p] = add; touch(c); },
      children: [kw('subnets', 'Consider subnets for redistribution into OSPF', { run: (c) => { (ospfOf(c).redistribute ??= {})[p] = add; touch(c); } }),
        rest('x', 'LINE', '', (c) => { (ospfOf(c).redistribute ??= {})[p] = add; touch(c); })],
    })),
  });
  return {
    children: [
      network(true),
      kw('router-id', 'router-id for this OSPF process', { children: [arg('rid', 'A.B.C.D', 'OSPF router-id in IP address format', isIp, { run: (c) => { ospfOf(c).routerId = c.args.rid; touch(c); c.out.push('Reload or use "clear ip ospf process" command, for this to take effect', ''); } })] }),
      passive(ospfOf, true),
      defaultInfo(true),
      redistribute(true),
      accept('log-adjacency-changes', 'Log changes in adjacency state'),
      accept('auto-cost', 'Calculate OSPF interface cost according to bandwidth'),
      accept('area', 'OSPF area parameters'),
      kw('no', 'Negate a command or set its defaults', {
        children: [network(false), passive(ospfOf, false), defaultInfo(false), redistribute(false),
          kw('router-id', '', { run: (c) => { delete ospfOf(c).routerId; touch(c); } }), accept('log-adjacency-changes', '')],
      }),
      leaveRouter(),
      ...common,
    ],
  };
}

export function ripTree(common) {
  const network = (add) => kw('network', 'Enable routing on an IP network', {
    children: [arg('net', 'A.B.C.D', 'Network number', isIp, {
      run: (c) => {
        const r = ripOf(c);
        // IOS ramène le réseau à sa classe : « network 10.1.0.0 » devient 10.0.0.0
        const first = Number(c.args.net.split('.')[0]);
        const mask = first < 128 ? 8 : first < 192 ? 16 : 24;
        const classful = formatIp(networkOf(c.args.net, mask));
        const list = new Set(r.networks ?? []);
        if (add) list.add(classful); else list.delete(classful);
        r.networks = [...list];
        touch(c);
      },
    })],
  });
  return {
    children: [
      kw('version', 'Set routing protocol version', {
        children: [arg('v', '<1-2>', 'version', isNum(1, 2), { run: (c) => { ripOf(c).version = Number(c.args.v); touch(c); } })],
      }),
      network(true),
      passive(ripOf, true),
      kw('auto-summary', 'Enable automatic network number summarization', { run: (c) => { ripOf(c).autoSummary = true; touch(c); c.out.push('% NetCanvas : le résumé automatique n\'est pas simulé (routes calculées sans résumé).', ''); } }),
      kw('default-information', 'Control distribution of default information', { children: [kw('originate', 'Distribute a default route', { run: (c) => { ripOf(c).defaultOriginate = true; touch(c); } })] }),
      kw('redistribute', 'Redistribute information from another routing protocol', {
        children: [kw('static', 'Static routes', { run: (c) => { (ripOf(c).redistribute ??= {}).static = true; touch(c); }, children: [rest('x', 'LINE', '', (c) => { (ripOf(c).redistribute ??= {}).static = true; touch(c); })] })],
      }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          network(false), passive(ripOf, false),
          kw('auto-summary', 'Enable automatic network number summarization', { run: (c) => { ripOf(c).autoSummary = false; touch(c); } }),
          kw('default-information', '', { children: [kw('originate', '', { run: (c) => { delete ripOf(c).defaultOriginate; touch(c); } })] }),
          kw('redistribute', '', { children: [kw('static', '', { run: (c) => { delete ripOf(c).redistribute; touch(c); } })] }),
        ],
      }),
      leaveRouter(),
      ...common,
    ],
  };
}

export function bgpTree(common) {
  const neighborOf = (c) => (bgpOf(c).neighbors ??= []).find((n) => n.ip === c.args.ip);
  // Les options d'un voisin exigent « remote-as » d'abord, comme sur IOS
  const option = (word, help, apply, children) => kw(word, help, {
    ...(children ? { children } : {}),
    ...(apply ? { run: (c) => { const n = neighborOf(c); if (!n) return c.out.push('% Specify remote-as or peer-group commands first', ''); apply(c, n); touch(c); } } : {}),
  });
  const neighbor = arg('ip', 'A.B.C.D', 'Neighbor address', isIp, {
    children: [
      kw('remote-as', 'Specify a BGP neighbor', {
        children: [arg('as', '<1-65535>', 'AS of remote neighbor', isNum(1, 4294967295), {
          run: (c) => {
            const n = neighborOf(c);
            if (n) n.remoteAs = Number(c.args.as);
            else bgpOf(c).neighbors.push({ ip: c.args.ip, remoteAs: Number(c.args.as) });
            touch(c);
          },
        })],
      }),
      option('update-source', 'Source of routing updates', null, [rest('ifname', 'WORD', 'Interface name', (c) => {
        const n = neighborOf(c);
        if (!n) return c.out.push('% Specify remote-as or peer-group commands first', '');
        const r = parseInterfaces(c.args.ifname, c.dev);
        if (r.error) return c.out.push(r.error, '');
        n.updateSource = r.names[0];
        touch(c);
      })]),
      option('next-hop-self', 'Disable the next hop calculation for this neighbor', (c, n) => { n.nextHopSelf = true; }),
      option('ebgp-multihop', 'Allow EBGP neighbors not on directly connected networks', (c, n) => { n.ebgpMultihop = 255; },
        [arg('ttl', '<1-255>', 'maximum hop count', isNum(1, 255), { run: (c) => { const n = neighborOf(c); if (!n) return c.out.push('% Specify remote-as or peer-group commands first', ''); n.ebgpMultihop = Number(c.args.ttl); touch(c); } })]),
      accept('description', 'Neighbor specific description'),
      accept('password', 'Set a password'),
    ],
  });
  const noNeighbor = arg('ip', 'A.B.C.D', 'Neighbor address', isIp, {
    run: (c) => { bgpOf(c).neighbors = (bgpOf(c).neighbors ?? []).filter((n) => n.ip !== c.args.ip); touch(c); },
    children: [
      kw('next-hop-self', '', { run: (c) => { const n = neighborOf(c); if (n) delete n.nextHopSelf; touch(c); } }),
      kw('update-source', '', { run: (c) => { const n = neighborOf(c); if (n) delete n.updateSource; touch(c); } }),
      kw('ebgp-multihop', '', { run: (c) => { const n = neighborOf(c); if (n) delete n.ebgpMultihop; touch(c); } }),
    ],
  });
  const network = (add) => kw('network', 'Specify a network to announce via BGP', {
    children: [arg('net', 'A.B.C.D', 'Network number', isIp, {
      // Sans « mask », le masque de la classe
      run: (c) => setNetwork(c, add, c.args.net, Number(c.args.net.split('.')[0]) < 128 ? 8 : Number(c.args.net.split('.')[0]) < 192 ? 16 : 24),
      children: [kw('mask', 'Network mask', {
        children: [arg('mask', 'A.B.C.D', 'Network mask', isIp, {
          run: (c) => {
            const cidr = [...Array(33).keys()].find((n) => cidrToMask(n) === c.args.mask);
            if (cidr === undefined) return c.out.push('% Invalid mask', '');
            setNetwork(c, add, c.args.net, cidr);
          },
        })],
      })],
    })],
  });
  const redistribute = (add) => kw('redistribute', 'Redistribute information from another routing protocol', {
    children: [
      kw('connected', 'Connected', { run: (c) => { (bgpOf(c).redistribute ??= {}).connected = add; touch(c); } }),
      kw('static', 'Static routes', { run: (c) => { (bgpOf(c).redistribute ??= {}).static = add; touch(c); } }),
      kw('ospf', 'Open Shortest Path First (OSPF)', { children: [rest('x', '<1-65535>', 'Process ID', (c) => { (bgpOf(c).redistribute ??= {}).ospf = add; touch(c); })] }),
    ],
  });
  return {
    children: [
      kw('neighbor', 'Specify a neighbor router', { children: [neighbor] }),
      network(true),
      kw('bgp', 'BGP specific commands', {
        children: [
          kw('router-id', 'Override configured router identifier', { children: [arg('rid', 'A.B.C.D', 'Manually configured router identifier', isIp, { run: (c) => { bgpOf(c).routerId = c.args.rid; touch(c); } })] }),
          accept('log-neighbor-changes', 'Log neighbor up/down and reset reason'),
        ],
      }),
      redistribute(true),
      accept('synchronization', 'Perform IGP synchronization'),
      accept('auto-summary', 'Enable automatic network number summarization'),
      kw('no', 'Negate a command or set its defaults', {
        children: [kw('neighbor', 'Specify a neighbor router', { children: [noNeighbor] }), network(false), redistribute(false),
          accept('synchronization', ''), accept('auto-summary', ''),
          kw('bgp', '', { children: [kw('router-id', '', { run: (c) => { delete bgpOf(c).routerId; touch(c); } }), accept('log-neighbor-changes', '')] })],
      }),
      leaveRouter(),
      ...common,
    ],
  };
}

function setNetwork(c, add, ip, cidr) {
  const b = bgpOf(c);
  const network = formatIp(networkOf(ip, cidr));
  b.networks = (b.networks ?? []).filter((n) => !(n.network === network && Number(n.mask) === cidr));
  if (add) b.networks.push({ network, mask: cidr });
  touch(c);
}

// « router ospf 1 », « router rip », « router bgp 65001 » (mode config globale)
export function routerCommands() {
  const enter = (proto) => (c) => {
    const cfg = c.dev.config;
    if (proto === 'ospf') {
      const pid = Number(c.args.pid);
      if (cfg.ospf && Number(cfg.ospf.processId ?? 1) !== pid) {
        return c.out.push(`% NetCanvas : un seul processus OSPF par routeur (déjà « router ospf ${cfg.ospf.processId ?? 1} »).`, '');
      }
      cfg.ospf ??= { processId: pid, networks: [] };
      cfg.ospf.processId = pid;
    }
    if (proto === 'rip') cfg.rip ??= { networks: [] };
    if (proto === 'bgp') {
      const asn = Number(c.args.asn);
      if (cfg.bgp?.asn && Number(cfg.bgp.asn) !== asn) return c.out.push(`BGP is already running; AS is ${cfg.bgp.asn}`, '');
      cfg.bgp ??= { asn, neighbors: [], networks: [] };
    }
    c.s.mode = `router-${proto}`;
    touch(c);
  };
  const remove = (proto) => (c) => { delete c.dev.config[proto]; touch(c); };
  const tree = (run) => [
    kw('ospf', 'Open Shortest Path First (OSPF)', { children: [arg('pid', '<1-65535>', 'Process ID', isNum(1, 65535), { run: run('ospf') })] }),
    kw('rip', 'Routing Information Protocol (RIP)', { run: run('rip') }),
    kw('bgp', 'Border Gateway Protocol (BGP)', { children: [arg('asn', '<1-65535>', 'Autonomous system number', isNum(1, 4294967295), { run: run('bgp') })] }),
    kw('eigrp', 'Enhanced Interior Gateway Routing Protocol (EIGRP)', { children: [rest('x', '<1-65535>', '', (c) => c.out.push('% NetCanvas : EIGRP n\'est pas simulé (OSPF, RIP et BGP le sont).', ''))] }),
  ];
  return {
    router: kw('router', 'Enable a routing process', { children: tree(enter) }),
    noRouter: kw('router', 'Enable a routing process', { children: tree(remove) }),
  };
}

// Commandes d'interface liées au routage
export function interfaceRoutingCommands(forIfaces) {
  return {
    bandwidth: kw('bandwidth', 'Set bandwidth informational parameter', {
      children: [arg('bw', '<1-10000000>', 'Bandwidth in kilobits', isNum(1, 10000000), { run: (c) => forIfaces(c, (e) => { e.bandwidth = Number(c.args.bw); }) })],
    }),
    ipOspf: kw('ospf', 'OSPF interface commands', {
      children: [
        kw('cost', 'Interface cost', { children: [arg('cost', '<1-65535>', 'Cost', isNum(1, 65535), { run: (c) => forIfaces(c, (e) => { e.ospfCost = Number(c.args.cost); }) })] }),
        arg('pid', '<1-65535>', 'Process ID', isNum(1, 65535), {
          children: [kw('area', 'Set the OSPF area ID', {
            children: [arg('area', '<0-4294967295>', 'OSPF area ID', isArea, {
              run: (c) => {
                const o = (c.dev.config.ospf ??= { processId: Number(c.args.pid), networks: [] });
                const list = (o.interfaces ??= []).filter((x) => !c.s.ifaces.includes(x.name));
                o.interfaces = [...list, ...c.s.ifaces.map((name) => ({ name, area: areaNum(c.args.area) }))];
                c.changed = true;
              },
            })],
          })],
        }),
        accept('hello-interval', 'Time between HELLO packets'),
        accept('dead-interval', 'Interval after which a neighbor is declared dead'),
        accept('priority', 'Router priority'),
      ],
    }),
    noIpOspf: kw('ospf', '', {
      children: [
        kw('cost', '', { run: (c) => forIfaces(c, (e) => { delete e.ospfCost; }) }),
        rest('x', 'LINE', '', (c) => {
          const o = c.dev.config.ospf;
          if (o?.interfaces) o.interfaces = o.interfaces.filter((x) => !c.s.ifaces.includes(x.name));
          c.changed = true;
        }),
      ],
    }),
    noBandwidth: kw('bandwidth', '', { run: (c) => forIfaces(c, (e) => { delete e.bandwidth; }) }),
  };
}
