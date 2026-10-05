// Simulation d'un ping (ICMP echo request / reply) sur un schéma au format v2, en IPv4 ou en IPv6.
//
// Modèle :
//  - niveau 3 : chaque hôte choisit envoi direct ou passerelle selon son masque ;
//    chaque routeur cherche la route la plus spécifique dans sa table (connecté, statique, OSPF, RIP, BGP :
//    voir routing.js).
//  - niveau 2 : la résolution ARP est un parcours en largeur du domaine de diffusion,
//    en respectant les VLAN des ports de switch (access / trunk, VLAN natif 1). Un hub répète tout.
//  - niveau 1 : un câble hors service (mauvais câble, port inexistant, clock rate absent) ne transmet rien.
//  - IPv6 (destination IPv6) : préfixes et passerelle (souvent link-local) des hôtes, table IPv6 des routeurs
//    (routing6.js), NDP (Neighbor Solicitation / Advertisement) à la place d'ARP. Les ACL et le NAT IPv4
//    ne s'appliquent pas aux paquets IPv6.
import { formatIp, isValidCidr, isValidIp, networkLabel, networkOf, parseIp, sameSubnet } from './ip.js';
import { buildTopology, isHost, isL3Switch, isRouting } from './topology.js';
import { isMikrotik, modelOf } from './catalog.js';
import { evaluateAcl, evaluateFirewall } from './acl.js';
import { destNat, isPrivate, natGlobals, sourceNat } from './nat.js';
import { withLeases } from './dhcp.js';
import { NAT_ICMP_TIMEOUT, activeNat, runtimeOf } from './runtime.js';
import { macCisco, macOf } from './mac.js';
import { flood } from './l2.js';
import { computeRouting, lookup } from './routing.js';
import { serviceEnabled } from './services.js';
import { isLinkLocal6, isValidIp6, multicastMac6, networkLabel6, normIp6, sameSubnet6, solicitedNode6 } from './ip6.js';
import { lookup6, routeText6 } from './routing6.js';

const MAX_TTL = 64;

// Services d'un serveur (config.services = { dns: { enabled, records }, http: { enabled, title, body } })
// et le port sur lequel ils écoutent
export const SERVICE_PORTS = { dns: { proto: 'udp', port: 53, label: 'DNS' }, http: { proto: 'tcp', port: 80, label: 'HTTP' } };
const serviceAt = (proto, port) => Object.entries(SERVICE_PORTS).find(([, s]) => s.proto === proto && s.port === port)?.[0] ?? null;
const EPHEMERAL_PORT = 49152;
// En-têtes de transport du paquet selon le sens (la réponse inverse les ports)
function l4(ctx, phase) {
  const { proto, sport, dport } = ctx.l4;
  if (proto === 'icmp') return { proto };
  return phase === 'request' ? { proto, sport, dport } : { proto, sport: dport, dport: sport };
}

class SimError extends Error {
  constructor(text, device) {
    super(text);
    this.device = device;
  }
}

