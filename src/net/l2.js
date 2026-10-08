// Niveau 2 : parcours en largeur du domaine de diffusion depuis un câble.
// Sert à la résolution ARP du ping et à la découverte des voisins OSPF / RIP.
import { macOf } from './mac.js';
import { macText, nativeOf } from './switching.js';

// Renvoie les équipements de niveau 3 (hôtes, routeurs) atteints par une trame non étiquetée,
// dans l'ordre du parcours, avec le chemin suivi ; et les trames perdues en route.
// startTag : trame émise étiquetée (sous-interface 802.1Q d'un routeur)
// sviVlan : trame émise par l'interface VLAN d'un switch niveau 3 (linkId est alors null)
export function flood(topo, fromId, linkId, startTag = null, sviVlan = null) {
  const queue = linkId == null
    ? [{ device: fromId, inLink: null, tag: null, vlan: sviVlan, internal: true, hops: [] }]
    : [{ device: topo.other(linkId, fromId), inLink: linkId, tag: startTag, vlan: startTag, hops: [{ edge: linkId, from: fromId, to: topo.other(linkId, fromId), tag: startTag }] }];
  const seen = new Set();
  const reached = new Set();
  const endpoints = [];
  const drops = [];
  const vlansSeen = new Set();
  const switches = []; // switches atteints par la diffusion : { device, inLink, vlan } (apprentissage MAC)
  const traversed = queue[0].hops.slice(); // tous les câbles parcourus par la diffusion (simulation pas à pas)
  let storm = null; // boucle sans STP atteinte : tempête de diffusion
  // MAC source (port-security) : carte de l'émetteur sur ce câble, ou son interface VLAN
  const src = topo.devices.get(fromId);
  const srcMac = src && (linkId != null || sviVlan != null) ? macText(macOf(src, linkId != null ? topo.portName(linkId, fromId) : `Vlan${sviVlan}`)) : null;

  while (queue.length) {
    const { device, inLink, tag, vlan, hops, internal } = queue.shift();
    const dev = topo.devices.get(device);

    // Hub : répète la trame telle quelle sur tous ses autres ports
    if (dev.type === 'hub') {
      const key = `${device}|${tag}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const out of topo.linksOf.get(device)) {
        if (out === inLink) continue;
        if (!topo.isUp(out)) {
          drops.push(`câble ${dev.label} ${topo.portName(out, device)} hors service : ${topo.status.get(out).reason}`);
          continue;
        }
        const next = topo.other(out, device);
        const hop = { edge: out, from: device, to: next, tag };
        traversed.push(hop);
        queue.push({ device: next, inLink: out, tag, vlan, hops: [...hops, hop] });
      }
      continue;
    }

    if (dev.type === 'switch') {
      let v;
      if (internal) v = vlan;
      else {
        const r = topo.ingress(device, inLink, tag);
        if (r.drop) {
          drops.push(r.drop);
          continue;
        }
        v = r.vlan;
        // Port-security en restrict / protect : MAC en trop jetée
        const ps = srcMac && topo.psDrop?.(device, inLink, srcMac);
        if (ps) {
          drops.push(ps);
          continue;
        }
      }
      // Port bloqué par STP : la trame est jetée à l'entrée
      if (!internal && topo.stp?.blocked(device, inLink, v)) continue;
      vlansSeen.add(v);
      storm ??= topo.stp?.storm(device, v) ?? null;
      const key = `${device}|${v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      switches.push({ device, inLink, vlan: v });
      // La trame atteint l'interface VLAN du switch (SVI)
      if (device !== fromId && topo.l3Ifaces(device).some((s) => s.svi && s.vlan === v)) {
        endpoints.push({ device, inLink, tag: null, svi: v, hops, vlan: v });
      }

      for (const out of topo.l2Links(device)) {
        if (out === inLink) continue;
        const p = topo.switchPort(device, out);
        if (!topo.carries(device, out, v)) {
          // Trunk qui refuse ce VLAN : on le dit (un port access d'un autre VLAN, c'est normal)
          if (p.mode === 'trunk' && topo.isUp(out)) drops.push(topo.vlanExists(device, v) ? `${dev.label} ${p.name} : le VLAN ${v} n'est pas autorisé sur ce trunk (switchport trunk allowed vlan)` : `${dev.label} (client VTP) ne connaît pas le VLAN ${v}`);
          continue;
        }
        const outTag = topo.egressTag(device, out, v);
        // Trunk entre deux switches avec des VLAN natifs différents : PVST+ bloque ces deux VLAN (PVID inconsistent)
        const peer = topo.devices.get(topo.other(out, device));
        if (p.mode === 'trunk' && peer.type === 'switch') {
          const q = topo.switchPort(peer.id, out);
          if (q.mode === 'trunk' && nativeOf(q) !== nativeOf(p) && [nativeOf(p), nativeOf(q)].includes(v)) {
            drops.push(`${dev.label} ${p.name} ↔ ${peer.label} ${q.name} : VLAN natifs différents (${nativeOf(p)} et ${nativeOf(q)}), le trunk est bloqué (%CDP-4-NATIVE_VLAN_MISMATCH)`);
            continue;
          }
        }
        if (topo.stp?.blocked(device, out, v)) continue;
        if (!topo.isUp(out)) {
          drops.push(`câble ${dev.label} ${p.name} hors service : ${topo.status.get(out).reason}`);
          continue;
        }
        const next = topo.other(out, device);
        const hop = { edge: out, from: device, to: next, tag: outTag };
        traversed.push(hop);
        queue.push({ device: next, inLink: out, tag: outTag, vlan: v, hops: [...hops, hop] });
      }
      continue;
    }

    // Hôte : seulement des trames non étiquetées. Routeur : une trame étiquetée arrive sur sa sous-interface.
    if (tag != null && !topo.l3IfaceOn(device, inLink, tag)) {
      drops.push(dev.type === 'router'
        ? `${dev.label} n'a pas de sous-interface pour le VLAN ${tag} sur ${topo.portName(inLink, device)}`
        : `${dev.label} ne gère pas les trames étiquetées (VLAN ${tag})`);
      continue;
    }
    const key = `${device}|${inLink}|${tag}`;
    if (reached.has(key) || device === fromId) continue;
    reached.add(key);
    endpoints.push({ device, inLink, tag, hops, vlan });
  }
  return { endpoints, drops, vlansSeen, switches, traversed, storm };
}
