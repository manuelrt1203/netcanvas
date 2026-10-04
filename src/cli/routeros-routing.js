// Terminal RouterOS v7 : /routing ospf, /routing rip, /routing bgp et /ip firewall address-list.
// Même configuration que les routeurs Cisco (config.ospf, config.rip, config.bgp) : un MikroTik
// forme des adjacences OSPF ou des sessions BGP avec un Cisco.
import { pad } from './device.js';
import { cidrToWildcard, computeRouting, prefixText, wildcardToCidr } from '../net/routing.js';
import { formatIp, isValidIp, networkOf, sameSubnet, splitCidr } from '../net/ip.js';
import { firewallRuleText, parseFirewallRule } from '../net/acl.js';
import { buildTopology } from '../net/topology.js';

export const ROUTING_MENUS = {
  routing: { menus: ['ospf', 'rip', 'bgp'], commands: [] },
  'routing ospf': { menus: ['instance', 'area', 'interface-template', 'neighbor'], commands: [] },
  'routing ospf instance': { menus: [], commands: ['add', 'print', 'set', 'remove'] },
  'routing ospf area': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing ospf interface-template': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing ospf neighbor': { menus: [], commands: ['print'] },
  'routing rip': { menus: ['instance', 'interface-template', 'neighbor'], commands: [] },
  'routing rip instance': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing rip interface-template': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing rip neighbor': { menus: [], commands: ['print'] },
  'routing bgp': { menus: ['connection', 'session'], commands: [] },
  'routing bgp connection': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing bgp session': { menus: [], commands: ['print'] },
  'ip firewall': { menus: ['address-list', 'filter'], commands: [] },
  'ip firewall filter': { menus: [], commands: ['add', 'print', 'remove'] },
  'ip firewall address-list': { menus: [], commands: ['add', 'print', 'remove'] },
};

const areaId = (n) => formatIp(Number(n) >>> 0);
const areaFromId = (id) => (isValidIp(id) ? id.split('.').reduce((a, b) => a * 256 + Number(b), 0) : Number(id));
// Nom d'une zone : celui donné par « /routing ospf area add », sinon un nom par défaut
const areaName = (o, area) => Object.entries(o.areaNames ?? {}).find(([, a]) => Number(a) === Number(area))?.[0]
  ?? (Number(area) === 0 ? 'backbone-v2' : `area${area}-v2`);
const yes = (v) => v === undefined || v === '' || v === 'yes' || v === 'true';

// Réseaux annoncés en BGP = la liste d'adresses référencée par output.network
function syncBgpNetworks(cfg) {
  const b = cfg.bgp;
  if (!b?.outputNetwork) return;
  b.networks = (cfg.addressLists?.[b.outputNetwork] ?? []).map((cidr) => {
    const s = splitCidr(cidr);
    return { network: formatIp(networkOf(s.ip, s.cidr)), mask: s.cidr };
  });
}

// Interfaces actives couvertes par un réseau
const ifacesIn = (dev, doc, s) => buildTopology(doc).l3Ifaces(dev.id).filter((i) => networkOf(i.ip, s.cidr) === networkOf(s.ip, s.cidr));