// options : topo et routing déjà calculés (BGP vérifie ses sessions avec ce ping), srcIp imposée,
//           oneWay : seulement l'aller (réponse ICMP d'un routeur pour traceroute),
//           proto / dport : requête UDP ou TCP vers un service au lieu d'un ping ; app : couche applicative
//           (pas à pas) { name, request: [[champ, valeur]], reply: [[champ, valeur]] }
export function simulatePing(rawDoc, sourceId, target, options = {}) {
  const v6 = isValidIp6(target);
  const dstIp = v6 ? normIp6(target) : target;
  // Sans topologie fournie, on part du document effectif (clients DHCP avec leur bail)
  const doc = options.topo ? rawDoc : withLeases(rawDoc);
  const topo = options.topo ?? buildTopology(doc);
  const routing = options.routing ?? computeRouting(doc, topo);
  // natTable : traductions actives (table persistante du schéma) + celles faites pendant ce ping
  const runtime = runtimeOf(doc);
  const ctx = {
    topo, routing, natTable: [...activeNat(runtime)], now: runtime.time, natAdded: [],
    arpCache: (runtime.arp ?? []).filter((e) => e.expires > runtime.time),
    learned: { arp: [], mac: [], nd: [] }, // entrées ARP / MAC / voisins IPv6 apprises pendant ce ping
    v6,
    frames: [], // trames une par une, avec leurs en-têtes (simulation pas à pas)
    cursor: 0, // journal déjà rattaché à une trame
    l4: { proto: options.proto ?? 'icmp', sport: EPHEMERAL_PORT, dport: options.dport ?? null },
    app: options.app ?? null,
  };
  const svc = ctx.l4.proto === 'icmp' ? null : serviceAt(ctx.l4.proto, ctx.l4.dport);
  const what = svc ? `une requête ${SERVICE_PORTS[svc].label} (${ctx.l4.proto.toUpperCase()} ${ctx.l4.dport})`
    : ctx.l4.proto === 'icmp' ? (v6 ? 'un ping IPv6' : 'un ping') : `un paquet ${ctx.l4.proto.toUpperCase()} ${ctx.l4.dport}`;
  // path : équipements atteints et adresse d'entrée (sert à traceroute)
  const result = { ok: false, hops: [], path: [], log: [], failedAt: null, srcIp: null };
  result.natAdded = ctx.natAdded; // traductions créées, à enregistrer dans la table persistante
  result.learned = ctx.learned;
  result.frames = ctx.frames;
  const log = (phase, text, level = 'info', device = null) => result.log.push({ phase, text, level, device });
  const name = (id) => topo.devices.get(id)?.label ?? id;

  try {
    if (!topo.devices.has(sourceId)) throw new SimError("Choisis l'équipement source.");
    if (!isValidIp(dstIp) && !v6) throw new SimError(`« ${dstIp} » n'est pas une adresse IPv4 ou IPv6 valide.`);

    log('request', `${name(sourceId)} envoie ${what} vers ${dstIp}.`);
    const req = forward(ctx, sourceId, dstIp, 'request', result, log, name, options.srcIp);
    result.srcIp = req.srcIp;
    if (options.oneWay) {
      result.ok = true;
      return result;
    }
    if (ctx.l4.proto !== 'icmp') {
      // Le paquet est arrivé : encore faut-il qu'un service écoute sur ce port
      const target = topo.devices.get(req.arrivedAt);
      const proto = ctx.l4.proto.toUpperCase();
      if (!svc || !serviceEnabled(target, svc)) {
        const service = svc ? ` (serveur ${SERVICE_PORTS[svc].label})` : '';
        throw new SimError(`${name(req.arrivedAt)} reçoit le paquet mais aucun service n'écoute sur ${proto} ${ctx.l4.dport}${service} : il répond ${ctx.l4.proto === 'tcp' ? '« connexion refusée » (TCP RST)' : '« port injoignable » (ICMP)'}.`, req.arrivedAt);
      }
      log('request', `${name(req.arrivedAt)} reçoit la requête sur ${proto} ${ctx.l4.dport} (service ${SERVICE_PORTS[svc].label}) et répond.`, 'ok', req.arrivedAt);
    } else log('request', `${name(req.arrivedAt)} reçoit l'echo request et répond.`, 'ok', req.arrivedAt);

    // La réponse à une link-local repart par l'interface d'arrivée
    ctx.replyIface = req.inIface;
    const rep = forward(ctx, req.arrivedAt, req.srcIp, 'reply', result, log, name);
    log('reply', svc ? `${name(rep.arrivedAt)} reçoit la réponse ${SERVICE_PORTS[svc].label} : échange réussi.`
      : `${name(rep.arrivedAt)} reçoit l'echo reply : ping réussi (${v6 ? 'Hop Limit' : 'TTL'} ${rep.ttl}).`, 'ok', rep.arrivedAt);
    result.ok = true;
    result.ttl = rep.ttl;
    endFrame(ctx, result, { kind: 'done', phase: 'reply', at: rep.arrivedAt, summary: svc ? `Réponse ${SERVICE_PORTS[svc].label} reçue` : 'Ping réussi' });
  } catch (err) {
    if (!(err instanceof SimError)) throw err;
    const phase = result.log.at(-1)?.phase ?? 'request';
    log(phase, err.message, 'error', err.device);
    result.failedAt = err.device ?? null;
    endFrame(ctx, result, { kind: 'drop', phase, at: err.device ?? sourceId, summary: 'Paquet perdu' });
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
    const ownIp = (ip) => (ctx.v6 ? topo.l3Ifaces6(current).find((i) => i.ip === ip || i.linkLocal === ip)
      : topo.l3Ifaces(current).find((i) => parseIp(i.ip) === parseIp(ip)));
    const v4Only = !ctx.v6; // ACL et NAT IPv4
    // Filtrage en entrée (ACL « in », pare-feu MikroTik chain=input) ; pas sur le trafic émis par l'équipement
    const pkt = () => ({ src: srcIp, dst: dstIp, ...l4(ctx, phase) });
    if (v4Only && current !== startId && isRouting(dev) && arrived) filterIn(dev, arrived, pkt(), Boolean(ownIp(dstIp)), log, phase, name);
    // NAT de destination à l'entrée (statique, dst-nat, ou retour d'une traduction)
    if (v4Only && current !== startId && isRouting(dev) && arrived) {
      const t = destNat(dev, arrived, pkt(), ctx.natTable, phase === 'reply');
      if (t) {
        log(phase, `${name(current)} : NAT, destination ${dstIp} traduite en ${t.dst} (${t.how}).`, 'info', current);
        dstIp = t.dst;
      }
    }
    const own = ownIp(dstIp);
    if (own) return { arrivedAt: current, srcIp: srcIp ?? (ctx.v6 && isLinkLocal6(dstIp) ? own.linkLocal : own.ip), ttl, inIface: arrived };

    if (current !== startId && !isRouting(dev)) {
      const why = dev.type !== 'switch' ? "n'est pas un routeur : il le jette"
        : modelOf(dev).l3 ? 'mais le routage IP n\'est pas activé (« ip routing »)'
          : `ne route pas (un ${modelOf(dev).short} est un switch de niveau 2 : il faut un routeur ou un switch niveau 3)`;
      throw new SimError(`${name(current)} reçoit un paquet pour ${dstIp} ${why}.`, current);
    }
    if (ctx.v6 && current !== startId && !dev.config?.ipv6Routing) {
      throw new SimError(`${name(current)} reçoit un paquet IPv6 pour ${dstIp} mais le routage IPv6 n'est pas activé (« ipv6 unicast-routing ») : il le jette.`, current);
    }
    if (ctx.v6 && current !== startId && isLinkLocal6(dstIp)) {
      throw new SimError(`${name(current)} : ${dstIp} est une adresse link-local, elle ne traverse jamais un routeur.`, current);
    }
    // Chaque routeur (ou switch niveau 3) traversé décrémente le TTL
    if (isRouting(dev) && current !== startId && --ttl === 0) {
      throw new SimError(`${name(current)} : ${ctx.v6 ? 'Hop Limit' : 'TTL'} expiré, le paquet tourne en boucle entre les routeurs.`, current);
    }

    const step = ctx.v6
      ? (isRouting(dev) ? routerDecision6(ctx, current, dstIp, name, phase === 'reply' && current === startId ? ctx.replyIface : null)
        : dev.type === 'switch' ? switchHostDecision6(topo, current, dstIp, name)
          : hostDecision6(topo, current, dstIp, name))
      : isRouting(dev) ? routerDecision(ctx, current, dstIp, name)
        : dev.type === 'switch' ? switchHostDecision(topo, current, dstIp, name)
          : hostDecision(topo, current, dstIp, name);
    srcIp ??= step.srcIp ?? step.iface.ip;
    if (phase === 'request') result.srcIp = srcIp;
    log(phase, step.text, 'info', current);
    // NAT de source (inside -> outside, masquerade) puis filtrage en sortie, comme sur IOS
    if (v4Only && current !== startId && isRouting(dev)) {
      const t = sourceNat(dev, arrived, step.iface.name, step.iface.ip, pkt());
      if (t) {
        // Identifiant ICMP (le « port » du PAT) : suivant libre pour ce routeur
        const id = 1 + Math.max(0, ...ctx.natTable.filter((e) => e.router === current).map((e) => e.id ?? 0));
        const entry = {
          router: current, proto: ctx.l4.proto, insideLocal: srcIp, insideGlobal: t.src, outsideLocal: dstIp, outsideGlobal: dstIp,
          dynamic: t.dynamic, id, created: ctx.now, expires: ctx.now + NAT_ICMP_TIMEOUT,
        };
        ctx.natTable.push(entry);
        if (t.dynamic) ctx.natAdded.push(entry);
        log(phase, `${name(current)} : NAT, source ${srcIp} traduite en ${t.src} (${t.how}).`, 'info', current);
        srcIp = t.src;
      }
    }
    // Filtrage en sortie (ACL « out », pare-feu MikroTik chain=forward)
    if (v4Only && current !== startId && isRouting(dev)) filterOut(dev, arrived, step.iface.name, pkt(), log, phase, name);

    // Sous-interface 802.1Q : la trame part étiquetée sur le trunk
    const tag = step.iface.sub && !step.iface.native ? Number(step.iface.vlan) : null;
    const l2 = step.iface.svi
      ? deliver(topo, current, null, step.nextHop, name, null, step.iface.vlan, ctx.v6)
      : deliver(topo, current, step.iface.link, step.nextHop, name, tag, null, ctx.v6);
    result.hops.push(...l2.hops.map((h) => ({ ...h, phase })));
    result.path.push({ phase, device: l2.endpoint, ip: l2.iface?.ip ?? null });
    const via = l2.vlan != null ? ` (VLAN ${l2.vlan})` : '';
    const serial = topo.links.get(step.iface.link)?.cable === 'serial';
    // En cache : entrée encore valide, ou apprise pendant ce ping (la cible d'une requête ARP apprend l'émetteur)
    const known = (e) => e.device === current && e.ip === step.nextHop;
    const cached = !serial && (ctx.v6 ? ctx.learned.nd.some(known) : ctx.arpCache.some(known) || ctx.learned.arp.some(known));
    const res = ctx.v6 ? 'NDP' : 'ARP';
    if (!serial) learn(ctx, dev, step, l2);
    log(
      phase,
      serial ? `Liaison série point à point : ${name(l2.endpoint)} reçoit le paquet.`
        : cached ? `${res} (en cache) : ${step.nextHop} est ${name(l2.endpoint)}${via}. Trame transmise.`
          : `${res} : ${step.nextHop} est ${name(l2.endpoint)}${via}. Trame transmise.`,
      'info',
      l2.endpoint,
    );
    addFrames(ctx, result, { dev, step, l2, phase, serial, cached, packet: { src: srcIp, dst: dstIp, ttl } });
    arrived = l2.iface?.name ?? null;
    current = l2.endpoint;
  }
}

