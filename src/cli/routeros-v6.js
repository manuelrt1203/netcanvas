// RouterOS v6 (ex. MikroTik CHR 6.49 de GNS3) : ancienne syntaxe du routage dynamique.
//   /routing ospf network add network=10.0.0.0/24 area=backbone   (v7 : interface-template)
//   /routing bgp instance set default as=65001 ; /routing bgp peer add …   (v7 : connection)
//   /routing rip network add … ; /routing ospf-v3 interface add …
// Même configuration que la v7 et les routeurs Cisco (config.ospf, ospf6, rip, bgp) : seule la syntaxe change.
import { computeRouting, cidrToWildcard, wildcardToCidr } from '../net/routing.js';
import { formatIp, isValidCidr, isValidIp, networkOf, splitCidr } from '../net/ip.js';
import { modelOf } from '../net/catalog.js';

export const isRos6 = (dev) => modelOf(dev).ros === 6;

export const ROUTING_MENUS_V6 = {
  routing: { menus: ['ospf', 'ospf-v3', 'rip', 'bgp'], commands: [] },
  'routing ospf': { menus: ['instance', 'area', 'network', 'interface', 'neighbor'], commands: [] },
  'routing ospf instance': { menus: [], commands: ['set', 'print'] },
  'routing ospf area': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing ospf network': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing ospf interface': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing ospf neighbor': { menus: [], commands: ['print'] },
  'routing ospf-v3': { menus: ['instance', 'area', 'interface', 'neighbor'], commands: [] },
  'routing ospf-v3 instance': { menus: [], commands: ['set', 'print'] },
  'routing ospf-v3 area': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing ospf-v3 interface': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing ospf-v3 neighbor': { menus: [], commands: ['print'] },
  'routing rip': { menus: ['network', 'interface', 'neighbor'], commands: ['set', 'print'] },
  'routing rip network': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing rip interface': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing rip neighbor': { menus: [], commands: ['print'] },
  'routing bgp': { menus: ['instance', 'peer', 'network'], commands: [] },
  'routing bgp instance': { menus: [], commands: ['set', 'print'] },
  'routing bgp peer': { menus: [], commands: ['add', 'print', 'remove'] },
  'routing bgp network': { menus: [], commands: ['add', 'print', 'remove'] },
};

// Zones : « backbone » (0.0.0.0) existe d'office ; les autres sont créées par « area add »
const areaId = (n) => formatIp(Number(n) >>> 0);
const areaName = (o, area) => Object.entries(o?.areaNames ?? {}).find(([, a]) => Number(a) === Number(area))?.[0]
  ?? (Number(area) === 0 ? 'backbone' : `area${area}`);
const areaOf = (o, name = 'backbone') => (name === 'backbone' ? 0 : o?.areaNames?.[name]);
const yes = (v) => v === 'yes' || v === 'true';
const index = (p) => Number(p.named.numbers ?? p.unnamed[0]);

// Sous-réseau d'une interface (pour exporter un réseau OSPF/RIP par interface)
function subnetOf(cfg, name) {
  const e = (cfg.interfaces ?? []).find((i) => i.name === name);
  return e && isValidIp(e.ip) && isValidCidr(e.mask) ? `${formatIp(networkOf(e.ip, e.mask))}/${e.mask}` : null;
}

// « distribute-default=always-as-type-1 » <-> defaultOriginate ('always' | true)
const distribute = (v) => (v === 'always' ? 'always-as-type-1' : v ? 'if-installed-as-type-1' : 'never');

