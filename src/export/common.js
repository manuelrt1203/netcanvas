// Outils partagés par les exports : table des interfaces, noms compatibles avec chaque outil.
import { buildTopology, isHost, NATIVE_VLAN } from '../net/topology.js';
import { isValidCidr, isValidIp } from '../net/ip.js';

// « Équipe Réseau » -> « Equipe Reseau »
export const ascii = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '');

// Donne à chaque équipement un nom unique respectant `format` (ex. hostname IOS, nom de nœud Containerlab)
export function uniqueNames(devices, format) {
  const used = new Set();
  const names = new Map();
  for (const d of devices) {
    const base = format(d);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}`;
    used.add(name.toLowerCase());
    names.set(d.id, name);
  }
  return names;
}

// Pour chaque équipement, ses interfaces dans l'ordre des câbles, avec le voisin en face
export function interfaceTable(doc) {
  const topo = buildTopology(doc);
  const table = new Map();

  for (const d of topo.devices.values()) {
    const rows = topo.linksOf.get(d.id).map((linkId, index) => {
      const peerId = topo.other(linkId, d.id);
      const peer = topo.devices.get(peerId);
      const row = {
        link: linkId, index, name: topo.portName(linkId, d.id),
        peer: { id: peerId, label: peer.label, type: peer.type, port: topo.portName(linkId, peerId) },
      };
      if (d.type === 'router') Object.assign(row, topo.routerIface(d.id, linkId));
      else if (d.type === 'switch') Object.assign(row, topo.switchPort(d.id, linkId));
      else if (isHost(d) && index === 0) Object.assign(row, topo.hostIface(d.id));
      row.hasIp = isValidIp(row.ip) && isValidCidr(row.mask);
      // VLAN dans lequel se trouve l'interface (si un switch est en face, en mode access)
      if (peer.type === 'switch') {
        const p = topo.switchPort(peerId, linkId);
        row.accessVlan = p.mode === 'access' ? Number(p.vlan) || NATIVE_VLAN : null;
      }
      return row;
    });
    // Hôte sans câble : on garde sa config pour le plan d'adressage
    if (isHost(d) && !rows.length) {
      const i = topo.hostIface(d.id);
      rows.push({ ...i, link: null, index: 0, peer: null, hasIp: isValidIp(i.ip) && isValidCidr(i.mask) });
    }
    table.set(d.id, rows);
  }
  return { topo, table };
}

// VLAN (hors natif) utilisés par un switch
export function switchVlans(rows) {
  return [...new Set(rows.filter((r) => r.mode !== 'trunk').map((r) => Number(r.vlan) || NATIVE_VLAN))]
    .filter((v) => v !== NATIVE_VLAN)
    .sort((a, b) => a - b);
}

export function fileSafe(name) {
  return ascii(name).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'reseau';
}
