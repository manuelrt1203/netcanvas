// Conversion état React Flow <-> JSON stockable en base.
// On ne garde que ce qui décrit le réseau, pas l'état d'affichage (sélection, dimensions…).
//
// Dans l'éditeur, la config d'interface est indexée par nom de port, comme sur le vrai matériel :
// elle reste sur le port quand on débranche le câble, et on peut configurer un port avant de le câbler.
//   hôte    : data = { label, model, ip, mask, gateway }
//   routeur : data = { label, model, modules, ifaces: { [port]: { ip, mask, clockRate, shutdown, description } }, routes: [...] }
//   switch  : data = { label, model, ports: { [port]: { mode, vlan, shutdown, description } }, vlans: { [id]: nom } }
// Le câble porte son type et le nom des ports à chaque bout :
//   edge.data = { cable, sourceIface, targetIface, dce: 'source' | 'target' }
import { HOST_TYPES, buildTopology } from './net/topology.js';
import { DEFAULT_MODEL, MODELS, devicePorts, modelId } from './net/catalog.js';

export const FORMAT_VERSION = 3;

const nul = (v) => (v === '' || v === undefined ? null : v);

// Nom d'interface par défaut façon Cisco : G0/0, G0/1… pour un routeur, Fa0/1, Fa0/2… pour un switch
export function nextPortName(type, usedNames) {
  for (let i = 0; ; i++) {
    const name = type === 'router' ? `G0/${i}` : `Fa0/${i + 1}`;
    if (!usedNames.includes(name)) return name;
  }
}

// Câbles d'un équipement, dans l'ordre du schéma
export const linksOfNode = (edges, id) => edges.filter((e) => e.source === id || e.target === id);

// Port de l'équipement `id` sur le câble `e`
export const edgePort = (e, id) => (e.source === id ? e.data?.sourceIface : e.data?.targetIface);

// Interfaces d'un routeur/switch pour les câbles de données existants (pas les câbles console)
export function portsOf(node, edges) {
  const table = (node.type === 'router' ? node.data.ifaces : node.data.ports) ?? {};
  const links = linksOfNode(edges, node.id).filter((e) => e.data?.cable !== 'console');
  const used = links.map((e) => edgePort(e, node.id)).filter(Boolean);
  return links.map((e) => {
    let name = edgePort(e, node.id);
    if (!name) {
      name = nextPortName(node.type, used);
      used.push(name);
    }
    return { link: e.id, edge: e, ...table[name], name };
  });
}

// Ports libres d'un équipement (modèle + modules, moins ceux déjà câblés)
export function freePorts(node, edges, exceptEdge = null) {
  const taken = new Set(linksOfNode(edges, node.id).filter((e) => e.id !== exceptEdge).map((e) => edgePort(e, node.id)));
  return devicePorts(modelId({ type: node.type, model: node.data.model }), node.data.modules).filter((p) => !taken.has(p.name));
}

export function toJSON(nodes, edges, name = 'Sans titre') {
  const ids = new Set(nodes.map((n) => n.id));
  const liveEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));

  return {
    format: 'netcanvas',
    version: FORMAT_VERSION,
    name,
    devices: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      model: modelId({ type: n.type, model: n.data.model }),
      ...(n.type === 'router' ? { modules: { ...n.data.modules } } : {}),
      label: n.data.label,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      config: deviceConfig(n, liveEdges),
    })),
    links: liveEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      cable: e.data?.cable ?? 'straight',
      sourceIface: e.data?.sourceIface ?? null,
      targetIface: e.data?.targetIface ?? null,
      ...(e.data?.cable === 'serial' ? { dce: e.data.dce === 'target' ? 'target' : 'source' } : {}),
    })),
  };
}

// Ports câblés d'abord (ordre des câbles), puis ports configurés sans câble (ordre du modèle)
function configuredPorts(n, edges, table) {
  const cabled = portsOf(n, edges);
  const names = new Set(cabled.map((p) => p.name));
  const order = devicePorts(modelId({ type: n.type, model: n.data.model }), n.data.modules).map((p) => p.name);
  const loose = Object.keys(table ?? {})
    .filter((name) => !names.has(name))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((name) => ({ link: null, name, ...table[name] }));
  return [...cabled, ...loose];
}

// Champs facultatifs d'une interface, gardés tels quels entre l'éditeur et le JSON
const IFACE_EXTRAS = ['shutdown', 'description', 'bandwidth', 'ospfCost'];
const extras = (p) => Object.fromEntries(IFACE_EXTRAS.filter((k) => p[k] !== undefined && p[k] !== null && p[k] !== '' && p[k] !== false).map((k) => [k, p[k]]));
// Routage dynamique d'un routeur : copié sans transformation
const ROUTING_KEYS = ['ospf', 'rip', 'bgp', 'addressLists'];
const routing = (src) => Object.fromEntries(ROUTING_KEYS.filter((k) => src?.[k]).map((k) => [k, structuredClone(src[k])]));

