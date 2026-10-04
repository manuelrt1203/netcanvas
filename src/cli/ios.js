// Terminal Cisco IOS simulé (routeurs et switches Cisco). Il lit et écrit la même config que les formulaires.
import { accept, arg, complete as treeComplete, execute as treeExecute, help as treeHelp, kw, parse, rest } from './engine.js';
import { dataPorts, ensureEntry, getEntry, linkOf, maskToCidr, pad, ping, withDevice } from './device.js';
import { buildTopology, isLoopbackName } from '../net/topology.js';
import { cidrToMask, formatIp, isBroadcastAddress, isNetworkAddress, isValidIp, networkOf, parseIp, sameSubnet } from '../net/ip.js';
import { isSviName, modelOf } from '../net/catalog.js';
import { hostname as iosHostname, iosAclLines, iosInterfaceExtras, iosLongName, iosRoutingLines } from '../export/cisco.js';
import { traceroute } from '../net/traceroute.js';
import { accessGroupCommands, aclConfigCommands, aclShows, aclTree, showAccessLists } from './ios-acl.js';
import { bgpTree, interfaceRoutingCommands, ospfTree, ripTree, routeFilters, routerCommands, routingShows, showIpRoute } from './ios-routing.js';

const NOT_SIMULATED = (what) => [`% NetCanvas : ${what} n'est pas encore simulé.`, ''];

const isIp = (t) => isValidIp(t);
const isNum = (min, max) => (t) => /^\d+$/.test(t) && Number(t) >= min && Number(t) <= max;
const long = iosLongName;
// Loopbacks configurées, puis ports physiques (ordre de show run)
const loopbackEntries = (dev) => (dev.config?.interfaces ?? []).filter((e) => isLoopbackName(e.name))
  .sort((a, b) => Number(a.name.slice(2)) - Number(b.name.slice(2)));
// Ordre de show run : loopbacks, puis chaque port suivi de ses sous-interfaces
const subEntries = (dev, parent) => (dev.config?.interfaces ?? []).filter((e) => e.parent === parent)
  .sort((a, b) => Number(a.name.split('.')[1]) - Number(b.name.split('.')[1]));
const sviEntries = (dev) => (dev.config?.interfaces ?? []).filter((e) => isSviName(e.name))
  .sort((a, b) => Number(a.name.slice(4)) - Number(b.name.slice(4)));
const allInterfaces = (dev) => [
  ...(dev.type === 'switch' ? sviEntries(dev).map((e) => ({ name: e.name, media: 'virtual' })) : []),
  ...loopbackEntries(dev).map((e) => ({ name: e.name, media: 'virtual' })),
  ...dataPorts(dev).flatMap((p) => [p, ...subEntries(dev, p.name).map((e) => ({ name: e.name, media: 'virtual' }))]),
];

// --- Noms d'interfaces -------------------------------------------------------------
const IF_TYPES = [['gigabitethernet', 'G'], ['fastethernet', 'Fa'], ['serial', 'Se'], ['ethernet', 'Eth'], ['loopback', 'Lo']];

// « g0/0 », « GigabitEthernet 0/0/0 », « fa0/1 - 5, fa0/7 » -> liste de noms courts
export function parseInterfaces(text, dev, { range = false } = {}) {
  const ports = new Set(dataPorts(dev).map((p) => p.name));
  const out = [];
  for (const part of text.split(',')) {
    const m = /^\s*([a-z]+)\s*(\d+(?:\/\d+)*)(\.\d+)?(?:\s*-\s*(\d+))?\s*$/i.exec(part);
    if (!m) return { error: '% Invalid interface type and number' };
    const types = IF_TYPES.filter(([full]) => full.startsWith(m[1].toLowerCase()));
    if (types.length !== 1) return { error: '% Invalid interface type and number' };
    if (m[3] && (dev.type !== 'router' || m[4])) return { error: '% Invalid interface type and number' };
    if (m[4] && !range) return { error: '% Invalid interface type and number' };
    // Loopback : interface virtuelle, n'importe quel numéro (routeurs seulement)
    if (types[0][1] === 'Lo') {
      if (dev.type !== 'router' || m[4] || !/^\d+$/.test(m[2])) return { error: '% Invalid interface type and number' };
      out.push(`Lo${Number(m[2])}`);
      continue;
    }
    const nums = m[2].split('/');
    const first = Number(nums.at(-1));
    const last = m[4] ? Number(m[4]) : first;
    for (let n = first; n <= last; n++) {
      const name = `${types[0][1]}${[...nums.slice(0, -1), n].join('/')}`;
      if (!ports.has(name)) return { error: '% Invalid interface type and number' };
      out.push(m[3] ? `${name}${m[3]}` : name);
    }
  }
  return { names: out };
}

