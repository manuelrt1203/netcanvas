// État d'exécution d'un schéma (à côté de la configuration) : temps simulé, baux DHCP, table NAT.
//   time   : secondes écoulées depuis le début de la simulation
//   leases : { [hôte]: { ip, mask, gateway, dns, server, relay, pool, start, end } } (baux en cours, même d'hôtes débranchés)
//   released : [hôte] (ipconfig /release : pas d'adresse jusqu'au prochain /renew)
//   nat    : [{ router, proto, insideLocal, insideGlobal, outsideLocal, outsideGlobal, id, created, expires }]
//   arp    : [{ device, ip, mac, iface, learned, expires }]   (caches ARP)
//   mac    : [{ switch, mac, vlan, port, learned, expires }]  (tables MAC des switches)
//   nd     : [{ device, ip, mac, iface, learned, expires }]   (voisins IPv6, NDP)
export const EMPTY_RUNTIME = { time: 0, leases: {}, released: [], nat: [], arp: [], mac: [], nd: [] };

export const runtimeOf = (doc) => ({ ...EMPTY_RUNTIME, ...doc?.runtime });
export const isEmptyRuntime = (r) => !r || (!r.time && !Object.keys(r.leases ?? {}).length && !r.released?.length && !r.nat?.length && !r.arp?.length && !r.mac?.length && !r.nd?.length);

// IOS : délai d'expiration d'une traduction ICMP (ip nat translation icmp-timeout)
export const NAT_ICMP_TIMEOUT = 60;
// IOS : durée de bail par défaut d'un pool DHCP (1 jour)
export const DEFAULT_LEASE = 86400;

// « J+1 03:25:10 »
export function formatTime(t) {
  const s = Math.max(0, Math.floor(t ?? 0));
  const days = Math.floor(s / 86400);
  const hms = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
  return `${days ? `J+${days} ` : ''}${hms}`;
}

// Durée lisible : « 1 j », « 2 h 30 min », « 45 s »
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s >= 86400 && s % 3600 === 0) return `${s / 86400 >= 1 && s % 86400 === 0 ? `${s / 86400} j` : `${Math.floor(s / 3600)} h`}`;
  if (s >= 3600) return `${Math.floor(s / 3600)} h${s % 3600 ? ` ${Math.floor((s % 3600) / 60)} min` : ''}`;
  if (s >= 60) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${s} s`;
}

// Entrées NAT encore valides à l'instant t
export const activeNat = (runtime) => (runtime.nat ?? []).filter((e) => e.expires > runtime.time);