// --- Trames pour la simulation pas à pas ---------------------------------------------------
// Chaque trame : { kind: arp-request | arp-reply | icmp | done | drop, phase, hops (câbles allumés
// ensemble), at (équipement qui la reçoit), summary, layers [{ name, fields: [[champ, valeur]] }],
// notes (ce que l'équipement émetteur a décidé, d'après le journal) }
const ETHERTYPE_IP = '0x0800 (IPv4)';
const ETHERTYPE_IP6 = '0x86DD (IPv6)';
const BROADCAST = 'ffff.ffff.ffff';

function takeNotes(ctx, result) {
  const notes = result.log.slice(ctx.cursor).map((l) => ({ text: l.text, level: l.level }));
  ctx.cursor = result.log.length;
  return notes;
}

function ethLayers(src, dst, type, tag) {
  const layers = [{ name: 'Ethernet II', fields: [['MAC destination', dst], ['MAC source', src], ['Type', type]] }];
  if (tag != null) layers.push({ name: '802.1Q', fields: [['TPID', '0x8100'], ['VLAN', String(tag)]] });
  return layers;
}

function addFrames(ctx, result, { dev, step, l2, phase, serial, cached, packet }) {
  const notes = takeNotes(ctx, result);
  const target = ctx.topo.devices.get(l2.endpoint);
  const senderMac = macCisco(macOf(dev, step.iface.name));
  const targetMac = macCisco(macOf(target, l2.iface?.name));
  const frames = [];
  if (ctx.v6 && !serial && !cached) {
    // NDP : Neighbor Solicitation au multicast « nœud sollicité », Neighbor Advertisement en retour
    const from6 = step.iface.linkLocal ?? step.iface.ip;
    const sn = solicitedNode6(step.nextHop);
    const nd = (type, tgt, extra) => ({ name: 'ICMPv6', fields: [['Type', type], ['Adresse cible', tgt], ...extra] });
    const ip6 = (src, dst) => ({ name: 'IPv6', fields: [['Source', src], ['Destination', dst], ['Hop Limit', '255'], ['Next Header', '58 (ICMPv6)']] });
    frames.push({
      kind: 'nd-ns', phase, hops: l2.traversed ?? l2.hops, at: l2.endpoint,
      summary: `NDP Neighbor Solicitation (multicast ${sn}) : qui a ${step.nextHop} ?`,
      layers: [...ethLayers(senderMac, multicastMac6(sn), ETHERTYPE_IP6, l2.hops[0]?.tag), ip6(from6, sn), nd('135 (Neighbor Solicitation)', step.nextHop, [['Option', `MAC source ${senderMac}`]])],
    });
    const isRouter = isRouting(target);
    for (const h of [...l2.hops].reverse()) {
      frames.push({
        kind: 'nd-na', phase, hops: [{ ...h, from: h.to, to: h.from }], at: h.from,
        summary: `NDP Neighbor Advertisement : ${step.nextHop} est à ${targetMac}`,
        layers: [...ethLayers(targetMac, senderMac, ETHERTYPE_IP6, h.tag), ip6(l2.iface?.linkLocal ?? step.nextHop, from6),
          nd('136 (Neighbor Advertisement)', step.nextHop, [['Drapeaux', `${isRouter ? 'R ' : ''}S O`], ['Option', `MAC cible ${targetMac}`]])],
      });
    }
  }
  if (!ctx.v6 && !serial && !cached) {
    const arp = (op, smac, sip, tmac, tip) => ({
      name: 'ARP',
      fields: [['Opération', op === 1 ? '1 (request)' : '2 (reply)'], ['MAC émetteur', smac], ['IP émetteur', sip], ['MAC cible', tmac], ['IP cible', tip]],
    });
    frames.push({
      kind: 'arp-request', phase, hops: l2.traversed ?? l2.hops, at: l2.endpoint,
      summary: `ARP request (diffusion) : qui a ${step.nextHop} ?`,
      layers: [...ethLayers(senderMac, BROADCAST, '0x0806 (ARP)', l2.hops[0]?.tag), arp(1, senderMac, step.iface.ip, '0000.0000.0000', step.nextHop)],
    });
    for (const h of [...l2.hops].reverse()) {
      frames.push({
        kind: 'arp-reply', phase, hops: [{ ...h, from: h.to, to: h.from }], at: h.from,
        summary: `ARP reply : ${step.nextHop} est à ${targetMac}`,
        layers: [...ethLayers(targetMac, senderMac, '0x0806 (ARP)', h.tag), arp(2, targetMac, step.nextHop, senderMac, step.iface.ip)],
      });
    }
  }
  const t = l4(ctx, phase);
  const PROTO_NUM = ctx.v6 ? { icmp: '58 (ICMPv6)', tcp: '6 (TCP)', udp: '17 (UDP)' } : { icmp: '1 (ICMP)', tcp: '6 (TCP)', udp: '17 (UDP)' };
  const ip = ctx.v6
    ? { name: 'IPv6', fields: [['Source', packet.src], ['Destination', packet.dst], ['Hop Limit', String(packet.ttl)], ['Next Header', PROTO_NUM[t.proto]]] }
    : { name: 'IPv4', fields: [['Source', packet.src], ['Destination', packet.dst], ['TTL', String(packet.ttl)], ['Protocole', PROTO_NUM[t.proto]]] };
  const ethertype = ctx.v6 ? ETHERTYPE_IP6 : ETHERTYPE_IP;
  const echo = ctx.v6
    ? { name: 'ICMPv6', fields: [['Type', phase === 'request' ? '128 (echo request)' : '129 (echo reply)'], ['Code', '0'], ['Identifiant', '1'], ['Séquence', '1']] }
    : { name: 'ICMP', fields: [['Type', phase === 'request' ? '8 (echo request)' : '0 (echo reply)'], ['Code', '0'], ['Identifiant', '1'], ['Séquence', '1']] };
  const upper = t.proto === 'icmp'
    ? [echo]
    : [
      { name: t.proto.toUpperCase(), fields: [['Port source', String(t.sport)], ['Port destination', String(t.dport)], ...(t.proto === 'tcp' ? [['Drapeaux', 'PSH, ACK']] : [])] },
      ...(ctx.app ? [{ name: ctx.app.name, fields: phase === 'request' ? ctx.app.request : ctx.app.reply }] : []),
    ];
  const svcName = t.proto === 'icmp' ? null : SERVICE_PORTS[serviceAt(ctx.l4.proto, ctx.l4.dport)]?.label ?? t.proto.toUpperCase();
  for (const h of l2.hops) {
    frames.push({
      kind: t.proto, phase, hops: [h], at: h.to,
      summary: t.proto === 'icmp' ? `${ctx.v6 ? 'ICMPv6' : 'ICMP'} echo ${phase === 'request' ? 'request' : 'reply'} ${packet.src} → ${packet.dst}`
        : `${svcName} ${phase === 'request' ? 'requête' : 'réponse'} ${packet.src}:${t.sport} → ${packet.dst}:${t.dport}`,
      layers: serial
        ? [{ name: 'HDLC', fields: [['Adresse', '0x0F'], ['Protocole', ethertype]] }, ip, ...upper]
        : [...ethLayers(senderMac, targetMac, ethertype, h.tag), ip, ...upper],
    });
  }
  // Ce que l'émetteur a décidé est affiché avec sa première trame
  if (frames.length) frames[0].notes = notes;
  ctx.frames.push(...frames.map((f) => ({ notes: [], ...f })));
}

