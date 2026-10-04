// Exercices (TP) : objectifs vérifiés en direct sur le schéma, avec des indices progressifs.
// doc.exercise = { title, instructions, objectives: [{ id, type, ...paramètres }] }
import { simulatePing } from './simulate.js';
import { withLeases } from './dhcp.js';
import { buildTopology } from './topology.js';
import { computeRouting, lookup } from './routing.js';
import { validate } from './validate.js';
import { isValidIp, networkOf } from './ip.js';

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

