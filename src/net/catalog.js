// Catalogue du matériel : modèles d'équipements, modules et types de câbles.
// Inspiré de Cisco Packet Tracer : mêmes noms de modèles et de ports, pour que les configs exportées
// se collent telles quelles.
//
// Un port : { name, media } avec media = copper | fiber | serial | console | rs232
//   copper / fiber / serial transportent des données ; console / rs232 servent à l'administration.

const port = (name, media = 'copper') => ({ name, media });
const range = (format, from, to, media) => Array.from({ length: to - from + 1 }, (_, i) => port(format(from + i), media));

// Famille électrique pour le choix droit / croisé (MDI : carte réseau, routeur ; MDI-X : switch, hub).
// 'auto' accepte les deux (le nuage Internet n'a pas de contrainte).
export const MDI = { router: 'mdi', pc: 'mdi', server: 'mdi', printer: 'mdi', switch: 'mdix', hub: 'mdix', cloud: 'auto' };

export const TYPES = {
  router: { label: 'Routeur', plural: 'Routeurs', one: 'un routeur', two: 'deux routeurs' },
  switch: { label: 'Switch', plural: 'Switches', one: 'un switch', two: 'deux switches' },
  hub: { label: 'Hub', plural: 'Hubs', one: 'un hub', two: 'deux hubs' },
  pc: { label: 'PC', plural: 'PC', one: 'un PC', two: 'deux PC' },
  server: { label: 'Serveur', plural: 'Serveurs', one: 'un serveur', two: 'deux serveurs' },
  printer: { label: 'Imprimante', plural: 'Imprimantes', one: 'une imprimante', two: 'deux imprimantes' },
  cloud: { label: 'Internet', plural: 'Internet', one: 'Internet', two: 'deux accès Internet' },
};
const CONSOLE = port('Console', 'console');
const RS232 = port('RS232', 'rs232');