function endFrame(ctx, result, frame) {
  ctx.frames.push({ hops: [], layers: [], ...frame, notes: takeNotes(ctx, result) });
}

// Apprentissage d'une livraison de niveau 2 : caches ARP de l'émetteur et de la cible,
// tables MAC des switches (la requête ARP diffusée, puis la réponse sur le chemin du retour)
function learn(ctx, dev, step, l2) {
  const { topo, learned } = ctx;
  const target = topo.devices.get(l2.endpoint);
  const senderMac = macOf(dev, step.iface.name);
  const targetMac = macOf(target, l2.iface?.name);
  if (ctx.v6) {
    learned.nd.push({ device: dev.id, ip: step.nextHop, mac: targetMac, iface: step.iface.name });
    const mine = step.iface.linkLocal ?? step.iface.ip;
    if (mine) learned.nd.push({ device: target.id, ip: mine, mac: senderMac, iface: l2.iface?.name });
  } else {
    learned.arp.push({ device: dev.id, ip: step.nextHop, mac: targetMac, iface: step.iface.name });
    if (isValidIp(step.iface.ip)) learned.arp.push({ device: target.id, ip: step.iface.ip, mac: senderMac, iface: l2.iface?.name });
  }
  for (const s of l2.switches ?? []) {
    if (s.inLink) learned.mac.push({ switch: s.device, mac: senderMac, vlan: s.vlan, port: topo.portName(s.inLink, s.device) });
  }
  for (const h of l2.hops) {
    if (topo.devices.get(h.from)?.type === 'switch') {
      learned.mac.push({ switch: h.from, mac: targetMac, vlan: l2.vlan ?? 1, port: topo.portName(h.edge, h.from) });
    }
  }
}

