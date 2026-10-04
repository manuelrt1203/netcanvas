// Import d'une configuration texte : « show running-config » Cisco ou « /export » MikroTik,
// rejouée ligne par ligne dans le terminal simulé de l'équipement. Les formulaires et le terminal
// écrivent la même config : l'import passe donc par les mêmes commandes, avec les mêmes contrôles.
import { shellFor } from './index.js';
import { host } from './host.js';
import { isMikrotik } from '../net/catalog.js';

// Lignes sans effet sur la simulation : en-têtes de « show run », commentaires
const NOISE_IOS = [/^!/, /^Building configuration/i, /^Current configuration/i, /^Last configuration change/i, /^version \S+$/, /^end$/, /^boot-(start|end)-marker$/];

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
  for (const { n, text: line, skipped, indented } of mk ? routerosLines(text) : iosLines(text)) {
    if (skipped) {
      ignored.push({ n, text: line, reason: skipped });
      continue;
    }
    if (indented && refused) {
      ignored.push({ n, text: line, reason: `ignorée avec « ${refused} » (ligne refusée plus haut)` });
      continue;
    }
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
