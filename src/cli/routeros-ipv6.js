// Terminal RouterOS : IPv6. /ipv6 address, /ipv6 route, /ipv6 settings (forward), /ipv6 neighbor.
// Même config que les formulaires : ipv6 / prefix6 / eui64 / linkLocal sur l'interface, routes6, ipv6NoForward.
import { ensureEntry, getEntry, pad, withDevice } from './device.js';
import { isLinkLocal6, isValidIp6, networkLabel6, normIp6, sameSubnet6, splitPrefix6 } from '../net/ip6.js';
import { buildTopology } from '../net/topology.js';
import { computeRouting } from '../net/routing.js';
import { withLeases } from '../net/dhcp.js';
import { routeText6 } from '../net/routing6.js';
import { ndRows } from '../net/tables.js';
import { macColon } from '../net/mac.js';

export const IPV6_MENUS = {
  ipv6: { menus: ['address', 'route', 'settings', 'neighbor'], commands: ['export'] },
  'ipv6 address': { menus: [], commands: ['add', 'print', 'remove', 'export'] },
  'ipv6 route': { menus: [], commands: ['add', 'print', 'remove', 'export'] },
  'ipv6 settings': { menus: [], commands: ['set', 'print', 'export'] },
  'ipv6 neighbor': { menus: [], commands: ['print'] },
};
export const IPV6_ARGS = {
  'ipv6 address|add': 'address= interface= eui-64= advertise=', 'ipv6 route|add': 'dst-address= gateway=', 'ipv6 settings|set': 'forward=',
};

const index = (n, items) => {
  const i = Number(n);
  return Number.isInteger(i) && i >= 0 && i < items.length ? i : null;
};
const live = (ctx) => withLeases(withDevice(ctx.doc, ctx.dev));

// Adresses affichées : globales configurées puis link-local (dynamiques si automatiques)
function addressRows(ctx) {
  const views = buildTopology(live(ctx)).l3Ifaces6(ctx.dev.id, { includeDown: true });
  const rows = [];
  for (const v of views) if (v.ip) rows.push({ flags: 'G', address: `${v.ip}/${v.prefix}`, iface: v.name, advertise: v.prefix === 64 ? 'yes' : 'no', kind: 'global' });
  for (const v of views) {
    if (v.linkLocal) rows.push({ flags: getEntry(ctx.dev, v.name)?.linkLocal ? 'L' : 'DL', address: `${v.linkLocal}/64`, iface: v.name, advertise: 'no', kind: 'link-local' });
  }
  return rows;
}

// Routes affichées : statiques (ordre de la config, A si installée), puis connectées et dynamiques
function routeRows(ctx) {
  const rib = computeRouting(live(ctx)).ribs6.get(ctx.dev.id) ?? new Map();
  const installed = [...rib.values()];
  const gwText = (hop, iface) => (hop ? `${hop}${isLinkLocal6(hop) ? `%${iface}` : ''}` : iface);
  const statics = (ctx.dev.config.routes6 ?? []).map((r, index) => {
    const active = installed.some((x) => x.proto.startsWith('S') && x.prefix === r.prefix && x.nextHop === (r.nextHop ?? null) && routeText6(x) === networkLabel6(r.network, r.prefix));
    return { index, flags: active ? 'As' : 's', dst: networkLabel6(r.network, r.prefix), gw: gwText(r.nextHop, r.iface), distance: 1 };
  });
  const dynamic = installed.filter((x) => !x.proto.startsWith('S') && x.proto !== 'L')
    .map((x) => ({ flags: `DA${x.proto === 'C' ? 'c' : x.proto[0].toLowerCase()}`, dst: routeText6(x), gw: gwText(x.nextHop, x.iface), distance: x.ad }));
  return [...statics, ...dynamic];
}

// gateway=fe80::1%ether1 (link-local + interface) ou gateway=2001:db8::1
function parseGateway(text) {
  const [ip, iface] = String(text ?? '').split('%');
  if (!isValidIp6(ip)) return null;
  if (isLinkLocal6(ip) && !iface) return null;
  return { nextHop: normIp6(ip), ...(iface ? { iface } : {}) };
}