const ifaceCfg = (dev, name) => (dev.config?.interfaces ?? []).find((i) => i.name === name);
const packetText = (p) => (p.proto && p.proto !== 'icmp' ? `${p.src} → ${p.dst}:${p.dport} (${p.proto.toUpperCase()})` : `${p.src} → ${p.dst} (ICMP)`);

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

// --- Décisions IPv6 -----------------------------------------------------------------------------
// Chaque décision renvoie aussi srcIp : l'adresse source choisie (link-local pour une destination link-local)
function hostDecision6(topo, id, dstIp, name) {
  const base = topo.hostIface(id);
  if (!base.link) throw new SimError(`${name(id)} n'est relié à aucun équipement.`, id);
  if (!topo.isUp(base.link)) throw new SimError(`${name(id)} : câble hors service. ${topo.status.get(base.link).reason}`, id);
  const v = topo.l3Ifaces6(id, { includeDown: true })[0];
  if (isLinkLocal6(dstIp)) {
    return { iface: v, nextHop: dstIp, srcIp: v.linkLocal, text: `${name(id)} : ${dstIp} est une link-local, envoi direct sur son lien depuis ${v.linkLocal}.` };
  }
  if (v.slaac && v.slaacError) throw new SimError(`${name(id)} n'a pas d'adresse IPv6 automatique (SLAAC) : ${v.slaacError}.`, id);
  if (!v.ip || v.prefix == null) throw new SimError(`${name(id)} n'a pas d'adresse IPv6 globale (seulement sa link-local ${v.linkLocal}) : il ne peut joindre que son lien.`, id);
  const net = networkLabel6(v.ip, v.prefix);
  if (sameSubnet6(v.ip, dstIp, v.prefix)) {
    return { iface: v, nextHop: dstIp, srcIp: v.ip, text: `${name(id)} : ${dstIp} est dans son réseau ${net}, envoi direct.` };
  }
  if (!v.gateway) throw new SimError(`${name(id)} : ${dstIp} est hors de son réseau ${net} et aucune passerelle IPv6 n'est configurée.`, id);
  if (!isLinkLocal6(v.gateway) && !sameSubnet6(v.ip, v.gateway, v.prefix)) {
    throw new SimError(`${name(id)} : la passerelle IPv6 ${v.gateway} n'est ni une link-local ni dans le réseau ${net}.`, id);
  }
  const how = v.slaac ? ' (apprise par l\'annonce RA)' : '';
  return { iface: v, nextHop: v.gateway, srcIp: v.ip, text: `${name(id)} : ${dstIp} est hors de son réseau ${net}, envoi à la passerelle ${v.gateway}${how}.` };
}

