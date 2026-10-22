// Variantes d'un sujet d'examen : chaque étudiant reçoit le même sujet avec d'autres adresses et d'autres
// numéros de VLAN, pour qu'une réponse copiée d'un voisin (ou d'une IA qui a vu un autre sujet) ne marche pas.
//
// La variante part du SUJET (le schéma avec ses pannes et ses objectifs), pas du schéma juste :
//  - adresses privées : 3e octet (et 2e octet de 10.x) décalés de façon bijective, 0 restant 0 ;
//  - VLAN : numéros remplacés par d'autres (1 et la plage réservée 1002+ ne bougent pas), noms de
//    sous-interfaces et d'interfaces VLAN compris ;
//  - tout ce qui cite ces valeurs suit : objectifs, consigne, libellés.
// Une variante n'est gardée que si le sujet y reste équivalent : mêmes objectifs atteints ou non, mêmes
// contrôles, mêmes tables de routes. Sinon on essaie une autre graine, puis un changement plus léger.
import { evaluateExercise } from './exercise.js';
import { withLeases } from './dhcp.js';
import { buildTopology } from './topology.js';
import { computeRouting } from './routing.js';
import { validate } from './validate.js';

export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 : générateur déterministe
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nom d'étudiant normalisé : « Élodie  DUPONT » et « elodie dupont » ont la même variante
export const normalizeName = (name) => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const isPrivate = (a, b) => a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
// Permutation de 1..255 qui laisse 0 en place (0.0.0.0, x.y.0.0 : réseaux courts, restent valides)
const shiftOctet = (c, k) => (c === 0 ? 0 : ((c - 1 + k) % 255) + 1);

const VLAN_NUMBER_KEYS = new Set(['vlan', 'nativeVlan', 'vlanId']);
const VLAN_LIST_KEYS = new Set(['allowedVlans']);
const movableVlan = (n) => Number.isInteger(n) && n > 1 && n < 1002;

// Parcours du schéma : `tools` donne les transformations (adresses, VLAN). Premier passage avec un
// « mappeur » qui note les VLAN rencontrés, second passage avec le vrai.
function walk(value, tools, key = '', parent = '') {
  if (typeof value === 'number') return VLAN_NUMBER_KEYS.has(key) ? tools.vlan(value) : value;
  if (typeof value === 'string') return mapText(value, tools, key);
  if (Array.isArray(value)) {
    if (VLAN_LIST_KEYS.has(key) || (key === 'disabled' && parent === 'stp')) return value.map((v) => (typeof v === 'number' ? tools.vlan(v) : walk(v, tools, key, parent)));
    return value.map((v) => walk(v, tools, key, parent));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Liste des VLAN déclarés : { id, name }
      if (k === 'id' && key === 'vlans' && typeof v === 'number') out[k] = tools.vlan(v);
      else out[tools.keys && key === 'priority' && parent === 'stp' ? tools.vlanKey(k) : k] = walk(v, tools, k, key);
    }
    return out;
  }
  return value;
}

function mapText(text, tools, key) {
  let out = text;
  if (tools.ip) {
    out = out.replace(IPV4, (m, a, b, c, d) => {
      const [A, B, C, D] = [a, b, c, d].map(Number);
      if ([A, B, C, D].some((x) => x > 255) || !isPrivate(A, B)) return m;
      return `${A}.${A === 10 ? shiftOctet(B, tools.k2) : B}.${shiftOctet(C, tools.k3)}.${D}`;
    });
  }
  if (tools.vlanOn) {
    // « VLAN 20 », « Vlan20 », « vlan20 » (consigne, interfaces VLAN, noms)
    out = out.replace(/\b(vlan)(\s*)(\d{1,4})\b/gi, (m, w, sp, n) => `${w}${sp}${tools.vlan(Number(n))}`);
    // Sous-interface « G0/0.10 »
    if (/^[A-Za-z][A-Za-z-]*\d+(?:\/\d+)*\.\d+$/.test(out)) out = out.replace(/\.(\d+)$/, (m, n) => `.${tools.vlan(Number(n))}`);
    // Paramètre d'objectif « vlan »
    if (key === 'vlan' && /^\d+$/.test(out)) out = String(tools.vlan(Number(out)));
  }
  return out;
}

