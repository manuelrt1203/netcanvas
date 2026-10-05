// Contrôles de cohérence du plan d'adressage, affichés en direct dans l'éditeur.
import { isBroadcastAddress, isNetworkAddress, isValidCidr, isValidIp, networkLabel, sameSubnet } from './ip.js';
import { buildTopology, isHost, v6Forwarding } from './topology.js';
import { computeRouting } from './routing.js';
import { withLeases } from './dhcp.js';
import { dnsServerOf, isHostname, serviceEnabled } from './services.js';
import { blocksNdp } from './acl6.js';
import { isLinkLocal6, isUnicast6, isValidIp6, isValidPrefix6, kindOf6, networkLabel6, normIp6, sameSubnet6 } from './ip6.js';

// ctx : topologie et routage déjà calculés par l'éditeur (évite de tout refaire)
export function validate(rawDoc, ctx = {}) {
  const doc = ctx.topo ? rawDoc : withLeases(rawDoc);
  const topo = ctx.topo ?? buildTopology(doc);
  const issues = [];
  const add = (device, level, text) => issues.push({ device, level, text });
  const ipOwners = new Map();

  function checkAddress(d, where, ip, mask) {
    if (!ip) return false;
    if (!isValidIp(ip)) return add(d.id, 'error', `${where} : « ${ip} » n'est pas une IPv4 valide.`), false;
    if (!isValidCidr(mask)) return add(d.id, 'error', `${where} : masque manquant ou invalide.`), false;
    if (isNetworkAddress(ip, mask)) add(d.id, 'error', `${where} : ${ip} est l'adresse du réseau ${networkLabel(ip, mask)}.`);
    if (isBroadcastAddress(ip, mask)) add(d.id, 'error', `${where} : ${ip} est l'adresse de diffusion de ${networkLabel(ip, mask)}.`);
    const owners = ipOwners.get(ip) ?? [];
    owners.push({ id: d.id, where });
    ipOwners.set(ip, owners);
    return true;
  }

  for (const d of topo.devices.values()) {
    const links = topo.linksOf.get(d.id);

    if (isHost(d)) {
      const i = topo.hostIface(d.id);
      const ok = checkAddress(d, d.label, i.ip, i.mask);
      if (i.gateway) {
        if (!isValidIp(i.gateway)) add(d.id, 'error', `${d.label} : passerelle « ${i.gateway} » invalide.`);
        else if (ok && !sameSubnet(i.ip, i.gateway, i.mask)) {
          add(d.id, 'error', `${d.label} : la passerelle ${i.gateway} est hors du réseau ${networkLabel(i.ip, i.mask)}.`);
        }
      }
      if (links.length > 1) add(d.id, 'warning', `${d.label} a ${links.length} câbles, seule sa première carte réseau est utilisée.`);
      if (i.ip && !links.length) add(d.id, 'warning', `${d.label} a une adresse IP mais aucun câble réseau n'est branché sur sa carte.`);
    }

    if (d.type === 'router') {
      const valid = [];
      for (const l of links) {
        const i = topo.routerIface(d.id, l);
        if (checkAddress(d, `${d.label} ${i.name}`, i.ip, i.mask)) valid.push(i);
      }
      // Sous-interfaces 802.1Q
      const seenVlans = new Map();
      for (const s of topo.subIfaces(d.id)) {
        if (!s.link) add(d.id, 'warning', `${d.label} ${s.name} : l'interface parente ${s.parent} n'est pas câblée.`);
        const key = `${s.parent}|${s.vlan}`;
        if (seenVlans.has(key)) add(d.id, 'error', `${d.label} : ${seenVlans.get(key)} et ${s.name} utilisent le même VLAN ${s.vlan} sur ${s.parent}.`);
        seenVlans.set(key, s.name);
        if (checkAddress(d, `${d.label} ${s.name}`, s.ip, s.mask)) valid.push(s);
      }
      for (let a = 0; a < valid.length; a++) {
        for (let b = a + 1; b < valid.length; b++) {
          const [x, y] = [valid[a], valid[b]];
          const m = Math.min(x.mask, y.mask);
          if (sameSubnet(x.ip, y.ip, m)) {
            add(d.id, 'error', `${d.label} : ${x.name} et ${y.name} sont dans le même réseau ${networkLabel(x.ip, m)}.`);
          }
        }
      }
      for (const r of d.config?.routes ?? []) {
        if (!isValidIp(r.network) || !isValidCidr(r.mask) || !isValidIp(r.nextHop)) {
          add(d.id, 'error', `${d.label} : route statique incomplète ou invalide.`);
        } else if (!valid.some((i) => sameSubnet(i.ip, r.nextHop, i.mask))) {
          add(d.id, 'warning', `${d.label} : le saut suivant ${r.nextHop} n'est sur aucun réseau connecté.`);
        }
      }
    }
  }

  // ACL appliquées : elles doivent exister (sinon IOS laisse tout passer, souvent par erreur)
  for (const d of topo.devices.values()) {
    for (const i of d.config?.interfaces ?? []) {
      for (const [dir, key] of [['entrée', 'aclIn'], ['sortie', 'aclOut']]) {
        if (i[key] && !d.config?.acls?.[i[key]]) add(d.id, 'warning', `${d.label} ${i.name} : l'ACL ${i[key]} appliquée en ${dir} n'existe pas, tout passe.`);
      }
    }
  }

  // DHCP : clients sans bail, et pools qui ne couvrent aucun réseau du serveur
  for (const d of topo.devices.values()) {
    if (d.config?.dhcpError) add(d.id, 'error', `${d.label} n'obtient pas d'adresse DHCP : ${d.config.dhcpError}.`);
    for (const p of d.config?.dhcp?.pools ?? []) {
      if (!isValidIp(p.network) || !isValidCidr(p.mask)) add(d.id, 'error', `${d.label} : le pool DHCP ${p.name ?? ''} n'a pas de réseau valide.`);
      else if (p.defaultRouter && !sameSubnet(p.network, p.defaultRouter, Number(p.mask))) {
        add(d.id, 'warning', `${d.label} : la passerelle ${p.defaultRouter} du pool ${p.name ?? p.network} est hors du réseau ${networkLabel(p.network, Number(p.mask))}.`);
      }
    }
  }

  // NAT Cisco : interfaces inside / outside, ACL et pools référencés
  for (const d of topo.devices.values()) {
    const nat = d.config?.nat;
    if (!nat || (!nat.statics?.length && !nat.dynamic?.length)) continue;
    const ifs = d.config.interfaces ?? [];
    if (!ifs.some((i) => i.natInside)) add(d.id, 'warning', `${d.label} : NAT configuré mais aucune interface « ip nat inside » : rien n'est traduit.`);
    if (!ifs.some((i) => i.natOutside)) add(d.id, 'warning', `${d.label} : NAT configuré mais aucune interface « ip nat outside » : rien n'est traduit.`);
    for (const r of nat.dynamic ?? []) {
      if (!d.config.acls?.[r.acl]) add(d.id, 'warning', `${d.label} : la règle NAT utilise l'ACL ${r.acl}, qui n'existe pas : rien n'est traduit.`);
      if (r.pool && !nat.pools?.[r.pool]) add(d.id, 'warning', `${d.label} : le pool NAT ${r.pool} n'existe pas.`);
      if (r.iface && !ifs.find((i) => i.name === r.iface)?.natOutside) add(d.id, 'warning', `${d.label} : la règle NAT sort par ${r.iface}, qui n'est pas « ip nat outside ».`);
    }
  }

  // DNS : serveur indiqué aux clients (PC, ip name-server, pools DHCP) et enregistrements des serveurs
  const ownerOfIp = (ip) => [...topo.devices.values()].find((x) => (isValidIp6(ip) ? topo.l3Ifaces6(x.id).some((i) => i.ip === normIp6(ip)) : topo.l3Ifaces(x.id).some((i) => i.ip === ip)));
  const checkDnsServer = (d, server, where) => {
    if (!isValidIp(server) && !isValidIp6(server)) return add(d.id, 'error', `${where} : serveur DNS « ${server} » invalide.`);
    const target = ownerOfIp(server);
    // Adresse hors du schéma (8.8.8.8…) : rien à vérifier
    if (target && !serviceEnabled(target, 'dns')) {
      add(d.id, 'warning', `${where} : le serveur DNS ${server} est ${target.label}, qui n'a pas de service DNS actif${target.type === 'router' ? ' (ip dns server / allow-remote-requests=yes)' : ''} : les noms ne seront pas résolus.`);
    }
  };
  for (const d of topo.devices.values()) {
    const server = dnsServerOf(d);
    if (server && !(d.config?.lease?.dns)) checkDnsServer(d, server, d.label);
    for (const p of d.config?.dhcp?.pools ?? []) if (p.dns) checkDnsServer(d, p.dns, `${d.label}, pool DHCP ${p.name ?? p.network}`);
    for (const h of d.config?.hosts ?? []) if (!isValidIp(h.ip)) add(d.id, 'error', `${d.label} : « ip host ${h.name} » a une adresse invalide.`);
    const dns = d.config?.services?.dns;
    if (!dns?.enabled) continue;
    if (!dns.records?.length) add(d.id, 'warning', `${d.label} : service DNS actif sans aucun enregistrement : il répondra « nom inconnu » à tout.`);
    const seen = new Set();
    for (const r of dns.records ?? []) {
      if (!r.name && !r.ip) continue;
      if (!isHostname(r.name)) add(d.id, 'error', `${d.label} : enregistrement DNS « ${r.name ?? ''} » : nom invalide.`);
      else if (!isValidIp(r.ip) && !isValidIp6(r.ip)) add(d.id, 'error', `${d.label} : enregistrement DNS ${r.name} : adresse « ${r.ip ?? ''} » invalide.`);
      const key = String(r.name).toLowerCase().replace(/\.$/, '');
      // Un A et un AAAA pour le même nom sont normaux ; deux du même type, non
      const typed = `${key}|${isValidIp6(r.ip) ? 'AAAA' : 'A'}`;
      if (seen.has(typed)) add(d.id, 'warning', `${d.label} : ${r.name} a deux enregistrements ${isValidIp6(r.ip) ? 'AAAA' : 'A'}, seul le premier est donné.`);
      seen.add(typed);
    }
  }

  // IPv6 : adresses, préfixes, passerelles, routage
  const v6Owners = new Map();
  const checkV6 = (d, where, raw, prefix, { eui64 = false } = {}) => {
    if (!raw) return false;
    if (!isValidIp6(raw)) return add(d.id, 'error', `${where} : « ${raw} » n'est pas une adresse IPv6 valide.`), false;
    if (!isValidPrefix6(prefix)) return add(d.id, 'error', `${where} : longueur de préfixe IPv6 manquante (ex. /64).`), false;
    if (eui64 && prefix !== 64) add(d.id, 'error', `${where} : EUI-64 demande un préfixe /64 (ici /${prefix}).`);
    const kind = kindOf6(raw);
    if (kind === 'link-local') return add(d.id, 'error', `${where} : ${normIp6(raw)} est une link-local (fe80::/10) : mets-la dans le champ link-local, pas comme adresse globale.`), false;
    if (!isUnicast6(raw)) return add(d.id, 'error', `${where} : ${normIp6(raw)} est une adresse ${kind === 'multicast' ? 'multicast' : 'réservée'}, pas une adresse d'interface.`), false;
    return true;
  };
  for (const d of topo.devices.values()) {
    const views = topo.l3Ifaces6(d.id, { includeDown: true });
    const c = d.config ?? {};
    if (isHost(d)) {
      if (c.slaac) {
        if (c.slaacError) add(d.id, 'error', `${d.label} n'obtient pas d'adresse IPv6 automatique : ${c.slaacError}.`);
        else if (c.slaac6?.dnsError) add(d.id, 'warning', `${d.label} n'obtient pas de serveur DNS par DHCPv6 : ${c.slaac6.dnsError}.`);
      } else if (c.ipv6 && checkV6(d, `${d.label} (IPv6)`, c.ipv6, c.prefix6) && c.gateway6) {
        if (!isValidIp6(c.gateway6)) add(d.id, 'error', `${d.label} : passerelle IPv6 « ${c.gateway6} » invalide.`);
        else if (!isLinkLocal6(c.gateway6) && !sameSubnet6(c.ipv6, c.gateway6, c.prefix6)) {
          add(d.id, 'error', `${d.label} : la passerelle IPv6 ${normIp6(c.gateway6)} n'est ni une link-local ni dans le réseau ${networkLabel6(c.ipv6, c.prefix6)}.`);
        }
      }
    } else {
      const ok = [];
      for (const raw of [...(c.interfaces ?? [])]) {
        if (!raw.ipv6) continue;
        if (raw.linkLocal && (!isValidIp6(raw.linkLocal) || !isLinkLocal6(raw.linkLocal))) add(d.id, 'error', `${d.label} ${raw.name} : link-local « ${raw.linkLocal} » invalide (fe80::/10 attendu).`);
        if (checkV6(d, `${d.label} ${raw.name}`, raw.ipv6, raw.prefix6, { eui64: raw.eui64 })) {
          const v = views.find((x) => x.name === raw.name);
          if (v?.ip) ok.push(v);
        }
      }
      for (let a = 0; a < ok.length; a++) {
        for (let b = a + 1; b < ok.length; b++) {
          const p = Math.min(ok[a].prefix, ok[b].prefix);
          if (!ok[a].loopback && !ok[b].loopback && sameSubnet6(ok[a].ip, ok[b].ip, p)) {
            add(d.id, 'error', `${d.label} : ${ok[a].name} et ${ok[b].name} sont dans le même réseau IPv6 ${networkLabel6(ok[a].ip, p)}.`);
          }
        }
      }
      const active = ok.filter((v) => !v.loopback);
      if (active.length > 1 && !v6Forwarding(d)) {
        add(d.id, 'warning', `${d.label} a des adresses IPv6 sur ${active.length} interfaces mais le routage IPv6 n'est pas activé (« ipv6 unicast-routing ») : il ne route pas IPv6 et n'envoie pas d'annonces RA.`);
      }
      // DHCPv6 : pools valides, interface qui sert un pool inexistant, drapeaux sans serveur
      for (const [name, p] of Object.entries(c.dhcp6Pools ?? {})) {
        if (p.prefix && (!isValidIp6(p.prefix) || !isValidPrefix6(p.len))) add(d.id, 'error', `${d.label} : le pool DHCPv6 ${name} a un préfixe invalide.`);
        if (p.dns && !isValidIp6(p.dns)) add(d.id, 'error', `${d.label} : le pool DHCPv6 ${name} a un serveur DNS invalide (« ${p.dns} »).`);
      }
      for (const e of c.interfaces ?? []) {
        if (e.dhcp6Server && !c.dhcp6Pools?.[e.dhcp6Server]) add(d.id, 'warning', `${d.label} ${e.name} : « ipv6 dhcp server ${e.dhcp6Server} » : ce pool n'existe pas.`);
        else if (e.ndManaged && e.dhcp6Server && !c.dhcp6Pools[e.dhcp6Server].prefix) add(d.id, 'warning', `${d.label} ${e.name} : M=1 mais le pool ${e.dhcp6Server} n'a pas de « address prefix » : les PC n'auront pas d'adresse.`);
        if (e.dhcp6Relay && !isValidIp6(e.dhcp6Relay)) add(d.id, 'error', `${d.label} ${e.name} : relais DHCPv6 vers « ${e.dhcp6Relay} » : adresse IPv6 invalide.`);
        else if ((e.ndManaged || e.ndOther) && !e.dhcp6Server && !e.dhcp6Relay) add(d.id, 'warning', `${d.label} ${e.name} : le drapeau ${e.ndManaged ? 'M' : 'O'} est annoncé mais il n'y a ni serveur DHCPv6 (« ipv6 dhcp server ») ni relais (« ipv6 dhcp relay destination ») sur l'interface.`);
      }
      // ACL IPv6 appliquées : existence, et « deny ipv6 any any » explicite en entrée qui bloque NDP
      for (const e of c.interfaces ?? []) {
        for (const [k, dir] of [['aclIn6', 'en entrée'], ['aclOut6', 'en sortie']]) {
          if (!e[k]) continue;
          const acl = c.acls6?.[e[k]];
          if (!acl) { add(d.id, 'warning', `${d.label} ${e.name} : l'ACL IPv6 ${e[k]} appliquée ${dir} n'existe pas : tout passe.`); continue; }
          const line = k === 'aclIn6' && blocksNdp(acl);
          if (line) add(d.id, 'warning', `${d.label} ${e.name} : la ligne ${line} de l'ACL IPv6 ${e[k]} (${dir}) bloque aussi la découverte des voisins (NDP) : ajoute « permit icmp any any nd-ns » et « nd-na » avant.`);
        }
      }
      for (const r of c.routes6 ?? []) {
        const what = `${d.label} : route IPv6 ${r.network || '?'}/${r.prefix ?? '?'}`;
        if (!isValidIp6(r.network) || !isValidPrefix6(r.prefix)) add(d.id, 'error', `${what} : réseau ou préfixe invalide.`);
        else if (!isValidIp6(r.nextHop) && !r.iface) add(d.id, 'error', `${what} : saut suivant manquant ou invalide.`);
        else if (r.nextHop && isLinkLocal6(r.nextHop) && !r.iface) add(d.id, 'error', `${what} : le saut suivant ${normIp6(r.nextHop)} est une link-local, il faut préciser l'interface de sortie.`);
      }
    }
    for (const v of views) {
      if (!v.ip || isLinkLocal6(v.ip) || !isUnicast6(v.ip)) continue;
      const owners = v6Owners.get(v.ip) ?? [];
      owners.push({ id: d.id, where: isHost(d) ? d.label : `${d.label} ${v.name}` });
      v6Owners.set(v.ip, owners);
    }
  }
  for (const [ip, owners] of v6Owners) {
    if (owners.length > 1) add(owners[0].id, 'error', `Adresse IPv6 ${ip} en double : ${owners.map((o) => o.where).join(', ')}.`);
  }

  // Interfaces VLAN des switches : adresse, et état (une SVI sans port actif dans son VLAN est down)
  for (const d of topo.devices.values()) {
    if (d.type !== 'switch') continue;
    for (const s of topo.svis(d.id)) {
      checkAddress(d, `${d.label} ${s.name}`, s.ip, s.mask);
      if (s.ip && !s.shutdown && !topo.sviUp(d.id, s.vlan)) add(d.id, 'warning', `${d.label} ${s.name} est down : aucun port actif n'est dans le VLAN ${s.vlan}.`);
    }
  }

  // Câblage : mauvais câble, port inexistant ou déjà pris, clock rate absent…
  for (const [id, st] of topo.status) {
    if (!st.up) add(topo.links.get(id).source, 'error', st.reason);
  }

  // Liaison switch ↔ switch : les deux ports doivent être d'accord
  for (const l of topo.links.values()) {
    const [a, b] = [topo.devices.get(l.source), topo.devices.get(l.target)];
    if (a.type !== 'switch' || b.type !== 'switch') continue;
    const [pa, pb] = [topo.switchPort(a.id, l.id), topo.switchPort(b.id, l.id)];
    if (pa.mode !== pb.mode) {
      add(a.id, 'warning', `${a.label} ${pa.name} (${pa.mode}) ↔ ${b.label} ${pb.name} (${pb.mode}) : modes différents.`);
    } else if (pa.mode === 'access' && Number(pa.vlan) !== Number(pb.vlan)) {
      add(a.id, 'warning', `${a.label} ${pa.name} (VLAN ${pa.vlan}) ↔ ${b.label} ${pb.name} (VLAN ${pb.vlan}) : VLAN différents.`);
    }
  }

  // Routage dynamique : adjacences OSPF, échanges RIP, sessions BGP qui ne montent pas
  for (const i of (ctx.routing ?? computeRouting(doc, topo)).issues) add(i.device, i.level, i.text);

  for (const [ip, owners] of ipOwners) {
    if (owners.length > 1) {
      add(owners[0].id, 'error', `Adresse ${ip} en double : ${owners.map((o) => o.where).join(', ')}.`);
    }
  }
  // Boucle de switches sans Spanning Tree : tempête de diffusion
  for (const storm of topo.stp?.storms ?? []) {
    const names = storm.switches.map((id) => topo.devices.get(id).label).join(', ');
    add(storm.switches[0], 'error', `Boucle de switches sans STP dans le VLAN ${storm.vlan} (${names}) : tempête de diffusion, plus rien ne passe dans ce VLAN. Réactive STP ou retire un câble.`);
  }

  return issues;
}
