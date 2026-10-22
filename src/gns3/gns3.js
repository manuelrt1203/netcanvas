// Projets GNS3 : import d'un .gns3 (topologie seule) ou d'un .gns3project (projet portable, avec les configs)
// et export d'un .gns3project qui s'ouvre dans GNS3 (File > Import portable project).
//
// Correspondance des équipements :
//   dynamips c7200 / c3725 / c3640 (c3600)  <-> routeurs GNS3 de NetCanvas, mêmes modules (slotN, wicN)
//   qemu MikroTik CHR / FRR                 <-> CHR 6.49 / 7.1 / 7.16, FRR 7.5.1
//   ethernet_switch                         <-> switch Cisco 2960 (ports access / dot1q, VLAN)
//   ethernet_hub                            <-> hub
//   vpcs                                    <-> PC
//   nat, cloud                              <-> Internet
// Un autre routeur Cisco de NetCanvas (2911…) part en c7200, interfaces renumérotées comme l'export texte GNS3.
// Ports GNS3 : (adapter_number, port_number). Dynamips : adapter = slot ; cartes WIC sur l'adapter 0,
// port 16 × (n° WIC + 1) + port. Qemu : adapter = n° de carte réseau, port 0. Switch, hub : adapter 0, port n.
import { MODELS, MODULES, devicePorts, isDataMedia, isFrr, isMikrotik, modelOf, slotList } from '../net/catalog.js';
import { autoCable } from '../net/cabling.js';
import { ciscoConfigs, hostname } from '../export/cisco.js';
import { interfaceTable, uniqueNames } from '../export/common.js';
import { importConfig } from '../cli/import.js';
import { applyHostConfig, parseHostConfig } from '../cli/host-import.js';
import { isZip, readZip, writeZip } from './zip.js';

const dataPorts = (model, modules) => devicePorts(model, modules).filter((p) => isDataMedia(p.media));

// --- Ports Dynamips ------------------------------------------------------------------------------

// Tous les ports d'un routeur Dynamips : [{ adapter, port, name }]
export function dynamipsPorts(model, modules = {}) {
  const m = MODELS[model];
  const out = [];
  // Ports intégrés (c3725 : Fa0/0, Fa0/1 sur l'adapter 0)
  m.ports.filter((p) => isDataMedia(p.media)).forEach((p, i) => out.push({ adapter: 0, port: i, name: p.name }));
  for (const s of slotList(m)) {
    const mod = MODULES[modules?.[s.id]];
    if (!mod || mod.slot !== s.kind) continue;
    mod.ports(s.n).forEach((p, i) => out.push(
      s.kind === 'wic' ? { adapter: 0, port: 16 * (s.n + 1) + i, name: p.name } : { adapter: s.n, port: i, name: p.name },
    ));
  }
  return out;
}

// --- Lecture --------------------------------------------------------------------------------------

const DYNAMIPS_PLATFORM = { c7200: 'c7200', c3725: 'c3725', c2691: 'c3725', c3600: 'c3640' };
const BUILTIN = new Set(['GT96100-FE', 'Leopard-2FE']); // cartes intégrées des c3725 / c2691 (ports déjà dans le modèle)

function qemuModel(node) {
  const p = node.properties ?? {};
  const text = `${p.hda_disk_image ?? ''} ${node.name ?? ''} ${node.symbol ?? ''} ${p.image ?? ''}`;
  if (/chr|mikrotik|routeros/i.test(text)) {
    const v = /(?:chr|mikrotik|routeros)\D*([67])\.(\d+)/i.exec(text);
    if (v?.[1] === '6') return 'CHR-6.49';
    if (v?.[1] === '7' && v[2] === '1') return 'CHR-7.1';
    return 'CHR';
  }
  if (/frr/i.test(text)) return 'FRR';
  return null;
}

// Équipement générique pour un nœud sans équivalent (IOU, qemu inconnu, docker…), d'après son icône
function genericModel(node) {
  const s = `${node.symbol ?? ''} ${node.node_type}`;
  if (/switch/i.test(s)) return 'Switch-PT';
  if (/router|firewall/i.test(s) || node.properties?.application_id !== undefined) return 'Router-PT';
  if (/server/i.test(s)) return 'Server-PT';
  return 'PC-PT';
}

