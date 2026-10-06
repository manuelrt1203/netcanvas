// Plan de contrôle : table de routage de chaque routeur, à l'état convergé.
//
//  - connecté (C/L) et statique (S) ;
//  - OSPF : voisins découverts sur le domaine de diffusion, SPF (Dijkstra) par zone, routes inter-zones
//    seulement à travers la zone 0, externes E2 (redistribute, default-information originate) ;
//  - RIP : Bellman-Ford, split horizon, 15 sauts maximum ;
//  - BGP : sessions vérifiées (adresses, AS, update-source, ebgp-multihop, joignabilité par un vrai ping),
//    propagation avec AS_PATH, pas de relais iBGP -> iBGP, next-hop conservé en iBGP (sauf next-hop-self).
// La sélection finale se fait par distance administrative, comme sur IOS.
//
// Chaque refus (adjacence absente, session down, route non annoncée) est expliqué dans `issues`.
import { buildRib6, connectedAndStatic6 } from './routing6.js';
import { networkOf6 } from './ip6.js';
import { buildTopology, isRouting, v6Forwarding } from './topology.js';
import { flood } from './l2.js';
import { formatIp, isValidCidr, isValidIp, maskBits, networkOf, parseIp, sameSubnet } from './ip.js';
import { isMikrotik } from './catalog.js';
import { simulatePing } from './simulate.js';

export const AD = { C: 0, L: 0, S: 1, eBGP: 20, D: 90, O: 110, R: 120, DEX: 170, iBGP: 200 };
const RIP_INFINITY = 16;

const prefixKey = (net, mask) => `${net}/${mask}`;
export const prefixText = (net, mask) => `${formatIp(net)}/${mask}`;
const ipNum = (ip) => parseIp(ip) ?? 0;
const byIp = (a, b) => ipNum(a) - ipNum(b);

// Wildcard Cisco « 0.0.0.255 » -> CIDR (null si non contigu)
export function wildcardToCidr(wc) {
  const n = parseIp(wc);
  if (n === null) return null;
  for (let c = 0; c <= 32; c++) if (((~maskBits(c)) >>> 0) === n) return c;
  return null;
}
export const cidrToWildcard = (cidr) => formatIp((~maskBits(cidr)) >>> 0);

// Réseau par classe (RIP « network 10.0.0.0 » couvre tout le 10.0.0.0/8)
export function classful(ip) {
  const first = ipNum(ip) >>> 24;
  const mask = first < 128 ? 8 : first < 192 ? 16 : 24;
  return { net: networkOf(ip, mask), mask };
}

// Bande passante par défaut (kbit/s) selon le nom d'interface
function bandwidth(name, entry) {
  if (entry?.bandwidth) return Number(entry.bandwidth);
  if (/^Se/.test(name)) return 1544;
  if (/^Fa/.test(name)) return 100000;
  if (/^Eth\d/.test(name)) return 10000;
  return 1000000;
}

export function ospfCost(dev, iface) {
  if (iface.ospfCost) return Number(iface.ospfCost);
  if (iface.loopback || isMikrotik(dev)) return 1;
  return Math.max(1, Math.floor(100000 / bandwidth(iface.name, iface)));
}

// Router-ID : configuré, sinon plus grande loopback, sinon plus grande adresse active
function routerId(r, configured) {
  if (isValidIp(configured)) return configured;
  const lo = r.ifaces.filter((i) => i.loopback).map((i) => i.ip).sort(byIp).at(-1);
  return lo ?? r.ifaces.map((i) => i.ip).sort(byIp).at(-1) ?? '0.0.0.0';
}

// Plus long préfixe dans une table (Map clé -> route)
export function lookup(rib, ip, filter = () => true) {
  const n = ipNum(ip);
  let best = null;
  for (const r of rib.values()) {
    if (!filter(r) || ((n & maskBits(r.mask)) >>> 0) !== r.net) continue;
    if (!best || r.mask > best.mask) best = r;
  }
  return best;
}

