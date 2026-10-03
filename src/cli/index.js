// Point d'entrée des terminaux : choisit l'émulateur selon l'équipement.
import { ios } from './ios.js';
import { routeros } from './routeros.js';
import { host } from './host.js';
import { isMikrotik } from '../net/catalog.js';
import { HOST_TYPES } from '../net/topology.js';

// null : pas de terminal (Internet, hub)
export function shellFor(dev) {
  if (dev.type === 'cloud' || dev.type === 'hub') return null;
  if (HOST_TYPES.has(dev.type)) return host;
  if (isMikrotik(dev)) return routeros;
  return ios;
}

// Exécute une ligne sur une copie de l'équipement ; renvoie { output, device (si modifié), effects }
export function runLine(shell, session, line, device, doc) {
  const dev = structuredClone(device);
  const r = shell.run(session, line, dev, doc);
  return { output: r.out, device: r.changed ? r.dev : null, effects: r.effects };
}