// Nœud GNS3 -> { model, modules, portName(adapter, port), notes[] } ; null : ignoré
function mapNode(node) {
  const p = node.properties ?? {};
  const notes = [];
  switch (node.node_type) {
    case 'dynamips': {
      const platform = p.platform === 'c3600' && p.chassis && p.chassis !== '3640' ? 'c3600' : p.platform;
      let model = DYNAMIPS_PLATFORM[platform];
      if (!model) {
        notes.push(`plateforme ${p.platform} remplacée par un c7200`);
        model = 'c7200';
      } else if (model !== p.platform && !(p.platform === 'c3600' && p.chassis === '3640')) {
        notes.push(`${p.platform}${p.chassis ? ` ${p.chassis}` : ''} remplacé par un ${model} (mêmes emplacements)`);
      }
      const modules = {};
      for (const s of slotList(MODELS[model])) {
        const value = p[s.kind === 'wic' ? s.id : `slot${s.id}`];
        if (!value || BUILTIN.has(value)) continue;
        if (MODULES[value]?.slot === s.kind) modules[s.id] = value;
        else notes.push(`module ${value} (${s.kind === 'wic' ? s.id : `slot ${s.id}`}) inconnu de NetCanvas, retiré`);
      }
      if (model === 'c7200' && !modules[0]) modules[0] = 'C7200-IO-FE';
      const ports = dynamipsPorts(model, modules);
      return { type: 'router', model, modules, notes, portName: (a, n) => ports.find((x) => x.adapter === a && x.port === n)?.name };
    }
    case 'qemu': {
      const model = qemuModel(node);
      if (model) {
        const prefix = isFrr({ model }) ? (a) => `eth${a}` : (a) => `ether${a + 1}`;
        return { type: 'router', model, modules: {}, notes, portName: (a) => prefix(a) };
      }
      break;
    }
    case 'docker':
      // Conteneur « invité » (debianiut de l'IUT…) : un PC, dont la config est dans /etc/network/interfaces
      if (!qemuModel(node) && !/router|switch|server/i.test(node.symbol ?? '')) {
        return { type: 'pc', model: 'PC-PT', notes, docker: true, portName: (a, n) => (a === 0 && n === 0 ? 'Fa0' : undefined) };
      }
      if (qemuModel(node)) {
        const model = qemuModel(node);
        const prefix = isFrr({ model }) ? (a) => `eth${a}` : (a) => `ether${a + 1}`;
        return { type: 'router', model, modules: {}, notes, portName: (a) => prefix(a) };
      }
      break;
    case 'vpcs':
      return { type: 'pc', model: 'PC-PT', notes, portName: (a, n) => (a === 0 && n === 0 ? 'Fa0' : undefined) };
    case 'ethernet_switch': {
      const max = Math.max(0, ...(p.ports_mapping ?? []).map((x) => x.port_number));
      const model = max < 24 ? '2960-24TT' : '2960-48TT';
      if (max >= 48) notes.push('plus de 48 ports : les ports au-delà sont retirés');
      return { type: 'switch', model, notes, portName: (a, n) => (n < 48 && n <= max ? `Fa0/${n + 1}` : undefined) };
    }
    case 'ethernet_hub':
      return { type: 'hub', model: 'Hub-PT', notes, portName: (a, n) => (n <= 5 ? `Port${n}` : undefined) };
    case 'nat':
    case 'cloud':
      return { type: 'cloud', model: 'Cloud', notes, portName: () => 'Eth0' };
    default:
      break;
  }
  if (['frame_relay_switch', 'atm_switch'].includes(node.node_type)) return null;
  // Sans équivalent : équipement générique, ports pris dans l'ordre (IOU : 4 ports par adapter)
  const model = genericModel(node);
  const ports = dataPorts(model);
  const per = node.node_type === 'iou' ? 4 : 1;
  notes.push(`${node.node_type} sans équivalent : remplacé par ${MODELS[model].label}, sans sa configuration`);
  return { type: MODELS[model].type, model, modules: {}, notes, portName: (a, n) => ports[a * per + n]?.name };
}

const SCALE = 1.8; // GNS3 dessine ses icônes plus petites que NetCanvas

