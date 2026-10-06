// Import d'une configuration texte : « show running-config » Cisco ou « /export » MikroTik,
// rejouée ligne par ligne dans le terminal simulé de l'équipement. Les formulaires et le terminal
// écrivent la même config : l'import passe donc par les mêmes commandes, avec les mêmes contrôles.
import { shellFor } from './index.js';
import { host } from './host.js';
import { MODELS, MODULES, devicePorts, isDataMedia, isMikrotik, modelId, slotList } from '../net/catalog.js';

// Lignes sans effet sur la simulation : en-têtes de « show run », commentaires
const NOISE_IOS = [/^!/, /^\S+#\s*(sh|show)\s/i, /^Building configuration/i, /^Current configuration/i, /^Last configuration change/i, /^version \S+$/, /^end$/, /^boot-(start|end)-marker$/];

// Sections IOS acceptées sans effet : leurs lignes indentées (« archive / log config / hidekeys ») le sont aussi
const NOOP_SECTIONS = /^(archive|control-plane|crypto|voice|gatekeeper|call-home|license|redundancy)\b/i;

// IOS : bannières sur plusieurs lignes (« banner motd ^C ... ^C ») et lignes vides retirées
function iosLines(text) {
  const out = [];
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || NOISE_IOS.some((re) => re.test(line))) continue;
    // Bloc par défaut de tout switch Cisco : interface Vlan1 sans adresse, éteinte
    if (line === 'interface Vlan1' && lines[i + 1]?.trim() === 'no ip address' && lines[i + 2]?.trim() === 'shutdown') {
      i += 2;
      continue;
    }
    const banner = /^banner\s+\S+\s+(\^C|\S)(.*)$/.exec(line);
    if (banner) {
      const delim = banner[1];
      // Délimiteur refermé sur la même ligne, sinon on saute jusqu'à la ligne qui le contient
      if (!banner[2].includes(delim)) while (i + 1 < lines.length && !lines[++i].includes(delim));
      out.push({ n: i + 1, text: line, skipped: 'bannière ignorée' });
      continue;
    }
    out.push({ n: i + 1, text: line, indented: /^\s/.test(lines[i]) });
  }
  return out;
}

// RouterOS : commentaires « # », lignes continuées par « \ »
function routerosLines(text) {
  const out = [];
  let pending = null;
  text.replace(/\r/g, '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!pending && (!line || line.startsWith('#'))) return;
    const joined = pending ? `${pending.text} ${line}` : line;
    if (joined.endsWith('\\')) {
      pending = { n: pending?.n ?? i + 1, text: joined.slice(0, -1).trim() };
      return;
    }
    out.push({ n: pending?.n ?? i + 1, text: joined });
    pending = null;
  });
  if (pending) out.push(pending);
  return out;
}

// Première ligne d'erreur d'une sortie de terminal. IOS : « % message » ou « %Message » (pas les messages
// système « %LINK-5-CHANGED: … », ni l'information « Access VLAN does not exist. Creating vlan ») ;
// RouterOS : « bad command… », « failure… »
const IOS_INFO = /^% Access VLAN does not exist/;
const SYSLOG = /^%[A-Z0-9_]+-\d-[A-Z0-9_]+:/;
function errorOf(out) {
  return out.find((l) => (/^%/.test(l) && !SYSLOG.test(l) && !IOS_INFO.test(l)) || /^(bad command|syntax error|expected|failure|input does not match|no such item|invalid)/i.test(l)) ?? null;
}

// Renvoie { device (config importée), applied, ignored: [{ n, text, reason }] }
export function importConfig(device, doc, text) {
  const shell = shellFor(device);
  if (!shell || shell === host) throw new Error('Import possible seulement sur un routeur ou un switch.');
  const mk = isMikrotik(device);
  const dev = structuredClone(device);
  const docOf = () => ({ ...doc, devices: doc.devices.map((d) => (d.id === dev.id ? dev : d)) });
  const session = shell.newSession(dev);
  if (!mk) {
    shell.run(session, 'enable', dev, docOf());
    shell.run(session, 'configure terminal', dev, docOf());
  }
  let applied = 0;
  const ignored = [];
  let refused = null; // section (interface, router…) refusée : ses lignes indentées sont ignorées avec elle
  let noop = false; // section sans effet sur la simulation (archive, control-plane…) : son contenu aussi
  for (const { n, text: line, skipped, indented } of mk ? routerosLines(text) : iosLines(text)) {
    if (skipped) {
      ignored.push({ n, text: line, reason: skipped });
      continue;
    }
    if (indented && refused) {
      ignored.push({ n, text: line, reason: `ignorée avec « ${refused} » (ligne refusée plus haut)` });
      continue;
    }
    if (!indented) noop = !mk && NOOP_SECTIONS.test(line);
    else if (noop) continue;
    if (!indented) refused = null;
    // Une config collée ne quitte jamais le mode configuration
    if (!mk && /^(end|exit)$/i.test(line) && session.mode === 'config') continue;
    const r = shell.run(session, line, dev, docOf());
    const err = errorOf(r.out);
    if (err) {
      ignored.push({ n, text: line, reason: err.replace(/^%\s*/, '') });
      if (!indented) refused = line;
    } else applied++;
    if (!mk && (session.mode === 'priv' || session.mode === 'user')) shell.run(session, 'configure terminal', dev, docOf());
  }
  return { device: dev, applied, ignored };
}

