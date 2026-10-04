// Simulation d'un ping (ICMP echo request / reply) sur un schéma au format v2.
//
// Modèle :
//  - niveau 3 : chaque hôte choisit envoi direct ou passerelle selon son masque ;
//    chaque routeur cherche la route la plus spécifique dans sa table (connecté, statique, OSPF, RIP, BGP :
//    voir routing.js).
//  - niveau 2 : la résolution ARP est un parcours en largeur du domaine de diffusion,
//    en respectant les VLAN des ports de switch (access / trunk, VLAN natif 1). Un hub répète tout.
//  - niveau 1 : un câble hors service (mauvais câble, port inexistant, clock rate absent) ne transmet rien.
import { formatIp, isValidCidr, isValidIp, networkLabel, networkOf, parseIp, sameSubnet } from './ip.js';
import { buildTopology, isHost } from './topology.js';
import { flood } from './l2.js';
import { computeRouting, lookup } from './routing.js';

const MAX_TTL = 64;

class SimError extends Error {
  constructor(text, device) {
    super(text);
    this.device = device;
  }
}

// options : topo et routing déjà calculés (BGP vérifie ses sessions avec ce ping), srcIp imposée,
//           oneWay : seulement l'aller (réponse ICMP d'un routeur pour traceroute)
export function simulatePing(doc, sourceId, dstIp, options = {}) {
  const topo = options.topo ?? buildTopology(doc);
  const routing = options.routing ?? computeRouting(doc, topo);
  const ctx = { topo, routing };
  // path : équipements atteints et adresse d'entrée (sert à traceroute)
  const result = { ok: false, hops: [], path: [], log: [], failedAt: null, srcIp: null };
  const log = (phase, text, level = 'info', device = null) => result.log.push({ phase, text, level, device });
  const name = (id) => topo.devices.get(id)?.label ?? id;

  try {
    if (!topo.devices.has(sourceId)) throw new SimError("Choisis l'équipement source.");
    if (!isValidIp(dstIp)) throw new SimError(`« ${dstIp} » n'est pas une adresse IPv4 valide.`);

    log('request', `${name(sourceId)} envoie un ping vers ${dstIp}.`);
    const req = forward(ctx, sourceId, dstIp, 'request', result, log, name, options.srcIp);
    result.srcIp = req.srcIp;
    if (options.oneWay) {
      result.ok = true;
      return result;
    }
    log('request', `${name(req.arrivedAt)} reçoit l'echo request et répond.`, 'ok', req.arrivedAt);

    const rep = forward(ctx, req.arrivedAt, req.srcIp, 'reply', result, log, name);
    log('reply', `${name(rep.arrivedAt)} reçoit l'echo reply : ping réussi (TTL ${rep.ttl}).`, 'ok', rep.arrivedAt);
    result.ok = true;
    result.ttl = rep.ttl;
  } catch (err) {
    if (!(err instanceof SimError)) throw err;
    const phase = result.log.at(-1)?.phase ?? 'request';
    log(phase, err.message, 'error', err.device);
    result.failedAt = err.device ?? null;
  }
  return result;
}

// Achemine un paquet de startId vers dstIp, routeur après routeur.
function forward(ctx, startId, dstIp, phase, result, log, name, fixedSrc = null) {
  const { topo } = ctx;
  let current = startId;
  let srcIp = fixedSrc;
  let ttl = MAX_TTL;

  while (true) {
    const dev = topo.devices.get(current);
    const own = topo.l3Ifaces(current).find((i) => parseIp(i.ip) === parseIp(dstIp));
    if (own) return { arrivedAt: current, srcIp: srcIp ?? own.ip, ttl };

    if (current !== startId && isHost(dev)) {
      throw new SimError(`${name(current)} reçoit un paquet pour ${dstIp} mais n'est pas un routeur : il le jette.`, current);
    }
    // Chaque routeur traversé décrémente le TTL
    if (dev.type === 'router' && current !== startId && --ttl === 0) {
      throw new SimError(`${name(current)} : TTL expiré, le paquet tourne en boucle entre les routeurs.`, current);
    }

    const step = isHost(dev) ? hostDecision(topo, current, dstIp, name) : routerDecision(ctx, current, dstIp, name);
    srcIp ??= step.iface.ip;
    if (phase === 'request') result.srcIp = srcIp;
    log(phase, step.text, 'info', current);

    // Sous-interface 802.1Q : la trame part étiquetée sur le trunk
    const tag = step.iface.sub && !step.iface.native ? Number(step.iface.vlan) : null;
    const l2 = deliver(topo, current, step.iface.link, step.nextHop, name, tag);
    result.hops.push(...l2.hops.map((h) => ({ ...h, phase })));
    result.path.push({ phase, device: l2.endpoint, ip: topo.l3IfaceOn(l2.endpoint, l2.inLink, l2.tag)?.ip ?? null });
    const via = l2.vlan != null ? ` (VLAN ${l2.vlan})` : '';
    log(
      phase,
      topo.links.get(step.iface.link).cable === 'serial'
        ? `Liaison série point à point : ${name(l2.endpoint)} reçoit le paquet.`
        : `ARP : ${step.nextHop} est ${name(l2.endpoint)}${via}. Trame transmise.`,
      'info',
      l2.endpoint,
    );
    current = l2.endpoint;
  }
}

