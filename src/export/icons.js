// Icônes des équipements en SVG brut (trait, 24x24) : partagées par l'éditeur et les exports SVG/PNG.
import { TYPES, modelOf } from '../net/catalog.js';

export const ICONS = {
  router:
    '<circle cx="12" cy="12" r="9"/><path d="M8 8l3 3M8 8h2.5M8 8v2.5M16 16l-3-3M16 16h-2.5M16 16v-2.5M16 8l-3 3M16 8h-2.5M16 8v2.5M8 16l3-3M8 16h2.5M8 16v-2.5"/>',
  switch: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 11h1M9 11h1M12 11h1M15 11h1M18 11h1M6 14h12"/>',
  pc: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  server: '<rect x="4" y="3" width="16" height="8" rx="1.5"/><rect x="4" y="13" width="16" height="8" rx="1.5"/><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5z"/>',
  hub: '<rect x="2" y="8" width="20" height="8" rx="2"/><path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01"/>',
  printer: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="1.5"/><path d="M7 14h10v7H7z"/>',
  laptop: '<rect x="5" y="5" width="14" height="10" rx="1"/><path d="M2 19h20l-2-4H4z"/>',
};

export const LABELS = Object.fromEntries(Object.entries(TYPES).map(([t, v]) => [t, v.label]));

// Icône d'un équipement : celle du modèle (portable…) sinon celle du type
export const iconOf = (d) => ICONS[modelOf(d).icon] ?? ICONS[d.type] ?? ICONS.pc;

// Couleurs du thème clair, utilisées pour les exports (rapports imprimés)
export const COLORS = {
  router: '#0b6bcb', switch: '#0f766e', hub: '#0f766e', pc: '#475569', server: '#7c3aed', printer: '#475569', cloud: '#c2410c',
};

// Style des câbles dans les exports : couleur, pointillés
export const CABLE_STYLE = {
  straight: { color: '#64748b', dash: null },
  cross: { color: '#64748b', dash: '6 4' },
  fiber: { color: '#ea580c', dash: null },
  serial: { color: '#dc2626', dash: null },
  console: { color: '#0891b2', dash: '2 4' },
};