function switchHostDecision6(topo, id, dstIp, name) {
  const svis = topo.l3Ifaces6(id).filter((s) => s.svi);
  const direct = svis.find((s) => (isLinkLocal6(dstIp) ? true : s.ip && sameSubnet6(s.ip, dstIp, s.prefix)));
  if (!direct) throw new SimError(`${name(id)} : aucune interface VLAN en IPv6 n'est dans le réseau de ${dstIp}.`, id);
  return { iface: direct, nextHop: dstIp, srcIp: isLinkLocal6(dstIp) ? direct.linkLocal : direct.ip, text: `${name(id)} : ${dstIp} est dans le réseau de ${direct.name}, envoi direct.` };
}

function routerDecision6({ topo, routing }, id, dstIp, name, replyIface) {
  const ifaces = topo.l3Ifaces6(id);
  // Link-local : seulement sur le lien d'où vient la demande
  if (isLinkLocal6(dstIp)) {
    const out = replyIface && ifaces.find((i) => i.name === replyIface);
    if (!out) throw new SimError(`${name(id)} : ${dstIp} est une link-local ; il faut préciser l'interface de sortie (une link-local n'existe que sur son lien).`, id);
    return { iface: out, nextHop: dstIp, srcIp: out.linkLocal, text: `${name(id)} : ${dstIp} est une link-local, réponse par ${out.name}.` };
  }
  const rib = routing.ribs6?.get(id) ?? new Map();
  const route = lookup6(rib, dstIp);
  if (!route) throw new SimError(noRoute6(topo, id, dstIp, name), id);
  const netText = routeText6(route);
  const out = ifaces.find((i) => i.name === route.iface);
  const srcIp = out.ip ?? out.linkLocal;
  if (route.proto === 'C' || route.proto === 'L') {
    if (out.loopback) throw new SimError(`${name(id)} : ${dstIp} est dans le réseau de ${out.name} (loopback), mais aucune interface n'a cette adresse.`, id);
    return { iface: out, nextHop: dstIp, srcIp, text: `${name(id)} : ${netText} est connecté sur ${out.name}.` };
  }
  const hop = route.nextHop ?? dstIp;
  const kind = DECISION[route.proto] ?? route.proto;
  return { iface: out, nextHop: hop, srcIp, text: `${name(id)} : ${kind} IPv6 ${netText} via ${route.nextHop ?? 'interface directe'} (${out.name}).` };
}