// --- Affichages -------------------------------------------------------------------
function portState(dev, name, doc, topo) {
  const e = getEntry(dev, name);
  if (e?.shutdown) return ['administratively down', 'down'];
  if (isLoopbackName(name)) return ['up', 'up'];
  if (isSviName(name)) return topo.sviUp(dev.id, Number(name.slice(4))) ? ['up', 'up'] : ['down', 'down'];
  // Sous-interface : état du câble de l'interface parente
  if (e?.parent && getEntry(dev, e.parent)?.shutdown) return ['down', 'down'];
  const link = linkOf(doc, dev.id, e?.parent ?? name);
  return link && topo.isUp(link) ? ['up', 'up'] : ['down', 'down'];
}

function showIpIntBrief(dev, doc) {
  const topo = buildTopology(doc);
  const rows = [`${pad('Interface', 23)}${pad('IP-Address', 16)}OK? Method Status                Protocol`];
  for (const p of allInterfaces(dev)) {
    const e = getEntry(dev, p.name);
    const ip = e?.ip && isValidIp(e.ip) ? e.ip : 'unassigned';
    const [status, proto] = portState(dev, p.name, doc, topo);
    rows.push(`${pad(long(p.name), 23)}${pad(ip, 16)}YES ${pad(ip === 'unassigned' ? 'unset' : 'manual', 7)}${pad(status, 22)}${proto}`);
  }
  return [...rows, ''];
}

function runningConfig(dev) {
  const lines = ['!', 'version 15.1', 'no service timestamps log datetime msec', '!', `hostname ${iosHostname(dev.label, dev.type)}`, '!'];
  if (dev.type === 'switch') {
    for (const p of dataPorts(dev)) {
      const e = getEntry(dev, p.name);
      lines.push(`interface ${long(p.name)}`);
      if (e?.description) lines.push(` description ${e.description}`);
      if (e?.mode === 'trunk') lines.push(' switchport mode trunk');
      else if (e && (Number(e.vlan) || 1) !== 1) lines.push(` switchport access vlan ${e.vlan}`);
      if (e?.shutdown) lines.push(' shutdown');
      lines.push('!');
    }
    const svis = sviEntries(dev);
    if (!svis.some((e) => e.name === 'Vlan1')) lines.push('interface Vlan1', ' no ip address', ' shutdown', '!');
    for (const e of svis) {
      lines.push(`interface ${e.name}`);
      if (e.description) lines.push(` description ${e.description}`);
      lines.push(e.ip && e.mask != null ? ` ip address ${e.ip} ${cidrToMask(e.mask)}` : ' no ip address');
      lines.push(...iosInterfaceExtras(dev.config ?? {}, e), ...(e.shutdown ? [' shutdown'] : []), '!');
    }
    const c = dev.config ?? {};
    if (c.ipRouting) lines.push('ip routing', '!');
    if (c.defaultGateway) lines.push(`ip default-gateway ${c.defaultGateway}`);
    for (const r of c.routes ?? []) {
      if (isValidIp(r.network) && r.mask != null && isValidIp(r.nextHop)) lines.push(`ip route ${r.network} ${cidrToMask(r.mask)} ${r.nextHop}`);
    }
    lines.push(...iosRoutingLines(c), ...iosAclLines(c), '!');
  } else {
    for (const p of allInterfaces(dev)) {
      const e = getEntry(dev, p.name);
      lines.push(`interface ${long(p.name)}`);
      if (e?.description) lines.push(` description ${e.description}`);
      if (e?.parent && e.vlan) lines.push(` encapsulation dot1Q ${e.vlan}${e.native ? ' native' : ''}`);
      lines.push(e?.ip && isValidIp(e.ip) && e.mask != null ? ` ip address ${e.ip} ${cidrToMask(e.mask)}` : ' no ip address');
      lines.push(...iosInterfaceExtras(dev.config ?? {}, e));
      if (e?.clockRate) lines.push(` clock rate ${e.clockRate}`);
      if (e?.shutdown) lines.push(' shutdown');
      lines.push('!');
    }
    lines.push(...iosRoutingLines(dev.config ?? {}));
    lines.push(...iosAclLines(dev.config ?? {}));
    lines.push('ip classless');
    for (const r of dev.config?.routes ?? []) {
      if (isValidIp(r.network) && r.mask != null && isValidIp(r.nextHop)) lines.push(`ip route ${r.network} ${cidrToMask(r.mask)} ${r.nextHop}`);
    }
    lines.push('!');
  }
  lines.push('line con 0', '!', 'line vty 0 4', ' login', '!', 'end');
  const text = lines.join('\n');
  return ['Building configuration...', '', `Current configuration : ${text.length} bytes`, ...lines, ''];
}

function vlanTable(dev) {
  const names = new Map([[1, 'default']]);
  for (const v of dev.config?.vlans ?? []) names.set(Number(v.id), v.name);
  const members = new Map();
  for (const p of dataPorts(dev)) {
    const e = getEntry(dev, p.name);
    if (e?.mode === 'trunk') continue;
    const v = Number(e?.vlan) || 1;
    if (!names.has(v)) names.set(v, `VLAN${String(v).padStart(4, '0')}`);
    members.set(v, [...(members.get(v) ?? []), p.name.replace(/^G(?=\d)/, 'Gig')]);
  }
  return [...names].sort(([a], [b]) => a - b).map(([id, name]) => ({ id, name, ports: members.get(id) ?? [] }));
}

