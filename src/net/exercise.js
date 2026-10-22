// Exercices (TP) : objectifs vérifiés en direct sur le schéma, avec des indices progressifs.
// doc.exercise = { title, instructions, objectives: [{ id, type, ...paramètres }] }
import { simulatePing } from './simulate.js';
import { withLeases } from './dhcp.js';
import { buildTopology } from './topology.js';
import { computeRouting, lookup } from './routing.js';
import { validate } from './validate.js';
import { isValidIp, networkOf } from './ip.js';
import { isValidIp6, normIp6, parseIp6, prefixBits6 } from './ip6.js';
import { httpGet, resolveName } from './services.js';

const label = (doc, id) => doc.devices.find((d) => d.id === id)?.label ?? id;
const errorOf = (r) => r.log.findLast((l) => l.level === 'error') ?? null;

// Types d'objectifs : libellé, paramètres (pour l'éditeur), description, vérification
// check renvoie { ok, where (équipement fautif), why (explication) }
export const OBJECTIVES = {
  ping: {
    label: 'Ping qui doit réussir',
    params: [['from', 'device'], ['to', 'ip']],
    describe: (o, doc) => `${label(doc, o.from)} ping ${o.to}`,
    check: (o, ctx) => {
      const r = simulatePing(ctx.live, o.from, o.to, ctx.sim);
      const err = errorOf(r);
      return { ok: r.ok, where: err?.device ?? null, why: err?.text ?? null };
    },
  },
  noPing: {
    label: 'Ping qui doit échouer (isolation)',
    params: [['from', 'device'], ['to', 'ip']],
    describe: (o, doc) => `${label(doc, o.from)} ne doit PAS joindre ${o.to}`,
    check: (o, ctx) => {
      const r = simulatePing(ctx.live, o.from, o.to, ctx.sim);
      return { ok: !r.ok, where: null, why: r.ok ? `${label(ctx.live, o.from)} joint encore ${o.to} : le trafic n'est pas filtré.` : null };
    },
  },
  dhcp: {
    label: 'Bail DHCP obtenu',
    params: [['host', 'device']],
    describe: (o, doc) => `${label(doc, o.host)} obtient une adresse par DHCP`,
    check: (o, ctx) => {
      const c = ctx.live.devices.find((d) => d.id === o.host)?.config ?? {};
      if (c.dhcp !== true) return { ok: false, where: o.host, why: `${label(ctx.live, o.host)} n'est pas configuré en DHCP.` };
      return { ok: Boolean(c.lease), where: c.lease ? null : o.host, why: c.dhcpError ? `Pas de bail : ${c.dhcpError}.` : null };
    },
  },
  ospf: {
    label: 'Adjacence OSPF',
    params: [['a', 'router'], ['b', 'router']],
    describe: (o, doc) => `Adjacence OSPF entre ${label(doc, o.a)} et ${label(doc, o.b)}`,
    check: (o, ctx) => {
      const r = ctx.routing.routers.get(o.a);
      const ok = Boolean(r?.ospf.neighbors.some((n) => n.peer.id === o.b));
      const why = ok ? null : (r?.issues ?? []).find((i) => /^OSPF/.test(i.text) && i.text.includes(label(ctx.live, o.b)))?.text
        ?? (r?.ospf.enabled ? `Pas de voisin ${label(ctx.live, o.b)} : vérifie les commandes « network » et les zones.` : `${label(ctx.live, o.a)} n'a pas OSPF.`);
      return { ok, where: ok ? null : o.a, why };
    },
  },
  bgp: {
    label: 'Session BGP établie',
    params: [['router', 'router'], ['neighbor', 'ip']],
    describe: (o, doc) => `Session BGP de ${label(doc, o.router)} vers ${o.neighbor}`,
    check: (o, ctx) => {
      const s = ctx.routing.routers.get(o.router)?.bgp.sessions.find((x) => x.neighbor === o.neighbor);
      if (!s) return { ok: false, where: o.router, why: `${label(ctx.live, o.router)} n'a pas de « neighbor ${o.neighbor} ».` };
      return { ok: s.state === 'Established', where: s.state === 'Established' ? null : o.router, why: s.reason ? `Session down : ${s.reason}.` : null };
    },
  },
  route: {
    label: 'Route présente dans la table',
    params: [['router', 'router'], ['to', 'ip']],
    describe: (o, doc) => `${label(doc, o.router)} a une route vers ${o.to}`,
    check: (o, ctx) => {
      // Une route qui couvre tout le préfixe demandé suffit (résumé, route par défaut)
      const [ip, len] = o.to.split('/');
      const rib = ctx.routing.ribs.get(o.router);
      const r = rib && isValidIp(ip) ? lookup(rib, ip) : null;
      const ok = Boolean(r) && (len === undefined || (r.mask <= Number(len) && r.net === networkOf(ip, r.mask)));
      return { ok, where: ok ? null : o.router, why: ok ? null : `Aucune route vers ${o.to} dans la table de ${label(ctx.live, o.router)}.` };
    },
  },
  noErrors: {
    label: 'Aucune erreur dans les contrôles',
    params: [],
    describe: () => 'Aucune erreur dans les contrôles (onglet Propriétés)',
    check: (o, ctx) => {
      const err = ctx.issues.find((i) => i.level === 'error');
      return { ok: !err, where: err?.device ?? null, why: err?.text ?? null };
    },
  },
};

