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
import { DEFAULT_LEASE, runtimeOf } from './runtime.js';

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
    return [{ ...p, iface: p.iface ?? server.iface, range: p.range ?? c.ranges?.[server?.pool], leaseTime: p.leaseTime ?? server?.leaseTime }];
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

const leaseValid = (l, now) => l && (l.end == null || l.end > now);

// Baux pour l'instant runtime.time. Renvoie { leases : Map hôte -> bail | { error }, store : baux à garder }.
// Un client connecté renouvelle à mi-bail et garde son adresse ; un bail d'hôte débranché ou supprimé
// occupe son adresse jusqu'à expiration ; « ipconfig /release » rend l'adresse.
export function computeLeases(doc) {
  const leases = new Map();
  const rt = runtimeOf(doc);
  const now = rt.time;
  const released = new Set(rt.released ?? []);
  const store = Object.fromEntries(Object.entries(rt.leases ?? {}).filter(([id, l]) => leaseValid(l, now) && !released.has(id)));
  const clients = doc.devices.filter(isDhcpClient);
  if (!clients.length) return { leases, store };
  const topo = buildTopology(doc);
  const routing = computeRouting(doc, topo);
  // Adresses prises : adresses statiques du schéma et baux en cours (y compris d'hôtes partis)
  const statics = new Set();
  for (const d of doc.devices) {
    if (isDhcpClient(d)) continue;
    for (const i of [d.config, ...(d.config?.interfaces ?? [])]) if (isValidIp(i?.ip)) statics.add(i.ip);
  }
  const owner = new Map(Object.entries(store).map(([id, l]) => [l.ip, id]));
  const free = (ip, who) => !statics.has(ip) && (!owner.has(ip) || owner.get(ip) === who);
  const allocate = (server, pool, who) => {
    const prev = store[who];
    // Même serveur, même pool, adresse toujours libre : le client la garde
    if (prev && prev.server === server.id && prev.pool === (pool.name ?? pool.network) && inPool(pool, prev.ip) && free(prev.ip, who)) return prev.ip;
    for (const ip of candidates(pool)) {
      if (free(ip, who) && !excluded(server, ip) && ip !== pool.defaultRouter) return ip;
    }
    return null;
  };
  const grant = (who, server, pool, ip, relay) => {
    const dur = pool.leaseTime === 'infinite' ? null : Number(pool.leaseTime) || DEFAULT_LEASE;
    const prev = store[who];
    const same = prev && prev.ip === ip && prev.server === server.id;
    // Renouvellement à mi-bail (T1), sinon on garde les dates
    const renew = !same || (dur !== null && now >= prev.start + dur / 2);
    const lease = {
      ip, mask: Number(pool.mask), gateway: pool.defaultRouter ?? null, dns: pool.dns ?? null, server: server.id,
      ...(relay ? { relay } : {}), pool: pool.name ?? pool.network,
      start: renew ? now : prev.start, end: renew ? (dur === null ? null : now + dur) : prev.end,
    };
    if (prev && prev.ip !== ip) owner.delete(prev.ip);
    owner.set(ip, who);
    store[who] = lease;
    return lease;
  };

  for (const host of clients) {
    const fail = (error) => leases.set(host.id, { error });
    if (released.has(host.id)) {
      fail('adresse libérée par « ipconfig /release » (tape « ipconfig /renew »)');
      continue;
    }
    const link = topo.linksOf.get(host.id)[0];
    if (!link) { fail(`${host.label} n'est relié à rien : aucune demande DHCP ne part`); continue; }
    if (!topo.isUp(link)) { fail(`câble hors service (${topo.status.get(link).reason})`); continue; }

    // Diffusion du DISCOVER dans le domaine de niveau 2
    const { endpoints, vlansSeen } = flood(topo, host.id, link);
    let lease = null;
    const reasons = [];
    for (const e of endpoints) {
      const dev = topo.devices.get(e.device);
      const isServer = dev.type === 'server' && dev.config?.dhcp?.pools?.length;
      if (!isRouting(dev) && !isServer) continue;
      const iface = e.svi != null ? topo.l3Ifaces(dev.id).find((x) => x.svi && x.vlan === e.svi) : topo.l3IfaceOn(dev.id, e.inLink, e.tag);
      if (!iface || !isValidIp(iface.ip)) continue;
      // Serveur sur ce réseau ?
      const local = poolsOf(dev).find((p) => inPool(p, iface.ip) && (!isMikrotik(dev) || !p.iface || p.iface === iface.name));
      if (local) {
        const ip = allocate(dev, local, host.id);
        if (!ip) { reasons.push(`le pool ${local.name ?? local.network} de ${dev.label} est épuisé`); continue; }
        lease = grant(host.id, dev, local, ip);
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
      const ip = allocate(server, pool, host.id);
      if (!ip) { reasons.push(`le pool ${pool.name ?? pool.network} de ${server.label} est épuisé`); continue; }
      lease = grant(host.id, server, pool, ip, dev.id);
      break;
    }
    if (lease) leases.set(host.id, lease);
    else {
      const where = vlansSeen.size ? ` dans le VLAN ${[...vlansSeen].join(', ')}` : '';
      fail(reasons.length ? reasons.join(' ; ') : `aucun serveur DHCP ni relais ne répond${where}`);
    }
  }
  return { leases, store };
}

// Document « effectif » : les hôtes DHCP reçoivent leur bail (ou une adresse APIPA sans passerelle),
// et runtime.leases contient les baux à garder (le schéma les enregistre)
const cache = new WeakMap();
export function withLeases(doc) {
  if (cache.has(doc)) return cache.get(doc);
  const rt = runtimeOf(doc);
  if (!doc.devices.some(isDhcpClient) && !Object.keys(rt.leases ?? {}).length) {
    cache.set(doc, doc);
    return doc;
  }
  const { leases, store } = computeLeases(doc);
  const released = new Set(rt.released ?? []);
  const out = {
    ...doc,
    runtime: { ...rt, leases: store },
    devices: doc.devices.map((d) => {
      if (!isDhcpClient(d)) return d;
      const l = leases.get(d.id);
      let config;
      if (l?.ip) config = { ...d.config, ip: l.ip, mask: l.mask, gateway: l.gateway, lease: l };
      else if (released.has(d.id)) config = { ...d.config, ip: null, mask: null, gateway: null, dhcpError: l.error };
      else config = { ...d.config, ip: apipa(d.id), mask: 16, gateway: null, dhcpError: l?.error ?? 'pas de réponse DHCP' };
      return { ...d, config };
    }),
  };
  cache.set(doc, out);
  cache.set(out, out);
  return out;
}