function showVlanBrief(dev) {
  const rows = [
    '',
    `${pad('VLAN', 5)}${pad('Name', 33)}${pad('Status', 10)}Ports`,
    `${'-'.repeat(4)} ${'-'.repeat(32)} ${'-'.repeat(9)} ${'-'.repeat(31)}`,
  ];
  for (const v of vlanTable(dev)) {
    const chunks = [];
    for (let i = 0; i < v.ports.length; i += 4) chunks.push(v.ports.slice(i, i + 4).join(', '));
    rows.push(`${pad(v.id, 5)}${pad(v.name, 33)}${pad('active', 10)}${chunks[0] ?? ''}`);
    for (const c of chunks.slice(1)) rows.push(`${' '.repeat(48)}${c}`);
  }
  return [...rows, ''];
}

function showCdp(dev, doc) {
  const topo = buildTopology(doc);
  const short = (n) => long(n).replace(/^(\w{3})\w*?(\d)/, '$1 $2');
  const rows = [
    'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
    '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone',
    `${pad('Device ID', 17)}${pad('Local Intrfce', 16)}${pad('Holdtme', 11)}${pad('Capability', 13)}${pad('Platform', 12)}Port ID`,
  ];
  for (const linkId of topo.linksOf.get(dev.id) ?? []) {
    if (!topo.isUp(linkId)) continue;
    const peer = topo.devices.get(topo.other(linkId, dev.id));
    if (peer.type !== 'router' && peer.type !== 'switch') continue;
    rows.push(
      `${pad(iosHostname(peer.label, peer.type), 17)}${pad(short(topo.portName(linkId, dev.id)), 16)}${pad(165, 11)}` +
        `${pad(peer.type === 'router' ? 'R' : 'S', 13)}${pad(modelOf(peer).short, 12)}${short(topo.portName(linkId, peer.id))}`,
    );
  }
  return [...rows, ''];
}

function showVersion(dev) {
  const m = modelOf(dev);
  const ports = dataPorts(dev);
  const count = (re) => ports.filter((p) => re.test(p.name)).length;
  return [
    `Cisco IOS Software (simulé par NetCanvas), ${m.label}`,
    '',
    `${iosHostname(dev.label, dev.type)} uptime is 5 minutes`,
    `cisco ${m.label} processor`,
    ...[[/^G/, 'Gigabit Ethernet'], [/^Fa/, 'FastEthernet'], [/^Se/, 'Serial']]
      .filter(([re]) => count(re))
      .map(([re, label]) => `${count(re)} ${label} interface${count(re) > 1 ? 's' : ''}`),
    ...(Object.keys(dev.modules ?? {}).length ? [`Modules : ${Object.entries(dev.modules).map(([s, mod]) => `${mod} (slot ${s})`).join(', ')}`] : []),
    '',
  ];
}

function doPing(ctx, ip) {
  const { dev, doc, out, effects } = ctx;
  out.push('Type escape sequence to abort.', `Sending 5, 100-byte ICMP Echos to ${ip}, timeout is 2 seconds:`);
  const r = ping(doc, dev.id, ip);
  effects.push({ type: 'ping', source: dev.id, target: ip });
  if (r.ok) out.push('!!!!!', 'Success rate is 100 percent (5/5), round-trip min/avg/max = 1/1/1 ms', '');
  else out.push('.....', 'Success rate is 0 percent (0/5)', `% NetCanvas : ${r.reason}`, '');
}

function doTraceroute(ctx, ip) {
  const { dev, doc, out, effects } = ctx;
  out.push('Type escape sequence to abort.', `Tracing the route to ${ip}`, '');
  const t = traceroute(doc, dev.id, ip);
  effects.push({ type: 'ping', source: dev.id, target: ip });
  for (const h of t.hops) out.push(`  ${h.ttl} ${h.ip ? `${h.ip} 0 msec 0 msec 0 msec` : '*    *    *'}`);
  if (t.reason) out.push(`% NetCanvas : ${t.reason}`);
  out.push('');
}