export function computeRouting(doc, topo = buildTopology(doc)) {
  const routers = new Map();
  for (const d of topo.devices.values()) {
    if (!isRouting(d)) continue;
    const ifaces = topo.l3Ifaces(d.id);
    routers.set(d.id, { id: d.id, dev: d, label: d.label, cfg: d.config ?? {}, ifaces, issues: [] });
  }
  const issue = (r, text, level = 'warning') => {
    if (!r.issues.some((i) => i.text === text)) r.issues.push({ device: r.id, level, text });
  };

  // --- Connecté et statique -------------------------------------------------------
  for (const r of routers.values()) {
    r.connected = new Map();
    for (const i of r.ifaces) {
      const net = networkOf(i.ip, i.mask);
      r.connected.set(prefixKey(net, i.mask), { net, mask: i.mask, proto: 'C', ad: 0, metric: 0, nextHop: null, iface: i.name, link: i.link });
      if (i.mask < 32) r.connected.set(prefixKey(ipNum(i.ip), 32), { net: ipNum(i.ip), mask: 32, proto: 'L', ad: 0, metric: 0, nextHop: null, iface: i.name, link: i.link, local: true });
    }
    r.statics = [];
    for (const s of r.cfg.routes ?? []) {
      if (!isValidIp(s.network) || !isValidCidr(s.mask) || !isValidIp(s.nextHop)) continue;
      // Installée seulement si le saut suivant est sur un réseau connecté actif
      const out = r.ifaces.find((i) => !i.loopback && sameSubnet(i.ip, s.nextHop, i.mask));
      if (!out) continue;
      const mask = Number(s.mask);
      const net = networkOf(s.network, mask);
      r.statics.push({ net, mask, proto: mask === 0 ? 'S*' : 'S', ad: 1, metric: 0, nextHop: s.nextHop, iface: out.name, link: out.link });
    }
  }

  // --- Voisins de niveau 3 sur chaque domaine de diffusion -----------------------------
  // r.peers : [{ iface (la mienne), peer (routeur), peerIface }]
  for (const r of routers.values()) {
    r.peers = [];
    for (const i of r.ifaces) {
      if (i.loopback) continue;
      const tag = i.sub && !i.native ? Number(i.vlan) : null;
      const reach = i.svi ? flood(topo, r.id, null, null, i.vlan) : flood(topo, r.id, i.link, tag);
      for (const e of reach.endpoints) {
        const p = routers.get(e.device);
        if (!p) continue;
        const theirs = e.svi != null ? p.ifaces.find((x) => x.svi && x.vlan === e.svi) : topo.l3IfaceOn(p.id, e.inLink, e.tag);
        const pi = theirs && p.ifaces.find((x) => x.name === theirs.name);
        if (pi) r.peers.push({ iface: i, peer: p, peerIface: pi, p2p: topo.links.get(i.link)?.cable === 'serial' });
      }
    }
  }

  computeOspf(routers, issue);
  computeRip(routers, issue);
  computeEigrp(routers, issue);

  // Table « IGP » : connecté, statique, OSPF, RIP (sert à BGP)
  const pick = (rib, route) => {
    const k = prefixKey(route.net, route.mask);
    const cur = rib.get(k);
    if (!cur || route.ad < cur.ad || (route.ad === cur.ad && route.metric < cur.metric)) rib.set(k, route);
  };
  for (const r of routers.values()) {
    r.rib = new Map();
    for (const route of [...r.connected.values(), ...r.statics, ...r.ospf.routes, ...r.rip.routes, ...r.eigrp.routes]) pick(r.rib, route);
  }

  computeBgp(routers, issue, doc, topo);
  for (const r of routers.values()) for (const route of r.bgp.routes) pick(r.rib, route);

  // IPv6 : connecté, statique, OSPFv3
  for (const r of routers.values()) {
    r.ifaces6 = topo.l3Ifaces6(r.id);
    const { connected, statics } = connectedAndStatic6(r.ifaces6, r.cfg);
    r.connected6 = connected;
    r.statics6 = statics;
  }
  // Voisins IPv6 : routeurs joignables en niveau 2 par une interface où IPv6 est actif (link-local)
  for (const r of routers.values()) {
    r.peers6 = [];
    for (const i of r.ifaces6) {
      if (i.loopback || !i.linkLocal) continue;
      const tag = i.sub && !i.native ? Number(i.vlan) : null;
      const reach = i.svi ? flood(topo, r.id, null, null, i.vlan) : flood(topo, r.id, i.link, tag);
      for (const e of reach.endpoints) {
        const p = routers.get(e.device);
        if (!p) continue;
        const theirs = e.svi != null ? p.ifaces6.find((x) => x.svi && x.vlan === e.svi) : topo.l3IfaceOn6(p.id, e.inLink, e.tag);
        const pi = theirs && p.ifaces6.find((x) => x.name === theirs.name);
        if (pi?.linkLocal) r.peers6.push({ iface: i, peer: p, peerIface: pi, p2p: topo.links.get(i.link)?.cable === 'serial' });
      }
    }
  }
  computeOspf6(routers, issue);
  for (const r of routers.values()) {
    r.rib6 = buildRib6([...r.connected6.values(), ...r.statics6, ...r.ospf6.routes.map(({ mask, ...x }) => ({ ...x, prefix: mask }))]);
  }

  return {
    routers,
    ribs: new Map([...routers].map(([id, r]) => [id, r.rib])),
    ribs6: new Map([...routers].map(([id, r]) => [id, r.rib6])),
    issues: [...routers.values()].flatMap((r) => r.issues),
  };
}

// === OSPF ====================================================================================
function ospfArea(r, iface) {
  const o = r.cfg.ospf;
  if (!o) return null;
  const byName = (o.interfaces ?? []).find((x) => x.name === iface.name);
  if (byName) return Number(byName.area);
  // Commande « network » la plus précise qui couvre l'adresse
  let best = null;
  for (const n of o.networks ?? []) {
    const cidr = wildcardToCidr(n.wildcard);
    if (cidr === null || !isValidIp(n.network)) continue;
    if (networkOf(iface.ip, cidr) === networkOf(n.network, cidr) && (!best || cidr > best.cidr)) best = { cidr, area: Number(n.area) };
  }
  return best ? best.area : null;
}

