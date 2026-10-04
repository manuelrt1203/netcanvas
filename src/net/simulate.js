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
import { buildTopology, isHost, isL3Switch, isRouting } from './topology.js';
import { isMikrotik, modelOf } from './catalog.js';
import { evaluateAcl, evaluateFirewall } from './acl.js';
import { destNat, isPrivate, natGlobals, sourceNat } from './nat.js';
import { withLeases } from './dhcp.js';
import { NAT_ICMP_TIMEOUT, activeNat, runtimeOf } from './runtime.js';
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
export function simulatePing(rawDoc, sourceId, dstIp, options = {}) {
  // Sans topologie fournie, on part du document effectif (clients DHCP avec leur bail)
  const doc = options.topo ? rawDoc : withLeases(rawDoc);
  const topo = options.topo ?? buildTopology(doc);
  const routing = options.routing ?? computeRouting(doc, topo);
  // natTable : traductions actives (table persistante du schéma) + celles faites pendant ce ping
  const runtime = runtimeOf(doc);
  const ctx = { topo, routing, natTable: [...activeNat(runtime)], now: runtime.time, natAdded: [] };
  // path : équipements atteints et adresse d'entrée (sert à traceroute)
  const result = { ok: false, hops: [], path: [], log: [], failedAt: null, srcIp: null };
  result.natAdded = ctx.natAdded; // traductions créées, à enregistrer dans la table persistante
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
function forward(ctx, startId, target, phase, result, log, name, fixedSrc = null) {
  const { topo } = ctx;
  let dstIp = target; // peut changer : NAT de destination
  let current = startId;
  let srcIp = fixedSrc;
  let ttl = MAX_TTL;
  let arrived = null; // interface d'entrée sur l'équipement courant

  while (true) {
    const dev = topo.devices.get(current);
    const ownIp = (ip) => topo.l3Ifaces(current).find((i) => parseIp(i.ip) === parseIp(ip));
    // Filtrage en entrée (ACL « in », pare-feu MikroTik chain=input) ; pas sur le trafic émis par l'équipement
    if (current !== startId && isRouting(dev) && arrived) filterIn(dev, arrived, { src: srcIp, dst: dstIp }, Boolean(ownIp(dstIp)), log, phase, name);
    // NAT de destination à l'entrée (statique, dst-nat, ou retour d'une traduction)
    if (current !== startId && isRouting(dev) && arrived) {
      const t = destNat(dev, arrived, { src: srcIp, dst: dstIp }, ctx.natTable, phase === 'reply');
      if (t) {
        log(phase, `${name(current)} : NAT, destination ${dstIp} traduite en ${t.dst} (${t.how}).`, 'info', current);
        dstIp = t.dst;
      }
    }
    const own = ownIp(dstIp);
    if (own) return { arrivedAt: current, srcIp: srcIp ?? own.ip, ttl };

    if (current !== startId && !isRouting(dev)) {
      const why = dev.type !== 'switch' ? "n'est pas un routeur : il le jette"
        : modelOf(dev).l3 ? 'mais le routage IP n\'est pas activé (« ip routing »)'
          : `ne route pas (un ${modelOf(dev).short} est un switch de niveau 2 : il faut un routeur ou un switch niveau 3)`;
      throw new SimError(`${name(current)} reçoit un paquet pour ${dstIp} ${why}.`, current);
    }
    // Chaque routeur (ou switch niveau 3) traversé décrémente le TTL
    if (isRouting(dev) && current !== startId && --ttl === 0) {
      throw new SimError(`${name(current)} : TTL expiré, le paquet tourne en boucle entre les routeurs.`, current);
    }

    const step = isRouting(dev) ? routerDecision(ctx, current, dstIp, name)
      : dev.type === 'switch' ? switchHostDecision(topo, current, dstIp, name)
        : hostDecision(topo, current, dstIp, name);
    srcIp ??= step.iface.ip;
    if (phase === 'request') result.srcIp = srcIp;
    log(phase, step.text, 'info', current);
    // NAT de source (inside -> outside, masquerade) puis filtrage en sortie, comme sur IOS
    if (current !== startId && isRouting(dev)) {
      const t = sourceNat(dev, arrived, step.iface.name, step.iface.ip, { src: srcIp, dst: dstIp });
      if (t) {
        // Identifiant ICMP (le « port » du PAT) : suivant libre pour ce routeur
        const id = 1 + Math.max(0, ...ctx.natTable.filter((e) => e.router === current).map((e) => e.id ?? 0));
        const entry = {
          router: current, proto: 'icmp', insideLocal: srcIp, insideGlobal: t.src, outsideLocal: dstIp, outsideGlobal: dstIp,
          dynamic: t.dynamic, id, created: ctx.now, expires: ctx.now + NAT_ICMP_TIMEOUT,
        };
        ctx.natTable.push(entry);
        if (t.dynamic) ctx.natAdded.push(entry);
        log(phase, `${name(current)} : NAT, source ${srcIp} traduite en ${t.src} (${t.how}).`, 'info', current);
        srcIp = t.src;
      }
    }
    // Filtrage en sortie (ACL « out », pare-feu MikroTik chain=forward)
    if (current !== startId && isRouting(dev)) filterOut(dev, arrived, step.iface.name, { src: srcIp, dst: dstIp }, log, phase, name);

    // Sous-interface 802.1Q : la trame part étiquetée sur le trunk
    const tag = step.iface.sub && !step.iface.native ? Number(step.iface.vlan) : null;
    const l2 = step.iface.svi
      ? deliver(topo, current, null, step.nextHop, name, null, step.iface.vlan)
      : deliver(topo, current, step.iface.link, step.nextHop, name, tag);
    result.hops.push(...l2.hops.map((h) => ({ ...h, phase })));
    result.path.push({ phase, device: l2.endpoint, ip: l2.iface?.ip ?? null });
    const via = l2.vlan != null ? ` (VLAN ${l2.vlan})` : '';
    log(
      phase,
      topo.links.get(step.iface.link)?.cable === 'serial'
        ? `Liaison série point à point : ${name(l2.endpoint)} reçoit le paquet.`
        : `ARP : ${step.nextHop} est ${name(l2.endpoint)}${via}. Trame transmise.`,
      'info',
      l2.endpoint,
    );
    arrived = l2.iface?.name ?? null;
    current = l2.endpoint;
  }
}

const ifaceCfg = (dev, name) => (dev.config?.interfaces ?? []).find((i) => i.name === name);
const packetText = (p) => `${p.src} → ${p.dst} (ICMP)`;

function checkAcl(dev, ifName, dir, packet, log, phase, name) {
  const aclName = ifaceCfg(dev, ifName)?.[dir === 'in' ? 'aclIn' : 'aclOut'];
  if (!aclName) return;
  const where = `en ${dir === 'in' ? 'entrée' : 'sortie'} de ${ifName}`;
  const acl = dev.config?.acls?.[aclName];
  if (!acl) {
    log(phase, `${name(dev.id)} : l'ACL ${aclName} appliquée ${where} n'existe pas : tout passe (comme sur IOS).`, 'info', dev.id);
    return;
  }
  const v = evaluateAcl(acl, packet);
  const rule = v.line ? `ligne ${v.line} « ${v.text} »` : 'refus implicite à la fin de la liste (aucune ligne ne correspond)';
  if (!v.permit) throw new SimError(`${name(dev.id)} : paquet ${packetText(packet)} refusé ${where} par l'ACL ${aclName}, ${rule}.`, dev.id);
  log(phase, `${name(dev.id)} : ACL ${aclName} ${where} : autorisé (${rule}).`, 'info', dev.id);
}

function checkFirewall(dev, chain, inIface, outIface, packet, log, phase, name) {
  const v = evaluateFirewall(dev.config?.firewall, chain, packet, inIface, outIface);
  if (v.line === null) return;
  if (!v.permit) throw new SimError(`${name(dev.id)} : paquet ${packetText(packet)} bloqué par le pare-feu, règle ${v.line} « ${v.text} ».`, dev.id);
  log(phase, `${name(dev.id)} : pare-feu, règle ${v.line} « ${v.text} » : accepté.`, 'info', dev.id);
}

function filterIn(dev, inIface, packet, toSelf, log, phase, name) {
  if (isMikrotik(dev)) {
    if (toSelf) checkFirewall(dev, 'input', inIface, null, packet, log, phase, name);
  } else checkAcl(dev, inIface, 'in', packet, log, phase, name);
}

function filterOut(dev, inIface, outIface, packet, log, phase, name) {
  if (isMikrotik(dev)) checkFirewall(dev, 'forward', inIface, outIface, packet, log, phase, name);
  else checkAcl(dev, outIface, 'out', packet, log, phase, name);
}

// Switch sans routage avec une interface VLAN (administration) : se comporte comme un hôte
function switchHostDecision(topo, id, dstIp, name) {
  const svis = topo.l3Ifaces(id).filter((s) => s.svi);
  if (!svis.length) throw new SimError(`${name(id)} n'a pas d'interface VLAN active avec une adresse IP.`, id);
  const direct = svis.find((s) => sameSubnet(s.ip, dstIp, s.mask));
  if (direct) return { iface: direct, nextHop: dstIp, text: `${name(id)} : ${dstIp} est dans le réseau de ${direct.name}, envoi direct.` };
  const gw = topo.devices.get(id).config?.defaultGateway;
  const out = isValidIp(gw) && svis.find((s) => sameSubnet(s.ip, gw, s.mask));
  if (!out) {
    const l3 = modelOf(topo.devices.get(id)).l3 && !isL3Switch(topo.devices.get(id));
    throw new SimError(`${name(id)} : ${dstIp} est hors de ses réseaux et aucune passerelle par défaut (« ip default-gateway ») n'est utilisable${l3 ? ' ; ou active « ip routing »' : ''}.`, id);
  }
  return { iface: out, nextHop: gw, text: `${name(id)} : envoi à la passerelle par défaut ${gw} (${out.name}).` };
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
  if (iface.dhcpError) {
    throw new SimError(`${name(id)} n'a pas obtenu d'adresse DHCP : ${iface.dhcpError}. Il s'est donné ${iface.ip} (APIPA), sans passerelle.`, id);
  }
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
  const isDown = (i) => i.shutdown || (i.svi ? !topo.sviUp(id, i.vlan) : !i.loopback && !topo.isUp(i.link));
  const down = all.find((i) => isDown(i) && sameSubnet(i.ip, dstIp, i.mask));
  if (down) {
    const why = down.shutdown ? `${name(id)} ${down.name} est désactivée (shutdown).`
      : down.svi ? `Aucun port actif du switch n'est dans le VLAN ${down.vlan}.`
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
  // Routeur « côté Internet » (aucun réseau privé connecté) et destination privée : il manque du NAT
  if (isPrivate(dstIp) && !all.some((i) => isPrivate(i.ip))) {
    hints.unshift(`${dstIp} est une adresse privée : elle ne circule pas sur Internet. Il faut la traduire (NAT/PAT) sur le routeur de bordure.`);
  }
  const tail = hints.length ? ` Piste : ${hints.slice(0, 2).join(' ')}` : '';
  return `${name(id)} : aucune route vers ${dstIp} (destination injoignable).${tail}`;
}

// Résolution ARP + acheminement de la trame dans le domaine de diffusion.
// Renvoie le chemin (liste de câbles) jusqu'à l'équipement qui possède targetIp.
function deliver(topo, fromId, linkId, targetIp, name, tag = null, sviVlan = null) {
  if (linkId != null && !topo.isUp(linkId)) throw new SimError(`${name(fromId)} : câble hors service. ${topo.status.get(linkId).reason}`, fromId);
  const target = parseIp(targetIp);
  const { endpoints, drops, vlansSeen } = flood(topo, fromId, linkId, tag, sviVlan);
  for (const e of endpoints) {
    const iface = e.svi != null ? topo.l3Ifaces(e.device).find((s) => s.svi && s.vlan === e.svi) : topo.l3IfaceOn(e.device, e.inLink, e.tag);
    // Le routeur répond aussi en ARP pour ses adresses publiques de NAT statique
    const natOwner = iface && natGlobals(topo.devices.get(e.device), iface.name).includes(targetIp);
    if (iface && isValidIp(iface.ip) && (parseIp(iface.ip) === target || natOwner)) {
      return { endpoint: e.device, inLink: e.inLink, tag: e.tag, hops: e.hops, vlan: e.vlan, iface };
    }
  }
  const where = vlansSeen.size ? ` dans le VLAN ${[...vlansSeen].join(', ')}` : ' sur ce lien';
  const extra = drops.length ? ` (${drops.join(' ; ')})` : '';
  throw new SimError(`${name(fromId)} : pas de réponse ARP, aucun équipement ne possède ${targetIp}${where}${extra}.`, fromId);
}
