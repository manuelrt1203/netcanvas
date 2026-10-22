// Route-maps (Cisco IOS) appliquées aux routes : voisins BGP (« neighbor X route-map NOM in|out »)
// et redistribution (« redistribute … route-map NOM »).
//
// config.routeMaps = { [nom]: [clause] }, clause = {
//   seq, action: 'permit' | 'deny',
//   match: { acl?: [noms], tag?: [n], prefixList?: [noms] },       // plusieurs valeurs : l'une d'elles suffit
//   set:   { localPref?, metric?, weight?, tag?, prepend?: [AS], nextHop? },
// }
// Les clauses sont essayées dans l'ordre du numéro ; la première dont les « match » sont tous vrais s'applique
// (sans « match » : toutes les routes). Aucune clause ne correspond : route refusée (refus implicite).
import { matchSpec } from './acl.js';
import { formatIp } from './ip.js';

export const sortedClauses = (rm) => [...(rm ?? [])].sort((a, b) => a.seq - b.seq);

// « match ip address ACL » sur une route : la source de l'ACL est testée sur l'adresse du réseau
// (ACL étendue : la destination sur son masque, comme IOS)
export function aclPermitsRoute(acl, net, mask) {
  const ip = formatIp(net);
  const maskIp = formatIp(mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0);
  for (const r of acl?.rules ?? []) {
    if (r.remark !== undefined) continue;
    const hit = acl.type === 'standard' ? matchSpec(r.src, ip) : matchSpec(r.src, ip) && matchSpec(r.dst ?? { any: true }, maskIp);
    if (hit) return r.action === 'permit';
  }
  return false;
}

function prefixListPermits(list, net, mask) {
  const ip = formatIp(net);
  for (const e of [...(list ?? [])].sort((a, b) => a.seq - b.seq)) {
    const [pnet, plen] = String(e.prefix).split('/');
    const len = Number(plen);
    const ge = e.ge ?? (e.le === undefined ? len : len);
    const le = e.le ?? (e.ge === undefined ? len : 32);
    if (mask < ge || mask > le) continue;
    const bits = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    const toNum = (s) => s.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0);
    if ((toNum(ip) & bits) !== (toNum(pnet) & bits)) continue;
    return e.action === 'permit';
  }
  return false;
}

function clauseMatches(clause, route, dev) {
  const m = clause.match ?? {};
  if (m.acl?.length && !m.acl.some((n) => aclPermitsRoute(dev.config?.acls?.[n], route.net, route.mask))) return false;
  if (m.prefixList?.length && !m.prefixList.some((n) => prefixListPermits(dev.config?.prefixLists?.[n], route.net, route.mask))) return false;
  if (m.tag?.length && !m.tag.includes(Number(route.tag ?? 0))) return false;
  return true;
}

// Applique la route-map `name` à une route. { permitted, route } : la route modifiée par les « set ».
// Route-map inexistante : tout passe (le contrôle de validité la signale).
export function applyRouteMap(dev, name, route) {
  const rm = dev.config?.routeMaps?.[name];
  if (!rm) return { permitted: true, route, missing: true };
  for (const clause of sortedClauses(rm)) {
    if (!clauseMatches(clause, route, dev)) continue;
    if (clause.action === 'deny') return { permitted: false, route, clause };
    const s = clause.set ?? {};
    const out = { ...route };
    if (s.localPref !== undefined) out.localPref = Number(s.localPref);
    if (s.metric !== undefined) out.metric = Number(s.metric);
    if (s.weight !== undefined) out.weight = Number(s.weight);
    if (s.tag !== undefined) out.tag = Number(s.tag);
    if (s.prepend?.length) out.asPath = [...s.prepend.map(Number), ...(route.asPath ?? [])];
    if (s.nextHop) out.nextHop = s.nextHop;
    return { permitted: true, route: out, clause };
  }
  return { permitted: false, route, clause: null };
}