function hostDecision(topo, id, dstIp, name) {
  const iface = topo.hostIface(id);
  if (!iface.link) {
    const onlyConsole = topo.consoleLinks.some((l) => topo.links.get(l).source === id || topo.links.get(l).target === id);
    throw new SimError(
      onlyConsole
        ? `${name(id)} n'a qu'un câble console : il sert à configurer, pas à transporter du trafic.`
        : `${name(id)} n'est relié à aucun équipement.`,
      id,
    );
  }
  if (!topo.isUp(iface.link)) throw new SimError(`${name(id)} : câble hors service. ${topo.status.get(iface.link).reason}`, id);
  if (!isValidIp(iface.ip) || !isValidCidr(iface.mask)) {
    throw new SimError(`${name(id)} n'a pas d'adresse IP ou de masque valide.`, id);
  }
  const net = networkLabel(iface.ip, iface.mask);
  if (sameSubnet(iface.ip, dstIp, iface.mask)) {
    return { iface, nextHop: dstIp, text: `${name(id)} : ${dstIp} est dans son réseau ${net}, envoi direct.` };
  }
  if (!isValidIp(iface.gateway)) {
    throw new SimError(`${name(id)} : ${dstIp} est hors de son réseau ${net} et aucune passerelle n'est configurée.`, id);
  }
  if (!sameSubnet(iface.ip, iface.gateway, iface.mask)) {
    throw new SimError(`${name(id)} : la passerelle ${iface.gateway} n'est pas dans le réseau ${net}.`, id);
  }
  return {
    iface,
    nextHop: iface.gateway,
    text: `${name(id)} : ${dstIp} est hors de son réseau ${net}, envoi à la passerelle ${iface.gateway}.`,
  };
}

const DECISION = {
  S: 'route statique', 'S*': 'route statique par défaut', O: 'route OSPF', 'O IA': 'route OSPF inter-zones',
  'O E2': 'route OSPF externe (E2)', 'O*E2': 'route OSPF par défaut (E2)', R: 'route RIP', 'R*': 'route RIP par défaut', B: 'route BGP',
};