export function runRoutingV6(ctx, p) {
  const { dev, doc, out } = ctx;
  const cfg = (dev.config ??= {});
  const n = p.named;
  const changed = () => { ctx.changed = true; };
  const fail = (msg) => (out.push(msg, ''), true);
  const where = `${p.path.join(' ')}|${p.command}`;
  const ospf = () => (cfg.ospf ??= { processId: 1, networks: [] });
  const ospf6 = () => (cfg.ospf6 ??= { processId: 1, interfaces: [] });

  switch (where) {
    // --- OSPF -----------------------------------------------------------------
    case 'routing ospf instance|set':
    case 'routing ospf-v3 instance|set': {
      const o = where.includes('v3') ? ospf6() : ospf();
      if (n['router-id']) {
        if (!isValidIp(n['router-id'])) return fail('invalid value for argument router-id');
        o.routerId = n['router-id'];
      }
      if (n['distribute-default']) {
        const d = n['distribute-default'];
        if (d === 'never') delete o.defaultOriginate;
        else o.defaultOriginate = d.startsWith('always') ? 'always' : true;
      }
      for (const kind of ['static', 'connected']) {
        const v = n[`redistribute-${kind}`];
        if (v === undefined) continue;
        o.redistribute = { ...o.redistribute, [kind]: v !== 'no' };
        if (!o.redistribute[kind]) delete o.redistribute[kind];
      }
      changed();
      return true;
    }
    case 'routing ospf instance|print':
    case 'routing ospf-v3 instance|print': {
      const o = where.includes('v3') ? cfg.ospf6 : cfg.ospf;
      out.push('Flags: X - disabled, * - default ', ` 0  * name="default" router-id=${o?.routerId ?? '0.0.0.0'} distribute-default=${distribute(o?.defaultOriginate)}`);
      if (!where.includes('v3')) out.push(`       redistribute-connected=${o?.redistribute?.connected ? 'as-type-1' : 'no'} redistribute-static=${o?.redistribute?.static ? 'as-type-1' : 'no'}`);
      return out.push(''), true;
    }
    case 'routing ospf area|add':
    case 'routing ospf-v3 area|add': {
      const o = where.includes('v3') ? ospf6() : ospf();
      if (!n.name || !isValidIp(n['area-id'] ?? '')) return fail('failure: name and area-id are required');
      (o.areaNames ??= {})[n.name] = n['area-id'].split('.').reduce((a, b) => a * 256 + Number(b), 0);
      changed();
      return true;
    }
    case 'routing ospf area|print':
    case 'routing ospf-v3 area|print': {
      const o = where.includes('v3') ? cfg.ospf6 : cfg.ospf;
      out.push('Flags: X - disabled, I - invalid, * - default ', ' 0  * name="backbone" area-id=0.0.0.0 type=default');
      Object.entries(o?.areaNames ?? {}).filter(([name]) => name !== 'backbone')
        .forEach(([name, a], i) => out.push(` ${i + 1}    name="${name}" area-id=${areaId(a)} type=default`));
      return out.push(''), true;
    }
    case 'routing ospf area|remove':
    case 'routing ospf-v3 area|remove': {
      const o = where.includes('v3') ? cfg.ospf6 : cfg.ospf;
      const names = Object.keys(o?.areaNames ?? {}).filter((x) => x !== 'backbone');
      const name = names[index(p) - 1] ?? p.unnamed[0];
      if (!o?.areaNames?.[name]) return fail('no such item');
      delete o.areaNames[name];
      changed();
      return true;
    }
    case 'routing ospf network|add': {
      const s = splitCidr(n.network ?? '');
      if (!s) return fail('invalid value for argument network');
      const o = ospf();
      const area = areaOf(o, n.area);
      if (area === undefined) return fail('input does not match any value of area');
      const network = formatIp(networkOf(s.ip, s.cidr));
      o.networks = [...(o.networks ?? []).filter((x) => x.network !== network), { network, wildcard: cidrToWildcard(s.cidr), area }];
      changed();
      return true;
    }
    case 'routing ospf network|print':
      out.push('Flags: X - disabled, I - invalid ', ' #   NETWORK            AREA');
      (cfg.ospf?.networks ?? []).forEach((x, i) => out.push(` ${String(i).padEnd(3)} ${`${x.network}/${wildcardToCidr(x.wildcard)}`.padEnd(18)} ${areaName(cfg.ospf, x.area)}`));
      return out.push(''), true;
    case 'routing ospf network|remove': {
      const k = index(p);
      if (!cfg.ospf?.networks?.[k]) return fail('no such item');
      cfg.ospf.networks.splice(k, 1);
      changed();
      return true;
    }
    // Paramètres par interface : passive, cost (v6 : /routing ospf interface)
    case 'routing ospf interface|add': {
      const name = n.interface;
      if (!name) return fail('failure: interface is required');
      const o = ospf();
      if (yes(n.passive)) o.passive = [...new Set([...(o.passive ?? []), name])];
      if (n.cost) {
        const e = (cfg.interfaces ??= []).find((x) => x.name === name);
        if (e) e.ospfCost = Number(n.cost);
      }
      changed();
      return true;
    }
    case 'routing ospf interface|print':
      out.push('Flags: X - disabled, I - inactive, D - dynamic, P - passive ', ' #    INTERFACE     COST');
      [...new Set([...(cfg.ospf?.passive ?? []), ...(cfg.interfaces ?? []).filter((e) => e.ospfCost).map((e) => e.name)])].forEach((name, i) => {
        const cost = (cfg.interfaces ?? []).find((e) => e.name === name)?.ospfCost ?? 10;
        out.push(` ${String(i).padEnd(2)} ${cfg.ospf?.passive?.includes(name) ? 'P' : ' '}  ${name.padEnd(13)} ${cost}`);
      });
      return out.push(''), true;
    case 'routing ospf interface|remove': {
      const o = cfg.ospf;
      const name = o?.passive?.[index(p)];
      if (!name) return fail('no such item');
      o.passive = o.passive.filter((x) => x !== name);
      changed();
      return true;
    }
    case 'routing ospf-v3 interface|add': {
      const name = n.interface;
      if (!name) return fail('failure: interface is required');
      const o = ospf6();
      const area = areaOf(o, n.area);
      if (area === undefined) return fail('input does not match any value of area');
      o.interfaces = [...(o.interfaces ?? []).filter((x) => x.name !== name), { name, area }];
      if (yes(n.passive)) o.passive = [...new Set([...(o.passive ?? []), name])];
      changed();
      return true;
    }
    case 'routing ospf-v3 interface|print':
      out.push('Flags: X - disabled, I - inactive, D - dynamic, P - passive ', ' #    INTERFACE     AREA');
      (cfg.ospf6?.interfaces ?? []).forEach((x, i) => out.push(` ${String(i).padEnd(2)} ${cfg.ospf6.passive?.includes(x.name) ? 'P' : ' '}  ${x.name.padEnd(13)} ${areaName(cfg.ospf6, x.area)}`));
      return out.push(''), true;
    case 'routing ospf-v3 interface|remove': {
      const k = index(p);
      if (!cfg.ospf6?.interfaces?.[k]) return fail('no such item');
      cfg.ospf6.interfaces.splice(k, 1);
      changed();
      return true;
    }
    case 'routing ospf neighbor|print':
    case 'routing ospf-v3 neighbor|print': {
      const v3 = where.includes('v3');
      const r = computeRouting(doc).routers.get(dev.id);
      ((v3 ? r?.ospf6 : r?.ospf)?.neighbors ?? []).forEach((x, i) => {
        const peer = v3 ? x.peer.ospf6 : x.peer.ospf;
        out.push(` ${i} instance=default router-id=${peer.routerId} address=${v3 ? x.peerIface.linkLocal : x.peerIface.ip} interface=${x.iface?.name ?? ''} state="Full" state-changes=6`);
      });
      for (const iss of r?.issues ?? []) if (/OSPF/.test(iss.text)) out.push(`NetCanvas : ${iss.text}`);
      return out.push(''), true;
    }

    // --- RIP ------------------------------------------------------------------
    case 'routing rip|set': {
      const r = (cfg.rip ??= { version: 2, interfaces: [] });
      if (n['distribute-default']) {
        if (n['distribute-default'] === 'always') r.defaultOriginate = true;
        else delete r.defaultOriginate;
      }
      if (n['redistribute-static'] !== undefined) {
        if (yes(n['redistribute-static'])) r.redistribute = { ...r.redistribute, static: true };
        else delete r.redistribute;
      }
      changed();
      return true;
    }
    case 'routing rip|print':
      out.push(`  distribute-default: ${cfg.rip?.defaultOriginate ? 'always' : 'never'}`, `  redistribute-static: ${cfg.rip?.redistribute?.static ? 'yes' : 'no'}`);
      return out.push(''), true;
    // « network add » : RIP sur les interfaces de ce réseau
    case 'routing rip network|add': {
      const s = splitCidr(n.network ?? '');
      if (!s) return fail('invalid value for argument network');
      const r = (cfg.rip ??= { version: 2, interfaces: [] });
      const names = (cfg.interfaces ?? []).filter((e) => isValidIp(e.ip) && isValidCidr(e.mask) && networkOf(e.ip, s.cidr) === networkOf(s.ip, s.cidr)).map((e) => e.name);
      r.interfaces = [...new Set([...(r.interfaces ?? []), ...names])];
      (r.ros6Networks ??= []).push(`${formatIp(networkOf(s.ip, s.cidr))}/${s.cidr}`);
      if (!names.length) out.push(`NetCanvas : aucune interface adressée dans ${n.network} pour l'instant.`, '');
      changed();
      return true;
    }
    case 'routing rip network|print':
      out.push('Flags: X - disabled ', ' #   NETWORK');
      ripNetworks(cfg).forEach((x, i) => out.push(` ${String(i).padEnd(3)} ${x}`));
      return out.push(''), true;
    case 'routing rip network|remove': {
      const net = ripNetworks(cfg)[index(p)];
      if (!net) return fail('no such item');
      const s = splitCidr(net);
      cfg.rip.interfaces = cfg.rip.interfaces.filter((name) => subnetOf(cfg, name) !== `${formatIp(networkOf(s.ip, s.cidr))}/${s.cidr}`);
      cfg.rip.ros6Networks = (cfg.rip.ros6Networks ?? []).filter((x) => x !== net);
      changed();
      return true;
    }
    case 'routing rip interface|add': {
      if (!n.interface) return fail('failure: interface is required');
      const r = (cfg.rip ??= { version: 2, interfaces: [] });
      if (yes(n.passive)) r.passive = [...new Set([...(r.passive ?? []), n.interface])];
      changed();
      return true;
    }
    case 'routing rip interface|print':
      out.push('Flags: X - disabled, I - inactive, P - passive ');
      (cfg.rip?.passive ?? []).forEach((x, i) => out.push(` ${i} P  interface=${x}`));
      return out.push(''), true;
    case 'routing rip interface|remove': {
      const name = cfg.rip?.passive?.[index(p)];
      if (!name) return fail('no such item');
      cfg.rip.passive = cfg.rip.passive.filter((x) => x !== name);
      changed();
      return true;
    }
    case 'routing rip neighbor|print': {
      const r = computeRouting(doc).routers.get(dev.id);
      const seen = new Map();
      for (const e of r?.rip.table.values() ?? []) if (e.via) seen.set(e.via.nextHop, e.via.iface);
      [...seen].forEach(([addr], i) => out.push(` ${i} address=${addr} routes=1 packets-total=12 bad-packets=0 bad-routes=0`));
      return out.push(''), true;
    }

    // --- BGP ------------------------------------------------------------------
    case 'routing bgp instance|set': {
      if (n.as !== undefined && !(Number(n.as) > 0)) return fail('invalid value for argument as');
      const b = (cfg.bgp ??= { asn: Number(n.as) || 65530, neighbors: [], networks: [] });
      if (n.as) b.asn = Number(n.as);
      if (n['router-id']) {
        if (!isValidIp(n['router-id'])) return fail('invalid value for argument router-id');
        b.routerId = n['router-id'];
      }
      changed();
      return true;
    }
    case 'routing bgp instance|print':
      out.push('Flags: * - default, X - disabled ', ` 0 * name="default" as=${cfg.bgp?.asn ?? 65530} router-id=${cfg.bgp?.routerId ?? '0.0.0.0'}`);
      return out.push(''), true;
    case 'routing bgp peer|add': {
      const remote = n['remote-address'];
      const remoteAs = Number(n['remote-as']);
      if (!isValidIp(remote ?? '')) return fail('invalid value for argument remote-address');
      if (!remoteAs) return fail('failure: remote-as is required');
      const b = (cfg.bgp ??= { asn: 65530, neighbors: [], networks: [] });
      const neighbor = { ip: remote, remoteAs, name: n.name ?? `peer${(b.neighbors?.length ?? 0) + 1}` };
      if (n['nexthop-choice'] === 'force-self') neighbor.nextHopSelf = true;
      if (yes(n.multihop)) neighbor.ebgpMultihop = 255;
      if (n['update-source']) neighbor.updateSource = n['update-source'];
      b.neighbors = [...(b.neighbors ?? []).filter((x) => x.ip !== remote), neighbor];
      changed();
      return true;
    }
    case 'routing bgp peer|print': {
      const r = computeRouting(doc).routers.get(dev.id);
      out.push('Flags: X - disabled, E - established ', ' #   INSTANCE        REMOTE-ADDRESS          REMOTE-AS');
      (cfg.bgp?.neighbors ?? []).forEach((x, i) => {
        const up = r?.bgp.sessions?.find((s) => s.neighbor === x.ip)?.state === 'Established';
        out.push(` ${String(i).padEnd(2)}${up ? 'E' : ' '} default         ${x.ip.padEnd(23)} ${x.remoteAs}`);
      });
      return out.push(''), true;
    }
    case 'routing bgp peer|remove': {
      const k = index(p);
      if (!cfg.bgp?.neighbors?.[k]) return fail('no such item');
      cfg.bgp.neighbors.splice(k, 1);
      changed();
      return true;
    }
    case 'routing bgp network|add': {
      const s = splitCidr(n.network ?? '');
      if (!s) return fail('invalid value for argument network');
      const b = (cfg.bgp ??= { asn: 65530, neighbors: [], networks: [] });
      const network = formatIp(networkOf(s.ip, s.cidr));
      b.networks = [...(b.networks ?? []).filter((x) => !(x.network === network && Number(x.mask) === s.cidr)), { network, mask: s.cidr }];
      changed();
      return true;
    }
    case 'routing bgp network|print':
      out.push('Flags: X - disabled ', ' #   NETWORK              SYNCHRONIZE');
      (cfg.bgp?.networks ?? []).forEach((x, i) => out.push(` ${String(i).padEnd(3)} ${`${x.network}/${x.mask}`.padEnd(20)} no`));
      return out.push(''), true;
    case 'routing bgp network|remove': {
      const k = index(p);
      if (!cfg.bgp?.networks?.[k]) return fail('no such item');
      cfg.bgp.networks.splice(k, 1);
      changed();
      return true;
    }
    default:
      return false;
  }
}