// Gère une commande de routage ; renvoie false si elle n'en est pas une
export function runRouting(ctx, p) {
  const { dev, doc, out } = ctx;
  const cfg = (dev.config ??= {});
  const n = p.named;
  const changed = () => { ctx.changed = true; };
  const where = `${p.path.join(' ')}|${p.command}`;

  switch (where) {
    // --- OSPF -----------------------------------------------------------------
    case 'routing ospf instance|add':
    case 'routing ospf instance|set': {
      const o = (cfg.ospf ??= { processId: 1, networks: [] });
      if (n.name) o.instance = n.name;
      if (n['router-id']) {
        if (!isValidIp(n['router-id'])) return out.push('invalid value for argument router-id', ''), true;
        o.routerId = n['router-id'];
      }
      if (n['originate-default']) o.defaultOriginate = n['originate-default'] === 'always' ? 'always' : n['originate-default'] === 'never' ? undefined : true;
      if (n.redistribute) o.redistribute = Object.fromEntries(n.redistribute.split(',').map((x) => [x, true]));
      changed();
      return true;
    }
    case 'routing ospf instance|print': {
      const o = cfg.ospf;
      out.push('Flags: X - disabled, I - inactive ');
      if (o) out.push(` 0    name="${o.instance ?? 'default-v2'}" version=2 router-id=${o.routerId ?? 'main'}${o.defaultOriginate ? ` originate-default=${o.defaultOriginate === 'always' ? 'always' : 'if-installed'}` : ''}`);
      return out.push(''), true;
    }
    case 'routing ospf instance|remove':
      delete cfg.ospf;
      changed();
      return true;
    case 'routing ospf area|add': {
      if (!cfg.ospf) return out.push('input does not match any value of instance', ''), true;
      if (!n.name) return out.push('expected end of command', ''), true;
      (cfg.ospf.areaNames ??= {})[n.name] = areaFromId(n['area-id'] ?? '0.0.0.0');
      changed();
      return true;
    }
    case 'routing ospf area|print': {
      out.push('Flags: X - disabled, I - inactive, D - dynamic; T - transit-capable ');
      const areas = Object.entries(cfg.ospf?.areaNames ?? {});
      areas.forEach(([name, a], i) => out.push(` ${i}    name="${name}" instance=${cfg.ospf.instance ?? 'default-v2'} area-id=${areaId(a)} type=default`));
      return out.push(''), true;
    }
    case 'routing ospf interface-template|add': {
      const o = cfg.ospf;
      if (!o) return out.push('input does not match any value of area', ''), true;
      const areaKey = n.area ?? 'backbone-v2';
      const area = o.areaNames?.[areaKey] ?? (areaKey === 'backbone-v2' || areaKey === 'backbone' ? 0 : null);
      if (area === null || area === undefined) return out.push(`input does not match any value of area`, ''), true;
      const targets = [];
      for (const net of (n.networks ?? '').split(',').filter(Boolean)) {
        const s = splitCidr(net);
        if (!s) return out.push('invalid value for argument networks', ''), true;
        (o.networks ??= []).push({ network: formatIp(networkOf(s.ip, s.cidr)), wildcard: cidrToWildcard(s.cidr), area });
        targets.push(...ifacesIn(dev, doc, s).map((i) => i.name));
      }
      for (const name of (n.interfaces ?? '').split(',').filter(Boolean)) {
        (o.interfaces ??= []).push({ name, area });
        targets.push(name);
      }
      if (!targets.length && !n.networks) return out.push('expected networks or interfaces', ''), true;
      if ('passive' in n || p.unnamed.includes('passive')) o.passive = [...new Set([...(o.passive ?? []), ...targets])];
      if (n.cost) {
        for (const name of targets) {
          const e = (cfg.interfaces ??= []).find((x) => x.name === name);
          if (e) e.ospfCost = Number(n.cost);
        }
      }
      changed();
      return true;
    }
    case 'routing ospf interface-template|print': {
      const o = cfg.ospf;
      out.push('Flags: X - disabled, I - inactive ');
      let i = 0;
      for (const x of o?.networks ?? []) out.push(` ${i++}    area=${areaName(o, x.area)} networks=${x.network}/${wildcardToCidr(x.wildcard)}`);
      for (const x of o?.interfaces ?? []) out.push(` ${i++}    area=${areaName(o, x.area)} interfaces=${x.name}`);
      return out.push(''), true;
    }
    case 'routing ospf interface-template|remove': {
      const o = cfg.ospf;
      const all = [...(o?.networks ?? []).map((x) => ['networks', x]), ...(o?.interfaces ?? []).map((x) => ['interfaces', x])];
      const k = Number(n.numbers ?? p.unnamed[0]);
      if (!Number.isInteger(k) || !all[k]) return out.push('no such item', ''), true;
      o[all[k][0]] = o[all[k][0]].filter((x) => x !== all[k][1]);
      changed();
      return true;
    }
    case 'routing ospf neighbor|print': {
      const r = computeRouting(doc).routers.get(dev.id);
      out.push('Flags: V - virtual; D - dynamic ');
      (r?.ospf.neighbors ?? []).forEach((x, i) => {
        out.push(` ${i}  D instance=${cfg.ospf.instance ?? 'default-v2'} area=${areaName(cfg.ospf, x.area)} address=${x.peerIface.ip} router-id=${x.peer.ospf.routerId} state="Full" state-changes=6`);
      });
      for (const iss of r?.issues ?? []) if (/^OSPF/.test(iss.text)) out.push(`NetCanvas : ${iss.text}`);
      return out.push(''), true;
    }

    // --- RIP ------------------------------------------------------------------
    case 'routing rip instance|add': {
      const r = (cfg.rip ??= { version: 2, interfaces: [] });
      r.version = 2;
      if (n.name) r.instance = n.name;
      if (n['originate-default'] === 'always') r.defaultOriginate = true;
      if (n.redistribute?.split(',').includes('static')) r.redistribute = { static: true };
      changed();
      return true;
    }
    case 'routing rip instance|print':
      out.push('Flags: X - disabled ');
      if (cfg.rip) out.push(` 0    name="${cfg.rip.instance ?? 'rip'}"${cfg.rip.defaultOriginate ? ' originate-default=always' : ''}`);
      return out.push(''), true;
    case 'routing rip instance|remove':
      delete cfg.rip;
      changed();
      return true;
    case 'routing rip interface-template|add': {
      const r = cfg.rip;
      if (!r) return out.push('input does not match any value of instance', ''), true;
      const names = (n.interfaces ?? '').split(',').filter(Boolean);
      for (const net of (n.networks ?? '').split(',').filter(Boolean)) {
        const s = splitCidr(net);
        if (!s) return out.push('invalid value for argument networks', ''), true;
        names.push(...ifacesIn(dev, doc, s).map((i) => i.name));
      }
      if (!names.length) return out.push('expected interfaces or networks', ''), true;
      r.interfaces = [...new Set([...(r.interfaces ?? []), ...names])];
      if ('passive' in n || p.unnamed.includes('passive')) r.passive = [...new Set([...(r.passive ?? []), ...names])];
      changed();
      return true;
    }
    case 'routing rip interface-template|print':
      out.push('Flags: X - disabled ');
      (cfg.rip?.interfaces ?? []).forEach((x, i) => out.push(` ${i}    instance=${cfg.rip.instance ?? 'rip'} interfaces=${x}${cfg.rip.passive?.includes(x) ? ' passive' : ''}`));
      return out.push(''), true;
    case 'routing rip interface-template|remove': {
      const k = Number(n.numbers ?? p.unnamed[0]);
      if (!cfg.rip?.interfaces?.[k]) return out.push('no such item', ''), true;
      cfg.rip.interfaces.splice(k, 1);
      changed();
      return true;
    }
    case 'routing rip neighbor|print': {
      const r = computeRouting(doc).routers.get(dev.id);
      out.push('Flags: D - dynamic ');
      const seen = new Map();
      for (const e of r?.rip.table.values() ?? []) if (e.via) seen.set(e.via.nextHop, e.via.iface);
      [...seen].forEach(([addr, iface], i) => out.push(` ${i}  D instance=${cfg.rip.instance ?? 'rip'} address=${addr} interface=${iface}`));
      return out.push(''), true;
    }

    // --- BGP ------------------------------------------------------------------
    case 'routing bgp connection|add': {
      const remote = n['remote.address'];
      const remoteAs = Number(n['remote.as']);
      const asn = Number(n.as ?? cfg.bgp?.asn);
      if (!isValidIp(remote?.split('/')[0])) return out.push('invalid value for argument remote.address', ''), true;
      if (!remoteAs || !asn) return out.push('failure: as and remote.as are required', ''), true;
      if (cfg.bgp?.asn && Number(cfg.bgp.asn) !== asn) return out.push(`failure: NetCanvas gère un seul AS par routeur (déjà ${cfg.bgp.asn})`, ''), true;
      const b = (cfg.bgp ??= { asn, neighbors: [], networks: [] });
      b.asn = asn;
      if (n['router-id']) b.routerId = n['router-id'];
      const neighbor = { ip: remote.split('/')[0], remoteAs, name: n.name ?? `peer-${remote}` };
      if (n['nexthop-choice'] === 'force-self') neighbor.nextHopSelf = true;
      if (yes(n.multihop) && 'multihop' in n) neighbor.ebgpMultihop = 255;
      if (n['local.address']) {
        const lo = (cfg.interfaces ?? []).find((e) => e.ip === n['local.address'].split('/')[0]);
        if (lo) neighbor.updateSource = lo.name;
      }
      b.neighbors = [...(b.neighbors ?? []).filter((x) => x.ip !== neighbor.ip), neighbor];
      if (n['output.network']) {
        b.outputNetwork = n['output.network'];
        syncBgpNetworks(cfg);
      }
      changed();
      return true;
    }
    case 'routing bgp connection|print':
      out.push('Flags: D - dynamic, X - disabled, I - inactive ');
      (cfg.bgp?.neighbors ?? []).forEach((x, i) => {
        out.push(` ${i}    name="${x.name ?? `peer-${x.ip}`}" remote.address=${x.ip} .as=${x.remoteAs} local.role=${Number(x.remoteAs) === Number(cfg.bgp.asn) ? 'ibgp' : 'ebgp'} as=${cfg.bgp.asn}${cfg.bgp.outputNetwork ? ` output.network=${cfg.bgp.outputNetwork}` : ''}`);
      });
      return out.push(''), true;
    case 'routing bgp connection|remove': {
      const k = Number(n.numbers ?? p.unnamed[0]);
      if (!cfg.bgp?.neighbors?.[k]) return out.push('no such item', ''), true;
      cfg.bgp.neighbors.splice(k, 1);
      changed();
      return true;
    }
    case 'routing bgp session|print': {
      const r = computeRouting(doc).routers.get(dev.id);
      out.push('Flags: E - established ');
      (r?.bgp.sessions ?? []).forEach((s, i) => {
        const up = s.state === 'Established';
        const pfx = up ? r.bgp.adjIn?.get(s.peer.id)?.size ?? 0 : 0;
        out.push(` ${i} ${up ? 'E' : ' '} remote.address=${s.neighbor} .as=${s.remoteAs}${up ? ` .id=${s.peer.bgp.routerId}` : ''} local.as=${r.bgp.asn} prefix-count=${pfx}`);
        if (!up) out.push(`     NetCanvas : ${s.reason}.`);
      });
      return out.push(''), true;
    }

    // --- Pare-feu (filtrage des paquets) -----------------------------------------
    case 'ip firewall filter|add': {
      const text = Object.entries(n).map(([k, v]) => `${k}=${v}`).join(' ');
      const r = parseFirewallRule(text);
      if (r.error) return out.push(`failure: ${r.error}`, ''), true;
      const at = n['place-before'] !== undefined ? Number(n['place-before']) : null;
      const rules = (cfg.firewall ??= []);
      if (at !== null && at >= 0 && at <= rules.length) rules.splice(at, 0, r.rule);
      else rules.push(r.rule);
      changed();
      return true;
    }
    case 'ip firewall filter|print':
      out.push('Flags: X - disabled, I - invalid, D - dynamic ');
      (cfg.firewall ?? []).forEach((r, i) => out.push(` ${pad(i, 3)} ${firewallRuleText(r)}`));
      return out.push(''), true;
    case 'ip firewall filter|remove': {
      const k = Number(n.numbers ?? p.unnamed[0]);
      if (!cfg.firewall?.[k]) return out.push('no such item', ''), true;
      cfg.firewall.splice(k, 1);
      changed();
      return true;
    }

    // --- Listes d'adresses (réseaux annoncés en BGP) --------------------------
    case 'ip firewall address-list|add': {
      const s = splitCidr(n.address ?? '') ?? (isValidIp(n.address) ? { ip: n.address, cidr: 32 } : null);
      if (!s || !n.list) return out.push('failure: list and address are required', ''), true;
      const lists = (cfg.addressLists ??= {});
      lists[n.list] = [...new Set([...(lists[n.list] ?? []), `${formatIp(networkOf(s.ip, s.cidr))}/${s.cidr}`])];
      syncBgpNetworks(cfg);
      changed();
      return true;
    }
    case 'ip firewall address-list|print': {
      out.push('Flags: X - disabled, D - dynamic ', ` #   ${pad('LIST', 20)}ADDRESS`);
      let i = 0;
      for (const [list, addrs] of Object.entries(cfg.addressLists ?? {})) for (const a of addrs) out.push(` ${pad(i++, 4)}${pad(list, 20)}${a}`);
      return out.push(''), true;
    }
    case 'ip firewall address-list|remove': {
      const all = Object.entries(cfg.addressLists ?? {}).flatMap(([list, addrs]) => addrs.map((a) => [list, a]));
      const k = Number(n.numbers ?? p.unnamed[0]);
      if (!all[k]) return out.push('no such item', ''), true;
      cfg.addressLists[all[k][0]] = cfg.addressLists[all[k][0]].filter((a) => a !== all[k][1]);
      syncBgpNetworks(cfg);
      changed();
      return true;
    }
    default:
      return false;
  }
}

