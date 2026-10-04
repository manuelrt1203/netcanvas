// Contrôles de cohérence du plan d'adressage, affichés en direct dans l'éditeur.
import { isBroadcastAddress, isNetworkAddress, isValidCidr, isValidIp, networkLabel, sameSubnet } from './ip.js';
import { buildTopology, isHost } from './topology.js';
import { computeRouting } from './routing.js';

// ctx : topologie et routage déjà calculés par l'éditeur (évite de tout refaire)
export function validate(doc, ctx = {}) {
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
  return issues;
}
