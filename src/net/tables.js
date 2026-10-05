// Tables ARP et MAC : fusion de ce qu'un ping a appris dans l'état d'exécution (avec vieillissement),
// et lignes prêtes à afficher, partagées par les terminaux et la vue « Tables ».
import { MAC_AGING, arpTimeout, macOf, sameMac } from './mac.js';
import { runtimeOf } from './runtime.js';
import { buildTopology } from './topology.js';
import { isValidIp } from './ip.js';

// Ajoute les entrées apprises (learned = { arp, mac, nd }) ; une entrée existante est rafraîchie
export function mergeLearned(runtime, learned, doc) {
  const now = runtime.time ?? 0;
  const devices = new Map(doc.devices.map((d) => [d.id, d]));
  const arp = (runtime.arp ?? []).filter((e) => e.expires > now);
  for (const e of learned?.arp ?? []) {
    if (!e.mac || !isValidIp(e.ip)) continue;
    const i = arp.findIndex((x) => x.device === e.device && x.ip === e.ip);
    const entry = { ...e, learned: now, expires: now + arpTimeout(devices.get(e.device)) };
    if (i >= 0) arp[i] = entry;
    else arp.push(entry);
  }
  const mac = (runtime.mac ?? []).filter((e) => e.expires > now);
  for (const e of learned?.mac ?? []) {
    if (!e.mac) continue;
    // Une MAC n'est que sur un port par VLAN : si elle a bougé, l'ancienne entrée disparaît
    const i = mac.findIndex((x) => x.switch === e.switch && x.vlan === e.vlan && sameMac(x.mac, e.mac));
    const entry = { ...e, learned: now, expires: now + MAC_AGING };
    if (i >= 0) mac[i] = entry;
    else mac.push(entry);
  }
  // Voisins IPv6 (NDP) : même durée de vie que le cache ARP de l'équipement
  const nd = (runtime.nd ?? []).filter((e) => e.expires > now);
  for (const e of learned?.nd ?? []) {
    if (!e.mac || !e.ip) continue;
    const i = nd.findIndex((x) => x.device === e.device && x.ip === e.ip);
    const entry = { ...e, learned: now, expires: now + arpTimeout(devices.get(e.device)) };
    if (i >= 0) nd[i] = entry;
    else nd.push(entry);
  }
  return { ...runtime, arp, mac, nd };
}

// Voisins IPv6 d'un équipement (état REACH pendant 30 s, puis STALE comme sur IOS)
export const ND_REACHABLE = 30;
export function ndRows(dev, doc) {
  const rt = runtimeOf(doc);
  return (rt.nd ?? [])
    .filter((e) => e.device === dev.id && e.expires > rt.time)
    .map((e) => {
      const age = rt.time - e.learned;
      return { ip: e.ip, mac: e.mac, iface: e.iface, age, state: age < ND_REACHABLE ? 'REACH' : 'STALE' };
    })
    .sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }) || a.ip.localeCompare(b.ip));
}
export const clearNd = (id) => (rt) => ({ ...rt, nd: (rt.nd ?? []).filter((e) => e.device !== id) });

// Cache ARP d'un équipement : ses propres adresses (routeur, statiques) puis les entrées apprises
export function arpRows(dev, doc) {
  const rt = runtimeOf(doc);
  const own = [];
  if (dev.type === 'router' || dev.type === 'switch') {
    const topo = buildTopology(doc);
    for (const i of topo.l3Ifaces(dev.id)) {
      // Pas d'ARP sur une loopback ni sur une liaison série (HDLC)
      if (!i.loopback && topo.links.get(i.link)?.cable !== 'serial') own.push({ ip: i.ip, mac: macOf(dev, i.name), iface: i.name, age: null, own: true });
    }
  }
  const learned = (rt.arp ?? [])
    .filter((e) => e.device === dev.id && e.expires > rt.time)
    .map((e) => ({ ip: e.ip, mac: e.mac, iface: e.iface, age: rt.time - e.learned, expiresIn: e.expires - rt.time }));
  const byIp = (a, b) => a.ip.split('.').map(Number).reduce((x, y) => x * 256 + y, 0) - b.ip.split('.').map(Number).reduce((x, y) => x * 256 + y, 0);
  return [...own, ...learned.filter((l) => !own.some((o) => o.ip === l.ip))].sort(byIp);
}

// Table MAC d'un switch
export function macRows(dev, doc) {
  const rt = runtimeOf(doc);
  return (rt.mac ?? [])
    .filter((e) => e.switch === dev.id && e.expires > rt.time)
    .map((e) => ({ vlan: e.vlan, mac: e.mac, port: e.port, age: rt.time - e.learned, expiresIn: e.expires - rt.time }))
    .sort((a, b) => a.vlan - b.vlan || a.port.localeCompare(b.port, undefined, { numeric: true }));
}

// Vider : cache ARP d'un équipement, table MAC d'un switch
export const clearArp = (id) => (rt) => ({ ...rt, arp: (rt.arp ?? []).filter((e) => e.device !== id) });
export const clearMac = (id) => (rt) => ({ ...rt, mac: (rt.mac ?? []).filter((e) => e.switch !== id) });