export const MODELS = {
  // --- Routeurs ---------------------------------------------------------------
  1941: {
    type: 'router', label: 'Cisco 1941', short: '1941',
    ports: [port('G0/0'), port('G0/1'), CONSOLE],
    slots: { kind: 'ehwic', ids: [0, 1] },
  },
  2901: {
    type: 'router', label: 'Cisco 2901', short: '2901',
    ports: [port('G0/0'), port('G0/1'), CONSOLE],
    slots: { kind: 'ehwic', ids: [0, 1, 2, 3] },
  },
  2911: {
    type: 'router', label: 'Cisco 2911', short: '2911',
    ports: [port('G0/0'), port('G0/1'), port('G0/2'), CONSOLE],
    slots: { kind: 'ehwic', ids: [0, 1, 2, 3] },
  },
  ISR4321: {
    type: 'router', label: 'Cisco ISR 4321', short: '4321',
    ports: [port('G0/0/0'), port('G0/0/1'), CONSOLE],
    slots: { kind: 'nim', ids: [1, 2] },
  },
  // Routeurs Dynamips de GNS3 : mêmes emplacements et modules que dans GNS3 (Configure > Slots)
  c3640: {
    type: 'router', gns3: true, label: 'Cisco 3640 (GNS3)', short: 'c3640',
    ports: [CONSOLE],
    slots: { kind: 'nm', ids: [0, 1, 2, 3] },
    defaultModules: { 0: 'NM-1FE-TX' },
  },
  c3725: {
    type: 'router', gns3: true, label: 'Cisco 3725 (GNS3)', short: 'c3725',
    ports: [port('Fa0/0'), port('Fa0/1'), CONSOLE],
    slots: [{ kind: 'wic', ids: ['wic0', 'wic1', 'wic2'] }, { kind: 'nm', ids: [1, 2] }],
  },
  c7200: {
    type: 'router', gns3: true, label: 'Cisco 7200 (GNS3)', short: 'c7200',
    ports: [CONSOLE],
    slots: [{ kind: 'c7200-io', ids: [0], required: true }, { kind: 'pa', ids: [1, 2, 3, 4, 5, 6] }],
    defaultModules: { 0: 'C7200-IO-FE' },
  },
  // MikroTik (RouterOS) : ports etherN en auto-MDI/MDIX, terminal RouterOS
  'hAP-ac2': {
    type: 'router', vendor: 'mikrotik', mdi: 'auto', label: 'MikroTik hAP ac²', short: 'hAP ac²',
    ports: range((i) => `ether${i}`, 1, 5),
  },
  RB4011: {
    type: 'router', vendor: 'mikrotik', mdi: 'auto', label: 'MikroTik RB4011', short: 'RB4011',
    ports: [...range((i) => `ether${i}`, 1, 10), port('sfp-sfpplus1', 'fiber'), port('serial0', 'console')],
  },
  CCR2004: {
    type: 'router', vendor: 'mikrotik', mdi: 'auto', label: 'MikroTik CCR2004-16G-2S+', short: 'CCR2004',
    ports: [...range((i) => `ether${i}`, 1, 16), port('sfp-sfpplus1', 'fiber'), port('sfp-sfpplus2', 'fiber'), port('serial0', 'console')],
  },
  // FRRouting (appliance GNS3) : Linux + vtysh, interfaces eth0…, auto-MDI comme toute carte virtuelle
  FRR: {
    type: 'router', vendor: 'frr', mdi: 'auto', gns3: true, label: 'FRR 7.5.1', short: 'FRR',
    ports: range((i) => `eth${i}`, 0, 7),
  },
  // MikroTik CHR (virtuel) des appliances GNS3 : la 6.49 a l'ancienne syntaxe de routage (/routing ospf network…)
  'CHR-6.49': {
    type: 'router', vendor: 'mikrotik', mdi: 'auto', gns3: true, ros: 6, label: 'MikroTik CHR 6.49.19', short: 'CHR 6.49',
    ports: range((i) => `ether${i}`, 1, 8),
  },
  'CHR-7.1': {
    type: 'router', vendor: 'mikrotik', mdi: 'auto', gns3: true, ros: 7, label: 'MikroTik CHR 7.1', short: 'CHR 7.1',
    ports: range((i) => `ether${i}`, 1, 8),
  },
  CHR: {
    type: 'router', vendor: 'mikrotik', mdi: 'auto', gns3: true, ros: 7, label: 'MikroTik CHR 7.16', short: 'CHR 7.16',
    ports: range((i) => `ether${i}`, 1, 8),
  },
  'Router-PT': {
    type: 'router', label: 'Routeur générique', short: 'Router-PT', generic: true,
    ports: [...range((i) => `G0/${i}`, 0, 7), port('G1/0', 'fiber'), port('G1/1', 'fiber'), ...range((i) => `Se2/${i}`, 0, 3, 'serial'), CONSOLE],
  },

  // --- Switches et hub ----------------------------------------------------------
  '2960-24TT': {
    type: 'switch', label: 'Cisco 2960-24TT', short: '2960-24',
    ports: [...range((i) => `Fa0/${i}`, 1, 24), port('G0/1'), port('G0/2'), CONSOLE],
  },
  '2960-48TT': {
    type: 'switch', label: 'Cisco 2960-48TT', short: '2960-48',
    ports: [...range((i) => `Fa0/${i}`, 1, 48), port('G0/1'), port('G0/2'), CONSOLE],
  },
  // Switches niveau 3 : interfaces VLAN (SVI) et « ip routing »
  '3560-24PS': {
    type: 'switch', l3: true, label: 'Cisco 3560-24PS (niveau 3)', short: '3560-24',
    ports: [...range((i) => `Fa0/${i}`, 1, 24), port('G0/1'), port('G0/2'), CONSOLE],
  },
  '3650-24PS': {
    type: 'switch', l3: true, label: 'Cisco 3650-24PS (niveau 3)', short: '3650-24',
    ports: [...range((i) => `G1/0/${i}`, 1, 24), ...range((i) => `G1/1/${i}`, 1, 4, 'fiber'), CONSOLE],
  },
  'Switch-PT': {
    type: 'switch', label: 'Switch générique', short: 'Switch-PT', generic: true,
    ports: [...range((i) => `Fa0/${i}`, 1, 24), port('G0/1'), port('G0/2'), port('G0/3', 'fiber'), port('G0/4', 'fiber'), CONSOLE],
  },
  'Hub-PT': {
    type: 'hub', label: 'Hub', short: 'Hub',
    ports: range((i) => `Port${i}`, 0, 5),
  },

  // --- Hôtes ----------------------------------------------------------------------
  'PC-PT': { type: 'pc', label: 'PC', short: 'PC', ports: [port('Fa0'), RS232] },
  'Laptop-PT': { type: 'pc', label: 'Ordinateur portable', short: 'Portable', icon: 'laptop', ports: [port('Fa0'), RS232] },
  'Server-PT': { type: 'server', label: 'Serveur', short: 'Serveur', ports: [port('Fa0')] },
  'Printer-PT': { type: 'printer', label: 'Imprimante', short: 'Imprimante', ports: [port('Fa0')] },
  Cloud: { type: 'cloud', label: 'Internet', short: 'Internet', ports: [port('Eth0')] },
};

