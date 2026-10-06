// Import d'une config d'une autre marque : « show run » Cisco dans un MikroTik ou un FRR, « /export » RouterOS
// dans un Cisco, etc. La config est d'abord lue par le terminal de sa marque d'origine (mêmes contrôles), sur un
// équipement « fantôme » ; comme toutes les marques partagent le même modèle de config (interfaces, routes, ospf,
// ospf6, rip, bgp…), il reste à renommer les interfaces et à écarter ce qui n'existe pas chez la cible.
import { importConfig, configInterfaces, fitModel } from './import.js';
import { linkOf } from './device.js';
import { MODELS, devicePorts, isDataMedia, isFrr, isMikrotik, modelId, modelOf } from '../net/catalog.js';
import { formatIp, isValidCidr, isValidIp, networkOf } from '../net/ip.js';
import { isLoopbackName, v6Forwarding } from '../net/topology.js';
import { cidrToWildcard } from '../net/routing.js';

export const DIALECTS = {
  ios: 'Cisco IOS', frr: 'FRR (vtysh)', routeros7: 'RouterOS v7', routeros6: 'RouterOS v6',
};
const FAMILY = { ios: 'cisco', frr: 'frr', routeros7: 'mikrotik', routeros6: 'mikrotik' };

// Marque d'une config collée (null : impossible à dire)
export function detectDialect(text) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('!'));
  if (!lines.length) return null;
  if (lines.some((l) => /^\/(ip|interface|routing|system|ipv6)\b/.test(l)) || /^# .*by RouterOS/m.test(text)) {
    return /^\/routing (ospf (network|interface(?!-))\b|bgp (peer|instance)\b|rip network\b|ospf-v3\b)/m.test(text) ? 'routeros6' : 'routeros7';
  }
  if (/^frr (version|defaults)/m.test(text)) return 'frr';
  if (/^\s*ip address \d+\.\d+\.\d+\.\d+\/\d+/m.test(text) || /^router ospf\s*$/m.test(text) || /^interface (eth\d+|lo)\s*$/m.test(text)) return 'frr';
  if (/^(interface|hostname|router|ip route|ipv6 route|line|version)\b/m.test(text)) return 'ios';
  return null;
}

export function dialectOf(dev) {
  if (isMikrotik(dev)) return modelOf(dev).ros === 6 ? 'routeros6' : 'routeros7';
  if (isFrr(dev)) return 'frr';
  return 'ios';
}

// Interfaces nommées par une config RouterOS / FRR (pour choisir le modèle fantôme)
const etherNames = (text, re) => [...new Set([...text.matchAll(re)].map((m) => m[1]))];

// Modèle capable de lire la config d'origine avec toutes ses interfaces
function sourceModel(dialect, text) {
  if (dialect === 'routeros6') return 'CHR-6.49';
  if (dialect === 'routeros7') {
    const n = Math.max(0, ...etherNames(text, /\bether(\d+)\b/g).map(Number));
    return n > 8 ? 'CCR2004' : 'CHR';
  }
  if (dialect === 'frr') return 'FRR';
  const names = configInterfaces(text);
  const cisco = Object.keys(MODELS).filter((id) => MODELS[id].type === 'router' && !MODELS[id].vendor);
  for (const id of cisco) {
    const modules = fitModel(id, names);
    if (modules) return { model: id, modules };
  }
  // Pas de modèle exact : le premier qui a toutes ces interfaces (modules compris), sinon le routeur générique
  for (const id of cisco) {
    const modules = fitModel(id, names, { exact: false });
    if (modules) return { model: id, modules };
  }
  return 'Router-PT';
}

// Lecture de la config par le terminal de sa marque, sur un routeur fantôme vierge
export function readForeign(text, dialect) {
  const src = sourceModel(dialect, text);
  const { model, modules } = typeof src === 'string' ? { model: src, modules: {} } : src;
  const ghost = { id: '__source__', type: 'router', model, modules, label: 'R', config: { interfaces: [], routes: [] } };
  const r = importConfig(ghost, { devices: [ghost], links: [] }, text);
  return { ...r, model };
}