function computeOspf(routers, issue) {
  for (const r of routers.values()) {
    r.ospf = { enabled: Boolean(r.cfg.ospf), routes: [], neighbors: [], ifaces: [] };
    if (!r.cfg.ospf) continue;
    r.ospf.routerId = routerId(r, r.cfg.ospf.routerId);
    const passive = new Set(r.cfg.ospf.passive ?? []);
    for (const i of r.ifaces) {
      const area = ospfArea(r, i);
      if (area === null) continue;
      r.ospf.ifaces.push({ iface: i, area, cost: ospfCost(r.dev, i), passive: passive.has(i.name) || i.loopback });
    }
    r.ospf.areas = [...new Set(r.ospf.ifaces.map((x) => x.area))];
    if (!r.ospf.ifaces.length) issue(r, `${r.label} : OSPF est activé mais aucune interface n'est couverte par une commande « network ».`);
  }

  // Router-ID en double : les adjacences tombent sur un vrai réseau
  const ids = new Map();
  for (const r of routers.values()) if (r.ospf.enabled) ids.set(r.ospf.routerId, [...(ids.get(r.ospf.routerId) ?? []), r]);
  for (const [rid, list] of ids) if (list.length > 1) for (const r of list) issue(r, `OSPF : router-id ${rid} en double (${list.map((x) => x.label).join(', ')}).`, 'error');

  // Adjacences
  for (const r of routers.values()) {
    if (!r.ospf.enabled) continue;
    for (const { iface, peer, peerIface, p2p } of r.peers) {
      const mine = r.ospf.ifaces.find((x) => x.iface.name === iface.name);
      if (!mine) continue;
      const where = `${r.label} ${iface.name} ↔ ${peer.label} ${peerIface.name}`;
      const fail = (why) => issue(r, `OSPF : pas d'adjacence ${where} : ${why}.`);
      if (!peer.ospf.enabled) { fail(`${peer.label} n'a pas OSPF`); continue; }
      const theirs = peer.ospf.ifaces.find((x) => x.iface.name === peerIface.name);
      if (!theirs) { fail(`${peerIface.name} de ${peer.label} n'est couverte par aucune commande « network »`); continue; }
      if (mine.passive) { fail(`${iface.name} est passive (passive-interface)`); continue; }
      if (theirs.passive) { fail(`${peerIface.name} de ${peer.label} est passive (passive-interface)`); continue; }
      if (!sameSubnet(iface.ip, peerIface.ip, Math.min(iface.mask, peerIface.mask))) { fail('les deux interfaces ne sont pas dans le même réseau'); continue; }
      if (iface.mask !== peerIface.mask) { fail(`masques différents (/${iface.mask} et /${peerIface.mask})`); continue; }
      if (mine.area !== theirs.area) { fail(`zones différentes (${mine.area} et ${theirs.area})`); continue; }
      if (r.ospf.routerId === peer.ospf.routerId) { fail(`même router-id ${r.ospf.routerId}`); continue; }
      r.ospf.neighbors.push({ peer, iface, peerIface, area: mine.area, cost: mine.cost, p2p });
    }
  }

  // DR/BDR sur les réseaux multi-accès : plus grand router-id
  for (const r of routers.values()) {
    for (const n of r.ospf.neighbors) {
      if (n.p2p) continue;
      const members = [r, ...r.ospf.neighbors.filter((x) => x.iface.name === n.iface.name).map((x) => x.peer)]
        .sort((a, b) => byIp(b.ospf.routerId, a.ospf.routerId));
      n.role = members[0] === n.peer ? 'DR' : members[1] === n.peer ? 'BDR' : 'DROTHER';
    }
  }

  // Annonces : réseaux des interfaces OSPF (loopback en /32) et externes
  for (const r of routers.values()) {
    if (!r.ospf.enabled) continue;
    r.ospf.stubs = r.ospf.ifaces.map(({ iface, area, cost }) => {
      const mask = iface.loopback ? 32 : iface.mask;
      return { net: networkOf(iface.ip, mask), mask, area, cost };
    });
    r.ospf.externals = [];
    const o = r.cfg.ospf;
    const hasDefault = r.statics.some((s) => s.mask === 0);
    if (o.defaultOriginate === 'always' || (o.defaultOriginate && hasDefault)) r.ospf.externals.push({ net: 0, mask: 0, metric: 1 });
    else if (o.defaultOriginate) issue(r, `${r.label} : « default-information originate » sans route par défaut : rien n'est annoncé (ajoute « always » ou une route 0.0.0.0/0).`);
    if (o.redistribute?.static) for (const s of r.statics) if (s.mask > 0) r.ospf.externals.push({ net: s.net, mask: s.mask, metric: 20 });
    if (o.redistribute?.connected) {
      for (const c of r.connected.values()) {
        if (c.proto !== 'C' || r.ospf.stubs.some((x) => x.net === c.net && x.mask === c.mask)) continue;
        r.ospf.externals.push({ net: c.net, mask: c.mask, metric: 20 });
      }
    }
  }

  spf(routers, 'ospf', (n) => n.peerIface.ip, (src, x) => src.connected.has(prefixKey(x.net, x.mask)));
}

