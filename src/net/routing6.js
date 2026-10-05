// Table de routage IPv6 d'un routeur : réseaux connectés (C, et L pour ses propres adresses),
// routes statiques (S) ; OSPFv3 s'y ajoute (routing.js). Mêmes règles qu'IOS :
// - une route statique avec saut suivant global n'est installée que s'il est sur un réseau connecté actif ;
// - un saut suivant link-local (fe80::) exige l'interface de sortie ;
// - une route « vers une interface » (sans saut suivant) est directement connectée.
import { formatIp6, isLinkLocal6, isValidIp6, isValidPrefix6, networkOf6, normIp6, parseIp6, prefixBits6, sameSubnet6 } from './ip6.js';

const key = (net, prefix) => `${net.toString(16)}/${prefix}`;

export function lookup6(rib, ip, filter = () => true) {
  const n = parseIp6(ip);
  if (n === null) return null;
  let best = null;
  for (const r of rib.values()) {
    if (!filter(r) || (n & prefixBits6(r.prefix)) !== r.net) continue;
    if (!best || r.prefix > best.prefix) best = r;
  }
  return best;
}

export const routeText6 = (r) => `${formatIp6(r.net)}/${r.prefix}`;

// ifaces : interfaces IPv6 actives du routeur (topo.l3Ifaces6) ; cfg : config du routeur
export function connectedAndStatic6(ifaces, cfg) {
  const connected = new Map();
  for (const i of ifaces) {
    if (!i.ip || !isValidPrefix6(i.prefix) || isLinkLocal6(i.ip)) continue;
    const net = networkOf6(i.ip, i.prefix);
    connected.set(key(net, i.prefix), { net, prefix: i.prefix, proto: 'C', ad: 0, metric: 0, nextHop: null, iface: i.name, link: i.link });
    connected.set(key(parseIp6(i.ip), 128), { net: parseIp6(i.ip), prefix: 128, proto: 'L', ad: 0, metric: 0, nextHop: null, iface: i.name, link: i.link, local: true });
  }
  const statics = [];
  for (const s of cfg.routes6 ?? []) {
    if (!isValidIp6(s.network) || !isValidPrefix6(s.prefix)) continue;
    const net = networkOf6(s.network, s.prefix);
    const hop = s.nextHop && isValidIp6(s.nextHop) ? normIp6(s.nextHop) : null;
    let out = null;
    if (s.iface) out = ifaces.find((i) => i.name === s.iface && !i.loopback);
    else if (hop && !isLinkLocal6(hop)) out = ifaces.find((i) => !i.loopback && i.ip && isValidPrefix6(i.prefix) && sameSubnet6(i.ip, hop, i.prefix));
    if (!out || (hop && isLinkLocal6(hop) && !s.iface)) continue;
    statics.push({ net, prefix: s.prefix, proto: s.prefix === 0 ? 'S*' : 'S', ad: 1, metric: 0, nextHop: hop, iface: out.name, link: out.link });
  }
  return { connected, statics };
}

export function buildRib6(routes) {
  const rib = new Map();
  for (const r of routes) {
    const k = key(r.net, r.prefix);
    const cur = rib.get(k);
    if (!cur || r.ad < cur.ad || (r.ad === cur.ad && r.metric < cur.metric)) rib.set(k, r);
  }
  return rib;
}