// Interfaces physiques configurées de la source (dans l'ordre des ports), et loopbacks
const used = (e) => e && (isValidIp(e.ip) || e.ipv6 || e.description || e.shutdown || e.ospfCost);
export function sourceInterfaces(src) {
  const order = devicePorts(modelId(src), src.modules).filter((p) => isDataMedia(p.media)).map((p) => p.name);
  const entries = src.config?.interfaces ?? [];
  const named = new Set([
    ...entries.filter((e) => !e.parent && !isLoopbackName(e.name) && (used(e) || entries.some((s) => s.parent === e.name))).map((e) => e.name),
    // Interfaces citées par le routage sans adresse (passive, ospf par interface…)
    ...[src.config?.ospf, src.config?.ospf6, src.config?.rip].flatMap((o) => [...(o?.interfaces ?? []).map((x) => x.name ?? x), ...(o?.passive ?? [])]),
  ].filter((n) => order.includes(n)));
  return order.filter((n) => named.has(n)).map((name) => ({ name, media: name.startsWith('Se') ? 'serial' : 'copper' }));
}

// Correspondance par défaut : ports câblés de la cible d'abord, même média, dans l'ordre
export function defaultMapping(src, target, doc) {
  const ports = devicePorts(modelId(target), target.modules).filter((p) => isDataMedia(p.media));
  const cabled = ports.filter((p) => linkOf(doc, target.id, p.name));
  const free = [...cabled, ...ports.filter((p) => !cabled.includes(p))];
  const mapping = {};
  for (const i of sourceInterfaces(src)) {
    const k = free.findIndex((p) => (p.media === 'serial') === (i.media === 'serial') || (i.media === 'serial' && !ports.some((x) => x.media === 'serial')));
    mapping[i.name] = k >= 0 ? free.splice(k, 1)[0].name : '';
  }
  return mapping;
}

// Loopbacks : Lo0, Lo1… chez Cisco ; une seule « lo » chez MikroTik et FRR
function loopbackName(name, family, warnings) {
  if (family === 'cisco') return name === 'lo' ? 'Lo0' : name;
  if (name === 'lo' || name === 'Lo0') return 'lo';
  warnings.push(`${name} ignorée : ${family === 'frr' ? 'FRR' : 'RouterOS'} n'a qu'une loopback (lo).`);
  return null;
}

