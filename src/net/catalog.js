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
  CHR: {
    type: 'router', vendor: 'mikrotik', mdi: 'auto', label: 'MikroTik CHR (virtuel)', short: 'CHR',
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
};

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
export const isSviName = (name) => /^Vlan\d+$/.test(name ?? '');

export const modelOf = (d) => MODELS[d?.model] ?? MODELS[DEFAULT_MODEL[d?.type]] ?? MODELS['PC-PT'];
export const modelId = (d) => (MODELS[d?.model] ? d.model : DEFAULT_MODEL[d?.type] ?? 'PC-PT');
export const modelsOfType = (type) => Object.entries(MODELS).filter(([, m]) => m.type === type).map(([id, m]) => ({ id, ...m }));

// Ports d'un équipement : ports du modèle + ports des modules installés ({ [slot]: moduleId })
export function devicePorts(model, modules = {}) {
  const m = MODELS[model] ?? MODELS[DEFAULT_MODEL[model]];
  if (!m) return [];
  const extra = Object.entries(modules ?? {})
    .filter(([slot, mod]) => MODULES[mod] && m.slots?.ids.includes(Number(slot)) && MODULES[mod].slot === m.slots.kind)
    .sort(([a], [b]) => a - b)
    .flatMap(([slot, mod]) => MODULES[mod].ports(Number(slot)));
  // Les ports des modules se placent avant le port console
  const base = m.ports.filter((p) => p.media !== 'console' && p.media !== 'rs232');
  const admin = m.ports.filter((p) => p.media === 'console' || p.media === 'rs232');
  return [...base, ...extra, ...admin];
}

export const isDataMedia = (media) => media === 'copper' || media === 'fiber' || media === 'serial';
