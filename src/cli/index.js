// Point d'entrée des terminaux : choisit l'émulateur selon l'équipement.
import { ios } from './ios.js';
import { routeros } from './routeros.js';
import { frr } from './frr.js';
import { host } from './host.js';
import { isFrr, isMikrotik } from '../net/catalog.js';
import { HOST_TYPES } from '../net/topology.js';

// null : pas de terminal (Internet, hub)
export function shellFor(dev) {
  if (dev.type === 'cloud' || dev.type === 'hub') return null;
  if (HOST_TYPES.has(dev.type)) return host;
  if (isMikrotik(dev)) return routeros;
  if (isFrr(dev)) return frr;
  return ios;
}

// Filtres de sortie IOS : « show … | include|exclude|begin|section TEXTE » (le texte est une expression régulière)
const MODIFIERS = ['include', 'exclude', 'begin', 'section'];
function splitPipe(line) {
  const m = /^(.*?)\s*\|\s*(\w+)\s+(.+?)\s*$/.exec(line);
  if (!m) return null;
  const word = m[2].toLowerCase();
  const kind = MODIFIERS.find((k) => k.startsWith(word));
  return kind ? { command: m[1], kind, pattern: m[3] } : null;
}
function applyFilter(lines, { kind, pattern }) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const rows = lines.filter((l, i) => i < lines.length - 1 || l !== '');
  if (kind === 'include') return rows.filter((l) => re.test(l));
  if (kind === 'exclude') return rows.filter((l) => !re.test(l));
  if (kind === 'begin') {
    const at = rows.findIndex((l) => re.test(l));
    return at < 0 ? [] : rows.slice(at);
  }
  // section : une ligne sans retrait qui correspond, avec les lignes en retrait qui la suivent
  const out = [];
  let keep = false;
  for (const l of rows) {
    if (!/^\s/.test(l)) keep = re.test(l);
    if (keep) out.push(l);
  }
  return out;
}

// Exécute une ligne sur une copie de l'équipement ; renvoie { output, device (si modifié), effects }
export function runLine(shell, session, line, device, doc) {
  const pipe = shell === ios ? splitPipe(line) : null;
  const dev = structuredClone(device);
  const r = shell.run(session, pipe ? pipe.command : line, dev, doc);
  const output = pipe && !r.changed ? applyFilter(r.out, pipe) : r.out;
  return { output, device: r.changed ? r.dev : null, effects: r.effects };
}