// Traduit la config lue (src) pour la cible ; mapping : { interface d'origine: port de la cible ('' = ignorée) }
export function translateConfig(src, target, doc, mapping, { replace = true } = {}) {
  const from = FAMILY[dialectOf(src)];
  const to = FAMILY[dialectOf(target)];
  const c = structuredClone(src.config ?? {});
  const warnings = [];
  const label = (k) => ({ cisco: 'Cisco', mikrotik: 'MikroTik', frr: 'FRR' })[k];

  // Nouveau nom d'une interface (null : écartée)
  const rename = new Map();
  for (const e of c.interfaces ?? []) {
    if (isLoopbackName(e.name)) rename.set(e.name, loopbackName(e.name, to, warnings));
    else if (!e.parent) rename.set(e.name, mapping[e.name] || null);
  }
  for (const [n, to2] of Object.entries(mapping)) if (!rename.has(n)) rename.set(n, to2 || null);
  // Sous-interfaces 802.1Q : G0/0.10 (Cisco) <-> vlan10 (MikroTik) ; FRR : non gérées
  for (const e of (c.interfaces ?? []).filter((x) => x.parent)) {
    const parent = rename.get(e.parent);
    if (!parent) rename.set(e.name, null);
    else if (to === 'frr') {
      rename.set(e.name, null);
      warnings.push(`Sous-interface ${e.name} (VLAN ${e.vlan}) ignorée : à créer sous Linux, pas dans vtysh.`);
    } else rename.set(e.name, to === 'mikrotik' ? `vlan${e.vlan}` : `${parent}.${e.vlan}`);
  }
  const ren = (n) => (n === undefined || n === null ? n : rename.has(n) ? rename.get(n) : n);
  const renList = (list) => (list ?? []).map(ren).filter(Boolean);

  // Interfaces : champs communs à toutes les marques
  const KEEP = ['ip', 'mask', 'ipv6', 'prefix6', 'eui64', 'description', 'shutdown', 'ospfCost'];
  const CISCO_ONLY = { aclIn: 'ACL', aclOut: 'ACL', aclIn6: 'ACL IPv6', aclOut6: 'ACL IPv6', natInside: 'NAT', natOutside: 'NAT', helperAddress: 'relais DHCP', bandwidth: 'bande passante EIGRP', delay: 'délai EIGRP' };
  const interfaces = [];
  for (const e of c.interfaces ?? []) {
    const name = ren(e.name);
    if (!name) {
      if (used(e)) warnings.push(`${e.name}${isValidIp(e.ip) ? ` (${e.ip}/${e.mask})` : ''} ignorée : aucun port choisi sur ${target.label}.`);
      continue;
    }
    const out = { link: e.parent || isLoopbackName(name) ? null : linkOf(doc, target.id, name), name };
    if (e.name.startsWith('Se') && !name.startsWith('Se')) warnings.push(`${e.name} (liaison série) reportée sur ${name} : remplace le câble série par un câble Ethernet.`);
    for (const k of KEEP) if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
    if (out.ip === undefined) Object.assign(out, { ip: null, mask: null });
    if (e.parent) Object.assign(out, { parent: ren(e.parent), vlan: e.vlan, ...(e.native ? { native: true } : {}) });
    if (e.clockRate && name.startsWith('Se')) out.clockRate = e.clockRate;
    if (from === to) Object.assign(out, Object.fromEntries(Object.entries(e).filter(([k]) => k in CISCO_ONLY)));
    else for (const k of Object.keys(CISCO_ONLY)) if (e[k]) warnings.push(`${e.name} : ${CISCO_ONLY[k]} non repris (propre à ${label(from)}).`);
    if (from !== to && (e.dhcp6Server || e.dhcp6Relay || e.ndManaged || e.ndOther)) warnings.push(`${e.name} : DHCPv6 / options RA non reprises (syntaxe propre à ${label(from)}).`);
    interfaces.push(out);
  }

  // Ordre de la cible : ports physiques, sous-interfaces / VLAN, loopbacks
  const portOrder = devicePorts(modelId(target), target.modules).map((p) => p.name);
  const rank = (e) => (isLoopbackName(e.name) ? 2e6 : e.parent ? 1e6 + portOrder.indexOf(e.parent) * 5000 + Number(e.vlan ?? 0) : portOrder.indexOf(e.name));
  interfaces.sort((x, y) => rank(x) - rank(y));

  const cfg = { interfaces, routes: (c.routes ?? []).map((r) => ({ network: r.network, mask: r.mask, nextHop: r.nextHop })) };
  if (c.routes6?.length) cfg.routes6 = c.routes6.map((r) => ({ ...r, ...(r.iface ? { iface: ren(r.iface) } : {}) })).filter((r) => r.iface !== null);

  // IPv6 : « ipv6 unicast-routing » / « ipv6 forwarding » <-> /ipv6 settings forward
  const hasV6 = interfaces.some((e) => e.ipv6) || cfg.routes6?.length || c.ospf6;
  if (hasV6) {
    const fwd = v6Forwarding(src);
    if (to === 'mikrotik') { if (!fwd) cfg.ipv6NoForward = true; } else if (fwd) cfg.ipv6Routing = true;
  }

  // Interfaces couvertes par un réseau (pour RIP chez MikroTik, qui active RIP par interface)
  const ifacesIn = (net, mask) => interfaces.filter((e) => isValidIp(e.ip) && isValidCidr(e.mask) && e.mask >= mask && networkOf(e.ip, mask) === networkOf(net, mask)).map((e) => e.name);
  const classful = (ip) => {
    const first = Number(ip.split('.')[0]);
    const mask = first < 128 ? 8 : first < 192 ? 16 : 24;
    return { net: formatIp(networkOf(ip, mask)), mask };
  };

  if (c.ospf) {
    const o = c.ospf;
    const ospf = { processId: o.processId ?? 1, networks: [...(o.networks ?? [])] };
    for (const k of ['routerId', 'defaultOriginate', 'redistribute']) if (o[k] !== undefined) ospf[k] = o[k];
    const byIface = (o.interfaces ?? []).map((x) => ({ name: ren(x.name), area: x.area })).filter((x) => x.name);
    // FRR refuse de mélanger « network » et « ip ospf area » : tout passe en network
    if (to === 'frr' && byIface.length && ospf.networks.length) {
      for (const x of byIface) {
        const e = interfaces.find((i) => i.name === x.name);
        const network = e && isValidIp(e.ip) ? formatIp(networkOf(e.ip, e.mask)) : null;
        if (network && !ospf.networks.some((n) => n.network === network && n.wildcard === cidrToWildcard(e.mask))) {
          ospf.networks.push({ network, wildcard: cidrToWildcard(e.mask), area: x.area });
        }
      }
    } else if (byIface.length) ospf.interfaces = byIface;
    if (o.passive?.length) ospf.passive = renList(o.passive);
    // Noms de zones RouterOS : « backbone-v2 » (v7) n'existe pas en v6, et inversement
    if (dialectOf(src) === dialectOf(target) && o.areaNames) ospf.areaNames = o.areaNames;
    cfg.ospf = ospf;
  }
  if (c.ospf6) {
    const o = c.ospf6;
    cfg.ospf6 = { processId: o.processId ?? 1, interfaces: (o.interfaces ?? []).map((x) => ({ name: ren(x.name), area: x.area })).filter((x) => x.name) };
    for (const k of ['routerId', 'defaultOriginate', 'redistribute']) if (o[k] !== undefined) cfg.ospf6[k] = o[k];
    if (o.passive?.length) cfg.ospf6.passive = renList(o.passive);
  }
  if (c.rip) {
    const r = c.rip;
    const rip = { version: 2 };
    if (to === 'frr') rip.versionDefault = true; // ripd envoie du v2 sans « version 2 »
    let names = renList(r.interfaces);
    const nets = (r.networks ?? []).filter(isValidIp);
    const prefixes = r.prefixes ?? [];
    if (to === 'mikrotik') {
      // RouterOS active RIP par interface : réseaux et préfixes -> interfaces couvertes
      for (const n of nets) names.push(...ifacesIn(classful(n).net, classful(n).mask));
      for (const p of prefixes) names.push(...ifacesIn(p.network, p.mask));
    } else if (to === 'cisco') {
      // IOS : « network » par classe ; interfaces et préfixes -> réseau de leur classe
      const cl = [...nets, ...prefixes.map((p) => p.network), ...names.map((n) => interfaces.find((e) => e.name === n)?.ip).filter(isValidIp)].map((ip) => classful(ip).net);
      rip.networks = [...new Set(cl)];
      names = [];
    } else {
      if (nets.length) rip.networks = nets;
      if (prefixes.length) rip.prefixes = prefixes;
    }
    if (names.length) rip.interfaces = [...new Set(names)];
    else if (to !== 'cisco') rip.interfaces = [];
    if (r.passive?.length) rip.passive = renList(r.passive);
    if (r.defaultOriginate) rip.defaultOriginate = r.defaultOriginate;
    if (r.redistribute) rip.redistribute = r.redistribute;
    cfg.rip = rip;
  }
  if (c.bgp?.asn) {
    const b = c.bgp;
    cfg.bgp = {
      asn: b.asn,
      ...(b.routerId ? { routerId: b.routerId } : {}),
      neighbors: (b.neighbors ?? []).map((n) => {
        const x = { ip: n.ip, remoteAs: n.remoteAs };
        if (n.nextHopSelf) x.nextHopSelf = true;
        if (n.ebgpMultihop) x.ebgpMultihop = n.ebgpMultihop;
        if (n.updateSource) {
          const s = ren(n.updateSource);
          if (s) x.updateSource = s;
          else warnings.push(`BGP ${n.ip} : update-source ${n.updateSource} retiré (interface non reprise).`);
        }
        if (to === 'mikrotik' && n.name) x.name = n.name;
        return x;
      }),
      networks: (b.networks ?? []).map((x) => ({ network: x.network, mask: x.mask })),
    };
  }
  if (c.eigrp) {
    if (to === 'cisco') cfg.eigrp = { ...c.eigrp, ...(c.eigrp.passive ? { passive: renList(c.eigrp.passive) } : {}) };
    else warnings.push(`EIGRP (AS ${c.eigrp.asn}) non repris : protocole Cisco, ${to === 'frr' ? 'non simulé sur FRR' : 'absent de RouterOS'}. Utilise OSPF.`);
  }
  // Nom de domaine et serveurs DNS : Cisco et MikroTik ; FRR n'en a pas
  for (const k of ['hosts', 'nameServer', 'dnsServer']) {
    if (!c[k] || (Array.isArray(c[k]) && !c[k].length)) continue;
    if (to === 'frr') warnings.push(`DNS (${k === 'hosts' ? 'noms statiques' : k === 'nameServer' ? 'serveur DNS' : 'serveur DNS local'}) non repris : à régler sous Linux, pas dans vtysh.`);
    else cfg[k] = c[k];
  }
  // Propre à une marque : repris seulement entre équipements de la même marque
  const SPECIFIC = {
    acls: 'ACL', acls6: 'ACL IPv6', nat: 'NAT', dhcp: 'serveur DHCP', dhcp6Pools: 'pools DHCPv6',
    firewall: 'pare-feu', firewall6: 'pare-feu IPv6', natRules: 'NAT', addressLists: 'listes d\'adresses',
  };
  for (const [k, what] of Object.entries(SPECIFIC)) {
    const v = c[k];
    const empty = !v || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
    if (empty) continue;
    if (from === to) cfg[k] = v;
    else warnings.push(`${what} non repris : la syntaxe ${label(from)} n'a pas d'équivalent direct chez ${label(to)}, à refaire à la main.`);
  }

  const base = replace ? {} : structuredClone(target.config ?? {});
  const merged = { ...base, ...cfg };
  if (!replace) {
    // Ajout : les interfaces existantes gardent ce que la config collée ne touche pas
    const byName = new Map((base.interfaces ?? []).map((e) => [e.name, e]));
    for (const e of interfaces) byName.set(e.name, { ...byName.get(e.name), ...e });
    merged.interfaces = [...byName.values()];
    merged.routes = [...(base.routes ?? []), ...cfg.routes];
  }
  return { device: { ...target, label: src.label === 'R' ? target.label : src.label, config: merged }, warnings };
}

