// SLAAC : un hôte en IPv6 automatique (config.slaac) écoute les annonces de routeur (RA) de son
// domaine de niveau 2. Le premier routeur IPv6 (ipv6 unicast-routing) qui y a une adresse globale en /64
// donne le préfixe ; l'hôte complète par son EUI-64 et prend la link-local du routeur comme passerelle.
// Drapeaux de l'annonce (interface du routeur) : M (ndManaged, « ipv6 nd managed-config-flag ») : l'adresse vient
// du serveur DHCPv6 (stateful) ; O (ndOther, « other-config-flag ») : SLAAC, et le DNS vient de DHCPv6 (stateless).
// Serveur DHCPv6 : « ipv6 dhcp server POOL » sur l'interface du routeur ; config.dhcp6Pools = { [nom]: { prefix, len, dns } }.
// Résultat dans config.slaac6 = { ip, prefix, gateway, router, iface, how: 'slaac' | 'dhcp6', dns, dnsError }
// ou config.slaacError.
import { flood } from './l2.js';
import { buildTopology, isHost, v6Forwarding } from './topology.js';
import { eui64Address, formatIp6, isLinkLocal6, isValidIp6, isValidPrefix6, networkLabel6, networkOf6 } from './ip6.js';
import { macCisco, macOf } from './mac.js';

const isSlaacClient = (d) => isHost(d) && d.config?.slaac === true;

function announce(topo, hostId) {
  const iface = topo.hostIface(hostId);
  if (!iface.link) return { error: 'pas de câble réseau' };
  if (!topo.isUp(iface.link)) return { error: 'câble hors service' };
  const { endpoints } = flood(topo, hostId, iface.link);
  let silent = null;
  let badPrefix = null;
  for (const e of endpoints) {
    const dev = topo.devices.get(e.device);
    if (isHost(dev)) continue;
    const v6 = e.svi != null ? topo.l3Ifaces6(e.device).find((s) => s.svi && s.vlan === e.svi) : topo.l3IfaceOn6(e.device, e.inLink, e.tag);
    if (!v6?.ip || isLinkLocal6(v6.ip) || v6.shutdown) continue;
    if (!v6Forwarding(dev)) {
      silent ??= `${dev.label} a une adresse IPv6 sur ce réseau mais n'envoie pas d'annonces RA (« ipv6 unicast-routing » n'est pas activé)`;
      continue;
    }
    if (v6.prefix !== 64 && !v6.ndManaged) {
      badPrefix ??= `${dev.label} annonce ${networkLabel6(v6.ip, v6.prefix)} : SLAAC demande un préfixe /64`;
      continue;
    }
    const pool = v6.dhcp6Server ? dev.config?.dhcp6Pools?.[v6.dhcp6Server] : null;
    return {
      router: dev.id, routerLabel: dev.label, iface: v6.name, network: networkLabel6(v6.ip, 64).split('/')[0], gateway: v6.linkLocal,
      managed: Boolean(v6.ndManaged), other: Boolean(v6.ndOther), server: v6.dhcp6Server ?? null, pool,
    };
  }
  return { error: badPrefix ?? silent ?? 'aucun routeur IPv6 n\'envoie d\'annonce RA sur ce réseau' };
}

// DHCPv6 stateful : première adresse libre du pool (hors adresses déjà configurées ou attribuées)
function allocate(pool, used) {
  if (!isValidIp6(pool?.prefix) || !isValidPrefix6(pool.len)) return null;
  const base = networkOf6(pool.prefix, pool.len);
  for (let n = 1n; n < 4096n; n++) {
    const ip = formatIp6(base + n);
    if (!used.has(ip)) return ip;
  }
  return null;
}

export function withSlaac(doc) {
  if (!doc.devices.some(isSlaacClient)) return doc;
  const topo = buildTopology(doc);
  const used = new Set(doc.devices.flatMap((d) => topo.l3Ifaces6(d.id, { includeDown: true }).map((i) => i.ip).filter(Boolean)));
  return {
    ...doc,
    devices: doc.devices.map((d) => {
      if (!isSlaacClient(d)) return d;
      const { slaac6, slaacError, ...config } = d.config;
      const ra = announce(topo, d.id);
      if (ra.error) return { ...d, config: { ...config, slaacError: ra.error } };
      const where = `${ra.routerLabel} ${ra.iface}`;
      // Drapeau M ou O : le PC interroge le serveur DHCPv6 du routeur
      const asked = ra.managed || ra.other;
      const noServer = !ra.server ? `${where} annonce ${ra.managed ? 'M=1 (adresse par DHCPv6)' : 'O=1 (DNS par DHCPv6)'} mais n'a pas de serveur DHCPv6 (« ipv6 dhcp server »)`
        : !ra.pool ? `le pool DHCPv6 ${ra.server} de ${ra.routerLabel} n'existe pas` : null;
      if (ra.managed && noServer) return { ...d, config: { ...config, slaacError: noServer } };
      let ip;
      let how = 'slaac';
      if (ra.managed) {
        ip = allocate(ra.pool, used);
        if (!ip) return { ...d, config: { ...config, slaacError: `le pool DHCPv6 ${ra.server} de ${ra.routerLabel} n'a pas de préfixe valide ou est épuisé` } };
        used.add(ip);
        how = 'dhcp6';
      } else {
        ip = eui64Address(ra.network, macCisco(macOf(d, topo.hostIface(d.id).name)));
      }
      const dns = asked && ra.pool?.dns && isValidIp6(ra.pool.dns) ? ra.pool.dns : null;
      const dnsError = asked && noServer ? noServer : null;
      return {
        ...d,
        config: {
          ...config,
          slaac6: { ip, prefix: 64, gateway: ra.gateway, router: ra.router, iface: ra.iface, how, ...(dns ? { dns } : {}), ...(dnsError ? { dnsError } : {}) },
        },
      };
    }),
  };
}