// Réseaux RIP affichés : ceux tapés, sinon le sous-réseau de chaque interface RIP (config venue d'un formulaire ou d'un Cisco)
function ripNetworks(cfg) {
  const r = cfg.rip;
  if (!r) return [];
  const typed = r.ros6Networks ?? [];
  const covered = (name) => typed.some((net) => {
    const s = splitCidr(net);
    const e = (cfg.interfaces ?? []).find((i) => i.name === name);
    return e && isValidIp(e.ip) && networkOf(e.ip, s.cidr) === networkOf(s.ip, s.cidr);
  });
  return [...typed, ...new Set((r.interfaces ?? []).filter((name) => !covered(name)).map((name) => subnetOf(cfg, name)).filter(Boolean))];
}

// « /export » v6 du routage dynamique
export function routingScriptV6(dev) {
  const cfg = dev.config ?? {};
  const out = [];
  const o = cfg.ospf;
  if (o) {
    const extra = [
      o.routerId ? `router-id=${o.routerId}` : null,
      o.defaultOriginate ? `distribute-default=${distribute(o.defaultOriginate)}` : null,
      o.redistribute?.connected ? 'redistribute-connected=as-type-1' : null,
      o.redistribute?.static ? 'redistribute-static=as-type-1' : null,
    ].filter(Boolean).join(' ');
    if (extra) out.push('/routing ospf instance', `set [ find default=yes ] ${extra}`);
    const areas = [...new Set([...(o.networks ?? []), ...(o.interfaces ?? [])].map((x) => Number(x.area)))].filter((a) => a !== 0);
    if (areas.length) out.push('/routing ospf area', ...areas.map((a) => `add area-id=${areaId(a)} name=${areaName(o, a)}`));
    const costs = (cfg.interfaces ?? []).filter((e) => e.ospfCost);
    const params = [...new Set([...(o.passive ?? []), ...costs.map((e) => e.name)])];
    if (params.length) {
      out.push('/routing ospf interface', ...params.map((name) => {
        const cost = costs.find((e) => e.name === name)?.ospfCost;
        return `add interface=${name}${cost ? ` cost=${cost}` : ''}${o.passive?.includes(name) ? ' passive=yes' : ''}`;
      }));
    }
    // Interfaces OSPF de la v7 / des formulaires : leur sous-réseau
    const nets = [
      ...(o.networks ?? []).map((x) => [`${x.network}/${wildcardToCidr(x.wildcard)}`, x.area]),
      ...(o.interfaces ?? []).map((x) => [subnetOf(cfg, x.name), x.area]).filter(([net]) => net),
    ];
    if (nets.length) out.push('/routing ospf network', ...nets.map(([net, a]) => `add area=${areaName(o, a)} network=${net}`));
  }
  const o6 = cfg.ospf6;
  if (o6) {
    const extra = [o6.routerId ? `router-id=${o6.routerId}` : null, o6.defaultOriginate ? `distribute-default=${distribute(o6.defaultOriginate)}` : null].filter(Boolean).join(' ');
    if (extra) out.push('/routing ospf-v3 instance', `set [ find default=yes ] ${extra}`);
    const areas = [...new Set((o6.interfaces ?? []).map((x) => Number(x.area)))].filter((a) => a !== 0);
    if (areas.length) out.push('/routing ospf-v3 area', ...areas.map((a) => `add area-id=${areaId(a)} name=${areaName(o6, a)}`));
    if (o6.interfaces?.length) out.push('/routing ospf-v3 interface', ...o6.interfaces.map((x) => `add area=${areaName(o6, x.area)} interface=${x.name}${o6.passive?.includes(x.name) ? ' passive=yes' : ''}`));
  }
  const r = cfg.rip;
  if (r) {
    const extra = [r.defaultOriginate ? 'distribute-default=always' : null, r.redistribute?.static ? 'redistribute-static=yes' : null].filter(Boolean).join(' ');
    if (extra) out.push('/routing rip', `set ${extra}`);
    if (r.passive?.length) out.push('/routing rip interface', ...r.passive.map((name) => `add interface=${name} passive=yes`));
    const nets = ripNetworks(cfg);
    if (nets.length) out.push('/routing rip network', ...nets.map((x) => `add network=${x}`));
  }
  const b = cfg.bgp;
  if (b?.asn) {
    out.push('/routing bgp instance', `set default as=${b.asn}${b.routerId ? ` router-id=${b.routerId}` : ''}`);
    if (b.networks?.length) out.push('/routing bgp network', ...b.networks.map((x) => `add network=${x.network}/${x.mask} synchronize=no`));
    if (b.neighbors?.length) {
      out.push('/routing bgp peer', ...b.neighbors.map((x) => [
        `add name=${x.name ?? `peer-${x.ip}`} remote-address=${x.ip} remote-as=${x.remoteAs}`,
        x.nextHopSelf ? 'nexthop-choice=force-self' : null,
        x.ebgpMultihop ? 'multihop=yes' : null,
        x.updateSource ? `update-source=${x.updateSource}` : null,
      ].filter(Boolean).join(' ')));
    }
  }
  return out;
}