// --- Configuration ------------------------------------------------------------------------
// Messages IOS après un changement d'état d'interface
function linkMessages(ctx, names) {
  const doc = withDevice(ctx.doc, ctx.dev);
  const topo = buildTopology(doc);
  for (const n of names) {
    const [status, proto] = portState(ctx.dev, n, doc, topo);
    ctx.out.push(`%LINK-5-CHANGED: Interface ${long(n)}, changed state to ${status}`);
    if (status !== 'administratively down') ctx.out.push(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${long(n)}, changed state to ${proto}`);
    if (status === 'down') {
      const link = linkOf(doc, ctx.dev.id, n);
      ctx.out.push(link ? `% NetCanvas : ${topo.status.get(link).reason}` : '% NetCanvas : aucun câble n\'est branché sur ce port.');
    }
  }
  ctx.out.push('');
}

// Sous-interface 802.1Q : seulement sur « G0/0.10 », pas sur l'interface physique
function setEncapsulation(c, native) {
  if (!c.s.ifaces.every((n) => n.includes('.'))) return c.out.push('% Configuring IEEE 802.1Q encapsulation is only allowed on subinterfaces (ex. interface g0/0.10)', '');
  forIfaces(c, (e) => {
    e.vlan = Number(c.args.vlan);
    if (native) e.native = true;
    else delete e.native;
  });
}

function setIpAddress(ctx) {
  const { dev, doc, out, args, s } = ctx;
  const cidr = maskToCidr(args.mask);
  if (cidr === null || cidr === 0) {
    out.push(`% Bad mask 0x${(parseIp(args.mask) >>> 0).toString(16).toUpperCase()} for address ${args.ip}`, '');
    return;
  }
  if (cidr < 31 && (isNetworkAddress(args.ip, cidr) || isBroadcastAddress(args.ip, cidr))) {
    out.push(`Bad mask /${cidr} for address ${args.ip}`, '');
    return;
  }
  const [name] = s.ifaces;
  if (name.includes('.') && !getEntry(dev, name)?.vlan) {
    out.push('% Configuring IP routing on a LAN subinterface is only allowed if that', 'subinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q,', 'or ISL vLAN.', '');
    return;
  }
  // IOS refuse deux interfaces dans le même réseau
  for (const e of dev.config?.interfaces ?? []) {
    if (e.name !== name && isValidIp(e.ip) && e.mask != null && sameSubnet(e.ip, args.ip, Math.min(e.mask, cidr))) {
      out.push(`% ${formatIp(networkOf(args.ip, cidr))} overlaps with ${long(e.name)}`, '');
      return;
    }
  }
  Object.assign(ensureEntry(dev, name, doc), { ip: args.ip, mask: cidr });
  ctx.changed = true;
}

function forIfaces(ctx, fn) {
  for (const n of ctx.s.ifaces) fn(ensureEntry(ctx.dev, n, ctx.doc), n);
  ctx.changed = true;
}

function setAccessVlan(ctx) {
  const vlan = Number(ctx.args.vlan);
  const vlans = (ctx.dev.config.vlans ??= []);
  if (vlan !== 1 && !vlans.some((v) => Number(v.id) === vlan)) {
    vlans.push({ id: vlan, name: `VLAN${String(vlan).padStart(4, '0')}` });
    ctx.out.push('% Access VLAN does not exist. Creating vlan ' + vlan);
  }
  forIfaces(ctx, (e) => Object.assign(e, { vlan, mode: e.mode ?? 'access' }));
}


function showTree(dev) {
  const isSwitch = dev.type === 'switch';
  const kids = [
    kw('running-config', 'Current operating configuration', { run: (c) => c.out.push(...runningConfig(c.dev)) }),
    kw('ip', 'IP information', {
      children: [
        kw('interface', 'IP interface status and configuration', {
          children: [kw('brief', 'Brief summary of IP status and configuration', { run: (c) => c.out.push(...showIpIntBrief(c.dev, c.doc)) })],
        }),
        ...(!isSwitch || modelOf(dev).l3 ? [kw('route', 'IP routing table', {
          run: (c) => c.out.push(...(c.dev.type === 'switch' && !c.dev.config?.ipRouting
            ? [`Default gateway is ${c.dev.config?.defaultGateway ?? 'not set'}`, '', 'Host               Gateway           Last Use    Total Uses  Interface', 'ICMP redirect cache is empty', '']
            : showIpRoute(c.dev, c.doc))),
          children: routeFilters(),
        }), ...routingShows()] : []),
        kw('access-lists', 'List IP access lists', { run: (c) => c.out.push(...showAccessLists(c.dev)) }),
      ],
    }),
    ...aclShows(),
    kw('cdp', 'CDP information', { children: [kw('neighbors', 'CDP neighbor entries', { run: (c) => c.out.push(...showCdp(c.dev, c.doc)) })] }),
    kw('version', 'System hardware and software status', { run: (c) => c.out.push(...showVersion(c.dev)) }),
    kw('interfaces', 'Interface status and configuration', { run: (c) => c.out.push(...NOT_SIMULATED('« show interfaces » détaillé (utilise « show ip interface brief »)')) }),
  ];
  if (isSwitch) {
    kids.push(kw('vlan', 'VTP VLAN status', { run: (c) => c.out.push(...showVlanBrief(c.dev)), children: [kw('brief', 'VTP all VLAN status in brief', { run: (c) => c.out.push(...showVlanBrief(c.dev)) })] }));
    kids.push(kw('mac-address-table', 'MAC forwarding table', { run: (c) => c.out.push(...NOT_SIMULATED('la table MAC')) }));
  } else {
    kids.push(kw('arp', 'ARP table', { run: (c) => c.out.push(...NOT_SIMULATED('la table ARP')) }));
  }
  return kw('show', 'Show running system information', { children: kids });
}

const pingCmd = () => kw('ping', 'Send echo messages', {
  children: [arg('ip', 'WORD', 'Ping destination address', isIp, { run: (c) => doPing(c, c.args.ip) })],
});

function execTree(dev, privileged) {
  const children = [
    kw('enable', 'Turn on privileged commands', { run: (c) => { c.s.mode = 'priv'; } }),
    kw('exit', 'Exit from the EXEC', { run: (c) => logout(c) }),
    kw('logout', 'Exit from the EXEC', { run: (c) => logout(c) }),
    pingCmd(),
    kw('traceroute', 'Trace route to destination', { children: [arg('ip', 'WORD', 'Trace route to destination address', isIp, { run: (c) => doTraceroute(c, c.args.ip) })] }),
    showTree(dev),
  ];
  if (privileged) {
    children.push(
      kw('configure', 'Enter configuration mode', {
        children: [kw('terminal', 'Configure from the terminal', {
          run: (c) => {
            c.s.mode = 'config';
            c.out.push('Enter configuration commands, one per line.  End with CNTL/Z.');
          },
        })],
      }),
      kw('disable', 'Turn off privileged commands', { run: (c) => { c.s.mode = 'user'; } }),
      kw('write', 'Write running configuration to memory', { run: (c) => c.out.push('Building configuration...', '[OK]', ''), children: [kw('memory', 'Write to NV memory', { run: (c) => c.out.push('Building configuration...', '[OK]', '') })] }),
      kw('copy', 'Copy from one file to another', {
        children: [kw('running-config', 'Copy from current system configuration', {
          children: [kw('startup-config', 'Copy to startup configuration', { run: (c) => c.out.push('Destination filename [startup-config]? ', 'Building configuration...', '[OK]', '') })],
        })],
      }),
      kw('reload', 'Halt and perform a cold restart', { run: (c) => c.out.push(...NOT_SIMULATED('le redémarrage')) }),
    );
  }
  return { children };
}

function logout(c) {
  c.s.mode = 'user';
  c.out.push('', `${iosHostname(c.dev.label, c.dev.type)} con0 is now available`, '', 'Press RETURN to get started.', '');
}

const leave = (mode) => ({ run: (c) => { c.s.mode = mode; } });
const endCmd = () => kw('end', 'Exit from configure mode', {
  run: (c) => {
    c.s.mode = 'priv';
    c.out.push('%SYS-5-CONFIG_I: Configured from console by console', '');
  },
});

function doCmd(dev) {
  return kw('do', 'To run exec commands in config mode', {
    children: [rest('cmd', 'LINE', 'Exec Command', (c) => {
      const err = treeExecute(execTree(dev, true), c.args.cmd, c, 0);
      if (err) c.out.push(...err.slice(1));
    })],
  });
}

function interfaceCmd(isSwitch) {
  return kw('interface', 'Select an interface to configure', {
    children: [
      kw('range', 'interface range command', { children: [rest('spec', 'LINE', 'Interfaces', (c) => enterInterfaces(c, true))] }),
      ...(isSwitch ? [kw('vlan', 'Catalyst Vlans', {
        children: [arg('n', '<1-4094>', 'Vlan interface number', isNum(1, 4094), { run: (c) => { c.s.mode = 'if'; c.s.ifaces = [`Vlan${Number(c.args.n)}`]; } })],
      })] : []),
      rest('spec', 'WORD', 'Interface type and number', (c) => enterInterfaces(c, false)),
    ],
  });
}

function configTree(dev) {
  const isSwitch = dev.type === 'switch';
  const children = [
    kw('hostname', 'Set system\'s network name', {
      children: [arg('name', 'WORD', 'This system\'s network name', null, {
        run: (c) => { c.dev.label = c.args.name; c.changed = true; },
      })],
    }),
    interfaceCmd(isSwitch),
    aclConfigCommands().numbered,
    kw('ip', 'Global IP configuration subcommands', {
      children: [
        aclConfigCommands().ipNamed,
        ...(isSwitch ? [kw('default-gateway', 'Specify default gateway', {
          children: [arg('gw', 'A.B.C.D', 'IP address of default gateway', isIp, { run: (c) => { c.dev.config.defaultGateway = c.args.gw; c.changed = true; } })],
        })] : []),
        ...(!isSwitch || modelOf(dev).l3 ? [kw('route', 'Establish static routes', { children: [routeArgs(addRoute)] })] : []),
        kw('domain-lookup', 'Enable IP Domain Name System hostname translation', { run() {} }),
        accept('domain-name', 'Define the default domain name'),
        kw('dhcp', 'Configure DHCP server and relay parameters', { run: (c) => c.out.push(...NOT_SIMULATED('DHCP')), children: [rest('x', 'LINE', '', (c) => c.out.push(...NOT_SIMULATED('DHCP')))] }),
        kw('routing', 'Enable IP routing', { run: (c) => setIpRouting(c, true) }),
      ],
    }),
    accept('enable', 'Modify enable password parameters'),
    accept('service', 'Modify use of network based services'),
    accept('banner', 'Define a login banner'),
    accept('username', 'Establish User Name Authentication'),
    accept('crypto', 'Encryption module'),
    kw('line', 'Configure a terminal line', { children: [rest('x', 'LINE', 'Line type and number', (c) => { c.s.mode = 'line'; })] }),
    ...(!isSwitch || modelOf(dev).l3 ? [routerCommands().router] : []),
    kw('no', 'Negate a command or set its defaults', {
      children: [
        ...(!isSwitch || modelOf(dev).l3 ? [routerCommands().noRouter] : []),
        aclConfigCommands().noNumbered,
        ...(isSwitch ? [] : [kw('ip', 'Global IP configuration subcommands', {
          children: [
            kw('route', 'Establish static routes', { children: [routeArgs(removeRoute, true)] }),
            kw('domain-lookup', 'Enable IP Domain Name System hostname translation', { run() {} }),
            aclConfigCommands().noIpNamed,
          ],
        })]),
        ...(isSwitch ? [
          kw('ip', 'Global IP configuration subcommands', {
            children: [
              kw('domain-lookup', '', { run() {} }),
              aclConfigCommands().noIpNamed,
              kw('routing', 'Enable IP routing', { run: (c) => setIpRouting(c, false) }),
              kw('default-gateway', 'Specify default gateway', { run: (c) => { delete c.dev.config.defaultGateway; c.changed = true; } }),
              ...(modelOf(dev).l3 ? [kw('route', 'Establish static routes', { children: [routeArgs(removeRoute, true)] })] : []),
            ],
          }),
          kw('vlan', 'Vlan commands', { children: [arg('vlan', '<1-4094>', 'VLAN ID', isNum(2, 4094), { run: removeVlan })] }),
        ] : []),
        accept('service', ''),
        accept('banner', ''),
      ],
    }),
    kw('exit', 'Exit from configure mode', leave('priv')),
    endCmd(),
    doCmd(dev),
  ];
  if (isSwitch) {
    children.push(kw('vlan', 'Vlan commands', {
      children: [arg('vlan', '<1-4094>', 'ISL VLAN IDs 1-1005', isNum(1, 4094), {
        run: (c) => {
          const id = Number(c.args.vlan);
          const vlans = (c.dev.config.vlans ??= []);
          if (id !== 1 && !vlans.some((v) => Number(v.id) === id)) {
            vlans.push({ id, name: `VLAN${String(id).padStart(4, '0')}` });
            c.changed = true;
          }
          c.s.mode = 'vlan';
          c.s.vlan = id;
        },
      })],
    }));
  }
  return { children };
}

function routeArgs(run, optionalHop = false) {
  const hop = arg('hop', 'A.B.C.D', 'Forwarding router\'s address', isIp, { run });
  return arg('net', 'A.B.C.D', 'Destination prefix', isIp, {
    children: [arg('mask', 'A.B.C.D', 'Destination prefix mask', isIp, { ...(optionalHop ? { run } : {}), children: [hop] })],
  });
}

function setIpRouting(c, on) {
  if (c.dev.type === 'switch' && !modelOf(c.dev).l3) {
    return c.out.push(`% NetCanvas : un ${modelOf(c.dev).short} est un switch de niveau 2, il ne route pas (choisis un 3560 ou un 3650).`, '');
  }
  if (c.dev.type !== 'switch') return undefined; // toujours actif sur un routeur
  if (on) c.dev.config.ipRouting = true;
  else delete c.dev.config.ipRouting;
  c.changed = true;
  return undefined;
}

function addRoute(c) {
  const mask = maskToCidr(c.args.mask);
  if (mask === null) return c.out.push('%Inconsistent address and mask', '');
  const routes = (c.dev.config.routes ??= []);
  const network = formatIp(networkOf(c.args.net, mask));
  if (network !== c.args.net) return c.out.push('%Inconsistent address and mask', '');
  if (!routes.some((r) => r.network === network && Number(r.mask) === mask && r.nextHop === c.args.hop)) {
    routes.push({ network, mask, nextHop: c.args.hop });
    c.changed = true;
  }
}

function removeRoute(c) {
  const mask = maskToCidr(c.args.mask);
  const routes = c.dev.config.routes ?? [];
  const keep = routes.filter((r) => !(r.network === c.args.net && Number(r.mask) === mask && (!c.args.hop || r.nextHop === c.args.hop)));
  if (keep.length === routes.length) return c.out.push('%No matching route to delete', '');
  c.dev.config.routes = keep;
  c.changed = true;
}

function removeVlan(c) {
  const id = Number(c.args.vlan);
  c.dev.config.vlans = (c.dev.config.vlans ?? []).filter((v) => Number(v.id) !== id);
  c.changed = true;
}

function enterInterfaces(c, range) {
  const r = parseInterfaces(c.args.spec, c.dev, { range });
  if (r.error) return c.out.push(r.error, '');
  c.s.mode = range ? 'if-range' : 'if';
  c.s.ifaces = r.names;
}

function interfaceTree(dev) {
  const isSwitch = dev.type === 'switch';
  const shutdown = (value) => (c) => {
    forIfaces(c, (e) => { if (value) e.shutdown = true; else delete e.shutdown; });
    linkMessages(c, c.s.ifaces);
  };
  const children = [
    kw('shutdown', 'Shutdown the selected interface', { run: shutdown(true) }),
    kw('description', 'Interface specific description', {
      children: [rest('text', 'LINE', 'Up to 240 characters describing this interface', (c) => forIfaces(c, (e) => { e.description = c.args.text; }))],
    }),
    accept('speed', 'Configure speed operation.'),
    accept('duplex', 'Configure duplex operation.'),
    ...(isSwitch ? [accept('bandwidth', 'Set bandwidth informational parameter')] : [interfaceRoutingCommands(forIfaces).bandwidth]),
    interfaceCmd(isSwitch),
    kw('exit', 'Exit from interface configuration mode', leave('config')),
    endCmd(),
    doCmd(dev),
  ];
  const no = [
    kw('shutdown', 'Shutdown the selected interface', { run: shutdown(false) }),
    kw('description', 'Interface specific description', { run: (c) => forIfaces(c, (e) => { delete e.description; }) }),
  ];

  if (isSwitch) {
    // Adresse IP : seulement sur une interface VLAN (un port de switch est de niveau 2)
    const onSvi = (run) => (c) => {
      if (!c.s.ifaces.every(isSviName)) return c.out.push(`${' '.repeat(c.line.indexOf('ip') + 16)}^`, "% Invalid input detected at '^' marker.", '');
      return run(c);
    };
    children.push(kw('ip', 'Interface Internet Protocol config commands', {
      children: [kw('address', 'Set the IP address of an interface', {
        children: [arg('ip', 'A.B.C.D', 'IP address', isIp, { children: [arg('mask', 'A.B.C.D', 'IP subnet mask', isIp, { run: onSvi(setIpAddress) })] })],
      }), accessGroupCommands(forIfaces).add],
    }));
    no.push(kw('ip', '', { children: [kw('address', '', { run: onSvi((c) => forIfaces(c, (e) => { e.ip = null; e.mask = null; })) }), accessGroupCommands(forIfaces).remove] }));
    children.push(
      kw('switchport', 'Set switching mode characteristics', {
        children: [
          kw('mode', 'Set trunking mode of the interface', {
            children: [
              kw('access', 'Set trunking mode to ACCESS unconditionally', { run: (c) => forIfaces(c, (e) => { e.mode = 'access'; e.vlan ??= 1; }) }),
              kw('trunk', 'Set trunking mode to TRUNK unconditionally', { run: (c) => forIfaces(c, (e) => { e.mode = 'trunk'; }) }),
            ],
          }),
          kw('access', 'Set access mode characteristics of the interface', {
            children: [kw('vlan', 'Set VLAN when interface is in access mode', { children: [arg('vlan', '<1-4094>', 'VLAN ID of the VLAN when this port is in access mode', isNum(1, 4094), { run: setAccessVlan })] })],
          }),
          kw('trunk', 'Set trunking characteristics of the interface', {
            children: [rest('x', 'LINE', '', (c) => c.out.push('% NetCanvas : un trunk transporte tous les VLAN, VLAN natif 1 (allowed / native non simulés).', ''))],
          }),
          kw('port-security', 'Security related command', { run: (c) => c.out.push(...NOT_SIMULATED('port-security')), children: [rest('x', 'LINE', '', (c) => c.out.push(...NOT_SIMULATED('port-security')))] }),
          kw('nonegotiate', 'Device will not engage in negotiation protocol on this interface', { run() {} }),
        ],
      }),
      accept('spanning-tree', 'Spanning Tree Subsystem'),
    );
    no.push(kw('switchport', 'Set switching mode characteristics', {
      children: [kw('access', '', { children: [kw('vlan', '', { run: (c) => forIfaces(c, (e) => { e.vlan = 1; }) })] })],
    }));
  } else {
    children.push(
      kw('ip', 'Interface Internet Protocol config commands', {
        children: [
          kw('address', 'Set the IP address of an interface', {
            children: [arg('ip', 'A.B.C.D', 'IP address', isIp, { children: [arg('mask', 'A.B.C.D', 'IP subnet mask', isIp, { run: setIpAddress })] })],
          }),
          kw('helper-address', 'Specify a destination address for UDP broadcasts', { children: [arg('x', 'A.B.C.D', '', isIp, { run: (c) => c.out.push(...NOT_SIMULATED('le relais DHCP')) })] }),
          interfaceRoutingCommands(forIfaces).ipOspf,
          accessGroupCommands(forIfaces).add,
        ],
      }),
      kw('clock', 'Configure serial interface clock', {
        children: [kw('rate', 'Configure serial interface clock speed', {
          children: [arg('rate', '<300-8000000>', 'Choose clockrate from list above', isNum(300, 8000000), {
            run: (c) => {
              const name = c.s.ifaces[0];
              if (!/^Se/.test(name)) return c.out.push(...['', "% Invalid input detected at '^' marker.", '']);
              const link = c.doc.links.find((l) => l.id === linkOf(c.doc, c.dev.id, name));
              const dceId = link && (link.dce === 'target' ? link.target : link.source);
              if (link && dceId !== c.dev.id) c.out.push('This command applies only to DCE interfaces', '');
              forIfaces(c, (e) => { e.clockRate = Number(c.args.rate); });
            },
          })],
        })],
      }),
      kw('encapsulation', 'Set encapsulation type for an interface', {
        children: [kw('dot1Q', 'IEEE 802.1Q Virtual LAN', {
          children: [arg('vlan', '<1-4094>', 'IEEE 802.1Q VLAN ID', isNum(1, 4094), {
            run: (c) => setEncapsulation(c, false),
            children: [kw('native', 'Make this as native vlan', { run: (c) => setEncapsulation(c, true) })],
          })],
        })],
      }),
    );
    no.push(
      kw('ip', '', { children: [kw('address', 'Set the IP address of an interface', { run: (c) => forIfaces(c, (e) => { e.ip = null; e.mask = null; }) }), interfaceRoutingCommands(forIfaces).noIpOspf, accessGroupCommands(forIfaces).remove] }),
      interfaceRoutingCommands(forIfaces).noBandwidth,
      kw('clock', '', { children: [kw('rate', '', { run: (c) => forIfaces(c, (e) => { delete e.clockRate; }) })] }),
    );
  }
  children.push(kw('no', 'Negate a command or set its defaults', { children: no }));
  return { children };
}

function vlanTree(dev) {
  return {
    children: [
      kw('name', 'Ascii name of the VLAN', {
        children: [arg('name', 'WORD', 'The ascii name for the VLAN', null, {
          run: (c) => {
            const v = (c.dev.config.vlans ??= []).find((x) => Number(x.id) === c.s.vlan);
            if (v) v.name = c.args.name;
            c.changed = true;
          },
        })],
      }),
      kw('exit', 'Apply changes, bump revision number, and exit mode', leave('config')),
      endCmd(),
      doCmd(dev),
    ],
  };
}

function lineTree(dev) {
  return {
    children: [
      accept('password', 'Set a password'),
      kw('login', 'Enable password checking', { run() {}, children: [rest('x', 'LINE', '', () => {})] }),
      accept('logging', 'Modify message logging facilities'),
      accept('exec-timeout', 'Set the EXEC timeout'),
      accept('transport', 'Define transport protocols for line'),
      kw('exit', 'Exit from line configuration mode', leave('config')),
      endCmd(),
      doCmd(dev),
    ],
  };
}

const TREES = {
  user: (d) => execTree(d, false),
  priv: (d) => execTree(d, true),
  config: configTree,
  if: interfaceTree,
  'if-range': interfaceTree,
  vlan: vlanTree,
  line: lineTree,
  'router-ospf': (d) => ospfTree([endCmd(), doCmd(d)]),
  'router-rip': (d) => ripTree([endCmd(), doCmd(d)]),
  'router-bgp': (d) => bgpTree([endCmd(), doCmd(d)]),
  'acl-std': (d) => aclTree([endCmd(), doCmd(d)]),
  'acl-ext': (d) => aclTree([endCmd(), doCmd(d)]),
};

const SUFFIX = { user: '>', priv: '#', config: '(config)#', if: '(config-if)#', 'if-range': '(config-if-range)#', vlan: '(config-vlan)#', line: '(config-line)#',
  'router-ospf': '(config-router)#', 'router-rip': '(config-router)#', 'router-bgp': '(config-router)#',
  'acl-std': '(config-std-nacl)#', 'acl-ext': '(config-ext-nacl)#' };

export const ios = {
  banner: (dev) => [`${modelOf(dev).label} : terminal IOS simulé. Tape « ? » pour l'aide, Tab pour compléter.`, ''],
  newSession: () => ({ mode: 'user', ifaces: [], vlan: null }),
  prompt: (s, dev) => `${iosHostname(dev.label, dev.type)}${SUFFIX[s.mode]}`,

  run(s, line, dev, doc) {
    const ctx = { s, dev, doc, out: [], effects: [], changed: false };
    if (!line.trim()) return ctx;
    const tree = TREES[s.mode](dev);
    // En mode EXEC, un premier mot inconnu est pris pour un nom d'hôte (telnet), comme sur IOS
    const p = parse(tree, line);
    if (p.error === 'invalid' && p.index === 0 && (s.mode === 'user' || s.mode === 'priv')) {
      ctx.out.push(`Translating "${p.tokens[0].text}"...domain server (255.255.255.255)`, '% Unknown command or computer name, or unable to find computer address', '');
      return ctx;
    }
    const err = treeExecute(tree, line, ctx, this.prompt(s, dev).length);
    if (err) ctx.out.push(...err);
    return ctx;
  },
  help: (s, line, dev) => treeHelp(TREES[s.mode](dev), line),
  complete: (s, line, dev) => treeComplete(TREES[s.mode](dev), line),
};
