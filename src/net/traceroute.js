// Traceroute : les routeurs traversés, chacun répondant depuis son interface d'entrée.
// Comme en vrai, un saut n'apparaît que si sa réponse (ICMP time exceeded) revient jusqu'à la source.
import { simulatePing } from './simulate.js';
import { buildTopology } from './topology.js';
import { computeRouting } from './routing.js';
import { withLeases } from './dhcp.js';

export const MAX_HOPS = 30;

// Renvoie { hops: [{ ttl, ip, device, reached }], ok, reason }
export function traceroute(rawDoc, sourceId, dstIp) {
  const doc = withLeases(rawDoc);
  const topo = buildTopology(doc);
  const routing = computeRouting(doc, topo);
  const ping = simulatePing(doc, sourceId, dstIp, { topo, routing });
  const forwardPath = ping.path.filter((p) => p.phase === 'request');
  const reason = ping.ok ? null : ping.log.findLast((l) => l.level === 'error')?.text ?? null;
  const hops = [];

  forwardPath.forEach((p, i) => {
    const last = i === forwardPath.length - 1;
    const reached = last && topo.l3Ifaces(p.device).some((x) => x.ip === dstIp);
    // Un routeur intermédiaire répond depuis son interface d'entrée : il faut que ça revienne
    const back = reached ? ping.ok : Boolean(ping.srcIp) && simulatePing(doc, p.device, ping.srcIp, { topo, routing, srcIp: p.ip, oneWay: true }).ok;
    hops.push({ ttl: i + 1, ip: back ? (reached ? dstIp : p.ip) : null, device: p.device, reached });
  });

  // Échec avant la destination : la trace s'arrête sur des étoiles
  if (!hops.some((h) => h.reached)) hops.push({ ttl: hops.length + 1, ip: null, device: null, reached: false });
  return { hops, ok: hops.some((h) => h.reached && h.ip), reason: hops.some((h) => h.reached && h.ip) ? null : reason ?? 'pas de réponse' };
}