// Résumé de ce qui a été repris
export function translatedSummary(cfg) {
  const parts = [];
  const ifs = (cfg.interfaces ?? []).filter((e) => isValidIp(e.ip) || e.ipv6).length;
  if (ifs) parts.push(`${ifs} interface${ifs > 1 ? 's' : ''}`);
  const routes = (cfg.routes?.length ?? 0) + (cfg.routes6?.length ?? 0);
  if (routes) parts.push(`${routes} route${routes > 1 ? 's' : ''} statique${routes > 1 ? 's' : ''}`);
  if (cfg.ospf) parts.push('OSPF');
  if (cfg.ospf6) parts.push('OSPFv3');
  if (cfg.rip) parts.push('RIP');
  if (cfg.eigrp) parts.push('EIGRP');
  if (cfg.bgp?.asn) {
    const ibgp = cfg.bgp.neighbors.filter((n) => Number(n.remoteAs) === Number(cfg.bgp.asn)).length;
    const ebgp = cfg.bgp.neighbors.length - ibgp;
    parts.push(`BGP AS ${cfg.bgp.asn}${ebgp || ibgp ? ` (${[ebgp && `${ebgp} eBGP`, ibgp && `${ibgp} iBGP`].filter(Boolean).join(', ')})` : ''}`);
  }
  return parts;
}
