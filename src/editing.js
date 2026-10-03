// Opérations d'édition sur l'état React Flow (sans React) : copier-coller, alignement, recherche.

const newId = () => crypto.randomUUID().slice(0, 8);

// « R1 » -> « R3 » si R2 est pris ; « PC Compta » -> « PC Compta 2 »
export function nextLabel(label, taken) {
  const m = /^(.*?)(\d+)$/.exec(label);
  const base = m ? m[1] : `${label} `;
  let n = m ? Number(m[2]) + 1 : 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

// Copie des équipements et des câbles entre eux. Renvoie les éléments à ajouter (sélectionnés).
export function duplicate(clip, existingNodes, offset = 32) {
  const taken = new Set(existingNodes.map((n) => n.data.label));
  const ids = new Map();
  const nodes = clip.nodes.map((n) => {
    const id = `${n.type}-${newId()}`;
    ids.set(n.id, id);
    const label = nextLabel(n.data.label, taken);
    taken.add(label);
    return {
      ...structuredClone(n),
      id,
      selected: true,
      position: { x: n.position.x + offset, y: n.position.y + offset },
      data: { ...structuredClone(n.data), label },
    };
  });
  const edges = clip.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ ...structuredClone(e), id: `link-${newId()}`, source: ids.get(e.source), target: ids.get(e.target), selected: false }));
  return { nodes, edges };
}

// Ce qu'on copie : les équipements sélectionnés et les câbles qui les relient entre eux
export function copySelection(nodes, edges) {
  const picked = nodes.filter((n) => n.selected);
  const ids = new Set(picked.map((n) => n.id));
  return {
    nodes: structuredClone(picked.map(({ selected, dragging, measured, ...n }) => n)),
    edges: structuredClone(edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map(({ selected, ...e }) => e)),
  };
}

// Alignement / répartition des équipements sélectionnés
export function arrange(nodes, how) {
  const sel = nodes.filter((n) => n.selected);
  if (sel.length < 2) return nodes;
  const xs = sel.map((n) => n.position.x);
  const ys = sel.map((n) => n.position.y);
  const place = new Map();
  if (how === 'row') {
    const y = Math.round(ys.reduce((a, b) => a + b, 0) / ys.length);
    for (const n of sel) place.set(n.id, { x: n.position.x, y });
  } else if (how === 'column') {
    const x = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    for (const n of sel) place.set(n.id, { x, y: n.position.y });
  } else {
    // Répartition régulière, dans l'ordre actuel
    const axis = how === 'spread-x' ? 'x' : 'y';
    const sorted = [...sel].sort((a, b) => a.position[axis] - b.position[axis]);
    const first = sorted[0].position[axis];
    const step = (sorted.at(-1).position[axis] - first) / (sorted.length - 1);
    sorted.forEach((n, i) => place.set(n.id, { ...n.position, [axis]: Math.round(first + step * i) }));
  }
  return nodes.map((n) => (place.has(n.id) ? { ...n, position: place.get(n.id) } : n));
}

// Recherche par nom, modèle ou adresse IP (doc JSON : les IP de chaque interface)
export function search(doc, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ipsOf = (d) => [d.config?.ip, ...(d.config?.interfaces ?? []).map((i) => i.ip)].filter(Boolean);
  return doc.devices
    .map((d) => {
      const ip = ipsOf(d).find((x) => x.startsWith(q));
      const hit = d.label.toLowerCase().includes(q) || (d.model ?? '').toLowerCase().includes(q) || ip;
      return hit ? { id: d.id, label: d.label, detail: ip ?? d.model, exact: d.label.toLowerCase() === q || ip === q } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || a.label.localeCompare(b.label))
    .slice(0, 8);
}