// project : JSON du .gns3 ; files : Map<chemin, () => Promise<Uint8Array>> (vide pour un .gns3 seul)
// Renvoie { doc, warnings, configs: nombre de configs appliquées }
export async function fromGns3(project, files = new Map()) {
  if (project?.type !== 'topology' || !project.topology) throw new Error("Ce fichier n'est pas un projet GNS3.");
  const warnings = [];
  const nodes = project.topology.nodes ?? [];
  const mapped = new Map();
  const xs = nodes.map((n) => n.x ?? 0);
  const ys = nodes.map((n) => n.y ?? 0);
  const [minX, minY] = [Math.min(0, ...xs), Math.min(0, ...ys)];

  const devices = [];
  nodes.forEach((n, i) => {
    const m = mapNode(n);
    if (!m) {
      warnings.push(`${n.name} (${n.node_type}) : pas d'équivalent dans NetCanvas, ignoré.`);
      return;
    }
    for (const note of m.notes) warnings.push(`${n.name} : ${note}.`);
    const id = `${m.type}-g${String(i + 1).padStart(2, '0')}`;
    mapped.set(n.node_id, { ...m, id, node: n });
    const config = m.type === 'router' ? { interfaces: [], routes: [] } : m.type === 'switch' ? { ports: [] } : m.type === 'pc' ? { ip: null, mask: null, gateway: null } : {};
    devices.push({
      id, type: m.type, model: m.model, ...(m.type === 'router' ? { modules: m.modules } : {}),
      label: n.name ?? id,
      position: { x: Math.round(((n.x ?? 0) - minX) * SCALE) + 40, y: Math.round(((n.y ?? 0) - minY) * SCALE) + 40 },
      config,
    });
  });
  const byId = new Map(devices.map((d) => [d.id, d]));

  const links = [];
  for (const [i, l] of (project.topology.links ?? []).entries()) {
    const [a, b] = l.nodes ?? [];
    const ma = mapped.get(a?.node_id);
    const mb = mapped.get(b?.node_id);
    if (!ma || !mb) continue;
    const pa = ma.portName(a.adapter_number, a.port_number);
    const pb = mb.portName(b.adapter_number, b.port_number);
    const da = byId.get(ma.id);
    const db = byId.get(mb.id);
    if (!pa || !pb) {
      warnings.push(`Câble ${da.label} ↔ ${db.label} retiré : port ${!pa ? `${a.adapter_number}/${a.port_number} de ${da.label}` : `${b.adapter_number}/${b.port_number} de ${db.label}`} introuvable.`);
      continue;
    }
    const used = links.flatMap((x) => [[x.source, x.sourceIface], [x.target, x.targetIface]]);
    if (used.some(([d, p]) => (d === da.id && p === pa) || (d === db.id && p === pb))) {
      warnings.push(`Câble ${da.label} ${pa} ↔ ${db.label} ${pb} retiré : port déjà câblé dans NetCanvas.`);
      continue;
    }
    const portA = dataPorts(da.model, da.modules).find((p) => p.name === pa) ?? { name: pa, media: 'copper' };
    const portB = dataPorts(db.model, db.modules).find((p) => p.name === pb) ?? { name: pb, media: 'copper' };
    const dev = (d) => ({ type: d.type, mdi: modelOf(d).mdi });
    const cable = autoCable(dev(da), portA, dev(db), portB) ?? 'straight';
    const id = `link-g${String(i + 1).padStart(2, '0')}`;
    links.push({ id, source: da.id, target: db.id, sourceHandle: null, targetHandle: null, cable, sourceIface: pa, targetIface: pb, ...(cable === 'serial' ? { dce: 'source' } : {}) });
    // Config de port d'un switch GNS3 : access / dot1q et VLAN
    for (const [m, d, end, port] of [[ma, da, a, pa], [mb, db, b, pb]]) {
      if (d.type === 'router') d.config.interfaces.push({ link: id, name: port, ip: null, mask: null });
      if (d.type !== 'switch') continue;
      const pm = (m.node.properties?.ports_mapping ?? []).find((x) => x.port_number === end.port_number);
      if (pm?.type === 'dot1q') d.config.ports.push({ link: id, name: port, mode: 'trunk', ...(pm.vlan && pm.vlan !== 1 ? { nativeVlan: pm.vlan } : {}) });
      else {
        if (pm?.type === 'qinq') warnings.push(`${d.label} port ${end.port_number} : QinQ non simulé, port en access.`);
        d.config.ports.push({ link: id, name: port, mode: 'access', vlan: Number(pm?.vlan) || 1 });
      }
    }
  }
  for (const d of devices.filter((x) => x.type === 'switch')) {
    const ids = [...new Set(d.config.ports.flatMap((p) => [p.vlan, p.nativeVlan]).filter((v) => v && v !== 1))].sort((x, y) => x - y);
    if (ids.length) d.config.vlans = ids.map((v) => ({ id: v, name: `VLAN${String(v).padStart(4, '0')}` }));
  }

  let doc = { format: 'netcanvas', version: 3, name: project.name || 'Projet GNS3', devices, links };

  // Configs du projet portable : startup-config des routeurs Dynamips, startup.vpc des VPCS
  let configs = 0;
  const qemuRouters = [];
  const find = (dir, re) => [...files.keys()].find((k) => k.startsWith(dir) && re.test(k.slice(dir.length)));
  const decode = async (key) => new TextDecoder().decode(await files.get(key)());
  for (const [nodeId, m] of mapped) {
    const kind = m.node.node_type;
    // Config d'un routeur Dynamips : startup-config de son dossier, sinon « <nom>.cfg » à la racine de project-files/dynamips
    const byName = `project-files/dynamips/${m.node.name}.cfg`;
    const key = kind === 'dynamips' ? find(`project-files/dynamips/${nodeId}/`, /(^|\/)i\d+_startup-config\.cfg$/) ?? (files.has(byName) ? byName : null)
      : kind === 'vpcs' ? find(`project-files/vpcs/${nodeId}/`, /^startup\.vpc$/)
        : m.docker ? find(`project-files/docker/${nodeId}/`, /^etc\/network\/interfaces$/) : null;
    if (!key) {
      if (m.type === 'router' && ['qemu', 'docker'].includes(kind)) qemuRouters.push(m.node.name);
      continue;
    }
    let text;
    try {
      text = await decode(key);
    } catch (err) {
      warnings.push(`${m.node.name} : config illisible (${err.message}).`);
      continue;
    }
    if (!text.trim()) continue;
    const device = doc.devices.find((d) => d.id === m.id);
    if (m.type === 'pc') {
      const parsed = parseHostConfig(text);
      // Fichier d'exemple de GNS3 (tout en commentaire) : rien à reprendre
      if (!parsed.format || !Object.keys(parsed.config).length) continue;
      const next = applyHostConfig(device, parsed);
      doc = { ...doc, devices: doc.devices.map((d) => (d.id === m.id ? { ...next, label: device.label } : d)) };
      configs++;
      continue;
    }
    try {
      const r = importConfig(device, doc, text);
      doc = { ...doc, devices: doc.devices.map((d) => (d.id === m.id ? { ...r.device, label: device.label } : d)) };
      configs++;
      const lost = r.ignored.filter((x) => !/^(no |!|version|service|boot|end)/i.test(x.text));
      if (lost.length) warnings.push(`${device.label} : ${lost.length} ligne(s) de sa config non reprise(s) (ex. « ${lost[0].text} » : ${lost[0].reason}).`);
    } catch (err) {
      warnings.push(`${device.label} : config non importée (${err.message}).`);
    }
  }
  if (files.size && qemuRouters.length) {
    warnings.push(`${qemuRouters.join(', ')} : la config d'une machine virtuelle reste dans son disque. Pour la reprendre, colle son « /export » ou « show run » avec « Importer une config ».`);
  }
  if (!files.size && nodes.some((n) => ['dynamips', 'vpcs'].includes(n.node_type))) {
    warnings.push('Fichier .gns3 seul : les configs des routeurs et des VPCS sont dans le dossier project-files. Pour les importer aussi, exporte le projet depuis GNS3 (File > Export portable project) et ouvre le .gns3project.');
  }
  return { doc, warnings, configs };
}

