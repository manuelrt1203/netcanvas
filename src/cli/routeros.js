// Terminal MikroTik RouterOS simulé : menus (/ip address, /ip route…), arguments clé=valeur,
// abréviations, « ? » et Tab. Même config que les formulaires.
import { tokenize } from './engine.js';
import { dataPorts, ensureEntry, getEntry, linkOf, pad, ping } from './device.js';
import { buildTopology } from '../net/topology.js';
import { formatIp, isBroadcastAddress, isNetworkAddress, isValidCidr, isValidIp, networkOf, sameSubnet, splitCidr } from '../net/ip.js';
import { modelOf } from '../net/catalog.js';
import { ROUTING_MENUS, routeTable, routingScript, runRouting } from './routeros-routing.js';

// Menus : sous-menus et commandes de chaque chemin
const MENUS = {
  '': { menus: ['interface', 'ip', 'routing', 'system'], commands: ['ping', 'export', 'quit'] },
  interface: { menus: ['ethernet'], commands: ['print', 'enable', 'disable', 'export'] },
  'interface ethernet': { menus: [], commands: ['print', 'enable', 'disable', 'export'] },
  ip: { menus: ['address', 'route', 'firewall'], commands: ['export'] },
  'ip address': { menus: [], commands: ['add', 'print', 'remove', 'export'] },
  'ip route': { menus: [], commands: ['add', 'print', 'remove', 'export'] },
  system: { menus: ['identity'], commands: ['reboot'] },
  'system identity': { menus: [], commands: ['print', 'set', 'export'] },
  ...ROUTING_MENUS,
};

const match = (word, options) => {
  const exact = options.find((o) => o === word);
  if (exact) return [exact];
  return options.filter((o) => o.startsWith(word));
};

const err = (text, col) => [`${text} (line 1 column ${col})`, ''];

// Analyse : chemin + commande + arguments (clé=valeur ou valeurs sans nom)
function parseLine(line, cwd) {
  const tokens = tokenize(line);
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

// Interfaces adressables : ports physiques + loopback « lo »
const ifaceNames = (dev) => [...dataPorts(dev).map((p) => p.name), 'lo'];

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
  lines.push('/system identity', `set name="${dev.label.replace(/"/g, '\\"')}"`);
  return lines;
}

const index = (n, items) => {
  const i = Number(n);
  return Number.isInteger(i) && i >= 0 && i < items.length ? i : null;
};

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
      out.push('Flags: D - dynamic, X - disabled, R - running, S - slave ', ` #     ${pad('NAME', 36)}${pad('TYPE', 11)}ACTUAL-MTU`);
      dataPorts(dev).forEach((port, i) => {
        const off = getEntry(dev, port.name)?.shutdown;
        const link = linkOf(doc, dev.id, port.name);
        const flag = off ? 'X' : link && topo.isUp(link) ? 'R' : ' ';
        out.push(` ${pad(i, 2)} ${pad(flag, 3)}${pad(port.name, 36)}${pad('ether', 11)}${String(1500).padStart(10)}`);
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
      const target = p.named.address ?? p.unnamed[0];
      if (!isValidIp(target)) return out.push('invalid value for argument address', '');
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
    case '|export':
    case 'ip|export':
    case 'ip address|export':
    case 'ip route|export':
    case 'interface|export':
    case 'interface ethernet|export':
    case 'system identity|export':
      return out.push(...routerosScript(dev), '');
    case '|quit':
      s.path = [];
      return out.push('interrupted', '');
    default:
      if (runRouting(ctx, p)) return;
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
      const ARGS = { 'ip address|add': 'address= interface=', 'ip route|add': 'dst-address= gateway=', '|ping': 'address count=', 'system identity|set': 'name=' };
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
