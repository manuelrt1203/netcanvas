// Export draw.io / diagrams.net (.drawio) avec les formes Cisco officielles de la bibliothèque draw.io.
import { interfaceTable } from './common.js';
import { modelOf } from '../net/catalog.js';
import { CABLE_STYLE } from './icons.js';

const SHAPES = {
  router: { shape: 'mxgraph.cisco.routers.router', w: 50, h: 34 },
  switch: { shape: 'mxgraph.cisco.switches.workgroup_switch', w: 64, h: 32 },
  pc: { shape: 'mxgraph.cisco.computers_and_peripherals.pc', w: 49, h: 44 },
  server: { shape: 'mxgraph.cisco.servers.file_server', w: 27, h: 36 },
  cloud: { shape: 'mxgraph.cisco.storage.cloud', w: 90, h: 52 },
  hub: { shape: 'mxgraph.cisco.hubs_and_gateways.small_hub', w: 64, h: 22 },
  printer: { shape: 'mxgraph.cisco.computers_and_peripherals.printer', w: 50, h: 40 },
  laptop: { shape: 'mxgraph.cisco.computers_and_peripherals.laptop', w: 50, h: 32 },
};

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// La valeur d'une cellule html=1 est du HTML : on échappe le texte en HTML, puis le tout en XML
const htmlValue = (title, lines) => xml([`<b>${xml(title)}</b>`, ...lines.map(xml)].join('<br>'));

const NODE_W = 96; // largeur d'un nœud dans l'éditeur, pour centrer la forme au même endroit

export function toDrawio(doc) {
  const { table, topo } = interfaceTable(doc);
  const cells = [];

  for (const d of doc.devices) {
    const s = SHAPES[modelOf(d).icon] ?? SHAPES[d.type] ?? SHAPES.pc;
    const rows = table.get(d.id);
    const ips = rows.filter((r) => r.hasIp).map((r) => `${r.ip}/${r.mask}`);
    const style = [
      `shape=${s.shape}`, 'html=1', 'pointerEvents=1', 'dashed=0', 'fillColor=#036897', 'strokeColor=#ffffff',
      'strokeWidth=2', 'verticalLabelPosition=bottom', 'verticalAlign=top', 'align=center', 'outlineConnect=0', 'fontSize=11',
    ].join(';');
    const x = Math.round(d.position.x + NODE_W / 2 - s.w / 2);
    cells.push(
      `<mxCell id="n-${xml(d.id)}" value="${htmlValue(d.label, ips)}" style="${style};" vertex="1" parent="1">` +
        `<mxGeometry x="${x}" y="${Math.round(d.position.y)}" width="${s.w}" height="${s.h}" as="geometry"/></mxCell>`,
    );
  }

  for (const l of doc.links) {
    if (!table.has(l.source) || !table.has(l.target) || l.source === l.target) continue;
    // Câble console : pas dans la table des interfaces (il ne transporte pas de données)
    const src = table.get(l.source).find((r) => r.link === l.id) ?? { name: l.sourceIface };
    const dst = table.get(l.target).find((r) => r.link === l.id) ?? { name: l.targetIface };
    const look = CABLE_STYLE[topo.links.get(l.id)?.cable] ?? CABLE_STYLE.straight;
    // Étiquette du câble d'après les ports de switch à ses extrémités
    const ports = [src, dst].filter((r) => r.mode);
    const trunk = ports.some((p) => p.mode === 'trunk');
    const vlan = ports.map((p) => Number(p.vlan) || 1).find((v) => v > 1);
    const id = `e-${xml(l.id)}`;
    cells.push(
      `<mxCell id="${id}" value="${trunk ? 'Trunk' : vlan ? `VLAN ${vlan}` : ''}" ` +
        `style="endArrow=none;html=1;rounded=0;strokeWidth=${trunk ? 3 : 2};strokeColor=${look.color};${look.dash ? `dashed=1;dashPattern=${look.dash.replace(' ', ' ')};` : ''}fontSize=9;labelBackgroundColor=#ffffff;" ` +
        `edge="1" parent="1" source="n-${xml(l.source)}" target="n-${xml(l.target)}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    );
    // Noms des ports près de chaque extrémité (x = -1 côté source, +1 côté cible)
    for (const [row, pos, suffix] of [[src, -0.7, 's'], [dst, 0.7, 't']]) {
      if (!row.name) continue;
      cells.push(
        `<mxCell id="${id}-${suffix}" value="${xml(row.name)}" style="edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];fontSize=9;fontColor=#475569;" ` +
          `vertex="1" connectable="0" parent="${id}"><mxGeometry x="${pos}" relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry></mxCell>`,
      );
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<mxfile host="NetCanvas" type="device">`,
    `<diagram id="netcanvas" name="${xml(doc.name)}">`,
    '<mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">',
    '<root><mxCell id="0"/><mxCell id="1" parent="0"/>',
    ...cells,
    '</root></mxGraphModel></diagram></mxfile>',
    '',
  ].join('\n');
}
