// Catalogue des formats d'export proposés dans l'onglet « Export ».
import { ciscoBundle } from './cisco.js';
import { toContainerlab } from './containerlab.js';
import { toCsv } from './csv.js';
import { toDrawio } from './drawio.js';
import { toSvg } from './svg.js';
import { fileSafe } from './common.js';

export const FORMATS = [
  {
    id: 'json', label: 'NetCanvas (JSON)', ext: 'json', mime: 'application/json',
    help: 'Le schéma complet, réimportable avec le bouton Importer.',
    build: (doc) => `${JSON.stringify(doc, null, 2)}\n`,
  },
  {
    id: 'packet-tracer', label: 'Cisco Packet Tracer', ext: 'txt', mime: 'text/plain',
    help: 'Un bloc par routeur (2911) et switch (2960) à coller dans l\'onglet CLI. La config des PC est indiquée en commentaire.',
    build: (doc) => ciscoBundle(doc, 'packet-tracer'),
  },
  {
    id: 'gns3', label: 'GNS3', ext: 'txt', mime: 'text/plain',
    help: 'Startup-config des routeurs c7200, ports du switch Ethernet intégré et commandes VPCS des PC.',
    build: (doc) => ciscoBundle(doc, 'gns3'),
  },
  {
    id: 'containerlab', label: 'Containerlab', ext: 'clab.yml', mime: 'text/yaml',
    help: 'Le réseau en vrai avec des conteneurs Linux : sudo containerlab deploy -t fichier.clab.yml',
    build: toContainerlab,
  },
  {
    id: 'csv', label: 'Plan d\'adressage (CSV)', ext: 'csv', mime: 'text/csv',
    help: 'Une ligne par interface. S\'ouvre directement dans Excel ou LibreOffice (séparateur ;).',
    build: toCsv,
  },
  {
    id: 'drawio', label: 'draw.io', ext: 'drawio', mime: 'application/xml',
    help: 'Schéma modifiable dans diagrams.net, avec les icônes Cisco.',
    build: toDrawio,
  },
  {
    id: 'svg', label: 'Image SVG', ext: 'svg', mime: 'image/svg+xml',
    help: 'Image vectorielle sur fond clair, pour un rapport ou une présentation.',
    build: toSvg,
  },
  {
    id: 'png', label: 'Image PNG', ext: 'png', mime: 'image/png', binary: true,
    help: 'Même image que le SVG, en PNG haute définition (x2).',
    build: toSvg, // converti en PNG par le navigateur au téléchargement
  },
];

export const formatById = (id) => FORMATS.find((f) => f.id === id) ?? FORMATS[0];

export const fileName = (doc, format) => `${fileSafe(doc.name)}.${format.ext}`;

// Avertissements des configs Cisco (interfaces absentes du matériel, pas d'IP…)
export { ciscoConfigs } from './cisco.js';