const lastError = (...logs) => logs.flat().filter(Boolean).findLast((l) => l.level === 'error') ?? null;
const vlanOf = (o) => Number(o.vlan);
// Route (IPv4) qui couvre l'adresse, et tout le préfixe demandé quand il y en a un
const covers = (r, ip, len) => networkOf(ip, r.mask) === r.net && (len === undefined || r.mask <= Number(len));
const splitTarget = (to) => { const [ip, len] = String(to).split('/'); return [ip, len === undefined || len === '' ? undefined : Number(len)]; };
const peerIssue = (r, re, other) => (r?.issues ?? []).find((i) => re.test(i.text) && i.text.includes(other))?.text ?? null;

export const MORE_OBJECTIVES = {
  dns: {
    label: 'Nom résolu (DNS)',
    params: [['from', 'device'], ['name', 'text'], ['expect', 'ip']],
    describe: (o, doc) => `${label(doc, o.from)} résout ${o.name}${o.expect ? ` en ${o.expect}` : ''}`,
    check: (o, ctx) => {
      const r = resolveName(ctx.live, o.from, o.name.trim(), { topo: ctx.topo, routing: ctx.routing });
      const err = lastError(r.log);
      if (!r.ok) return { ok: false, where: err?.device ?? o.from, why: err?.text ?? null };
      const want = o.expect ? (isValidIp6(o.expect) ? normIp6(o.expect) : o.expect) : null;
      const ok = !want || (r.addresses ?? [r.ip]).includes(want);
      return { ok, where: ok ? null : (r.server ? o.from : null), why: ok ? null : `${o.name} est résolu en ${r.ip}, pas en ${o.expect}.` };
    },
  },
  web: {
    label: 'Page web accessible',
    params: [['from', 'device'], ['target', 'text']],
    describe: (o, doc) => `${label(doc, o.from)} ouvre http://${String(o.target).replace(/^https?:\/\//i, '')}`,
    check: (o, ctx) => {
      const r = httpGet(ctx.live, o.from, o.target.trim(), { topo: ctx.topo, routing: ctx.routing });
      const err = lastError(r.dns?.log, r.result?.log, r.log);
      return { ok: r.ok, where: r.ok ? null : err?.device ?? o.from, why: r.ok ? null : err?.text ?? null };
    },
  },
  nat: {
    label: 'Trafic traduit par NAT',
    params: [['from', 'device'], ['to', 'ip']],
    describe: (o, doc) => `${label(doc, o.from)} atteint ${o.to} à travers le NAT`,
    check: (o, ctx) => {
      const r = simulatePing(ctx.live, o.from, o.to, ctx.sim);
      const translated = r.log.find((l) => /NAT, (source|destination)/.test(l.text));
      if (r.ok && !translated) return { ok: false, where: null, why: `Le ping passe mais aucune traduction NAT n'a lieu : l'adresse source n'est jamais modifiée.` };
      const err = errorOf(r);
      return { ok: r.ok, where: err?.device ?? null, why: err?.text ?? null };
    },
  },
  ripRoute: {
    label: 'Route apprise par RIP',
    params: [['router', 'router'], ['to', 'ip']],
    describe: (o, doc) => `${label(doc, o.router)} apprend ${o.to} par RIP`,
    check: (o, ctx) => {
      const r = ctx.routing.routers.get(o.router);
      const [ip, len] = splitTarget(o.to);
      const ok = isValidIp(ip) && Boolean(r?.rip.routes.some((x) => covers(x, ip, len)));
      const why = ok ? null : !r?.rip.enabled ? `${label(ctx.live, o.router)} n'a pas RIP.`
        : (r.issues ?? []).find((i) => /^RIP/.test(i.text))?.text ?? `Aucune route RIP vers ${o.to} dans la table de ${label(ctx.live, o.router)} : vérifie les « network » et la version.`;
      return { ok, where: ok ? null : o.router, why };
    },
  },
  eigrp: {
    label: 'Voisinage EIGRP',
    params: [['a', 'router'], ['b', 'router']],
    describe: (o, doc) => `Voisinage EIGRP entre ${label(doc, o.a)} et ${label(doc, o.b)}`,
    check: (o, ctx) => {
      const r = ctx.routing.routers.get(o.a);
      const ok = Boolean(r?.eigrp.neighbors.some((n) => n.peer.id === o.b));
      const why = ok ? null : peerIssue(r, /^EIGRP/, label(ctx.live, o.b))
        ?? (r?.eigrp.enabled ? `Pas de voisin ${label(ctx.live, o.b)} : vérifie les « network » et le numéro d'AS.` : `${label(ctx.live, o.a)} n'a pas EIGRP.`);
      return { ok, where: ok ? null : o.a, why };
    },
  },
  route6: {
    label: 'Route IPv6 présente',
    params: [['router', 'router'], ['to', 'text']],
    describe: (o, doc) => `${label(doc, o.router)} a une route IPv6 vers ${o.to}`,
    check: (o, ctx) => {
      const [ip, len] = String(o.to).split('/');
      const addr = parseIp6(ip);
      const rib = ctx.routing.ribs6?.get(o.router);
      const want = len === undefined || len === '' ? 128 : Number(len);
      const ok = addr !== null && Boolean(rib) && [...rib.values()].some((x) => x.prefix <= want && (addr & prefixBits6(x.prefix)) === x.net);
      return { ok, where: ok ? null : o.router, why: ok ? null : `Aucune route IPv6 vers ${o.to} dans la table de ${label(ctx.live, o.router)}.` };
    },
  },
  stpRoot: {
    label: 'Switch root du Spanning Tree',
    params: [['switch', 'router'], ['vlan', 'text']],
    describe: (o, doc) => `${label(doc, o.switch)} est le root bridge du VLAN ${o.vlan}`,
    check: (o, ctx) => {
      const info = ctx.topo.stp.vlans.get(vlanOf(o));
      const me = info?.switches.get(o.switch);
      if (!me) return { ok: false, where: o.switch, why: `${label(ctx.live, o.switch)} ne participe pas au Spanning Tree du VLAN ${o.vlan}.` };
      const root = [...info.switches.entries()].find(([, x]) => x.isRoot);
      return {
        ok: me.isRoot, where: me.isRoot ? null : o.switch,
        why: me.isRoot ? null : `Le root du VLAN ${o.vlan} est ${root ? label(ctx.live, root[0]) : 'un autre switch'} (priorité ${root?.[1].priority ?? '?'}, la tienne : ${me.priority}). Baisse la priorité avec « spanning-tree vlan ${o.vlan} priority » ou « root primary ».`,
      };
    },
  },
  stpBlocked: {
    label: 'Port bloqué par le Spanning Tree',
    params: [['switch', 'router'], ['vlan', 'text']],
    describe: (o, doc) => `${label(doc, o.switch)} a un port bloqué par STP (VLAN ${o.vlan})`,
    check: (o, ctx) => {
      const ports = ctx.topo.stp.vlans.get(vlanOf(o))?.ports;
      const ok = Boolean(ports) && [...ports].some(([k, e]) => k.startsWith(`${o.switch}|`) && e.state === 'blocking');
      return { ok, where: ok ? null : o.switch, why: ok ? null : `Aucun port de ${label(ctx.live, o.switch)} n'est bloqué en VLAN ${o.vlan} : STP bloque la boucle sur un autre switch (ou il n'y a pas de boucle).` };
    },
  },
  etherchannel: {
    label: 'EtherChannel monté',
    params: [['a', 'router'], ['b', 'router']],
    describe: (o, doc) => `EtherChannel actif entre ${label(doc, o.a)} et ${label(doc, o.b)}`,
    check: (o, ctx) => {
      const chans = ctx.topo.channels.filter((c) => c.device === o.a && c.peer === o.b);
      if (chans.some((c) => c.state === 'up')) return { ok: true, where: null, why: null };
      const down = chans[0];
      const mine = ctx.live.devices.find((d) => d.id === o.a);
      return { ok: false, where: o.a, why: down?.reason ?? (mine ? `${label(ctx.live, o.a)} n'a pas de channel-group vers ${label(ctx.live, o.b)}.` : null) };
    },
  },
  vtp: {
    label: 'VLAN appris par VTP',
    params: [['switch', 'router'], ['vlan', 'text']],
    describe: (o, doc) => `${label(doc, o.switch)} connaît le VLAN ${o.vlan}`,
    check: (o, ctx) => {
      const db = ctx.topo.vtp.get(o.switch);
      const dev = ctx.live.devices.find((d) => d.id === o.switch);
      const known = db ? db.vlans.has(vlanOf(o)) : vlanOf(o) === 1 || (dev?.config?.vlans ?? []).some((v) => Number(v.id) === vlanOf(o));
      return { ok: known, where: known ? null : o.switch, why: known ? null : `${label(ctx.live, o.switch)} ne connaît pas le VLAN ${o.vlan} : vérifie le domaine VTP, le mot de passe, le mode et que les liens sont des trunks.` };
    },
  },
  portSecurity: {
    label: 'Port coupé par port-security',
    params: [['switch', 'router']],
    describe: (o, doc) => `Port-security coupe un port de ${label(doc, o.switch)}`,
    check: (o, ctx) => {
      const ok = [...ctx.topo.security].some(([k, st]) => k.startsWith(`${o.switch}|`) && st.errDisabled);
      return { ok, where: ok ? null : o.switch, why: ok ? null : `Aucun port de ${label(ctx.live, o.switch)} n'est en err-disabled : active port-security (« violation shutdown ») et limite le nombre d'adresses.` };
    },
  },
  acl: {
    label: 'ACL appliquée à une interface',
    params: [['router', 'router'], ['name', 'text']],
    describe: (o, doc) => `${label(doc, o.router)} applique l'ACL ${o.name}`,
    check: (o, ctx) => {
      const dev = ctx.live.devices.find((d) => d.id === o.router);
      const name = String(o.name).trim();
      const defined = Boolean(dev?.config?.acls?.[name]?.rules?.length);
      const applied = (dev?.config?.interfaces ?? []).some((i) => i.aclIn === name || i.aclOut === name);
      const ok = defined && applied;
      return { ok, where: ok ? null : o.router, why: ok ? null : !defined ? `L'ACL ${name} n'existe pas (ou est vide) sur ${label(ctx.live, o.router)}.` : `L'ACL ${name} existe mais n'est appliquée à aucune interface (« ip access-group ${name} in|out »).` };
    },
  },
};
Object.assign(OBJECTIVES, MORE_OBJECTIVES);