// Table de routage façon « /ip route print » (v7) : statiques configurées puis routes dynamiques
const FLAG = { C: 'DAc', L: null, S: 'As', 'S*': 'As', O: 'DAo', 'O IA': 'DAo', 'O E2': 'DAo', 'O*E2': 'DAo', R: 'DAr', 'R*': 'DAr', B: 'DAb' };

export function routeTable(dev, doc) {
  const rib = computeRouting(doc).ribs.get(dev.id) ?? new Map();
  const ifaces = buildTopology(doc).l3Ifaces(dev.id);
  const statics = (dev.config?.routes ?? []).map((r, index) => {
    const installed = [...rib.values()].some((x) => x.proto.startsWith('S') && x.nextHop === r.nextHop && prefixText(x.net, x.mask) === `${r.network}/${r.mask}`);
    return { index, flags: installed ? 'As' : ifaces.some((i) => sameSubnet(i.ip, r.nextHop, i.mask)) ? 'S' : 'IS', dst: `${r.network}/${r.mask}`, src: '', gw: r.nextHop, distance: 1 };
  });
  const dynamic = [...rib.values()]
    .filter((r) => FLAG[r.proto] && !r.proto.startsWith('S'))
    .sort((a, b) => a.net - b.net || a.mask - b.mask)
    .map((r) => ({
      flags: FLAG[r.proto],
      dst: prefixText(r.net, r.mask),
      src: r.proto === 'C' ? ifaces.find((i) => i.name === r.iface)?.ip ?? '' : '',
      gw: r.proto === 'C' ? r.iface : r.nextHop,
      distance: r.ad,
    }));
  return [...statics, ...dynamic];
}