// Modules d'extension des routeurs : interface 0/<slot>/<n>
export const MODULES = {
  'HWIC-2T': { label: 'HWIC-2T : 2 ports série', slot: 'ehwic', ports: (s) => [port(`Se0/${s}/0`, 'serial'), port(`Se0/${s}/1`, 'serial')] },
  'HWIC-1GE-SFP': { label: 'HWIC-1GE-SFP : 1 port fibre', slot: 'ehwic', ports: (s) => [port(`G0/${s}/0`, 'fiber')] },
  'NIM-2T': { label: 'NIM-2T : 2 ports série', slot: 'nim', ports: (s) => [port(`Se0/${s}/0`, 'serial'), port(`Se0/${s}/1`, 'serial')] },
  'NIM-1GE-CU-SFP': { label: 'NIM-1GE-CU-SFP : 1 port fibre', slot: 'nim', ports: (s) => [port(`G0/${s}/0`, 'fiber')] },
  // Dynamips (GNS3) : modules réseau des c3640 / c3725, interface <slot>/<n>
  'NM-1FE-TX': { label: 'NM-1FE-TX : 1 port FastEthernet', slot: 'nm', ports: (s) => [port(`Fa${s}/0`)] },
  'NM-1E': { label: 'NM-1E : 1 port Ethernet', slot: 'nm', ports: (s) => [port(`Eth${s}/0`)] },
  'NM-4E': { label: 'NM-4E : 4 ports Ethernet', slot: 'nm', ports: (s) => range((i) => `Eth${s}/${i}`, 0, 3) },
  'NM-4T': { label: 'NM-4T : 4 ports série', slot: 'nm', ports: (s) => range((i) => `Se${s}/${i}`, 0, 3, 'serial') },
  // Cartes WIC du c3725 : ports série Serial0/<n>, numérotés à la suite (wic0 -> 0/0-0/1, wic1 -> 0/2-0/3…)
  'WIC-1T': { label: 'WIC-1T : 1 port série', slot: 'wic', ports: (w) => [port(`Se0/${w * 2}`, 'serial')] },
  'WIC-2T': { label: 'WIC-2T : 2 ports série', slot: 'wic', ports: (w) => [port(`Se0/${w * 2}`, 'serial'), port(`Se0/${w * 2 + 1}`, 'serial')] },
  // c7200 : carte d'entrées-sorties (slot 0) et adaptateurs de ports (slots 1 à 6)
  'C7200-IO-FE': { label: 'C7200-IO-FE : 1 port FastEthernet', slot: 'c7200-io', ports: () => [port('Fa0/0')] },
  'C7200-IO-2FE': { label: 'C7200-IO-2FE : 2 ports FastEthernet', slot: 'c7200-io', ports: () => [port('Fa0/0'), port('Fa0/1')] },
  'C7200-IO-GE-E': { label: 'C7200-IO-GE-E : 1 port Gigabit', slot: 'c7200-io', ports: () => [port('G0/0')] },
  'PA-FE-TX': { label: 'PA-FE-TX : 1 port FastEthernet', slot: 'pa', ports: (s) => [port(`Fa${s}/0`)] },
  'PA-2FE-TX': { label: 'PA-2FE-TX : 2 ports FastEthernet', slot: 'pa', ports: (s) => [port(`Fa${s}/0`), port(`Fa${s}/1`)] },
  'PA-4E': { label: 'PA-4E : 4 ports Ethernet', slot: 'pa', ports: (s) => range((i) => `Eth${s}/${i}`, 0, 3) },
  'PA-8E': { label: 'PA-8E : 8 ports Ethernet', slot: 'pa', ports: (s) => range((i) => `Eth${s}/${i}`, 0, 7) },
  'PA-4T+': { label: 'PA-4T+ : 4 ports série', slot: 'pa', ports: (s) => range((i) => `Se${s}/${i}`, 0, 3, 'serial') },
  'PA-8T': { label: 'PA-8T : 8 ports série', slot: 'pa', ports: (s) => range((i) => `Se${s}/${i}`, 0, 7, 'serial') },
  'PA-GE': { label: 'PA-GE : 1 port Gigabit', slot: 'pa', ports: (s) => [port(`G${s}/0`)] },
};