// Contenu d'un fichier choisi par l'utilisateur (.gns3 ou .gns3project) -> résultat de fromGns3
export async function readGns3(bytes) {
  if (isZip(bytes)) {
    const files = readZip(bytes);
    const main = files.get('project.gns3') ?? [...files.entries()].find(([k]) => /^[^/]+\.gns3$/.test(k))?.[1];
    if (!main) throw new Error("Archive sans project.gns3 : ce n'est pas un projet portable GNS3.");
    return fromGns3(JSON.parse(new TextDecoder().decode(await main())), files);
  }
  let project;
  try {
    project = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Ce fichier n'est pas un projet GNS3 (ni .gns3, ni .gns3project).");
  }
  return fromGns3(project);
}

// --- Écriture -------------------------------------------------------------------------------------

// Images par défaut : celles des appliances GNS3 courantes (à changer dans GNS3 si les tiennes ont un autre nom)
export const GNS3_IMAGES = {
  c7200: 'c7200-adventerprisek9-mz.124-24.T5.image',
  c3725: 'c3725-adventerprisek9-mz.124-15.T14.image',
  c3640: 'c3640-a3js-mz.124-25d.image',
  'CHR-6.49': 'chr-6.49.19.vmdk',
  'CHR-7.1': 'chr-7.16.img',
  CHR: 'chr-7.16.img',
  FRR: 'frr-7.5.1.qcow2',
};
const RAM = { c7200: 512, c3725: 128, c3640: 192 };
const PLATFORM = { c7200: { platform: 'c7200' }, c3725: { platform: 'c3725' }, c3640: { platform: 'c3600', chassis: '3640' } };

