// Plan d'adressage au format CSV « Excel français » (séparateur ;, UTF-8 avec BOM).
import { cidrToMask, networkLabel } from '../net/ip.js';
import { interfaceTable } from './common.js';
import { CABLES, MODELS, modelId } from '../net/catalog.js';

const HEADER = ['Équipement', 'Modèle', 'Interface', 'Adresse IP', 'Masque', 'CIDR', 'Réseau', 'Passerelle', 'VLAN', 'Mode', 'Relié à', 'Câble'];

const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function cableText(topo, link) {
  const st = topo.status.get(link);
  const label = CABLES[topo.links.get(link).cable]?.label ?? '';
  return st.up ? label : `${label} (hors service)`;
}

export function addressPlanRows(doc) {
  const { table, topo } = interfaceTable(doc);
  const rows = [];
  for (const d of doc.devices) {
    for (const r of table.get(d.id)) {
      const isSwitch = d.type === 'switch';
      rows.push([
        d.label,
        MODELS[modelId(d)].label,
        r.name,
        r.hasIp ? r.ip : '',
        r.hasIp ? cidrToMask(r.mask) : '',
        r.hasIp ? `/${r.mask}` : '',
        r.hasIp ? networkLabel(r.ip, r.mask) : '',
        r.gateway || '',
        isSwitch ? (r.mode === 'trunk' ? 'tous' : Number(r.vlan) || 1) : (r.accessVlan ?? ''),
        isSwitch ? (r.mode === 'trunk' ? 'trunk 802.1Q' : 'access') : '',
        r.peer ? `${r.peer.label} ${r.peer.port}` : '',
        r.link ? cableText(topo, r.link) : '',
      ]);
    }
  }
  return rows;
}

export function toCsv(doc) {
  const lines = [HEADER, ...addressPlanRows(doc)].map((row) => row.map(cell).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}
