// SLAAC : un hôte en IPv6 automatique (config.slaac) écoute les annonces de routeur (RA) de son
// domaine de niveau 2. Le premier routeur IPv6 (ipv6 unicast-routing) qui y a une adresse globale en /64
// donne le préfixe ; l'hôte complète par son EUI-64 et prend la link-local du routeur comme passerelle.
// Résultat dans config.slaac6 = { ip, prefix, gateway, router, iface } ou config.slaacError.
import { flood } from './l2.js';
import { buildTopology, isHost, v6Forwarding } from './topology.js';
import { eui64Address, isLinkLocal6, networkLabel6 } from './ip6.js';
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
    if (v6.prefix !== 64) {
      badPrefix ??= `${dev.label} annonce ${networkLabel6(v6.ip, v6.prefix)} : SLAAC demande un préfixe /64`;
      continue;
    }
    return { router: dev.id, iface: v6.name, network: networkLabel6(v6.ip, 64).split('/')[0], gateway: v6.linkLocal };
  }
  return { error: badPrefix ?? silent ?? 'aucun routeur IPv6 n\'envoie d\'annonce RA sur ce réseau' };
}

export function withSlaac(doc) {
  if (!doc.devices.some(isSlaacClient)) return doc;
  const topo = buildTopology(doc);
  return {
    ...doc,
    devices: doc.devices.map((d) => {
      if (!isSlaacClient(d)) return d;
      const { slaac6, slaacError, ...config } = d.config;
      const ra = announce(topo, d.id);
      if (ra.error) return { ...d, config: { ...config, slaacError: ra.error } };
      const mac = macCisco(macOf(d, topo.hostIface(d.id).name));
      return { ...d, config: { ...config, slaac6: { ip: eui64Address(ra.network, mac), prefix: 64, gateway: ra.gateway, router: ra.router, iface: ra.iface } } };
    }),
  };
}