const label = (text) => ({
  rotation: 0, style: 'font-family: TypeWriter;font-size: 10.0;font-weight: bold;fill: #000000;fill-opacity: 1.0;', text, x: 0, y: -25,
});

// Un routeur Cisco hors GNS3 (2911, 4321, générique…) devient un c7200 : ports Ethernet sur la carte C7200-IO-2FE
// puis des PA-2FE-TX, ports série sur des PA-4T+. Les noms changent partout (câbles, interfaces, routage, NAT…).
const SHORT_IFACE = /\b(G|Fa|Eth|Se)(\d+(?:\/\d+)+)(?![\d/])/g;
const renameShort = (value, mapping) => JSON.parse(JSON.stringify(value).replace(SHORT_IFACE, (all) => mapping[all] ?? all));

function asC7200(doc, warnings) {
  const renames = new Map(); // id -> { 'G0/0': 'Fa0/0' }
  const devices = doc.devices.map((d) => {
    if (d.type !== 'router' || isMikrotik(d) || isFrr(d) || modelOf(d).gns3) return d;
    const own = dataPorts(d.model, d.modules);
    const used = new Set([
      ...doc.links.flatMap((l) => [l.source === d.id && l.sourceIface, l.target === d.id && l.targetIface]),
      ...(d.config?.interfaces ?? []).map((i) => i.name),
    ].filter(Boolean));
    const list = own.filter((p) => used.has(p.name));
    const eth = list.filter((p) => p.media !== 'serial');
    const ser = list.filter((p) => p.media === 'serial');
    const modules = { 0: 'C7200-IO-2FE' };
    const mapping = {};
    let slot = 1;
    eth.forEach((p, i) => {
      if (i < 2) mapping[p.name] = `Fa0/${i}`;
      else {
        const s = slot + Math.floor((i - 2) / 2);
        if (s <= 6) { modules[s] = 'PA-2FE-TX'; mapping[p.name] = `Fa${s}/${(i - 2) % 2}`; }
      }
    });
    slot = Math.max(slot, ...Object.keys(modules).map(Number).map((n) => n + 1));
    ser.forEach((p, i) => {
      const s = slot + Math.floor(i / 4);
      if (s <= 6) { modules[s] = 'PA-4T+'; mapping[p.name] = `Se${s}/${i % 4}`; }
    });
    const lost = list.filter((p) => !mapping[p.name]).map((p) => p.name);
    if (lost.length) warnings.push(`${d.label} : plus de place sur le c7200 (6 emplacements), ${lost.join(', ')} retiré(s).`);
    warnings.push(`${d.label} (${modelOf(d).label}) devient un c7200 dans GNS3 : ${Object.entries(mapping).filter(([a, b]) => a !== b).map(([a, b]) => `${a} → ${b}`).join(', ') || 'mêmes noms'}.`);
    renames.set(d.id, mapping);
    return { ...d, model: 'c7200', modules, config: renameShort(d.config ?? {}, mapping) };
  });
  const links = doc.links.map((l) => ({
    ...l,
    sourceIface: renames.get(l.source)?.[l.sourceIface] ?? l.sourceIface,
    targetIface: renames.get(l.target)?.[l.targetIface] ?? l.targetIface,
  }));
  return { ...doc, devices, links };
}