const setLines = (s = {}) => [
  s.localPref !== undefined && ` set local-preference ${s.localPref}`,
  s.metric !== undefined && ` set metric ${s.metric}`,
  s.weight !== undefined && ` set weight ${s.weight}`,
  s.tag !== undefined && ` set tag ${s.tag}`,
  s.prepend?.length && ` set as-path prepend ${s.prepend.join(' ')}`,
  s.nextHop && ` set ip next-hop ${s.nextHop}`,
].filter(Boolean);

const matchLines = (m = {}) => [
  m.acl?.length && ` match ip address ${m.acl.join(' ')}`,
  m.prefixList?.length && ` match ip address prefix-list ${m.prefixList.join(' ')}`,
  m.tag?.length && ` match tag ${m.tag.join(' ')}`,
].filter(Boolean);

// « ip prefix-list NOM [seq N] permit|deny A.B.C.D/len [ge N] [le N] » -> { seq, action, prefix, ge?, le? } ou { error }
export function parsePrefixListEntry(text, nextSeq) {
  const t = text.trim().split(/\s+/);
  let seq = nextSeq;
  if (t[0]?.toLowerCase() === 'seq') {
    if (!/^\d+$/.test(t[1] ?? '')) return { error: 'numéro de séquence attendu' };
    seq = Number(t[1]);
    t.splice(0, 2);
  }
  const action = t.shift()?.toLowerCase();
  if (action !== 'permit' && action !== 'deny') return { error: '« permit » ou « deny » attendu' };
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(t.shift() ?? '');
  if (!m || Number(m[2]) > 32 || m[1].split('.').some((o) => Number(o) > 255)) return { error: 'préfixe A.B.C.D/len attendu' };
  const e = { seq, action, prefix: `${m[1]}/${m[2]}` };
  while (t.length) {
    const k = t.shift().toLowerCase();
    const v = Number(t.shift());
    if ((k !== 'ge' && k !== 'le') || !Number.isInteger(v) || v < 0 || v > 32) return { error: `« ${k} » : valeur 0-32 attendue` };
    e[k] = v;
  }
  if (e.ge !== undefined && e.ge < Number(m[2])) return { error: '« ge » doit être au moins la longueur du préfixe' };
  if (e.le !== undefined && e.ge !== undefined && e.le < e.ge) return { error: '« le » doit être au moins « ge »' };
  return { entry: e };
}

export const prefixListEntryText = (e) => `seq ${e.seq} ${e.action} ${e.prefix}${e.ge !== undefined ? ` ge ${e.ge}` : ''}${e.le !== undefined ? ` le ${e.le}` : ''}`;

export function prefixListLines(lists) {
  const out = [];
  for (const [name, entries] of Object.entries(lists ?? {})) for (const e of [...entries].sort((a, b) => a.seq - b.seq)) out.push(`ip prefix-list ${name} ${prefixListEntryText(e)}`);
  return out.length ? [...out, '!'] : [];
}

// Lignes de « show running-config »
export function routeMapLines(routeMaps) {
  const out = [];
  for (const [name, rm] of Object.entries(routeMaps ?? {})) {
    for (const c of sortedClauses(rm)) out.push(`route-map ${name} ${c.action} ${c.seq}`, ...matchLines(c.match), ...setLines(c.set), '!');
  }
  return out;
}

// « show route-map [NOM] »
export function showRouteMaps(dev, only = null) {
  const out = [];
  for (const [name, rm] of Object.entries(dev.config?.routeMaps ?? {})) {
    if (only && name !== only) continue;
    for (const c of sortedClauses(rm)) {
      out.push(`route-map ${name}, ${c.action}, sequence ${c.seq}`, '  Match clauses:');
      for (const l of matchLines(c.match)) out.push(`    ${l.trim().replace('match ', '')}`);
      out.push('  Set clauses:');
      for (const l of setLines(c.set)) out.push(`    ${l.trim().replace('set ', '')}`);
      out.push('  Policy routing matches: 0 packets, 0 bytes');
    }
  }
  return out.length ? out : [only ? `route-map ${only} not found` : ''];
}