// Lignes de /export pour le routage et le pare-feu
export function routingScript(dev) {
  const cfg = dev.config ?? {};
  const out = [];
  if (cfg.firewall?.length) out.push('/ip firewall filter', ...cfg.firewall.map((r) => `add ${firewallRuleText(r)}`));
  const o = cfg.ospf;
  if (o) {
    const instance = o.instance ?? 'default-v2';
    const extra = [
      o.routerId ? `router-id=${o.routerId}` : null,
      o.defaultOriginate ? `originate-default=${o.defaultOriginate === 'always' ? 'always' : 'if-installed'}` : null,
      o.redistribute && Object.keys(o.redistribute).filter((k) => o.redistribute[k]).length
        ? `redistribute=${Object.keys(o.redistribute).filter((k) => o.redistribute[k]).join(',')}` : null,
    ].filter(Boolean).join(' ');
    out.push('/routing ospf instance', `add name=${instance} version=2${extra ? ` ${extra}` : ''}`);
    const areas = [...new Set([...(o.networks ?? []), ...(o.interfaces ?? [])].map((x) => Number(x.area)))];
    out.push('/routing ospf area', ...areas.map((a) => `add area-id=${areaId(a)} instance=${instance} name=${areaName(o, a)}`));
    out.push('/routing ospf interface-template');
    const passive = new Set(o.passive ?? []);
    for (const x of o.networks ?? []) out.push(`add area=${areaName(o, x.area)} networks=${x.network}/${wildcardToCidr(x.wildcard)}`);
    for (const x of o.interfaces ?? []) out.push(`add area=${areaName(o, x.area)} interfaces=${x.name}${passive.has(x.name) ? ' passive' : ''}`);
    for (const name of passive) if (!(o.interfaces ?? []).some((x) => x.name === name)) out.push(`# ${name} : passive-interface (ajoute « passive » au modèle qui la couvre)`);
  }
  const r = cfg.rip;
  if (r) {
    const instance = r.instance ?? 'rip';
    out.push('/routing rip instance', `add name=${instance}${r.defaultOriginate ? ' originate-default=always' : ''}${r.redistribute?.static ? ' redistribute=static' : ''}`);
    out.push('/routing rip interface-template');
    for (const name of r.interfaces ?? []) out.push(`add instance=${instance} interfaces=${name}${r.passive?.includes(name) ? ' passive' : ''}`);
    for (const net of r.networks ?? []) out.push(`# réseau RIP ${net} (Cisco) : ajoute les interfaces concernées`);
  }
  const b = cfg.bgp;
  if (b?.asn) {
    const list = b.outputNetwork ?? 'bgp-networks';
    if (b.networks?.length) {
      out.push('/ip firewall address-list', ...b.networks.map((x) => `add address=${x.network}/${x.mask} list=${list}`));
    }
    out.push('/routing bgp connection');
    for (const x of b.neighbors ?? []) {
      const role = Number(x.remoteAs) === Number(b.asn) ? 'ibgp' : 'ebgp';
      const local = x.updateSource ? (cfg.interfaces ?? []).find((e) => e.name === x.updateSource)?.ip : null;
      out.push([
        `add as=${b.asn} local.role=${role} name=${x.name ?? `peer-${x.ip}`}`,
        b.networks?.length ? `output.network=${list}` : null,
        `remote.address=${x.ip} remote.as=${x.remoteAs}`,
        b.routerId ? `router-id=${b.routerId}` : null,
        x.nextHopSelf ? 'nexthop-choice=force-self' : null,
        x.ebgpMultihop ? 'multihop=yes' : null,
        local ? `local.address=${local}` : null,
      ].filter(Boolean).join(' '));
    }
  }
  return out;
}