// Évalue tous les objectifs d'un exercice ; ctx déjà calculé par l'éditeur (live, topo, routing, issues) ou recalculé
export function evaluateExercise(doc, ctx = null) {
  const exercise = doc.exercise;
  if (!exercise?.objectives?.length) return [];
  const live = ctx?.live ?? withLeases(doc);
  const topo = ctx?.topo ?? buildTopology(live);
  const routing = ctx?.routing ?? computeRouting(live, topo);
  const issues = ctx?.issues ?? validate(live, { topo, routing });
  const c = { live, topo, routing, issues, sim: { topo, routing } };
  return exercise.objectives.map((o) => {
    const def = OBJECTIVES[o.type];
    if (!def) return { objective: o, ok: false, text: `Objectif inconnu (${o.type})`, where: null, why: null };
    let res;
    try {
      res = def.check(o, c);
    } catch {
      res = { ok: false, where: null, why: 'Objectif incomplet : vérifie ses paramètres.' };
    }
    return { objective: o, text: o.label || def.describe(o, live), ...res };
  });
}

// Indices progressifs : 1 = quel objectif, 2 = où ça bloque, 3 = l'explication du simulateur
export function hintFor(result, level, doc) {
  if (result.ok) return null;
  if (level <= 1) return 'Cet objectif n\'est pas encore atteint. Relis la consigne et teste avec un ping ou le terminal.';
  if (level === 2) return result.where ? `Regarde du côté de ${label(doc, result.where)}.` : 'Regarde le chemin suivi par les paquets (onglet Simulation).';
  return result.why ?? 'Pas d\'explication disponible pour cet objectif.';
}