// Pourquoi aucune route IPv6 : interface down, route statique inutilisable, sinon rien
function noRoute6(topo, id, dstIp, name) {
  const all = topo.l3Ifaces6(id, { includeDown: true });
  const isDown = (i) => i.shutdown || (i.svi ? !topo.sviUp(id, i.vlan) : !i.loopback && !topo.isUp(i.link));
  const down = all.find((i) => i.ip && i.prefix != null && isDown(i) && sameSubnet6(i.ip, dstIp, i.prefix));
  if (down) {
    const why = down.shutdown ? `${name(id)} ${down.name} est désactivée (shutdown).` : down.link ? topo.status.get(down.link).reason : `${down.name} n'est pas câblée.`;
    return `${name(id)} : ${networkLabel6(down.ip, down.prefix)} est sur ${down.name}, mais l'interface est down. ${why}`;
  }
  for (const r of topo.devices.get(id).config?.routes6 ?? []) {
    if (!isValidIp6(r.network) || r.prefix == null || !sameSubnet6(r.network, dstIp, r.prefix)) continue;
    const text = networkLabel6(r.network, r.prefix);
    if (r.nextHop && isLinkLocal6(r.nextHop) && !r.iface) return `${name(id)} : la route IPv6 ${text} a un saut suivant link-local (${r.nextHop}) sans interface de sortie : elle n'est pas installée.`;
    return `${name(id)} : le saut suivant ${r.nextHop ?? r.iface} de la route IPv6 ${text} n'est sur aucun réseau connecté actif.`;
  }
  return `${name(id)} : aucune route IPv6 vers ${dstIp} (destination injoignable).`;
}

