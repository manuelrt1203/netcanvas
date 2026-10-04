// DHCP : baux calculés pour les hôtes en mode DHCP (config.dhcp === true).
//
// Serveur (routeur, switch niveau 3 ou serveur Server-PT) : config.dhcp = {
//   pools: [{ name, network, mask, defaultRouter, dns, range?: [début, fin], iface? }],
//   excluded: [[début, fin]],                       // ip dhcp excluded-address (Cisco)
//   servers: [{ name, iface, pool }], ranges: { [nom]: [début, fin] }   // /ip dhcp-server, /ip pool (MikroTik)
// }
// Relais : interface avec helperAddress (ip helper-address).
// La demande (DISCOVER) est diffusée dans le domaine de niveau 2 de l'hôte : le premier routeur qui y a
// un pool pour ce réseau répond ; sinon un relais la transmet à son serveur, qui choisit le pool du réseau
// du relais (giaddr). Adresse attribuée : la première libre (ni exclue, ni statique, ni déjà louée).
import { flood } from './l2.js';
import { formatIp, isValidCidr, isValidIp, maskBits, networkOf, parseIp } from './ip.js';
import { buildTopology, isHost, isRouting } from './topology.js';
import { isMikrotik } from './catalog.js';
import { computeRouting } from './routing.js';
import { simulatePing } from './simulate.js';

export const isDhcpClient = (d) => isHost(d) && d.config?.dhcp === true;

// Pools utilisables d'un serveur, au format commun (MikroTik : serveur + plage + réseau)
export function poolsOf(dev) {
  const c = dev.config?.dhcp;
  if (!c || c === true) return [];
  const pools = (c.pools ?? []).filter((p) => isValidIp(p.network) && isValidCidr(p.mask));
  if (!isMikrotik(dev)) return pools;
  // MikroTik : un serveur (/ip dhcp-server) sur l'interface du réseau, avec une plage (/ip pool) ;
  // le réseau (gateway, dns) vient de « /ip dhcp-server network ». Sans serveur, rien n'est distribué.
  const ifaceIp = (name) => (dev.config?.interfaces ?? []).find((i) => i.name === name)?.ip;
  return pools.flatMap((p) => {
    const server = (c.servers ?? []).find((s) => (p.iface ? s.iface === p.iface : isValidIp(ifaceIp(s.iface)) && inPool(p, ifaceIp(s.iface))));
    if (!server && !p.iface) return [];
    return [{ ...p, iface: p.iface ?? server.iface, range: p.range ?? c.ranges?.[server?.pool] }];
  });
}

const inPool = (p, ip) => networkOf(ip, Number(p.mask)) === networkOf(p.network, Number(p.mask));

// Adresses candidates d'un pool (plage MikroTik, sinon tout le réseau sauf réseau/diffusion), plafonnées
function* candidates(p) {
  const mask = Number(p.mask);
  const net = networkOf(p.network, mask);
  const first = p.range ? parseIp(p.range[0]) : net + 1;
  const last = p.range ? parseIp(p.range[1]) : ((net | ~maskBits(mask)) >>> 0) - 1; // >>> 0 : entier non signé
  for (let n = first; n <= last && n - first < 4096; n++) yield formatIp(n >>> 0);
}

const excluded = (dev, ip) => (dev.config?.dhcp?.excluded ?? []).some(([a, b]) => {
  const n = parseIp(ip);
  return n >= parseIp(a) && n <= parseIp(b ?? a);
});

// Adresse APIPA stable pour un hôte sans bail (169.254.x.y)
export function apipa(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `169.254.${1 + (h % 254)}.${1 + ((h >> 8) % 254)}`;
}

