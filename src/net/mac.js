// Adresses MAC : une par interface, stable (calculée à partir de l'équipement et du port),
// avec un préfixe constructeur (OUI) réaliste. Formats d'affichage Cisco, Windows et MikroTik.
import { isMikrotik } from './catalog.js';
import { isHost } from './topology.js';

const OUI = { cisco: [0x00, 0x01, 0x42], mikrotik: [0x4c, 0x5e, 0x0c], host: [0x00, 0xe0, 0xf7] };

function hash(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// Sous-interface : même MAC que l'interface parente ; SVI : MAC du switch ; loopback : aucune
export function macOf(dev, ifName) {
  if (!dev || /^(Lo\d+|lo)$/.test(ifName ?? '')) return null;
  const parent = (dev.config?.interfaces ?? []).find((i) => i.name === ifName)?.parent;
  const port = /^Vlan\d+$/.test(ifName ?? '') ? 'switch' : parent ?? ifName ?? 'nic';
  const oui = isMikrotik(dev) ? OUI.mikrotik : isHost(dev) ? OUI.host : OUI.cisco;
  const h = hash(`${dev.id}|${port}`);
  return [...oui, (h >>> 16) & 255, (h >>> 8) & 255, h & 255];
}

const hex = (b) => b.toString(16).padStart(2, '0');
// Cisco : 0001.42ab.cdef ; Windows : 00-e0-f7-ab-cd-ef ; MikroTik : 4C:5E:0C:AB:CD:EF
export const macCisco = (m) => (m ? [0, 2, 4].map((i) => hex(m[i]) + hex(m[i + 1])).join('.') : '-');
export const macWindows = (m) => (m ? m.map(hex).join('-') : '-');
export const macColon = (m) => (m ? m.map(hex).join(':').toUpperCase() : '-');
export const sameMac = (a, b) => a && b && a.join() === b.join();

// Délais de vieillissement (secondes)
export const MAC_AGING = 300; // table MAC d'un switch Cisco
export function arpTimeout(dev) {
  if (isHost(dev)) return 120; // cache ARP d'un PC (Windows)
  if (isMikrotik(dev)) return 30; // RouterOS : arp-timeout
  return 14400; // IOS : 4 heures
}