export function runIpv6(ctx, p, isIface) {
  const { dev, out } = ctx;
  const c = (dev.config ??= {});
  switch (`${p.path.join(' ')}|${p.command}`) {
    case 'ipv6 address|add': {
      const a = splitPrefix6(p.named.address ?? '');
      if (!a) return out.push('failure: invalid value for argument address', ''), true;
      if (!p.named.interface || !isIface(p.named.interface)) return out.push('input does not match any value of interface', ''), true;
      const e = ensureEntry(dev, p.named.interface, ctx.doc);
      if (isLinkLocal6(a.ip)) {
        e.linkLocal = a.ip;
      } else {
        const eui = p.named['eui-64'] === 'yes';
        if (eui && a.prefix !== 64) return out.push('failure: eui-64 requires /64 prefix', ''), true;
        for (const x of c.interfaces ?? []) {
          if (x !== e && x.ipv6 && isValidIp6(x.ipv6) && x.prefix6 != null && sameSubnet6(x.ipv6, a.ip, Math.min(x.prefix6, a.prefix))) {
            return out.push(`failure: ${networkLabel6(a.ip, a.prefix)} overlaps with ${x.name}`, ''), true;
          }
        }
        if (e.ipv6) return out.push(`failure: NetCanvas gère une adresse IPv6 globale par interface : supprime d'abord ${e.ipv6}/${e.prefix6} (remove)`, ''), true;
        Object.assign(e, { ipv6: a.ip, prefix6: a.prefix, ...(eui ? { eui64: true } : {}) });
      }
      delete e.ipv6Enable;
      ctx.changed = true;
      return true;
    }
    case 'ipv6 address|print': {
      out.push('Flags: D - DYNAMIC; G - GLOBAL, L - LINK-LOCAL', 'Columns: ADDRESS, INTERFACE, ADVERTISE', `#    ${pad('ADDRESS', 42)}${pad('INTERFACE', 11)}ADVERTISE`);
      addressRows(ctx).forEach((r, i) => out.push(`${pad(i, 2)}${r.flags.padStart(2)} ${pad(r.address, 42)}${pad(r.iface, 11)}${r.advertise}`));
      out.push('');
      return true;
    }
    case 'ipv6 address|remove': {
      const rows = addressRows(ctx);
      const i = index(p.named.numbers ?? p.unnamed[0], rows);
      if (i === null) return out.push('no such item', ''), true;
      const r = rows[i];
      if (r.flags === 'DL') return out.push('failure: cannot remove dynamic address', ''), true;
      const e = getEntry(dev, r.iface);
      if (r.kind === 'link-local') delete e.linkLocal;
      else for (const k of ['ipv6', 'prefix6', 'eui64']) delete e[k];
      ctx.changed = true;
      return true;
    }
    case 'ipv6 route|add': {
      const dst = splitPrefix6(p.named['dst-address'] ?? '::/0');
      if (!dst) return out.push('failure: invalid value for argument dst-address', ''), true;
      const gw = parseGateway(p.named.gateway);
      if (!gw) return out.push('failure: invalid value for argument gateway (une link-local s\'écrit fe80::1%ether1)', ''), true;
      if (gw.iface && !isIface(gw.iface)) return out.push('input does not match any value of interface', ''), true;
      c.routes6 = [...(c.routes6 ?? []), { network: dst.ip, prefix: dst.prefix, ...gw }];
      ctx.changed = true;
      return true;
    }
    case 'ipv6 route|print': {
      out.push('Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC, o - OSPF', 'Columns: DST-ADDRESS, GATEWAY, DISTANCE', `#     ${pad('DST-ADDRESS', 28)}${pad('GATEWAY', 28)}DISTANCE`);
      routeRows(ctx).forEach((r, i) => out.push(`${pad(i, 2)}${r.flags.padStart(4)} ${pad(r.dst, 28)}${pad(r.gw, 28)}${r.distance}`));
      out.push('');
      return true;
    }
    case 'ipv6 route|remove': {
      const rows = routeRows(ctx);
      const i = index(p.named.numbers ?? p.unnamed[0], rows);
      if (i === null) return out.push('no such item', ''), true;
      if (rows[i].index === undefined) return out.push('failure: cannot remove dynamic route', ''), true;
      c.routes6 = c.routes6.filter((_, j) => j !== rows[i].index);
      if (!c.routes6.length) delete c.routes6;
      ctx.changed = true;
      return true;
    }
    case 'ipv6 settings|set': {
      const f = p.named.forward;
      if (!['yes', 'no'].includes(f)) return out.push('invalid value for argument forward', ''), true;
      if (f === 'no') c.ipv6NoForward = true;
      else delete c.ipv6NoForward;
      ctx.changed = true;
      return true;
    }
    case 'ipv6 settings|print':
      out.push(`  forward: ${c.ipv6NoForward ? 'no' : 'yes'}`, '  accept-router-advertisements: yes-if-forwarding-disabled', '');
      return true;
    case 'ipv6 neighbor|print': {
      out.push('Columns: ADDRESS, INTERFACE, MAC-ADDRESS, STATUS', `#  ${pad('ADDRESS', 40)}${pad('INTERFACE', 10)}${pad('MAC-ADDRESS', 19)}STATUS`);
      ndRows(dev, live(ctx)).forEach((r, i) => out.push(`${pad(i, 3)}${pad(r.ip, 40)}${pad(r.iface, 10)}${pad(macColon(r.mac), 19)}${r.state === 'REACH' ? 'reachable' : 'stale'}`));
      out.push('');
      return true;
    }
    default:
      return false;
  }
}

// Lignes d'export (/export)
export function ipv6Script(dev) {
  const c = dev.config ?? {};
  const lines = [];
  const addrs = (c.interfaces ?? []).flatMap((e) => [
    ...(e.linkLocal ? [`add address=${e.linkLocal}/64 advertise=no interface=${e.name}`] : []),
    ...(e.ipv6 ? [`add address=${normIp6(e.ipv6) ?? e.ipv6}/${e.prefix6 ?? 64}${e.prefix6 === 64 ? '' : ' advertise=no'}${e.eui64 ? ' eui-64=yes' : ''} interface=${e.name}`] : []),
  ]);
  if (addrs.length) lines.push('/ipv6 address', ...addrs);
  const routes = (c.routes6 ?? []).filter((r) => isValidIp6(r.network) && r.nextHop);
  if (routes.length) lines.push('/ipv6 route', ...routes.map((r) => `add dst-address=${normIp6(r.network)}/${r.prefix} gateway=${r.nextHop}${r.iface ? `%${r.iface}` : ''}`));
  if (c.ipv6NoForward) lines.push('/ipv6 settings', 'set forward=no');
  return lines;
}