export function computeLeases(doc) {
  const leases = new Map();
  const clients = doc.devices.filter(isDhcpClient);
  if (!clients.length) return leases;
  const topo = buildTopology(doc);
  const routing = computeRouting(doc, topo);
  // Adresses déjà prises : toutes les adresses statiques du schéma
  const used = new Set();
  for (const d of doc.devices) {
    if (isDhcpClient(d)) continue;
    for (const i of [d.config, ...(d.config?.interfaces ?? [])]) if (isValidIp(i?.ip)) used.add(i.ip);
  }
  const allocate = (server, pool) => {
    for (const ip of candidates(pool)) {
      if (!used.has(ip) && !excluded(server, ip) && ip !== pool.defaultRouter) {
        used.add(ip);
        return ip;
      }
    }
    return null;
  };

  for (const host of clients) {
    const link = topo.linksOf.get(host.id)[0];
    const fail = (error) => leases.set(host.id, { error });
    if (!link) { fail(`${host.label} n'est relié à rien : aucune demande DHCP ne part.`); continue; }
    if (!topo.isUp(link)) { fail(`câble hors service (${topo.status.get(link).reason})`); continue; }

    // Diffusion du DISCOVER dans le domaine de niveau 2
    const { endpoints, vlansSeen } = flood(topo, host.id, link);
    let lease = null;
    const reasons = [];
    for (const e of endpoints) {
      const dev = topo.devices.get(e.device);
      const isServer = dev.type === 'server' && dev.config?.dhcp?.pools?.length;
      if (!isRouting(dev) && !isServer) continue;
      const iface = e.svi != null ? topo.l3Ifaces(dev.id).find((s) => s.svi && s.vlan === e.svi) : topo.l3IfaceOn(dev.id, e.inLink, e.tag);
      if (!iface || !isValidIp(iface.ip)) continue;
      // Serveur sur ce réseau ?
      const local = poolsOf(dev).find((p) => inPool(p, iface.ip) && (!isMikrotik(dev) || !p.iface || p.iface === iface.name));
      if (local) {
        const ip = allocate(dev, local);
        if (!ip) { reasons.push(`le pool ${local.name ?? local.network} de ${dev.label} est épuisé`); continue; }
        lease = { ip, mask: Number(local.mask), gateway: local.defaultRouter ?? null, dns: local.dns ?? null, server: dev.id, pool: local.name ?? local.network };
        break;
      }
      if (isServer) continue; // un serveur ne relaie pas
      // Relais : ip helper-address
      const helper = (dev.config?.interfaces ?? []).find((i) => i.name === iface.name)?.helperAddress;
      if (!helper) { reasons.push(`${dev.label} ${iface.name} n'a ni pool DHCP pour ce réseau ni « ip helper-address »`); continue; }
      const server = [...topo.devices.values()].find((d) => topo.l3Ifaces(d.id).some((i) => i.ip === helper));
      if (!server) { reasons.push(`${dev.label} relaie vers ${helper}, mais aucun équipement actif n'a cette adresse`); continue; }
      const ping = simulatePing(doc, dev.id, helper, { topo, routing, srcIp: iface.ip });
      if (!ping.ok) { reasons.push(`${dev.label} relaie vers ${helper}, injoignable depuis ${iface.ip} (${ping.log.findLast((l) => l.level === 'error')?.text})`); continue; }
      const pool = poolsOf(server).find((p) => inPool(p, iface.ip));
      if (!pool) { reasons.push(`le serveur ${server.label} n'a pas de pool pour le réseau ${formatIp(networkOf(iface.ip, iface.mask))}/${iface.mask} (adresse du relais ${iface.ip})`); continue; }
      const ip = allocate(server, pool);
      if (!ip) { reasons.push(`le pool ${pool.name ?? pool.network} de ${server.label} est épuisé`); continue; }
      lease = { ip, mask: Number(pool.mask), gateway: pool.defaultRouter ?? null, dns: pool.dns ?? null, server: server.id, relay: dev.id, pool: pool.name ?? pool.network };
      break;
    }
    if (lease) leases.set(host.id, lease);
    else {
      const where = vlansSeen.size ? ` dans le VLAN ${[...vlansSeen].join(', ')}` : '';
      fail(reasons.length ? reasons.join(' ; ') : `aucun serveur DHCP ni relais ne répond${where}`);
    }
  }
  return leases;
}

// Document « effectif » : les hôtes DHCP reçoivent leur bail (ou une adresse APIPA sans passerelle)
const cache = new WeakMap();
export function withLeases(doc) {
  if (cache.has(doc)) return cache.get(doc);
  if (!doc.devices.some(isDhcpClient)) {
    cache.set(doc, doc);
    return doc;
  }
  const leases = computeLeases(doc);
  const out = {
    ...doc,
    devices: doc.devices.map((d) => {
      if (!isDhcpClient(d)) return d;
      const l = leases.get(d.id);
      const config = l?.ip
        ? { ...d.config, ip: l.ip, mask: l.mask, gateway: l.gateway, lease: l }
        : { ...d.config, ip: apipa(d.id), mask: 16, gateway: null, dhcpError: l?.error ?? 'pas de réponse DHCP' };
      return { ...d, config };
    }),
  };
  cache.set(doc, out);
  cache.set(out, out);
  return out;
}