// Comportement du sujet : à conserver à l'identique par une variante
function behaviour(doc) {
  const live = withLeases(doc);
  const topo = buildTopology(live);
  const routing = computeRouting(live, topo);
  const issues = validate(live, { topo, routing });
  return JSON.stringify({
    objectives: evaluateExercise(doc).map((r) => r.ok),
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warning').length,
    routes: [...routing.ribs.entries()].map(([id, rib]) => [id, rib.size]),
  });
}

const LEVELS = [
  { name: 'adresses et VLAN', ip: true, vlan: true, second: true },
  { name: 'adresses et VLAN', ip: true, vlan: true, second: false },
  { name: 'adresses', ip: true, vlan: false, second: false },
  { name: 'VLAN', ip: false, vlan: true, second: false },
];

function transform(subject, level, seed) {
  const rand = rng(seed);
  const k3 = 1 + Math.floor(rand() * 254);
  const k2 = level.second ? 1 + Math.floor(rand() * 254) : 0;
  // Premier passage : quels VLAN le schéma emploie-t-il ?
  const found = new Set();
  const note = (n) => { if (movableVlan(n)) found.add(n); return n; };
  const common = { ip: false, vlanOn: level.vlan, k3, k2, vlan: note, vlanKey: (k) => { note(Number(k)); return k; } };
  walk(subject, { ...common, keys: true });
  // Nouveaux numéros : multiples de 10, tous différents, jamais 1 ni la plage réservée
  const pool = Array.from({ length: 99 }, (_, i) => (i + 1) * 10);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const map = new Map(level.vlan ? [...found].sort((a, b) => a - b).map((n, i) => [n, pool[i]]) : []);
  const vlan = (n) => (movableVlan(n) && map.has(n) ? map.get(n) : n);
  const tools = { ip: level.ip, vlanOn: level.vlan, k3, k2, vlan, vlanKey: (k) => String(vlan(Number(k))), keys: true };
  return walk(subject, tools);
}

// Variante d'un sujet pour une graine. { doc, applied: 'adresses et VLAN' | 'adresses' | 'VLAN' | null }
export function makeVariant(subject, seed, { levels = LEVELS } = {}) {
  if (!subject?.exercise?.objectives?.length) return { doc: subject, applied: null };
  const before = JSON.stringify(subject);
  let base;
  try {
    base = behaviour(subject);
  } catch {
    return { doc: subject, applied: null };
  }
  for (const level of levels) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const doc = transform(subject, level, hashString(`${seed}:${level.name}:${attempt}`));
      if (JSON.stringify(doc) === before) continue;
      try {
        if (behaviour(doc) === base) return { doc, applied: level.name };
      } catch {
        /* variante invalide : on en essaie une autre */
      }
    }
  }
  return { doc: subject, applied: null };
}

// Ce que les variantes peuvent changer sur ce sujet (affiché au prof avant de créer l'examen)
export function variantSupport(subject) {
  const can = (level) => makeVariant(subject, 'essai', { levels: [level] }).applied !== null;
  return { ip: can(LEVELS[2]), vlan: can(LEVELS[3]) };
}

const cache = new Map();
// Variante d'un étudiant : graine = sel de l'examen + nom normalisé (le prof la retrouve à la notation).
// Les réglages de l'examen ne comptent pas : l'étudiant et le prof n'ont pas le même objet sous la main.
export function variantOf(subject, salt, student) {
  const { settings, examOptions, ...doc } = subject; // eslint-disable-line no-unused-vars
  const key = `${salt}|${normalizeName(student)}|${hashString(JSON.stringify(doc))}`;
  if (!cache.has(key)) {
    if (cache.size > 200) cache.clear();
    cache.set(key, makeVariant(doc, `${salt}|${normalizeName(student)}`));
  }
  return cache.get(key);
}