// Résolution ARP + acheminement de la trame dans le domaine de diffusion.
// Renvoie le chemin (liste de câbles) jusqu'à l'équipement qui possède targetIp.
function deliver(topo, fromId, linkId, targetIp, name, tag = null, sviVlan = null, v6 = false) {
  if (linkId != null && !topo.isUp(linkId)) throw new SimError(`${name(fromId)} : câble hors service. ${topo.status.get(linkId).reason}`, fromId);
  const target = v6 ? null : parseIp(targetIp);
  const { endpoints, drops, vlansSeen, switches, traversed, storm } = flood(topo, fromId, linkId, tag, sviVlan);
  if (storm) {
    const names = storm.switches.map((id) => name(id)).join(', ');
    throw new SimError(`Tempête de diffusion dans le VLAN ${storm.vlan} : la requête ${v6 ? 'NDP' : 'ARP'} tourne sans fin dans la boucle entre ${names}, car STP est désactivé. Le réseau est saturé et plus rien ne passe. Réactive STP (« spanning-tree vlan ${storm.vlan} ») ou retire un câble de la boucle.`, fromId);
  }
  for (const e of endpoints) {
    if (v6) {
      const i6 = e.svi != null ? topo.l3Ifaces6(e.device).find((s) => s.svi && s.vlan === e.svi) : topo.l3IfaceOn6(e.device, e.inLink, e.tag);
      if (i6 && !i6.shutdown && (i6.ip === targetIp || i6.linkLocal === targetIp)) {
        return { endpoint: e.device, inLink: e.inLink, tag: e.tag, hops: e.hops, vlan: e.vlan, iface: i6, switches, traversed };
      }
      continue;
    }
    const iface = e.svi != null ? topo.l3Ifaces(e.device).find((s) => s.svi && s.vlan === e.svi) : topo.l3IfaceOn(e.device, e.inLink, e.tag);
    // Le routeur répond aussi en ARP pour ses adresses publiques de NAT statique
    const natOwner = iface && natGlobals(topo.devices.get(e.device), iface.name).includes(targetIp);
    if (iface && isValidIp(iface.ip) && (parseIp(iface.ip) === target || natOwner)) {
      return { endpoint: e.device, inLink: e.inLink, tag: e.tag, hops: e.hops, vlan: e.vlan, iface, switches, traversed };
    }
  }
  const where = vlansSeen.size ? ` dans le VLAN ${[...vlansSeen].join(', ')}` : ' sur ce lien';
  const extra = drops.length ? ` (${drops.join(' ; ')})` : '';
  throw new SimError(`${name(fromId)} : pas de réponse ${v6 ? 'NDP (Neighbor Advertisement)' : 'ARP'}, aucun équipement ne possède ${targetIp}${where}${extra}.`, fromId);
}