// === OSPFv3 (IPv6) ===========================================================================
// config.ospf6 = { processId, routerId, interfaces: [{ name, area }], passive: [], defaultOriginate }
// Activé par interface (« ipv6 ospf 1 area 0 ») ; voisins par leurs link-local ; router-id IPv4 (32 bits)
// obligatoire : pris sur les adresses IPv4 si absent, sinon OSPFv3 ne démarre pas (comme IOS).
function computeOspf6(routers, issue) {
  for (const r of routers.values()) {
    const o = r.cfg.ospf6;
    r.ospf6 = { enabled: false, routes: [], neighbors: [], ifaces: [], areas: [], stubs: [], externals: [] };
    if (!o) continue;
    const rid = isValidIp(o.routerId) ? o.routerId : r.ifaces.length ? routerId(r, null) : null;
    if (!rid) {
      issue(r, `${r.label} : OSPFv3 ne démarre pas, aucun router-id (configure « router-id 1.1.1.1 » : il faut un identifiant au format IPv4, même en IPv6).`, 'error');
      continue;
    }
    if (!v6Forwarding(r.dev)) issue(r, `${r.label} : OSPFv3 configuré mais le routage IPv6 n'est pas activé (« ipv6 unicast-routing »).`);
    Object.assign(r.ospf6, { enabled: true, routerId: rid });
    const passive = new Set(o.passive ?? []);
    for (const i of r.ifaces6) {
      const x = (o.interfaces ?? []).find((y) => y.name === i.name);
      if (x) r.ospf6.ifaces.push({ iface: i, area: Number(x.area), cost: ospfCost(r.dev, i), passive: passive.has(i.name) || i.loopback });
    }
    r.ospf6.areas = [...new Set(r.ospf6.ifaces.map((x) => x.area))];
    if (!r.ospf6.ifaces.length) issue(r, `${r.label} : OSPFv3 est configuré mais aucune interface n'a « ipv6 ospf ${o.processId ?? 1} area … ».`);
  }
  const ids = new Map();
  for (const r of routers.values()) if (r.ospf6.enabled) ids.set(r.ospf6.routerId, [...(ids.get(r.ospf6.routerId) ?? []), r]);
  for (const [rid, list] of ids) if (list.length > 1) for (const r of list) issue(r, `OSPFv3 : router-id ${rid} en double (${list.map((x) => x.label).join(', ')}).`, 'error');

  for (const r of routers.values()) {
    if (!r.ospf6.enabled) continue;
    for (const { iface, peer, peerIface, p2p } of r.peers6) {
      const mine = r.ospf6.ifaces.find((x) => x.iface.name === iface.name);
      if (!mine) continue;
      const fail = (why) => issue(r, `OSPFv3 : pas d'adjacence ${r.label} ${iface.name} ↔ ${peer.label} ${peerIface.name} : ${why}.`);
      if (!peer.ospf6.enabled) { fail(`${peer.label} n'a pas OSPFv3`); continue; }
      const theirs = peer.ospf6.ifaces.find((x) => x.iface.name === peerIface.name);
      if (!theirs) { fail(`${peerIface.name} de ${peer.label} n'a pas « ipv6 ospf … area »`); continue; }
      if (mine.passive) { fail(`${iface.name} est passive (passive-interface)`); continue; }
      if (theirs.passive) { fail(`${peerIface.name} de ${peer.label} est passive (passive-interface)`); continue; }
      if (mine.area !== theirs.area) { fail(`zones différentes (${mine.area} et ${theirs.area})`); continue; }
      if (r.ospf6.routerId === peer.ospf6.routerId) { fail(`même router-id ${r.ospf6.routerId}`); continue; }
      r.ospf6.neighbors.push({ peer, iface, peerIface, area: mine.area, cost: mine.cost, p2p });
    }
  }
  for (const r of routers.values()) {
    if (!r.ospf6.enabled) continue;
    // Préfixes annoncés : adresses globales des interfaces OSPFv3 (loopback en /128)
    r.ospf6.stubs = r.ospf6.ifaces.filter(({ iface }) => iface.ip && iface.prefix != null).map(({ iface, area, cost }) => {
      const mask = iface.loopback ? 128 : iface.prefix;
      return { net: networkOf6(iface.ip, mask), mask, area, cost };
    });
    const o = r.cfg.ospf6;
    const hasDefault = r.statics6.some((x) => x.prefix === 0);
    if (o.defaultOriginate === 'always' || (o.defaultOriginate && hasDefault)) r.ospf6.externals.push({ net: 0n, mask: 0, metric: 1 });
    else if (o.defaultOriginate) issue(r, `${r.label} : OSPFv3 « default-information originate » sans route ::/0 : rien n'est annoncé (ajoute « always » ou une route ::/0).`);
  }
  spf(routers, 'ospf6', (n) => n.peerIface.linkLocal, (src, x) => [...src.connected6.values()].some((c) => c.net === x.net && c.prefix === x.mask));
}

// SPF depuis chaque routeur (OSPFv2 : key « ospf », OSPFv3 : « ospf6 »). État = (routeur, zone, passé par une
// autre zone ?). hopOf : adresse du voisin (IPv4, ou link-local en OSPFv3) ; connected : préfixe déjà connecté.
function spf(routers, key, hopOf, connected) {
  const bySortKey = (h) => h?.sortKey ?? '';
  for (const src of routers.values()) {
    if (!src[key].enabled) continue;
    const queue = [];
    for (const area of src[key].areas) queue.push({ r: src, area, inter: false, d: 0, hop: null });
    const done = new Map();
    while (queue.length) {
      queue.sort((a, b) => a.d - b.d || (bySortKey(a.hop) < bySortKey(b.hop) ? -1 : bySortKey(a.hop) > bySortKey(b.hop) ? 1 : 0));
      const cur = queue.shift();
      const k = `${cur.r.id}|${cur.area}|${cur.inter}`;
      if (done.has(k)) continue;
      done.set(k, cur);
      // Changement de zone sur un ABR : seulement vers ou depuis la zone 0
      for (const other of cur.r[key].areas) {
        if (other !== cur.area && (other === 0 || cur.area === 0)) queue.push({ ...cur, area: other, inter: cur.inter || cur.r !== src });
      }
      for (const n of cur.r[key].neighbors) {
        if (n.area !== cur.area) continue;
        const nextHop = hopOf(n);
        const hop = cur.hop ?? { nextHop, iface: n.iface.name, link: n.iface.link, sortKey: key === 'ospf' ? String(ipNum(nextHop)).padStart(10, '0') : nextHop };
        queue.push({ r: n.peer, area: cur.area, inter: cur.inter, d: cur.d + n.cost, hop });
      }
    }

    const best = new Map();
    const offer = (route) => {
      const k = prefixKey(route.net, route.mask);
      const cur = best.get(k);
      const rank = (x) => ({ O: 0, 'O IA': 1, 'O E2': 2, 'O*E2': 2 })[x.proto];
      if (!cur || rank(route) < rank(cur) || (rank(route) === rank(cur) && (route.metric < cur.metric || (route.metric === cur.metric && route.fwd < cur.fwd)))) best.set(k, route);
    };
    for (const st of done.values()) {
      if (st.r === src) continue;
      const { sortKey, ...hop } = st.hop;
      for (const stub of st.r[key].stubs) {
        if (stub.area !== st.area) continue;
        offer({ net: stub.net, mask: stub.mask, proto: st.inter ? 'O IA' : 'O', ad: AD.O, metric: st.d + stub.cost, fwd: st.d, ...hop });
      }
      for (const ext of st.r[key].externals) {
        offer({ net: ext.net, mask: ext.mask, proto: ext.mask === 0 ? 'O*E2' : 'O E2', ad: AD.O, metric: ext.metric, fwd: st.d, ...hop });
      }
    }
    // Les réseaux connectés restent connectés (distance 0)
    src[key].routes = [...best.values()].filter((x) => !connected(src, x));
  }
}

