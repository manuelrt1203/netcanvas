// Catalogue des équipements pour l'éditeur (icônes partagées avec les exports).
import { ICONS } from './export/icons.js';
import { MODELS, TYPES, modelsOfType } from './net/catalog.js';

export const Icon = ({ name }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] ?? ICONS.pc }} />
);

export const iconName = (type, model) => MODELS[model]?.icon ?? type;

export const DEVICE_TYPES = Object.keys(TYPES);

// Palette : groupes de modèles, comme le sélecteur en bas à gauche de Packet Tracer
export const PALETTE = [
  { title: 'Routeurs Cisco', models: modelsOfType('router').filter((m) => m.vendor !== 'mikrotik') },
  { title: 'MikroTik', models: modelsOfType('router').filter((m) => m.vendor === 'mikrotik') },
  { title: 'Switches', models: [...modelsOfType('switch'), ...modelsOfType('hub')] },
  { title: 'Hôtes', models: [...modelsOfType('pc'), ...modelsOfType('server'), ...modelsOfType('printer')] },
  { title: 'Réseaux externes', models: modelsOfType('cloud') },
];