// --- Interfaces d'une config venue d'un autre modèle ----------------------------------------------
// Ex. : « show run » d'un c3640 de GNS3 (FastEthernet0/0, FastEthernet1/0) importé dans un 2911 (G0/0…).
const LONG_TO_SHORT = [[/^gigabitethernet/i, 'G'], [/^fastethernet/i, 'Fa'], [/^ethernet/i, 'Eth'], [/^serial/i, 'Se']];
const SHORT_TO_LONG = { G: 'GigabitEthernet', Fa: 'FastEthernet', Eth: 'Ethernet', Se: 'Serial' };

// Interfaces physiques déclarées par « interface X » (sans loopbacks, VLAN, tunnels ni sous-interfaces), en noms courts
export function configInterfaces(text) {
  const out = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const m = /^interface\s+([a-z-]+)\s*(\d+(?:\/\d+)*)(\.\d+)?\s*$/i.exec(raw.trim());
    const type = m && LONG_TO_SHORT.find(([re]) => re.test(m[1]));
    if (!type) continue;
    const name = `${type[1]}${m[2]}`;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

const mediaOf = (name) => (name.startsWith('Se') ? 'serial' : 'copper');

// Modules qui donnent exactement ces interfaces sur ce modèle, ou null
function fitModel(modelKey, names) {
  const model = MODELS[modelKey];
  const want = new Set(names);
  const fixed = model.ports.filter((p) => isDataMedia(p.media)).map((p) => p.name);
  if (fixed.some((n) => !want.has(n))) return null; // « show run » liste toutes les interfaces : aucune en trop
  const modules = {};
  const left = new Set(names.filter((n) => !fixed.includes(n)));
  for (const slot of slotList(model)) {
    // Module de l'emplacement dont tous les ports sont demandés, le plus grand d'abord
    const best = Object.entries(MODULES)
      .filter(([, mod]) => mod.slot === slot.kind)
      .map(([id, mod]) => [id, mod.ports(slot.n).map((p) => p.name)])
      .filter(([, ports]) => ports.every((n) => left.has(n)))
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (best) {
      modules[slot.id] = best[0];
      best[1].forEach((n) => left.delete(n));
    } else if (slot.required) return null;
  }
  return left.size ? null : modules;
}

// Analyse avant import : interfaces absentes du modèle actuel, modèles qui les ont toutes, correspondance proposée
export function analyzeInterfaces(device, text) {
  const names = configInterfaces(text);
  const ports = devicePorts(modelId(device), device.modules).filter((p) => isDataMedia(p.media));
  const have = new Set(ports.map((p) => p.name));
  const missing = names.filter((n) => !have.has(n));
  if (!missing.length || isMikrotik(device) || device.type !== 'router') return { names, missing: [], models: [], mapping: {} };
  const models = Object.keys(MODELS)
    .filter((id) => MODELS[id].type === 'router' && !MODELS[id].vendor && !MODELS[id].generic)
    .map((id) => ({ id, label: MODELS[id].label, modules: fitModel(id, names) }))
    .filter((m) => m.modules)
    .sort((a, b) => Number(Boolean(MODELS[b.id].gns3)) - Number(Boolean(MODELS[a.id].gns3)));
  // Correspondance par défaut : même média, dans l'ordre ; les interfaces déjà présentes gardent leur nom
  const free = ports.filter((p) => !names.includes(p.name));
  const mapping = {};
  for (const n of missing) {
    const i = free.findIndex((p) => (p.media === 'serial') === (mediaOf(n) === 'serial'));
    mapping[n] = i >= 0 ? free.splice(i, 1)[0].name : '';
  }
  return { names, missing, models, mapping };
}

// Renomme les interfaces dans tout le texte (interface, passive-interface, ip route, nat…) : { 'Fa0/0': 'G0/0' }
export function renameInterfaces(text, mapping) {
  const entries = Object.entries(mapping).filter(([from, to]) => to && from !== to);
  if (!entries.length) return text;
  const re = /\b(GigabitEthernet|FastEthernet|Ethernet|Serial|Gi|Fa|Eth|Se|G|F|E|S)\s?(\d+(?:\/\d+)+)(?![\d/])/gi;
  return text.replace(re, (all, type, num) => {
    const short = LONG_TO_SHORT.find(([r]) => r.test(type))?.[1]
      ?? { gi: 'G', g: 'G', fa: 'Fa', f: 'Fa', eth: 'Eth', e: 'Eth', se: 'Se', s: 'Se' }[type.toLowerCase()];
    const to = mapping[`${short}${num}`];
    if (!to) return all;
    const [, t, n] = /^([A-Za-z]+)(.*)$/.exec(to);
    return `${SHORT_TO_LONG[t] ?? t}${n}`;
  });
}
