// Terminal MikroTik RouterOS simulé : menus (/ip address, /ip route…), arguments clé=valeur,
// abréviations, « ? » et Tab. Même config que les formulaires.
import { tokenize } from './engine.js';
import { dataPorts, ensureEntry, getEntry, linkOf, pad, ping, withDevice } from './device.js';
import { buildTopology } from '../net/topology.js';
import { formatIp, isBroadcastAddress, isNetworkAddress, isValidCidr, isValidIp, networkOf, sameSubnet, splitCidr } from '../net/ip.js';
import { modelOf } from '../net/catalog.js';
import { traceroute } from '../net/traceroute.js';
import { macColon, macOf } from '../net/mac.js';
import { ROUTING_MENUS, routeTable, routingScript, runRouting } from './routeros-routing.js';
import { isHostname, resolveName } from '../net/services.js';
import { IPV6_ARGS, IPV6_MENUS, ipv6Script, runIpv6 } from './routeros-ipv6.js';
import { isValidIp6, normIp6 } from '../net/ip6.js';

// Menus : sous-menus et commandes de chaque chemin
const MENUS = {
  '': { menus: ['interface', 'ip', 'ipv6', 'routing', 'system', 'tool'], commands: ['ping', 'export', 'quit'] },
  tool: { menus: [], commands: ['traceroute'] },
  interface: { menus: ['ethernet', 'vlan'], commands: ['print', 'enable', 'disable', 'export'] },
  'interface vlan': { menus: [], commands: ['add', 'print', 'remove', 'export'] },
  'interface ethernet': { menus: [], commands: ['print', 'enable', 'disable', 'export'] },
  ip: { menus: ['address', 'route', 'firewall', 'pool', 'dhcp-server', 'arp', 'dns'], commands: ['export'] },
  'ip dns': { menus: ['static'], commands: ['set', 'print', 'export'] },
  'ip dns static': { menus: [], commands: ['add', 'print', 'remove', 'export'] },
  'ip address': { menus: [], commands: ['add', 'print', 'remove', 'export'] },
  'ip route': { menus: [], commands: ['add', 'print', 'remove', 'export'] },
  system: { menus: ['identity'], commands: ['reboot'] },
  'system identity': { menus: [], commands: ['print', 'set', 'export'] },
  ...ROUTING_MENUS,
  ...IPV6_MENUS,
};

const match = (word, options) => {
  const exact = options.find((o) => o === word);
  if (exact) return [exact];
  return options.filter((o) => o.startsWith(word));
};

const err = (text, col) => [`${text} (line 1 column ${col})`, ''];