// === RIP =====================================================================================
function computeRip(routers, issue) {
  for (const r of routers.values()) {
    const c = r.cfg.rip;
    r.rip = { enabled: Boolean(c), routes: [], ifaces: [], table: new Map() };
    if (!c) continue;
    r.rip.version = c.version ?? null;
    const nets = (c.networks ?? []).filter(isValidIp).map((n) => classful(n));
    const names = new Set(c.interfaces ?? []);
    const passive = new Set(c.passive ?? []);
    for (const i of r.ifaces) {
      const cl = classful(i.ip);
      if (names.has(i.name) || nets.some((n) => n.net === cl.net && n.mask === cl.mask)) {
        r.rip.ifaces.push({ iface: i, passive: passive.has(i.name) || i.loopback });
      }
    }
    if (!r.rip.ifaces.length) issue(r, `${r.label} : RIP est activé mais aucune interface n'est couverte par une commande « network ».`);
    if (!c.version || Number(c.version) === 1) issue(r, `${r.label} : RIP version 1 n'envoie pas les masques. Ajoute « version 2 » (NetCanvas calcule comme en v2).`);
    for (const { iface } of r.rip.ifaces) {
      const mask = iface.loopback ? 32 : iface.mask;
      const net = networkOf(iface.ip, mask);
      r.rip.table.set(prefixKey(net, mask), { net, mask, metric: 0, via: null });
    }
    if (c.defaultOriginate) r.rip.table.set(prefixKey(0, 0), { net: 0, mask: 0, metric: 0, via: null });
    if (c.redistribute?.static) for (const s of r.statics) r.rip.table.set(prefixKey(s.net, s.mask), { net: s.net, mask: s.mask, metric: 0, via: null });
  }

  // Annonces directionnelles A -> B
  const links = [];
  for (const a of routers.values()) {
    if (!a.rip.enabled) continue;
    for (const { iface, peer, peerIface } of a.peers) {
      const mine = a.rip.ifaces.find((x) => x.iface.name === iface.name);
      if (!mine) continue;
      const where = `${a.label} ${iface.name} → ${peer.label} ${peerIface.name}`;
      if (mine.passive) { issue(a, `RIP : ${where} : rien n'est envoyé, ${iface.name} est passive.`); continue; }
      if (!peer.rip.enabled) { issue(a, `RIP : ${where} : ${peer.label} n'a pas RIP.`); continue; }
      if (!peer.rip.ifaces.some((x) => x.iface.name === peerIface.name)) { issue(a, `RIP : ${where} : ${peerIface.name} de ${peer.label} n'est couverte par aucune commande « network ».`); continue; }
      const sent = Number(a.rip.version ?? 1);
      if (peer.rip.version && Number(peer.rip.version) !== sent) { issue(a, `RIP : ${where} : versions différentes (${sent} et ${peer.rip.version}).`); continue; }
      links.push({ a, b: peer, aIface: iface, bIface: peerIface });
    }
  }

  for (let round = 0; round < 40; round++) {
    let changed = false;
    for (const { a, b, aIface, bIface } of links) {
      for (const [k, e] of a.rip.table) {
        if (e.via?.iface === aIface.name) continue; // split horizon
        const metric = e.metric + 1;
        if (metric >= RIP_INFINITY) continue;
        const cur = b.rip.table.get(k);
        if (cur && cur.metric === 0) continue;
        if (!cur || metric < cur.metric || (metric === cur.metric && byIp(aIface.ip, cur.via.nextHop) < 0)) {
          b.rip.table.set(k, { net: e.net, mask: e.mask, metric, via: { nextHop: aIface.ip, iface: bIface.name, link: bIface.link } });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (const r of routers.values()) {
    r.rip.routes = [...r.rip.table.values()]
      .filter((e) => e.metric > 0 && !r.connected.has(prefixKey(e.net, e.mask)))
      .map((e) => ({ net: e.net, mask: e.mask, proto: e.mask === 0 ? 'R*' : 'R', ad: AD.R, metric: e.metric, ...e.via }));
  }
}

// === EIGRP ===================================================================================
// config.eigrp = { asn, networks: [{ network, wildcard? }] (sans wildcard : réseau par classe), passive: [],
//                  routerId?, redistribute: { static } } ; interface : bandwidth (kbit/s), delay (dizaines de µs).
// Métrique composite par défaut (K1 = K3 = 1) : 256 × (10⁷ / bande passante minimale + somme des délais),
// calculée comme EIGRP le fait : chaque routeur annonce sa meilleure distance, le voisin y ajoute son interface.
// AD 90 (interne, D), 170 (redistribuée, D EX). Une route statique redistribuée prend la métrique de son interface.
const EIGRP_DELAY = { G: 1, Fa: 10, Se: 2000, Lo: 500, Vlan: 1, Eth: 100, ether: 10, sfp: 1, lo: 500 };
export function eigrpBandwidth(iface) {
  if (iface.bandwidth) return Number(iface.bandwidth);
  if (iface.loopback) return 8000000;
  return bandwidth(iface.name, iface);
}
export function eigrpDelay(iface) {
  if (iface.delay) return Number(iface.delay);
  if (iface.loopback) return 500;
  const k = Object.keys(EIGRP_DELAY).find((p) => iface.name.startsWith(p));
  return k ? EIGRP_DELAY[k] : 1;
}
export const eigrpMetric = (bw, delay) => 256 * (Math.floor(1e7 / bw) + delay);

function eigrpCovers(c, ip) {
  return (c.networks ?? []).some((n) => {
    if (!isValidIp(n.network)) return false;
    if (!n.wildcard) {
      const cl = classful(n.network);
      return networkOf(ip, cl.mask) === cl.net;
    }
    const cidr = wildcardToCidr(n.wildcard);
    return cidr !== null && networkOf(ip, cidr) === networkOf(n.network, cidr);
  });
}

function computeEigrp(routers, issue) {
  for (const r of routers.values()) {
    const c = r.cfg.eigrp;
    r.eigrp = { enabled: Boolean(c?.asn), routes: [], ifaces: [], neighbors: [], table: new Map() };
    if (!r.eigrp.enabled) continue;
    if (isMikrotik(r.dev)) {
      r.eigrp.enabled = false;
      issue(r, `${r.label} : EIGRP est un protocole Cisco, RouterOS ne le gère pas.`);
      continue;
    }
    r.eigrp.asn = Number(c.asn);
    r.eigrp.routerId = routerId(r, c.routerId);
    const passive = new Set(c.passive ?? []);
    for (const i of r.ifaces) if (eigrpCovers(c, i.ip)) r.eigrp.ifaces.push({ iface: i, passive: passive.has(i.name) || i.loopback });
    if (!r.eigrp.ifaces.length) issue(r, `${r.label} : EIGRP ${c.asn} est activé mais aucune interface n'est couverte par une commande « network ».`);
    // Ce que le routeur annonce : ses réseaux couverts (même passifs), et les statiques redistribuées
    for (const { iface } of r.eigrp.ifaces) {
      const mask = iface.loopback ? 32 : iface.mask;
      const net = networkOf(iface.ip, mask);
      r.eigrp.table.set(prefixKey(net, mask), { net, mask, bw: eigrpBandwidth(iface), delay: eigrpDelay(iface), external: false, via: null, local: true });
    }
    if (c.redistribute?.static) {
      for (const st of r.statics) {
        const out = r.ifaces.find((i) => i.name === st.iface);
        if (!out) continue;
        r.eigrp.table.set(prefixKey(st.net, st.mask), { net: st.net, mask: st.mask, bw: eigrpBandwidth(out), delay: eigrpDelay(out), external: true, via: null, local: true });
      }
    }
  }

  // Adjacences : même AS, interfaces couvertes et non passives, même réseau
  const links = [];
  for (const a of routers.values()) {
    if (!a.eigrp.enabled) continue;
    for (const { iface, peer, peerIface, p2p } of a.peers) {
      const mine = a.eigrp.ifaces.find((x) => x.iface.name === iface.name);
      if (!mine) continue;
      const fail = (why) => issue(a, `EIGRP : pas de voisin ${a.label} ${iface.name} ↔ ${peer.label} ${peerIface.name} : ${why}.`);
      if (!peer.eigrp?.enabled) { fail(`${peer.label} n'a pas EIGRP`); continue; }
      if (peer.eigrp.asn !== a.eigrp.asn) { fail(`numéros d'AS différents (${a.eigrp.asn} et ${peer.eigrp.asn})`); continue; }
      const theirs = peer.eigrp.ifaces.find((x) => x.iface.name === peerIface.name);
      if (!theirs) { fail(`${peerIface.name} de ${peer.label} n'est couverte par aucune commande « network »`); continue; }
      if (mine.passive) { fail(`${iface.name} est passive (passive-interface)`); continue; }
      if (theirs.passive) { fail(`${peerIface.name} de ${peer.label} est passive (passive-interface)`); continue; }
      if (!sameSubnet(iface.ip, peerIface.ip, Math.min(iface.mask, peerIface.mask))) { fail('les deux interfaces ne sont pas dans le même réseau'); continue; }
      a.eigrp.neighbors.push({ peer, iface, peerIface, p2p });
      links.push({ a, b: peer, aIface: iface, bIface: peerIface });
    }
  }

  // Vecteur de distance : B reçoit ce que A annonce, et ajoute son interface vers A
  for (let round = 0; round < 64; round++) {
    let changed = false;
    for (const { a, b, aIface, bIface } of links) {
      for (const [k, e] of a.eigrp.table) {
        if (e.via?.iface === aIface.name) continue; // split horizon
        const cand = { bw: Math.min(e.bw, eigrpBandwidth(bIface)), delay: e.delay + eigrpDelay(bIface) };
        const metric = eigrpMetric(cand.bw, cand.delay);
        const cur = b.eigrp.table.get(k);
        if (cur?.local) continue;
        const curMetric = cur && eigrpMetric(cur.bw, cur.delay);
        if (!cur || metric < curMetric || (metric === curMetric && byIp(aIface.ip, cur.via.nextHop) < 0)) {
          b.eigrp.table.set(k, { net: e.net, mask: e.mask, ...cand, external: e.external, rd: eigrpMetric(e.bw, e.delay), via: { nextHop: aIface.ip, iface: bIface.name, link: bIface.link } });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (const r of routers.values()) {
    if (!r.eigrp.enabled) continue;
    r.eigrp.routes = [...r.eigrp.table.values()]
      .filter((e) => !e.local && !r.connected.has(prefixKey(e.net, e.mask)))
      .map((e) => ({
        net: e.net, mask: e.mask, proto: e.external ? 'D EX' : 'D', ad: e.external ? AD.DEX : AD.D,
        metric: eigrpMetric(e.bw, e.delay), rd: e.rd, ...e.via,
      }));
  }
}

// === BGP =====================================================================================
function ownerOf(routers, ip) {
  for (const r of routers.values()) if (r.ifaces.some((i) => i.ip === ip)) return r;
  return null;
}

// Adresse source d'une session : update-source, sinon interface de sortie vers le voisin
function sourceAddress(r, n) {
  if (n.updateSource) return r.ifaces.find((i) => i.name === n.updateSource)?.ip ?? null;
  const route = lookup(r.rib, n.ip);
  if (!route) return null;
  return r.ifaces.find((i) => i.name === route.iface)?.ip ?? null;
}

function computeBgp(routers, issue, doc, topo) {
  for (const r of routers.values()) {
    const c = r.cfg.bgp;
    r.bgp = { enabled: Boolean(c?.asn), asn: c?.asn ? Number(c.asn) : null, sessions: [], table: new Map(), routes: [] };
    if (r.bgp.enabled) r.bgp.routerId = routerId(r, c.routerId);
  }
  const igp = { ribs: new Map([...routers].map(([id, r]) => [id, r.rib])) };

  // Sessions
  for (const a of routers.values()) {
    if (!a.bgp.enabled) continue;
    for (const n of a.cfg.bgp.neighbors ?? []) {
      const s = { neighbor: n.ip, remoteAs: Number(n.remoteAs), state: 'Active', reason: null, peer: null, cfg: n };
      a.bgp.sessions.push(s);
      const down = (why) => {
        s.reason = why;
        issue(a, `BGP : session ${a.label} → ${n.ip} (AS ${n.remoteAs}) down : ${why}.`);
      };
      if (!isValidIp(n.ip)) { down('adresse du voisin invalide'); continue; }
      const b = ownerOf(routers, n.ip);
      if (!b) { down(`aucun routeur actif ne possède ${n.ip}`); continue; }
      s.peer = b;
      if (!b.bgp.enabled) { down(`${b.label} n'a pas BGP`); continue; }
      if (b.bgp.asn !== Number(n.remoteAs)) { down(`« remote-as ${n.remoteAs} » mais ${b.label} est dans l'AS ${b.bgp.asn}`); continue; }
      const src = sourceAddress(a, n);
      if (!src) { down(`pas de route vers ${n.ip} pour choisir l'adresse source`); continue; }
      s.source = src;
      const back = (b.cfg.bgp.neighbors ?? []).find((m) => m.ip === src);
      if (!back) {
        const other = (b.cfg.bgp.neighbors ?? []).find((m) => a.ifaces.some((i) => i.ip === m.ip));
        down(other
          ? `${b.label} attend ${a.label} sur ${other.ip}, mais la session part de ${src} : ajoute « neighbor ${n.ip} update-source ${a.ifaces.find((i) => i.ip === other.ip)?.name} » sur ${a.label}`
          : `${b.label} n'a pas de « neighbor ${src} remote-as ${a.bgp.asn} »`);
        continue;
      }
      if (Number(back.remoteAs) !== a.bgp.asn) { down(`${b.label} déclare ${src} dans l'AS ${back.remoteAs}, mais ${a.label} est dans l'AS ${a.bgp.asn}`); continue; }
      const ebgp = a.bgp.asn !== b.bgp.asn;
      if (ebgp) {
        const direct = (r, ip) => r.ifaces.some((i) => !i.loopback && sameSubnet(i.ip, ip, i.mask));
        if (!n.ebgpMultihop && !direct(a, n.ip)) { down(`eBGP vers ${n.ip}, qui n'est pas directement connecté : ajoute « neighbor ${n.ip} ebgp-multihop 2 »`); continue; }
        if (!back.ebgpMultihop && !direct(b, src)) { down(`eBGP : ${src} n'est pas directement connecté à ${b.label} : « neighbor ${src} ebgp-multihop 2 » sur ${b.label}`); continue; }
      }
      // TCP 179 : il faut que le ping passe dans les deux sens avec ces adresses
      const ping = simulatePing(doc, a.id, n.ip, { routing: igp, srcIp: src, topo });
      if (!ping.ok) { down(`${n.ip} injoignable depuis ${src} (${ping.log.findLast((l) => l.level === 'error')?.text ?? 'pas de réponse'})`); continue; }
      s.state = 'Established';
      s.ebgp = ebgp;
    }
  }

  // Origine des routes : « network » exige la route exacte dans la table, comme sur IOS
  for (const r of routers.values()) {
    if (!r.bgp.enabled) continue;
    r.bgp.local = [];
    const c = r.cfg.bgp;
    for (const n of c.networks ?? []) {
      if (!isValidIp(n.network) || !isValidCidr(n.mask)) continue;
      const net = networkOf(n.network, Number(n.mask));
      const exact = [...r.rib.values()].some((x) => x.net === net && x.mask === Number(n.mask));
      if (!exact) {
        issue(r, `BGP : ${r.label} n'annonce pas ${prefixText(net, n.mask)} : cette route exacte n'est pas dans sa table de routage.`);
        continue;
      }
      r.bgp.local.push({ net, mask: Number(n.mask), asPath: [], nextHop: '0.0.0.0', local: true, origin: 'i' });
    }
    const redistribute = (routes) => {
      for (const x of routes) {
        if (r.bgp.local.some((l) => l.net === x.net && l.mask === x.mask)) continue;
        r.bgp.local.push({ net: x.net, mask: x.mask, asPath: [], nextHop: '0.0.0.0', local: true, origin: '?' });
      }
    };
    if (c.redistribute?.connected) redistribute([...r.connected.values()].filter((x) => x.proto === 'C'));
    if (c.redistribute?.static) redistribute(r.statics);
    if (c.redistribute?.ospf) redistribute(r.ospf.routes);
    r.bgp.adjIn = new Map(); // peerId -> Map prefixKey -> path
    for (const p of r.bgp.local) r.bgp.table.set(prefixKey(p.net, p.mask), [p]);
  }

  const established = [];
  for (const a of routers.values()) for (const s of a.bgp.sessions) if (s.state === 'Established') established.push({ a, s });

  const valid = (r, p) => {
    if (p.local || p.ebgp) return true;
    return Boolean(lookup(r.rib, p.nextHop, (x) => x.proto !== 'B'));
  };
  const better = (r, x, y) => {
    // Locale, puis AS_PATH le plus court, puis eBGP avant iBGP, puis plus petit router-id
    if (x.local !== y.local) return x.local;
    if (x.asPath.length !== y.asPath.length) return x.asPath.length < y.asPath.length;
    if (Boolean(x.ebgp) !== Boolean(y.ebgp)) return Boolean(x.ebgp);
    return byIp(x.peerRouterId ?? '0.0.0.0', y.peerRouterId ?? '0.0.0.0') < 0;
  };
  const bestOf = (r, paths) => paths.filter((p) => valid(r, p)).reduce((b, p) => (!b || better(r, p, b) ? p : b), null);

  for (let round = 0; round < 30; round++) {
    let changed = false;
    for (const { a, s } of established) {
      const b = s.peer;
      const back = b.bgp.sessions.find((x) => x.neighbor === s.source && x.state === 'Established');
      if (!back) continue;
      const ebgp = a.bgp.asn !== b.bgp.asn;
      const out = new Map();
      for (const [k, paths] of a.bgp.table) {
        const best = bestOf(a, paths);
        if (!best) continue;
        if (!best.local && !best.ebgp && !ebgp) continue; // pas de relais iBGP -> iBGP
        let path;
        if (ebgp) {
          if (best.asPath.includes(b.bgp.asn)) continue; // b rejetterait (boucle d'AS)
          path = { net: best.net, mask: best.mask, asPath: [a.bgp.asn, ...best.asPath], nextHop: s.source, ebgp: true, origin: best.origin };
        } else {
          const self = best.local || s.cfg.nextHopSelf;
          path = { net: best.net, mask: best.mask, asPath: best.asPath, nextHop: self ? s.source : best.nextHop, ebgp: false, origin: best.origin };
        }
        out.set(k, { ...path, from: a.id, peerRouterId: a.bgp.routerId, peerIp: s.source });
      }
      const prev = b.bgp.adjIn.get(a.id);
      if (JSON.stringify(prev ? [...prev] : null) !== JSON.stringify([...out])) {
        b.bgp.adjIn.set(a.id, out);
        changed = true;
      }
    }
    if (!changed) break;
    for (const r of routers.values()) {
      if (!r.bgp.enabled) continue;
      r.bgp.table = new Map();
      for (const p of r.bgp.local) r.bgp.table.set(prefixKey(p.net, p.mask), [p]);
      for (const m of r.bgp.adjIn.values()) {
        for (const [k, p] of m) r.bgp.table.set(k, [...(r.bgp.table.get(k) ?? []), p]);
      }
    }
  }

  // Meilleurs chemins -> table de routage
  for (const r of routers.values()) {
    if (!r.bgp.enabled) continue;
    for (const [, paths] of r.bgp.table) {
      const best = bestOf(r, paths);
      for (const p of paths) {
        p.best = p === best;
        p.valid = valid(r, p);
      }
      const invalid = paths.find((p) => !p.valid);
      if (invalid && !best) {
        issue(r, `BGP : ${r.label} reçoit ${prefixText(invalid.net, invalid.mask)} avec le next-hop ${invalid.nextHop}, injoignable : la route n'est pas utilisée (« neighbor … next-hop-self » sur le routeur qui l'annonce en iBGP).`);
      }
      if (!best || best.local) continue;
      // Résolution récursive du next-hop par l'IGP
      const via = best.ebgp ? r.ifaces.find((i) => !i.loopback && sameSubnet(i.ip, best.nextHop, i.mask)) : null;
      const igpRoute = via ? null : lookup(r.rib, best.nextHop, (x) => x.proto !== 'B');
      r.bgp.routes.push({
        net: best.net, mask: best.mask, proto: 'B', ad: best.ebgp ? AD.eBGP : AD.iBGP, metric: 0,
        nextHop: best.nextHop, asPath: best.asPath, ebgp: Boolean(best.ebgp),
        iface: via?.name ?? igpRoute?.iface ?? null, link: via?.link ?? igpRoute?.link ?? null, recursive: !via,
      });
    }
  }
}
