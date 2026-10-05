// Services réseau : DNS (UDP 53) et web (TCP 80), simulés de bout en bout.
//
// Serveur : config.services = { dns: { enabled, records: [{ name, ip }] }, http: { enabled, title, body } }
// Client  : PC / serveur : config.dns (statique) ou bail DHCP (lease.dns) ; routeur Cisco : config.nameServer,
//           table locale config.hosts = [{ name, ip }] (« ip host »).
// La requête suit le vrai chemin (ARP, routage, ACL, NAT, STP) : si elle n'arrive pas, la raison est donnée.
import { simulatePing } from './simulate.js';
import { withLeases } from './dhcp.js';
import { buildTopology } from './topology.js';
import { computeRouting } from './routing.js';
import { isValidIp, parseIp } from './ip.js';
import { isMikrotik } from './catalog.js';
import { isValidIp6, normIp6 } from './ip6.js';

const norm = (name) => String(name ?? '').trim().toLowerCase().replace(/\.$/, '');
// Nom d'hôte (« www.exemple.fr », point final accepté : forme absolue)
export const isHostname = (t) => /^(?=.{1,254}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/i.test(t ?? '') && !isValidIp(t);

// Serveur DNS utilisé par un équipement (document effectif : bail DHCP appliqué)
export function dnsServerOf(dev) {
  const c = dev?.config ?? {};
  if (dev?.type === 'router' || dev?.type === 'switch') return c.nameServer ?? null;
  return c.lease?.dns ?? c.dns ?? null;
}

// Le routeur sert aussi de serveur DNS : « ip dns server » (Cisco), « allow-remote-requests=yes » (MikroTik).
// Il répond avec sa table locale (ip host, /ip dns static) et relaie le reste à son propre serveur.
export function serviceEnabled(dev, svc) {
  return Boolean(dev?.config?.services?.[svc]?.enabled || (svc === 'dns' && dev?.config?.dnsServer));
}
const recordsOf = (dev) => (dev.config?.services?.dns?.enabled ? dev.config.services.dns.records ?? [] : dev.config?.hosts ?? []);
const MAX_FORWARD = 3;
const isAddr = (ip) => isValidIp(ip) || isValidIp6(ip);
// Enregistrements d'un nom : A (IPv4) et AAAA (IPv6). Un hôte qui a une adresse IPv6 globale préfère AAAA.
function pick(records, name, topo, srcId) {
  const all = records.filter((r) => norm(r.name) === norm(name));
  const v6 = all.find((r) => isValidIp6(r.ip));
  const v4 = all.find((r) => !isValidIp6(r.ip));
  const hasV6 = topo.l3Ifaces6(srcId).some((i) => i.ip);
  return { record: (hasV6 && v6) || v4 || v6 || null, all };
}

// Équipement qui possède une adresse IP
function ownerOf(topo, ip) {
  for (const d of topo.devices.values()) if (topo.l3Ifaces(d.id).some((i) => parseIp(i.ip) === parseIp(ip))) return d;
  return null;
}

const prepare = (rawDoc, ctx) => {
  const doc = ctx?.topo ? rawDoc : withLeases(rawDoc);
  const topo = ctx?.topo ?? buildTopology(doc);
  return { doc, topo, routing: ctx?.routing ?? computeRouting(doc, topo) };
};

// Résout un nom depuis srcId : { ok, ip, server, log: [{ phase, text, level, device }], query (résultat de simulation) }
export function resolveName(rawDoc, srcId, name, ctx = null, depth = 0) {
  const { doc, topo, routing } = prepare(rawDoc, ctx);
  const dev = topo.devices.get(srcId);
  const label = (id) => topo.devices.get(id)?.label ?? id;
  const log = [];
  const fail = (text, device = srcId) => ({ ok: false, ip: null, server: null, log: [...log, { phase: 'dns', text, level: 'error', device }] });
  if (isValidIp(name)) return { ok: true, ip: name, server: null, log };
  if (isValidIp6(name)) return { ok: true, ip: normIp6(name), server: null, log };
  if (!isHostname(name)) return fail(`« ${name} » n'est ni une adresse IP ni un nom valide.`);

  // Routeur : table locale « ip host » d'abord
  const local = pick(dev.config?.hosts ?? [], name, topo, srcId).record;
  if (local) return { ok: true, ip: local.ip, server: null, log: [{ phase: 'dns', text: `${label(srcId)} : ${name} est dans sa table locale (${isMikrotik(dev) ? '/ip dns static' : 'ip host'}) : ${local.ip}.`, level: 'ok', device: srcId }] };

  const server = dnsServerOf(dev);
  if (!server) {
    return fail(dev.type === 'router' || dev.type === 'switch'
      ? (isMikrotik(dev)
        ? `${label(srcId)} : aucun serveur DNS (/ip dns set servers=) ni entrée statique (/ip dns static) pour ${name}.`
        : `${label(srcId)} : aucun serveur DNS (« ip name-server ») ni entrée « ip host » pour ${name}.`)
      : `${label(srcId)} : aucun serveur DNS configuré, impossible de résoudre ${name}.`);
  }
  if (!isValidIp(server)) return fail(`${label(srcId)} : serveur DNS « ${server} » invalide.`);

  // Réponse préparée d'après le serveur visé (affichée dans la simulation pas à pas)
  const target = ownerOf(topo, server);
  const { record, all } = target ? pick(recordsOf(target), name, topo, srcId) : { record: null, all: [] };
  const answer = all.map((r) => `${norm(name)} ${isValidIp6(r.ip) ? 'AAAA' : 'A'} ${isValidIp6(r.ip) ? normIp6(r.ip) : r.ip}`).join(', ');
  const app = {
    name: 'DNS',
    request: [['Question', `${norm(name)} (type A et AAAA)`], ['ID', '0x1a2b']],
    reply: [['Réponse', record ? answer : 'NXDOMAIN (nom inconnu)'], ['ID', '0x1a2b']],
  };
  log.push({ phase: 'dns', text: `${label(srcId)} demande l'adresse de ${name} au serveur DNS ${server}.`, level: 'info', device: srcId });
  const query = simulatePing(doc, srcId, server, { topo, routing, proto: 'udp', dport: 53, app });
  if (!query.ok) {
    const err = query.log.findLast((l) => l.level === 'error');
    return { ...fail(`Résolution de ${name} impossible : la requête DNS n'aboutit pas. ${err?.text ?? ''}`.trim(), err?.device ?? srcId), query };
  }
  // Relais : le routeur pose la question à son propre serveur DNS
  if (!record && !target.config?.services?.dns?.enabled && dnsServerOf(target) && depth < MAX_FORWARD) {
    log.push({ phase: 'dns', text: `${label(target.id)} n'a pas ${name} dans sa table locale : il relaie la question à ${dnsServerOf(target)}.`, level: 'info', device: target.id });
    const up = resolveName(doc, target.id, name, { topo, routing }, depth + 1);
    const res = { ...up, log: [...log, ...up.log], query };
    if (!up.ok) return { ...res, server };
    res.log.push({ phase: 'dns', text: `${label(target.id)} transmet la réponse : ${name} = ${up.ip}.`, level: 'ok', device: target.id });
    return { ...res, server };
  }
  if (!record) {
    const fix = target.config?.services?.dns?.enabled ? 'ajoute un enregistrement A' : 'ajoute une entrée statique ou un serveur DNS à relayer';
    return { ...fail(`Le serveur DNS ${server} (${label(target.id)}) ne connaît pas ${name} (NXDOMAIN) : ${fix}.`, target.id), query };
  }
  if (!isAddr(record.ip)) return { ...fail(`Le serveur DNS ${label(target.id)} a pour ${name} une adresse invalide (« ${record.ip} »).`, target.id), query };
  const ip = isValidIp6(record.ip) ? normIp6(record.ip) : record.ip;
  const others = all.filter((r) => r !== record).map((r) => (isValidIp6(r.ip) ? normIp6(r.ip) : r.ip));
  log.push({ phase: 'dns', text: `${label(target.id)} répond : ${name} = ${ip}${others.length ? ` (aussi ${others.join(', ')})` : ''}.`, level: 'ok', device: target.id });
  return { ok: true, ip, addresses: [ip, ...others], server, log, query };
}

// Page web : résolution du nom si besoin, puis requête HTTP (TCP 80)
// { ok, ip, page: { title, body } | null, dns (résultat de resolveName), result (simulation HTTP), log }
export function httpGet(rawDoc, srcId, target, ctx = null) {
  const { doc, topo, routing } = prepare(rawDoc, ctx);
  const host = String(target).replace(/^https?:\/\//i, '').split('/')[0];
  const dns = resolveName(doc, srcId, host, { topo, routing });
  if (!dns.ok) return { ok: false, ip: null, page: null, dns, result: null, log: dns.log };
  const server = ownerOf(topo, dns.ip);
  const http = server?.config?.services?.http;
  const app = {
    name: 'HTTP',
    request: [['Requête', 'GET / HTTP/1.1'], ['Host', host]],
    reply: [['Statut', http?.enabled ? 'HTTP/1.1 200 OK' : '—'], ['Titre', http?.title || '—']],
  };
  const result = simulatePing(doc, srcId, dns.ip, { topo, routing, proto: 'tcp', dport: 80, app });
  const log = [...dns.log, ...result.log];
  if (!result.ok) return { ok: false, ip: dns.ip, page: null, dns, result, log };
  // NAT de destination possible : la page vient de l'équipement réellement atteint
  const reached = topo.devices.get(result.path.filter((p) => p.phase === 'request').at(-1)?.device) ?? server;
  const page = reached?.config?.services?.http ?? http;
  return { ok: true, ip: dns.ip, page: { title: page?.title || 'Page sans titre', body: page?.body ?? '' }, dns, result, log };
}

// Résultat unique pour le panneau de simulation et l'animation (même forme qu'un ping) :
// requête DNS puis, pour le web, requête HTTP ; trames et sauts mis bout à bout.
// kind : 'dns' | 'web' ; { ok, hops, frames, log, failedAt, natAdded, learned, service: { kind, name, ip, page } }
export function runService(rawDoc, srcId, kind, target, ctx = null) {
  const { doc, topo, routing } = prepare(rawDoc, ctx);
  const c = { topo, routing };
  const r = kind === 'web' ? httpGet(doc, srcId, target, c) : resolveName(doc, srcId, String(target).trim(), c);
  const dns = kind === 'web' ? r.dns : r;
  const sims = [dns.query, kind === 'web' ? r.result : null].filter(Boolean);
  // Messages DNS (phase « dns ») gardés dans l'ordre : avant la requête, puis la réponse ou l'échec
  const dnsLog = dns.log;
  const log = [...dnsLog.slice(0, 1), ...(dns.query?.log ?? []), ...dnsLog.slice(1), ...(kind === 'web' && r.result ? r.result.log : [])];
  const last = sims.at(-1);
  return {
    ok: r.ok,
    hops: sims.flatMap((s) => s.hops),
    frames: sims.flatMap((s) => s.frames ?? []),
    log,
    failedAt: r.ok ? null : (last && !last.ok ? last.failedAt : null) ?? dnsLog.findLast((l) => l.level === 'error')?.device ?? null,
    natAdded: sims.flatMap((s) => s.natAdded ?? []),
    learned: { arp: sims.flatMap((s) => s.learned?.arp ?? []), mac: sims.flatMap((s) => s.learned?.mac ?? []) },
    service: { kind, name: String(target).trim(), ip: r.ip ?? null, page: r.page ?? null },
  };
}