export const SLOT_LABEL = { ehwic: 'EHWIC', nim: 'NIM', nm: 'NM', wic: 'WIC', 'c7200-io': 'I/O', pa: 'PA' };

// Emplacements d'un modèle, à plat : [{ id, n, kind, required }] ; id = clé dans device.modules
export function slotList(model) {
  const groups = [model?.slots ?? []].flat();
  return groups.flatMap((g) => g.ids.map((id) => ({ id: String(id), n: Number(String(id).replace(/\D/g, '')), kind: g.kind, required: Boolean(g.required) })));
}

export const DEFAULT_MODEL = {
  router: '2911', switch: '2960-24TT', hub: 'Hub-PT', pc: 'PC-PT', server: 'Server-PT', printer: 'Printer-PT', cloud: 'Cloud',
};

export const CABLES = {
  straight: { label: 'Droit', media: 'copper', help: 'Cuivre RJ45 entre familles différentes : PC ↔ switch, routeur ↔ switch.' },
  cross: { label: 'Croisé', media: 'copper', help: 'Cuivre RJ45 entre équipements de même famille : PC ↔ routeur, switch ↔ switch.' },
  fiber: { label: 'Fibre', media: 'fiber', help: 'Entre deux ports fibre (SFP).' },
  serial: { label: 'Série', media: 'serial', help: 'Liaison WAN entre deux routeurs. Le côté DCE fournit l\'horloge (clock rate).' },
  console: { label: 'Console', media: 'console', help: 'Administration : port RS232 d\'un PC ↔ port Console d\'un routeur ou switch.' },
};

export const MEDIA_LABEL = { copper: 'cuivre', fiber: 'fibre', serial: 'série', console: 'console', rs232: 'RS232' };

// Débits proposés pour « clock rate » sur un port série DCE (bits/s)
export const CLOCK_RATES = [64000, 128000, 256000, 512000, 1000000, 2000000, 4000000];

export const vendorOf = (d) => modelOf(d).vendor ?? 'cisco';
export const isMikrotik = (d) => vendorOf(d) === 'mikrotik';
export const isFrr = (d) => vendorOf(d) === 'frr';
export const isSviName = (name) => /^Vlan\d+$/.test(name ?? '');

export const modelOf = (d) => MODELS[d?.model] ?? MODELS[DEFAULT_MODEL[d?.type]] ?? MODELS['PC-PT'];
export const modelId = (d) => (MODELS[d?.model] ? d.model : DEFAULT_MODEL[d?.type] ?? 'PC-PT');
export const modelsOfType = (type) => Object.entries(MODELS).filter(([, m]) => m.type === type).map(([id, m]) => ({ id, ...m }));

// Ports d'un équipement : ports du modèle + ports des modules installés ({ [slot]: moduleId })
export function devicePorts(model, modules = {}) {
  const m = MODELS[model] ?? MODELS[DEFAULT_MODEL[model]];
  if (!m) return [];
  const extra = slotList(m)
    .filter((s) => MODULES[modules?.[s.id]]?.slot === s.kind)
    .flatMap((s) => MODULES[modules[s.id]].ports(s.n));
  // Les ports des modules se placent avant le port console
  const base = m.ports.filter((p) => p.media !== 'console' && p.media !== 'rs232');
  const admin = m.ports.filter((p) => p.media === 'console' || p.media === 'rs232');
  return [...base, ...extra, ...admin];
}

export const isDataMedia = (media) => media === 'copper' || media === 'fiber' || media === 'serial';
