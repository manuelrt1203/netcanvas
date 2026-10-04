// Niveau 2 : parcours en largeur du domaine de diffusion depuis un câble.
// Sert à la résolution ARP du ping et à la découverte des voisins OSPF / RIP.
import { NATIVE_VLAN } from './topology.js';

// Renvoie les équipements de niveau 3 (hôtes, routeurs) atteints par une trame non étiquetée,
// dans l'ordre du parcours, avec le chemin suivi ; et les trames perdues en route.
// startTag : trame émise étiquetée (sous-interface 802.1Q d'un routeur)
// sviVlan : trame émise par l'interface VLAN d'un switch niveau 3 (linkId est alors null)
export function flood(topo, fromId, linkId, startTag = null, sviVlan = null) {
  const queue = linkId == null
    ? [{ device: fromId, inLink: null, tag: null, vlan: sviVlan, internal: true, hops: [] }]
    : [{ device: topo.other(linkId, fromId), inLink: linkId, tag: startTag, vlan: startTag, hops: [{ edge: linkId, from: fromId, to: topo.other(linkId, fromId) }] }];
  const seen = new Set();
  const reached = new Set();
  const endpoints = [];
  const drops = [];
  const vlansSeen = new Set();

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
          drops.push(`câble ${dev.label} ${topo.portName(out, device)} hors service`);
          continue;
        }
        const next = topo.other(out, device);
        queue.push({ device: next, inLink: out, tag, vlan, hops: [...hops, { edge: out, from: device, to: next }] });
      }
      continue;
    }

    if (dev.type === 'switch') {
      let v;
      if (internal) v = vlan;
      else {
        const port = topo.switchPort(device, inLink);
        if (tag == null) v = port.mode === 'trunk' ? NATIVE_VLAN : Number(port.vlan) || NATIVE_VLAN;
        else if (port.mode === 'trunk') v = tag;
        else {
          drops.push(`${dev.label} ${port.name} (access) jette une trame étiquetée VLAN ${tag}`);
          continue;
        }
      }
      vlansSeen.add(v);
      const key = `${device}|${v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // La trame atteint l'interface VLAN du switch (SVI)
      if (device !== fromId && topo.l3Ifaces(device).some((s) => s.svi && s.vlan === v)) {
        endpoints.push({ device, inLink, tag: null, svi: v, hops, vlan: v });
      }

      for (const out of topo.linksOf.get(device)) {
        if (out === inLink) continue;
        const p = topo.switchPort(device, out);
        let outTag;
        if (p.mode === 'trunk') outTag = v === NATIVE_VLAN ? null : v;
        else if ((Number(p.vlan) || NATIVE_VLAN) === v) outTag = null;
        else continue;
        if (!topo.isUp(out)) {
          drops.push(`câble ${dev.label} ${p.name} hors service : ${topo.status.get(out).reason}`);
          continue;
        }
        const next = topo.other(out, device);
        queue.push({ device: next, inLink: out, tag: outTag, vlan: v, hops: [...hops, { edge: out, from: device, to: next }] });
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
  return { endpoints, drops, vlansSeen };
}
