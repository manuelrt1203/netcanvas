// Export image du schéma (SVG autonome, thème clair) : rapports, slides, comptes-rendus de TP.
// Même géométrie que l'éditeur : nœud de 96 px de large, câbles droits entre les points de connexion.
import { CABLE_STYLE, COLORS, iconOf } from './icons.js';
import { interfaceTable } from './common.js';
import { isHost } from '../net/topology.js';

// Comme dans l'éditeur : 96 px minimum, élargi par le texte jusqu'à 150 px
const MIN_W = 96;
const MAX_W = 150;
const PAD = 40;
const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Lignes affichées sous le nom, comme dans l'éditeur
function summary(d, rows) {
  if (d.type === 'switch') {
    const vlans = [...new Set(rows.filter((r) => r.mode !== 'trunk').map((r) => Number(r.vlan) || 1))].sort((a, b) => a - b);
    return vlans.length ? [`VLAN ${vlans.join(', ')}`] : [];
  }
  return rows.filter((r) => r.hasIp).map((r) => `${r.ip}/${r.mask}`);
}

const nodeHeight = (lines) => 10 + 36 + 4 + 16 + lines * 14 + 8;
// Largeur estimée (pas de mesure de texte hors navigateur) : ~7 px par caractère en gras 12 px, 6,7 px en mono 11 px
const nodeWidth = (label, lines) =>
  Math.round(Math.min(MAX_W, Math.max(MIN_W, String(label).length * 7 + 12, ...lines.map((l) => l.length * 6.7 + 12))));

function anchor(box, side) {
  const { x, y, w, h } = box;
  return {
    t: [x + w / 2, y],
    b: [x + w / 2, y + h],
    l: [x, y + h / 2],
    r: [x + w, y + h / 2],
  }[side] ?? [x + w / 2, y + h / 2];
}

export function toSvg(doc) {
  const { table, topo } = interfaceTable(doc);
  const byId = new Map(doc.devices.map((d) => [d.id, d]));
  const boxes = new Map(
    doc.devices.map((d) => {
      const lines = summary(d, table.get(d.id));
      return [d.id, { x: d.position.x, y: d.position.y, w: nodeWidth(d.label, lines), h: nodeHeight(lines.length), lines }];
    }),
  );

  const all = [...boxes.values()];
  const minX = all.length ? Math.min(...all.map((b) => b.x)) - PAD : 0;
  const minY = all.length ? Math.min(...all.map((b) => b.y)) - PAD : 0;
  const width = all.length ? Math.max(...all.map((b) => b.x + b.w)) + PAD - minX : 200;
  const height = all.length ? Math.max(...all.map((b) => b.y + b.h)) + PAD - minY : 100;

  const cables = [];
  const labels = [];
  for (const l of doc.links) {
    const a = boxes.get(l.source);
    const b = boxes.get(l.target);
    if (!a || !b || l.source === l.target) continue;
    // Câble console : absent de la table des interfaces, on garde le nom des ports du lien
    const src = table.get(l.source).find((r) => r.link === l.id) ?? { name: l.sourceIface };
    const dst = table.get(l.target).find((r) => r.link === l.id) ?? { name: l.targetIface };
    const look = CABLE_STYLE[topo.links.get(l.id)?.cable] ?? CABLE_STYLE.straight;
    const [x1, y1] = anchor(a, l.sourceHandle);
    const [x2, y2] = anchor(b, l.targetHandle);
    const ports = [src, dst].filter((r) => r.mode);
    const trunk = ports.some((p) => p.mode === 'trunk');
    const vlan = ports.map((p) => Number(p.vlan) || 1).find((v) => v > 1);
    const dash = look.dash ? ` stroke-dasharray="${look.dash}"` : '';
    cables.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${look.color}" stroke-width="${trunk ? 3.5 : 2}"${dash}/>`);

    const at = (t) => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    const tag = trunk ? 'Trunk' : vlan ? `VLAN ${vlan}` : null;
    if (tag) labels.push(pill(...at(0.5), tag, FONT, 10, '#0f172a', '#e2e8f0'));
    // Noms de ports côté routeur et switch seulement, comme dans l'éditeur
    for (const [row, id, t] of [[src, l.source, 0.22], [dst, l.target, 0.78]]) {
      if (row.name && !isHost(byId.get(id))) labels.push(pill(...at(t), row.name, MONO, 9, '#475569', '#ffffff'));
    }
  }

  const nodes = doc.devices.map((d) => {
    const { x, y, w, h, lines } = boxes.get(d.id);
    const cx = x + w / 2;
    const color = COLORS[d.type] ?? COLORS.pc;
    const text = [
      `<text x="${cx}" y="${y + 64}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="#0f172a">${xml(d.label)}</text>`,
      ...lines.map((t, i) =>
        `<text x="${cx}" y="${y + 80 + i * 14}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="#475569">${xml(t)}</text>`),
    ];
    return [
      `<g data-id="${xml(d.id)}">`,
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#ffffff" stroke="#d5dce4" stroke-width="1.5"/>`,
      `<svg x="${cx - 18}" y="${y + 10}" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${iconOf(d)}</svg>`,
      ...text,
      '</g>',
    ].join('');
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">`,
    `<title>${xml(doc.name)}</title>`,
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#f4f6f8"/>`,
    ...cables,
    ...nodes,
    ...labels,
    '</svg>',
    '',
  ].join('\n');
}

// Petite étiquette sur fond, centrée en (x, y) ; largeur estimée (pas de mesure de texte hors navigateur)
function pill(x, y, text, font, size, color, bg) {
  const w = Math.ceil(String(text).length * size * 0.62) + 8;
  const h = size + 6;
  return (
    `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${bg}" stroke="#d5dce4"/>` +
    `<text x="${x}" y="${y + size * 0.35}" text-anchor="middle" font-family="${font}" font-size="${size}" fill="${color}">${xml(text)}</text>`
  );
}
