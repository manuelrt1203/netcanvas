// Outils partagés par les terminaux : lire et modifier la config JSON d'un équipement.
import { devicePorts, isDataMedia, modelId } from '../net/catalog.js';
import { maskBits, parseIp } from '../net/ip.js';
import { simulatePing } from '../net/simulate.js';

export const dataPorts = (dev) => devicePorts(modelId(dev), dev.modules).filter((p) => isDataMedia(p.media));

// Câble branché sur un port (id) ou null
export function linkOf(doc, devId, name) {
  return doc.links.find((l) => (l.source === devId && l.sourceIface === name) || (l.target === devId && l.targetIface === name))?.id ?? null;
}

const list = (dev) => {
  dev.config ??= {};
  const key = dev.type === 'switch' ? 'ports' : 'interfaces';
  dev.config[key] ??= [];
  return dev.config[key];
};

export const getEntry = (dev, name) => list(dev).find((e) => e.name === name);

// Entrée de config d'un port, créée si besoin
export function ensureEntry(dev, name, doc) {
  let e = getEntry(dev, name);
  if (!e) {
    // Sous-interface Cisco « G0/0.10 » : rattachée à sa parente, sans câble propre
    const sub = dev.type !== 'switch' && /^(.+)\.\d+$/.exec(name);
    e = sub
      ? { link: null, name, parent: sub[1], ip: null, mask: null }
      : { link: linkOf(doc, dev.id, name), name, ...(dev.type === 'switch' ? { mode: 'access', vlan: 1 } : { ip: null, mask: null }) };
    list(dev).push(e);
  }
  return e;
}

// Document avec l'équipement modifié, pour recalculer la topologie après une commande
export const withDevice = (doc, dev) => ({ ...doc, devices: doc.devices.map((d) => (d.id === dev.id ? dev : d)) });

// Masque décimal pointé -> CIDR (null si non contigu)
export function maskToCidr(str) {
  const n = parseIp(str);
  if (n === null) return null;
  for (let c = 0; c <= 32; c++) if (maskBits(c) === n) return c;
  return null;
}

// Ping simulé + raison de l'échec (la particularité de NetCanvas)
export function ping(doc, srcId, ip) {
  const r = simulatePing(doc, srcId, ip);
  const reason = r.ok ? null : r.log.findLast((l) => l.level === 'error')?.text ?? null;
  return { ...r, reason };
}

export const pad = (s, n) => String(s).padEnd(n);