function deviceConfig(n, edges) {
  const d = n.data;
  if (HOST_TYPES.has(n.type)) return { ip: nul(d.ip), mask: nul(d.mask), gateway: nul(d.gateway) };
  if (n.type === 'router') {
    return {
      interfaces: configuredPorts(n, edges, d.ifaces)
        .filter((p) => p.link || p.ip || p.clockRate || Object.keys(extras(p)).length)
        .map((p) => ({
          link: p.link, name: p.name, ip: nul(p.ip), mask: nul(p.mask),
          ...(p.clockRate ? { clockRate: Number(p.clockRate) } : {}),
          ...extras(p),
        })),
      routes: (d.routes ?? []).map((r) => ({ network: nul(r.network), mask: nul(r.mask), nextHop: nul(r.nextHop) })),
      ...routing(d),
    };
  }
  if (n.type === 'switch') {
    const vlans = Object.entries(d.vlans ?? {}).map(([id, name]) => ({ id: Number(id), name })).sort((a, b) => a.id - b.id);
    return {
      ports: configuredPorts(n, edges, d.ports).map((p) => ({
        link: p.link,
        name: p.name,
        mode: p.mode ?? 'access',
        ...(p.mode === 'trunk' ? {} : { vlan: Number(p.vlan) || 1 }),
        ...extras(p),
      })),
      ...(vlans.length ? { vlans } : {}),
    };
  }
  return {};
}

const blank = (v) => v ?? '';

// v1/v2 : pas de modèle. On prend le modèle par défaut s'il a tous les ports utilisés, sinon un plus grand.
const FALLBACK_MODELS = { router: ['2911', 'Router-PT'], switch: ['2960-24TT', '2960-48TT', 'Switch-PT'] };

function guessModel(d) {
  const c = d.config ?? {};
  const names = (c.interfaces ?? c.ports ?? []).map((i) => i.name);
  const options = FALLBACK_MODELS[d.type] ?? [DEFAULT_MODEL[d.type] ?? 'PC-PT'];
  return options.find((m) => names.every((n) => devicePorts(m).some((p) => p.name === n))) ?? options[0];
}

// Remplit model, cable et noms de ports d'un document v1/v2 (ou v3 incomplet)
export function upgrade(doc) {
  const devices = doc.devices.map((d) => {
    const config = d.config ?? (HOST_TYPES.has(d.type) ? { ip: d.ip, mask: d.mask } : {}); // v1 : ip/mask à la racine
    const base = { ...d, config };
    return { ...base, model: MODELS[d.model]?.type === d.type ? d.model : guessModel(base) };
  });
  const partial = { ...doc, devices };
  const topo = buildTopology(partial);
  const links = doc.links.map((l) => ({
    ...l,
    sourceHandle: l.sourceHandle ?? l.sourcePort ?? null,
    targetHandle: l.targetHandle ?? l.targetPort ?? null,
    cable: topo.links.get(l.id)?.cable ?? l.cable ?? 'straight',
    sourceIface: l.sourceIface ?? (topo.links.has(l.id) ? topo.portName(l.id, l.source) : null),
    targetIface: l.targetIface ?? (topo.links.has(l.id) ? topo.portName(l.id, l.target) : null),
  }));
  return { ...partial, version: FORMAT_VERSION, links };
}

// Config JSON d'un équipement -> data de l'éditeur (aussi utilisé par le terminal)
export function deviceToData(d, links = []) {
  const c = d.config ?? {};
  // Le nom du port fait foi côté câble
  const portOfLink = new Map(links.flatMap((l) => [
    ...(l.source === d.id ? [[l.id, l.sourceIface]] : []),
    ...(l.target === d.id ? [[l.id, l.targetIface]] : []),
  ]));
  const keyOf = (entry) => (entry.link && portOfLink.get(entry.link)) || entry.name;

  const data = { label: d.label, model: d.model };
  if (HOST_TYPES.has(d.type)) Object.assign(data, { ip: blank(c.ip), mask: blank(c.mask), gateway: blank(c.gateway) });
  if (d.type === 'router') {
    data.modules = { ...d.modules };
    data.ifaces = Object.fromEntries((c.interfaces ?? []).map((i) => [
      keyOf(i), { ip: blank(i.ip), mask: blank(i.mask), ...(i.clockRate ? { clockRate: i.clockRate } : {}), ...extras(i) },
    ]));
    data.routes = (c.routes ?? []).map((r) => ({ network: blank(r.network), mask: blank(r.mask), nextHop: blank(r.nextHop) }));
    Object.assign(data, routing(c));
  }
  if (d.type === 'switch') {
    data.ports = Object.fromEntries((c.ports ?? []).map((p) => [keyOf(p), { mode: p.mode, vlan: p.vlan ?? 1, ...extras(p) }]));
    if (c.vlans?.length) data.vlans = Object.fromEntries(c.vlans.map((v) => [v.id, v.name]));
  }
  return data;
}

export function fromJSON(raw) {
  if (raw?.format !== 'netcanvas') throw new Error("Ce fichier n'est pas un schéma NetCanvas.");
  if (!(raw.version <= FORMAT_VERSION)) throw new Error(`Version ${raw.version} non prise en charge, mets à jour NetCanvas.`);
  const doc = upgrade(raw);

  return {
    name: doc.name,
    nodes: doc.devices.map((d) => ({ id: d.id, type: d.type, position: d.position, data: deviceToData(d, doc.links) })),
    edges: doc.links.map((l) => ({
      id: l.id,
      source: l.source,
      target: l.target,
      sourceHandle: l.sourceHandle,
      targetHandle: l.targetHandle,
      data: {
        cable: l.cable,
        sourceIface: l.sourceIface,
        targetIface: l.targetIface,
        ...(l.cable === 'serial' ? { dce: l.dce === 'target' ? 'target' : 'source' } : {}),
      },
    })),
  };
}