function routerDecision({ topo, routing }, id, dstIp, name) {
  const ifaces = topo.l3Ifaces(id);
  const rib = routing.ribs.get(id) ?? new Map();
  const route = lookup(rib, dstIp);
  if (!route) throw new SimError(noRoute(topo, routing, id, dstIp, name), id);

  const netText = `${formatIp(route.net)}/${route.mask}`;
  if (route.proto === 'C' || route.proto === 'L') {
    const iface = ifaces.find((i) => i.name === route.iface);
    if (iface.loopback) throw new SimError(`${name(id)} : ${dstIp} est dans le réseau de ${iface.name} (loopback), mais aucune interface n'a cette adresse.`, id);
    return { iface, nextHop: dstIp, text: `${name(id)} : ${netText} est connecté sur ${iface.name}.` };
  }

  // BGP : le next-hop est résolu par l'IGP (récursif)
  let hop = { nextHop: route.nextHop, iface: route.iface };
  let via = '';
  if (route.recursive) {
    const igp = lookup(rib, route.nextHop, (r) => r.proto !== 'B');
    if (!igp) throw new SimError(`${name(id)} : route BGP ${netText} via ${route.nextHop}, mais ce next-hop est injoignable.`, id);
    hop = { nextHop: igp.proto === 'C' ? route.nextHop : igp.nextHop, iface: igp.iface };
    via = `, next-hop ${route.nextHop} résolu par ${igp.proto === 'C' ? 'réseau connecté' : `${DECISION[igp.proto] ?? igp.proto} via ${igp.nextHop}`}`;
  }
  const out = ifaces.find((i) => i.name === hop.iface);
  const detail =
    route.proto.endsWith('E2') ? `, métrique externe ${route.metric}`
      : route.proto.startsWith('O') ? `, coût ${route.metric}`
      : route.proto.startsWith('R') ? `, ${route.metric} saut${route.metric > 1 ? 's' : ''}`
        : route.proto === 'B' ? `, AS_PATH ${route.asPath.length ? route.asPath.join(' ') : '(même AS)'}${via}`
          : '';
  return { iface: out, nextHop: hop.nextHop, text: `${name(id)} : ${DECISION[route.proto] ?? route.proto} ${netText} via ${route.nextHop} (${out.name})${detail}.` };
}

// Pourquoi aucune route : interface down, route statique inutilisable, protocole mal configuré
function noRoute(topo, routing, id, dstIp, name) {
  const all = topo.l3Ifaces(id, { includeDown: true });
  const down = all.find((i) => !i.loopback && (i.shutdown || !topo.isUp(i.link)) && sameSubnet(i.ip, dstIp, i.mask));
  if (down) {
    const why = down.shutdown ? `${name(id)} ${down.name} est désactivée (shutdown).`
      : down.link ? topo.status.get(down.link).reason : `${down.parent ?? down.name} n'est pas câblée.`;
    return `${name(id)} : ${networkLabel(down.ip, down.mask)} est sur ${down.name}, mais l'interface est down. ${why}`;
  }

  const statics = (topo.devices.get(id).config?.routes ?? [])
    .filter((r) => isValidIp(r.network) && isValidCidr(r.mask) && isValidIp(r.nextHop) && networkOf(dstIp, r.mask) === networkOf(r.network, r.mask))
    .sort((a, b) => b.mask - a.mask);
  for (const r of statics) {
    const netText = `${formatIp(networkOf(r.network, r.mask))}/${r.mask}`;
    const downOut = all.find((i) => !i.loopback && sameSubnet(i.ip, r.nextHop, i.mask));
    if (downOut) return `${name(id)} : le saut suivant ${r.nextHop} est derrière ${downOut.name}, qui est down. ${topo.status.get(downOut.link).reason}`;
    return `${name(id)} : le saut suivant ${r.nextHop} de la route ${netText} n'est sur aucun réseau connecté.`;
  }

  const hints = routing.routers?.get(id)?.issues.map((i) => i.text) ?? [];
  const tail = hints.length ? ` Piste : ${hints.slice(0, 2).join(' ')}` : '';
  return `${name(id)} : aucune route vers ${dstIp} (destination injoignable).${tail}`;
}

// Résolution ARP + acheminement de la trame dans le domaine de diffusion.
// Renvoie le chemin (liste de câbles) jusqu'à l'équipement qui possède targetIp.
function deliver(topo, fromId, linkId, targetIp, name, tag = null) {
  if (!topo.isUp(linkId)) throw new SimError(`${name(fromId)} : câble hors service. ${topo.status.get(linkId).reason}`, fromId);
  const target = parseIp(targetIp);
  const { endpoints, drops, vlansSeen } = flood(topo, fromId, linkId, tag);
  for (const e of endpoints) {
    const iface = topo.l3IfaceOn(e.device, e.inLink, e.tag);
    if (iface && isValidIp(iface.ip) && parseIp(iface.ip) === target) return { endpoint: e.device, inLink: e.inLink, tag: e.tag, hops: e.hops, vlan: e.vlan };
  }
  const where = vlansSeen.size ? ` dans le VLAN ${[...vlansSeen].join(', ')}` : ' sur ce lien';
  const extra = drops.length ? ` (${drops.join(' ; ')})` : '';
  throw new SimError(`${name(fromId)} : pas de réponse ARP, aucun équipement ne possède ${targetIp}${where}${extra}.`, fromId);
}