// doc NetCanvas -> { files: [{ name, data }], warnings }
export function gns3Files(source, uuid = () => crypto.randomUUID()) {
  const warnings = [];
  const doc = asC7200(source, warnings);
  const { table, topo } = interfaceTable(doc);
  const names = uniqueNames(doc.devices, (d) => hostname(d.label, d.type));
  const texts = new Map(ciscoConfigs(doc, { target: 'gns3' }).map((c) => [c.id, c]));
  const files = [];
  const nodes = [];
  const endpoints = new Map(); // `${deviceId}|${linkId}` -> { node_id, adapter_number, port_number }
  const xs = doc.devices.map((d) => d.position?.x ?? 0);
  const ys = doc.devices.map((d) => d.position?.y ?? 0);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  let dynamipsId = 0;
  let console = 5000;

  for (const d of doc.devices) {
    const rows = table.get(d.id) ?? [];
    const nodeId = uuid();
    const name = names.get(d.id);
    const base = {
      compute_id: 'local', console: null, console_auto_start: false, console_type: 'none', custom_adapters: [],
      first_port_name: null, height: 45, width: 66, label: label(name), locked: false, name, node_id: nodeId,
      port_name_format: 'Ethernet{0}', port_segment_size: 0,
      x: Math.round((d.position?.x ?? 0) - cx), y: Math.round((d.position?.y ?? 0) - cy), z: 1,
    };
    const at = (row, adapter, port) => endpoints.set(`${d.id}|${row.link}`, { node_id: nodeId, adapter_number: adapter, port_number: port });
    const cfg = texts.get(d.id);

    if (d.type === 'router' && !isMikrotik(d) && !isFrr(d)) {
      const { model, modules } = d;
      const ports = dynamipsPorts(model, modules);
      for (const r of rows) {
        const p = ports.find((x) => x.name === r.name);
        if (p) at(r, p.adapter, p.port);
        else warnings.push(`${d.label} ${r.name} : port introuvable sur le ${model}, câble retiré.`);
      }
      dynamipsId++;
      const slots = Object.fromEntries(slotList(MODELS[model]).filter((s) => modules[s.id])
        .map((s) => [s.kind === 'wic' ? s.id : `slot${s.id}`, modules[s.id]]));
      if (model === 'c3725') slots.slot0 = 'GT96100-FE';
      nodes.push({
        ...base, console: console++, console_type: 'telnet', node_type: 'dynamips', symbol: ':/symbols/router.svg',
        properties: {
          ...PLATFORM[model], image: GNS3_IMAGES[model], ram: RAM[model], nvram: 256, idlepc: '', dynamips_id: dynamipsId,
          auto_delete_disks: true, ...slots,
        },
      });
      files.push({ name: `project-files/dynamips/${nodeId}/configs/i${dynamipsId}_startup-config.cfg`, data: cfg.text });
    } else if (d.type === 'router') {
      // MikroTik ou FRR : appliance qemu ; le disque n'est pas fourni, la config se colle dans la console
      const model = isFrr(d) ? 'FRR' : MODELS[d.model]?.gns3 ? d.model : 'CHR';
      const own = dataPorts(d.model, d.modules).map((p) => p.name);
      let adapters = 1;
      for (const r of rows) {
        const a = own.indexOf(r.name);
        if (a < 0) continue;
        at(r, a, 0);
        adapters = Math.max(adapters, a + 1);
      }
      if (!modelOf(d).gns3) warnings.push(`${d.label} (${modelOf(d).label}) devient un MikroTik CHR 7.16 dans GNS3.`);
      warnings.push(`${d.label} : GNS3 ne précharge pas la config d'une machine qemu, colle-la dans sa console (export « GNS3 » en texte).`);
      nodes.push({
        ...base, console: console++, console_type: 'telnet', node_type: 'qemu', symbol: ':/symbols/router.svg',
        port_name_format: model === 'FRR' ? 'eth{0}' : 'ether{port1}',
        properties: {
          hda_disk_image: GNS3_IMAGES[model], adapters: Math.max(adapters, MODELS[model].ports.length), adapter_type: model === 'FRR' ? 'e1000' : 'virtio-net-pci',
          ram: model === 'FRR' ? 512 : 256, cpus: 1, platform: 'x86_64', console_type: 'telnet', options: model === 'FRR' ? '' : '-nographic',
        },
      });
    } else if (d.type === 'switch') {
      const vlanOf = (r) => (r.mode === 'trunk' ? Number(r.nativeVlan) || 1 : Number(r.vlan) || 1);
      const count = Math.max(8, rows.length);
      const byIndex = new Map(rows.map((r) => [r.index, r]));
      nodes.push({
        ...base, node_type: 'ethernet_switch', symbol: ':/symbols/ethernet_switch.svg',
        properties: {
          ports_mapping: Array.from({ length: count }, (_, n) => {
            const r = byIndex.get(n);
            return { name: `Ethernet${n}`, port_number: n, type: r?.mode === 'trunk' ? 'dot1q' : 'access', vlan: r ? vlanOf(r) : 1 };
          }),
        },
      });
      rows.forEach((r) => at(r, 0, r.index));
      if (modelOf(d).l3 || d.config?.interfaces?.length) warnings.push(`${d.label} : le switch Ethernet de GNS3 n'a pas de niveau 3 (SVI, routage), seuls les ports et VLAN sont repris.`);
      const lost = [
        rows.some((r) => r.channelGroup) && 'EtherChannel', rows.some((r) => r.ps?.enabled) && 'port-security',
        d.config?.vtp && 'VTP', rows.some((r) => r.allowedVlans) && 'VLAN autorisés',
      ].filter(Boolean);
      if (lost.length) warnings.push(`${d.label} : le switch Ethernet de GNS3 ne gère pas ${lost.join(', ')} (prends un switch IOU ou un c3725 avec NM-16ESW pour ça).`);
    } else if (d.type === 'hub') {
      nodes.push({
        ...base, node_type: 'ethernet_hub', symbol: ':/symbols/hub.svg',
        properties: { ports_mapping: Array.from({ length: Math.max(8, rows.length) }, (_, n) => ({ name: `Ethernet${n}`, port_number: n })) },
      });
      rows.forEach((r) => at(r, 0, r.index));
    } else if (d.type === 'cloud') {
      nodes.push({
        ...base, node_type: 'nat', symbol: ':/symbols/cloud.svg',
        properties: { ports_mapping: [{ interface: 'virbr0', name: 'nat0', port_number: 0, type: 'ethernet' }] },
      });
      if (rows[0]?.link) at(rows[0], 0, 0);
      if (rows.length > 1) warnings.push(`${d.label} : le nœud NAT de GNS3 n'a qu'un port, ${rows.length - 1} câble(s) retiré(s).`);
      warnings.push(`${d.label} devient un nœud NAT (Internet par l'hôte GNS3, DHCP en 192.168.122.0/24).`);
    } else {
      // PC, serveur, imprimante : VPCS (ping, DHCP, pas de services)
      nodes.push({
        ...base, console: console++, console_type: 'telnet', node_type: 'vpcs', symbol: ':/symbols/vpcs_guest.svg',
        properties: {},
      });
      if (rows[0]?.link) at(rows[0], 0, 0);
      if (rows.length > 1) warnings.push(`${d.label} : un VPCS n'a qu'une carte réseau, ${rows.length - 1} câble(s) retiré(s).`);
      if (d.config?.services && Object.keys(d.config.services).length) warnings.push(`${d.label} : VPCS ne fait ni DNS ni web, ses services ne sont pas repris.`);
      const vpc = cfg.text.split('\n').filter((l) => l && !l.startsWith('#'));
      files.push({ name: `project-files/vpcs/${nodeId}/startup.vpc`, data: `${vpc.join('\n')}\n` });
    }
  }

  const links = [];
  for (const [linkId] of topo.links) {
    const l = topo.links.get(linkId);
    const a = endpoints.get(`${l.source}|${linkId}`);
    const b = endpoints.get(`${l.target}|${linkId}`);
    if (!a || !b) continue;
    links.push({ filters: {}, link_id: uuid(), link_style: {}, nodes: [a, b], suspend: false });
  }

  const project = {
    auto_close: true, auto_open: false, auto_start: false, drawing_grid_size: 25, grid_size: 75,
    name: String(doc.name ?? '').replace(/[^\w .-]+/g, '-').trim() || 'netcanvas',
    project_id: uuid(), revision: 9, scene_height: 1000, scene_width: 2000,
    show_grid: false, show_interface_labels: true, show_layers: false, snap_to_grid: false, supplier: null,
    topology: { computes: [], drawings: [], links, nodes },
    type: 'topology', variables: null, version: '2.2.0', zoom: 100,
  };
  files.unshift({ name: 'project.gns3', data: `${JSON.stringify(project, null, 4)}\n` });
  return { files, warnings: [...new Set(warnings)], project };
}

export const toGns3Project = (doc) => writeZip(gns3Files(doc).files);