// Analyse : chemin + commande + arguments (clé=valeur ou valeurs sans nom)
// Mots séparés par des espaces ; une valeur entre guillemets peut en contenir (name="R3 MikroTik")
function tokenizeRos(line) {
  const tokens = [];
  const re = /(?:[^\s"]+|"(?:[^"\\]|\\.)*")+/g;
  let m;
  while ((m = re.exec(line))) {
    const text = m[0].replace(/^([^=]+=)?"(.*)"$/, (_, key = '', v) => key + v.replace(/\\(.)/g, '$1'));
    tokens.push({ text, start: m.index });
  }
  return tokens;
}

function parseLine(line, cwd) {
  const tokens = tokenizeRos(line);
  let path = [...cwd];
  let i = 0;
  if (tokens[0]?.text.startsWith('/')) {
    path = [];
    // « /ip/address/print » (v7) ou « /ip address print »
    const first = tokens[0].text.slice(1);
    tokens.splice(0, 1, ...first.split('/').filter(Boolean).map((t) => ({ text: t, start: tokens[0].start + 1 })));
  }
  let command = null;
  for (; i < tokens.length; i++) {
    const word = tokens[i].text;
    if (word === '..') {
      path.pop();
      continue;
    }
    const menu = MENUS[path.join(' ')];
    const subs = match(word, menu.menus);
    const cmds = match(word, menu.commands);
    if (subs.length + cmds.length > 1) return { error: err(`ambiguous value of command, more than one possible value: ${[...subs, ...cmds].join(', ')}`, tokens[i].start + 1) };
    if (subs.length === 1) {
      path.push(subs[0]);
      continue;
    }
    if (cmds.length === 1) {
      command = cmds[0];
      i++;
      break;
    }
    return { error: err(`bad command name ${word}`, tokens[i].start + 1) };
  }
  const named = {};
  const unnamed = [];
  for (; i < tokens.length; i++) {
    const t = tokens[i].text;
    const eq = t.indexOf('=');
    if (eq > 0) named[t.slice(0, eq)] = t.slice(eq + 1);
    else unnamed.push(t);
  }
  return { path, command, named, unnamed };
}

// Interfaces VLAN (sous-interfaces 802.1Q) : name=vlan10 interface=ether2 vlan-id=10
const vlanIfaces = (dev) => (dev.config?.interfaces ?? []).filter((e) => e.parent && e.vlan);

// Interfaces adressables : ports physiques, interfaces VLAN, loopback « lo »
const ifaceNames = (dev) => [...dataPorts(dev).map((p) => p.name), ...vlanIfaces(dev).map((e) => e.name), 'lo'];

// Adresses IP de l'équipement, dans l'ordre des ports (numéros de « print »)
function addresses(dev) {
  return ifaceNames(dev)
    .map((port) => ({ port, e: getEntry(dev, port) }))
    .filter(({ e }) => e && isValidIp(e.ip) && isValidCidr(e.mask));
}

export function routerosScript(dev) {
  const lines = ['# NetCanvas : export RouterOS', `# model = ${modelOf(dev).label}`];
  const disabled = dataPorts(dev).filter((p) => getEntry(dev, p.name)?.shutdown);
  if (disabled.length) {
    lines.push('/interface ethernet');
    for (const p of disabled) lines.push(`set [ find default-name=${p.name} ] disabled=yes`);
  }
  if (vlanIfaces(dev).length) {
    lines.push('/interface vlan');
    for (const e of vlanIfaces(dev)) lines.push(`add interface=${e.parent} name=${e.name} vlan-id=${e.vlan}`);
  }
  const addrs = addresses(dev);
  if (addrs.length) {
    lines.push('/ip address');
    for (const { port, e } of addrs) lines.push(`add address=${e.ip}/${e.mask} interface=${port} network=${formatIp(networkOf(e.ip, e.mask))}`);
  }
  const routes = (dev.config?.routes ?? []).filter((r) => isValidIp(r.network) && isValidCidr(r.mask) && isValidIp(r.nextHop));
  if (routes.length) {
    lines.push('/ip route');
    for (const r of routes) lines.push(`add dst-address=${r.network}/${r.mask} gateway=${r.nextHop}`);
  }
  lines.push(...routingScript(dev));
  lines.push(...ipv6Script(dev));
  const c = dev.config ?? {};
  if (c.nameServer || c.dnsServer) lines.push('/ip dns', `set${c.dnsServer ? ' allow-remote-requests=yes' : ''}${c.nameServer ? ` servers=${c.nameServer}` : ''}`);
  if (c.hosts?.length) lines.push('/ip dns static', ...c.hosts.map((h) => `add address=${h.ip} name=${h.name}`));
  lines.push('/system identity', `set name="${dev.label.replace(/"/g, '\\"')}"`);
  return lines;
}

const index = (n, items) => {
  const i = Number(n);
  return Number.isInteger(i) && i >= 0 && i < items.length ? i : null;
};

// Destination par nom (ping, traceroute) : résolue d'abord ; null si échec (message affiché)
function resolveTarget(ctx, target) {
  if (isValidIp6(target)) return normIp6(target);
  if (isValidIp(target) || !isHostname(target)) return target;
  const r = resolveName(withDevice(ctx.doc, ctx.dev), ctx.dev.id, target);
  if (r.query) ctx.effects.push({ type: 'ping', source: ctx.dev.id, target: ctx.dev.config.nameServer, options: { proto: 'udp', dport: 53 } });
  if (r.ok) return r.ip;
  ctx.out.push('invalid value for argument address:', `    while resolving ip-address: could not get answer from dns server`, `NetCanvas : ${r.log.at(-1).text}`, '');
  return null;
}

function runDns(ctx, p) {
  const { dev, out } = ctx;
  const c = (dev.config ??= {});
  const norm = (n) => n.toLowerCase().replace(/\.$/, '');
  switch (`${p.path.join(' ')}|${p.command}`) {
    case 'ip dns|set': {
      const { servers, 'allow-remote-requests': remote } = p.named;
      if (servers === undefined && remote === undefined) return out.push('expected end of command', ''), true;
      if (servers !== undefined) {
        const first = servers.split(',')[0];
        if (first && !isValidIp(first)) return out.push('invalid value for argument servers', ''), true;
        if (first) c.nameServer = first;
        else delete c.nameServer;
      }
      if (remote !== undefined) {
        if (!['yes', 'no'].includes(remote)) return out.push('invalid value for argument allow-remote-requests', ''), true;
        if (remote === 'yes') c.dnsServer = true;
        else delete c.dnsServer;
      }
      ctx.changed = true;
      return true;
    }
    case 'ip dns|print':
      out.push(`                servers: ${c.nameServer ?? ''}`, `  allow-remote-requests: ${c.dnsServer ? 'yes' : 'no'}`, '');
      return true;
    case 'ip dns static|add': {
      const { name, address } = p.named;
      if (!name || !isHostname(name)) return out.push('invalid value for argument name', ''), true;
      if (!isValidIp(address)) return out.push('invalid value for argument address', ''), true;
      if ((c.hosts ?? []).some((h) => norm(h.name) === norm(name))) return out.push('failure: entry already exists', ''), true;
      c.hosts = [...(c.hosts ?? []), { name: norm(name), ip: address }];
      ctx.changed = true;
      return true;
    }
    case 'ip dns static|print':
      out.push(`Columns: NAME, ADDRESS, TTL`, `#  ${pad('NAME', 24)}${pad('ADDRESS', 16)}TTL`);
      (c.hosts ?? []).forEach((h, i) => out.push(`${pad(i, 3)}${pad(h.name, 24)}${pad(h.ip, 16)}1d`));
      out.push('');
      return true;
    case 'ip dns static|remove': {
      const i = index(p.unnamed[0] ?? p.named.numbers, c.hosts ?? []);
      if (i === null) return out.push('no such item', ''), true;
      c.hosts = c.hosts.filter((_, j) => j !== i);
      if (!c.hosts.length) delete c.hosts;
      ctx.changed = true;
      return true;
    }
    default:
      return false;
  }
}

function run(ctx, p) {
  const { dev, doc, out, s } = ctx;
  const where = p.path.join(' ');
  const iface = (name) => ifaceNames(dev).includes(name);

  switch (`${where}|${p.command}`) {
    case 'ip address|add': {
      const a = splitCidr(p.named.address ?? '');
      if (!a) return out.push('failure: invalid value for argument address', '');
      if (!p.named.interface || !iface(p.named.interface)) return out.push('input does not match any value of interface', '');
      if (a.cidr < 31 && (isNetworkAddress(a.ip, a.cidr) || isBroadcastAddress(a.ip, a.cidr))) {
        return out.push(`failure: ${a.ip} is the network or broadcast address of ${formatIp(networkOf(a.ip, a.cidr))}/${a.cidr}`, '');
      }
      if (addresses(dev).some(({ e }) => e.ip === a.ip)) return out.push('failure: already have such address', '');
      const e = ensureEntry(dev, p.named.interface, doc);
      if (isValidIp(e.ip)) return out.push(`failure: NetCanvas gère une adresse par interface : supprime d'abord ${e.ip}/${e.mask} (remove)`, '');
      Object.assign(e, { ip: a.ip, mask: a.cidr });
      ctx.changed = true;
      return;
    }
    case 'ip address|print': {
      out.push('Flags: X - disabled, I - invalid, D - dynamic ', ` #   ${pad('ADDRESS', 19)}${pad('NETWORK', 16)}INTERFACE`);
      addresses(dev).forEach(({ port, e }, i) => {
        out.push(` ${pad(i, 4)}${pad(`${e.ip}/${e.mask}`, 19)}${pad(formatIp(networkOf(e.ip, e.mask)), 16)}${port}`);
      });
      return out.push('');
    }
    case 'ip address|remove': {
      const list = addresses(dev);
      const i = index(p.named.numbers ?? p.unnamed[0], list);
      if (i === null) return out.push('no such item', '');
      Object.assign(getEntry(dev, list[i].port), { ip: null, mask: null });
      ctx.changed = true;
      return;
    }
    case 'ip route|add': {
      const dst = splitCidr(p.named['dst-address'] ?? '0.0.0.0/0');
      if (!dst) return out.push('failure: invalid value for argument dst-address', '');
      if (!isValidIp(p.named.gateway)) return out.push('failure: invalid value for argument gateway', '');
      const network = formatIp(networkOf(dst.ip, dst.cidr));
      (dev.config.routes ??= []).push({ network, mask: dst.cidr, nextHop: p.named.gateway });
      ctx.changed = true;
      return;
    }
    case 'ip route|print': {
      out.push(
        'Flags: D - dynamic; X - disabled, I - inactive, A - active; c - connect, s - static, r - rip, b - bgp, o - ospf ',
        ` #      ${pad('DST-ADDRESS', 19)}${pad('PREF-SRC', 16)}${pad('GATEWAY', 19)}DISTANCE`,
      );
      routeTable(dev, doc).forEach((r, i) => {
        out.push(` ${pad(i, 2)}${pad(r.flags, 5)}${pad(r.dst, 19)}${pad(r.src, 16)}${pad(r.gw, 19)}${String(r.distance).padStart(8)}`);
      });
      return out.push('');
    }
    case 'ip route|remove': {
      const table = routeTable(dev, doc);
      const i = index(p.named.numbers ?? p.unnamed[0], table);
      if (i === null) return out.push('no such item', '');
      if (table[i].index === undefined) return out.push('failure: cannot remove dynamic route', '');
      dev.config.routes.splice(table[i].index, 1);
      ctx.changed = true;
      return;
    }
    case 'interface|print':
    case 'interface ethernet|print': {
      const topo = buildTopology(doc);
      out.push('Flags: D - dynamic, X - disabled, R - running, S - slave ', ` #     ${pad('NAME', 20)}${pad('TYPE', 8)}${pad('ACTUAL-MTU', 12)}MAC-ADDRESS`);
      dataPorts(dev).forEach((port, i) => {
        const off = getEntry(dev, port.name)?.shutdown;
        const link = linkOf(doc, dev.id, port.name);
        const flag = off ? 'X' : link && topo.isUp(link) ? 'R' : ' ';
        out.push(` ${pad(i, 2)} ${pad(flag, 3)}${pad(port.name, 20)}${pad('ether', 8)}${pad(String(1500).padStart(10), 12)}${macColon(macOf(dev, port.name))}`);
      });
      return out.push('');
    }
    case 'interface|enable':
    case 'interface|disable':
    case 'interface ethernet|enable':
    case 'interface ethernet|disable': {
      const ports = dataPorts(dev);
      const names = (p.named.numbers ?? p.unnamed.join(',')).split(',').filter(Boolean);
      if (!names.length) return out.push('expected end of command', '');
      for (const n of names) {
        const port = /^\d+$/.test(n) ? ports[Number(n)] : ports.find((x) => x.name === n);
        if (!port) return out.push(`no such item (${n})`, '');
        const e = ensureEntry(dev, port.name, doc);
        if (p.command === 'disable') e.shutdown = true;
        else delete e.shutdown;
      }
      ctx.changed = true;
      return;
    }
    case 'interface vlan|add': {
      const parent = p.named.interface;
      const vlan = Number(p.named['vlan-id']);
      const nameV = p.named.name ?? `vlan${vlan}`;
      if (!dataPorts(dev).some((x) => x.name === parent)) return out.push('input does not match any value of interface', '');
      if (!(vlan >= 1 && vlan <= 4094)) return out.push('invalid value for argument vlan-id', '');
      if (ifaceNames(dev).includes(nameV)) return out.push('failure: interface with such name exists', '');
      if (vlanIfaces(dev).some((e) => e.parent === parent && Number(e.vlan) === vlan)) return out.push(`failure: vlan-id ${vlan} already used on ${parent}`, '');
      (dev.config.interfaces ??= []).push({ link: null, name: nameV, parent, vlan, ip: null, mask: null });
      ctx.changed = true;
      return;
    }
    case 'interface vlan|print':
      out.push('Flags: X - disabled, R - running ', ` #   ${pad('NAME', 20)}${pad('MTU', 6)}${pad('VLAN-ID', 9)}INTERFACE`);
      vlanIfaces(dev).forEach((e, i) => out.push(` ${pad(i, 4)}${pad(e.name, 20)}${pad(1500, 6)}${pad(e.vlan, 9)}${e.parent}`));
      return out.push('');
    case 'interface vlan|remove': {
      const list = vlanIfaces(dev);
      const i = index(p.named.numbers ?? p.unnamed[0], list) ?? list.findIndex((e) => e.name === p.unnamed[0]);
      if (i === null || i < 0) return out.push('no such item', '');
      dev.config.interfaces = dev.config.interfaces.filter((e) => e !== list[i]);
      ctx.changed = true;
      return;
    }
    case 'system identity|set':
      if (!p.named.name) return out.push('expected end of command', '');
      dev.label = p.named.name.replace(/^"(.*)"$/, '$1');
      ctx.changed = true;
      return;
    case 'system identity|print':
      return out.push(`  name: ${dev.label}`, '');
    case 'system|reboot':
      return out.push('NetCanvas : le redémarrage n\'est pas simulé.', '');
    case '|ping': {
      const target = resolveTarget(ctx, p.named.address ?? p.unnamed[0]);
      if (target === null) return;
      if (!isValidIp(target) && !isValidIp6(target)) return out.push('invalid value for argument address', '');
      const count = Math.min(Number(p.named.count) || 4, 10);
      const r = ping(doc, dev.id, target);
      ctx.effects.push({ type: 'ping', source: dev.id, target });
      out.push(`  SEQ ${pad('HOST', 40)} SIZE TTL TIME       STATUS`);
      for (let i = 0; i < count; i++) {
        out.push(`${String(i).padStart(5)} ${pad(target, 40)} ${r.ok ? `  56  ${String(r.ttl).padStart(2)} 1ms` : `                    timeout`}`);
      }
      const recv = r.ok ? count : 0;
      out.push(`    sent=${count} received=${recv} packet-loss=${r.ok ? 0 : 100}%${r.ok ? ' min-rtt=1ms avg-rtt=1ms max-rtt=1ms' : ''}`);
      if (!r.ok) out.push(`NetCanvas : ${r.reason}`);
      return out.push('');
    }
    case 'tool|traceroute': {
      const target = resolveTarget(ctx, p.named.address ?? p.unnamed[0]);
      if (target === null) return;
      if (!isValidIp(target) && !isValidIp6(target)) return out.push('invalid value for argument address', '');
      const t = traceroute(doc, dev.id, target);
      ctx.effects.push({ type: 'ping', source: dev.id, target });
      out.push(` # ${pad('ADDRESS', 39)}LOSS SENT LAST`);
      for (const h of t.hops) out.push(`${String(h.ttl).padStart(2)} ${pad(h.ip ?? '', 39)}${h.ip ? '  0%    3 0.5ms' : '100%    3 timeout'}`);
      if (t.reason) out.push(`NetCanvas : ${t.reason}`);
      return out.push('');
    }
    case '|export':
    case 'ip|export':
    case 'ip address|export':
    case 'ip route|export':
    case 'interface|export':
    case 'interface ethernet|export':
    case 'interface vlan|export':
    case 'system identity|export':
    case 'ip dns|export':
    case 'ip dns static|export':
    case 'ipv6|export':
    case 'ipv6 address|export':
    case 'ipv6 route|export':
    case 'ipv6 settings|export':
      return out.push(...routerosScript(dev), '');
    case '|quit':
      s.path = [];
      return out.push('interrupted', '');
    default:
      if (runDns(ctx, p) || runIpv6(ctx, p, iface) || runRouting(ctx, p)) return;
      return out.push(...err('expected command name', 1));
  }
}

export const routeros = {
  banner: (dev) => [
    '  MMM      MMM       KKK                          TTTTTTTTTTT      KKK',
    '  MMMM    MMMM       KKK                          TTTTTTTTTTT      KKK',
    '  MMM MMMM MMM  III  KKK  KKK  RRRRRR     OOOOOO      TTT     III  KKK  KKK',
    '  MMM  MM  MMM  III  KKKKK     RRR  RRR  OOO  OOO     TTT     III  KKKKK',
    '  MMM      MMM  III  KKK KKK   RRRRRR    OOO  OOO     TTT     III  KKK KKK',
    '  MMM      MMM  III  KKK  KKK  RRR  RRR   OOOOOO      TTT     III  KKK  KKK',
    '',
    `  ${modelOf(dev).label} : RouterOS simulé par NetCanvas. « ? » pour l'aide, Tab pour compléter.`,
    '',
  ],
  newSession: () => ({ path: [] }),
  prompt: (s, dev) => `[admin@${dev.label}] ${s.path.length ? `/${s.path.join(' ')}` : ''}> `,

  run(s, line, dev, doc) {
    const ctx = { s, dev, doc, out: [], effects: [], changed: false };
    if (!line.trim()) return ctx;
    const p = parseLine(line, s.path);
    if (p.error) {
      ctx.out.push(...p.error);
      return ctx;
    }
    if (!p.command) {
      s.path = p.path; // simple navigation : « /ip address » ou « .. »
      return ctx;
    }
    run(ctx, p);
    return ctx;
  },

  help(s, line) {
    const p = parseLine(line.replace(/\?$/, ''), s.path);
    if (p.error) return p.error;
    const menu = MENUS[p.path.join(' ')];
    if (p.command) {
      const ARGS = { 'ip address|add': 'address= interface=', 'ip route|add': 'dst-address= gateway=', '|ping': 'address count=', 'system identity|set': 'name=', 'ip dns|set': 'servers= allow-remote-requests=', 'ip dns static|add': 'name= address=', ...IPV6_ARGS };
      return [`${p.command} ${ARGS[`${p.path.join(' ')}|${p.command}`] ?? ''}`.trim(), ''];
    }
    return [...menu.menus.map((m) => `  ${pad(m, 12)} --`), ...menu.commands.map((c) => `  ${c}`), ''];
  },

  complete(s, line) {
    if (/\s$/.test(line) || !line.trim()) return line;
    const tokens = tokenize(line);
    const last = tokens.at(-1);
    if (last.text.includes('=')) return line;
    const before = parseLine(line.slice(0, last.start), s.path);
    if (before.error || before.command) return line;
    const slash = last.text.startsWith('/') ? '/' : '';
    const word = last.text.slice(slash.length);
    const menu = MENUS[(slash ? [] : before.path).join(' ')];
    const options = [...match(word, menu.menus), ...match(word, menu.commands)];
    return options.length === 1 ? `${line.slice(0, last.start)}${slash}${options[0]} ` : line;
  },
};
