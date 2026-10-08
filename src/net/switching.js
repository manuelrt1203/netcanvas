// Fonctions de commutation des switches Cisco, calculées avant le Spanning Tree :
//   trunk   : VLAN natif (nativeVlan) et VLAN autorisés (allowedVlans, absent = tous)
//   EtherChannel : channelGroup + channelMode (on | active | passive | desirable | auto) sur les ports.
//             Les câbles d'un groupe négocié forment un seul lien logique (Port-channelN) : un seul membre
//             transporte les trames (primary), les autres sont « bundled ». Un membre incohérent est suspendu.
//   VTP     : config.vtp = { domain, mode: server | client | transparent | off, password, version, revision }.
//             Dans un domaine (switches reliés par des trunks, même nom et même mot de passe), la base de VLAN
//             du serveur ou client au plus grand numéro de révision s'impose. Un client n'a que ces VLAN :
//             un port dans un VLAN absent est inactif.
//   port-security : ps = { enabled, max, violation: shutdown | restrict | protect, sticky, macs, stickyMacs }
//             sur un port access. Les MAC vues derrière le port au-delà du maximum (hors adresses autorisées)
//             violent la règle : shutdown -> port err-disabled ; restrict / protect -> leurs trames sont jetées.
import { flood } from './l2.js';
import { macOf } from './mac.js';

// --- Listes de VLAN : « 10,20,30-35 » <-> [10, 20, 30, 31…] ------------------------------------------------
export function parseVlanList(text) {
  const out = new Set();
  for (const part of String(text).split(',')) {
    const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!m) return null;
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (a < 1 || b > 4094 || a > b) return null;
    for (let v = a; v <= b; v++) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

export function formatVlanList(list) {
  const v = [...new Set(list.map(Number))].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < v.length;) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    parts.push(j > i + 1 ? `${v[i]}-${v[j]}` : j === i + 1 ? `${v[i]},${v[j]}` : `${v[i]}`);
    i = j + 1;
  }
  return parts.join(',');
}

export const nativeOf = (p) => Number(p.nativeVlan) || 1;
export const allowedOf = (p) => (Array.isArray(p.allowedVlans) ? new Set(p.allowedVlans.map(Number)) : null); // null : tous
export const macText = (m) => [0, 2, 4].map((i) => m.slice(i, i + 2).map((b) => b.toString(16).padStart(2, '0')).join('')).join('.');

// --- EtherChannel ------------------------------------------------------------------------------------------
const LACP = new Set(['active', 'passive']);
const PAGP = new Set(['desirable', 'auto']);
export const CHANNEL_MODES = ['on', 'active', 'passive', 'desirable', 'auto'];
export const channelProtocol = (mode) => (LACP.has(mode) ? 'LACP' : PAGP.has(mode) ? 'PAgP' : 'aucun');

// Pourquoi deux modes ne forment pas de canal (null : ils s'entendent)
export function channelMismatch(a, b) {
  if (!a || !b) return null;
  if (a === 'on' && b === 'on') return null;
  if (a === 'on' || b === 'on') return `mode on d'un côté, ${a === 'on' ? b : a} (${channelProtocol(a === 'on' ? b : a)}) de l'autre : « on » n'envoie aucune trame de négociation`;
  if (LACP.has(a) !== LACP.has(b)) return `LACP (${LACP.has(a) ? a : b}) d'un côté, PAgP (${PAGP.has(a) ? a : b}) de l'autre`;
  if (a === 'passive' && b === 'passive') return 'passive des deux côtés : aucun ne lance la négociation LACP (il faut au moins un active)';
  if (a === 'auto' && b === 'auto') return 'auto des deux côtés : aucun ne lance la négociation PAgP (il faut au moins un desirable)';
  return null;
}

// Mode de négociation d'un groupe : un seul membre actif (active, desirable) suffit à lancer la négociation
const groupMode = (modes) => modes.find((m) => m === 'active' || m === 'desirable') ?? modes[0];

// Réglages qui doivent être identiques sur tous les membres d'un Port-channel
const portSignature = (p) => (p.mode === 'trunk'
  ? `trunk natif ${nativeOf(p)} autorisés ${p.allowedVlans ? formatVlanList(p.allowedVlans) : 'tous'}`
  : `access VLAN ${Number(p.vlan) || 1}`);

function computeChannels(topo) {
  const channels = []; // { device, group, mode, peer, links, primary, state: 'up' | 'down', reason, suspended: [{ link, reason }] }
  const suspended = new Map(); // link -> raison
  const bundled = new Set(); // câbles membres non principaux d'un canal actif
  const switches = [...topo.devices.values()].filter((d) => d.type === 'switch');
  for (const s of switches) {
    const groups = new Map();
    for (const l of topo.linksOf.get(s.id)) {
      const p = topo.switchPort(s.id, l);
      if (!p.channelGroup) continue;
      if (!groups.has(p.channelGroup)) groups.set(p.channelGroup, []);
      groups.get(p.channelGroup).push({ link: l, p });
    }
    for (const [group, members] of groups) {
      const ch = { device: s.id, group: Number(group), mode: groupMode(members.map((m) => m.p.channelMode ?? 'on')), links: [], primary: null, state: 'down', reason: null, suspended: [], members: members.map((m) => m.link) };
      // Équipement d'en face : celui de la majorité des câbles
      const peers = new Map();
      for (const m of members) peers.set(topo.other(m.link, s.id), (peers.get(topo.other(m.link, s.id)) ?? 0) + 1);
      const peer = [...peers].sort((a, b) => b[1] - a[1])[0][0];
      ch.peer = peer;
      const peerDev = topo.devices.get(peer);
      const ref = members.find((m) => topo.other(m.link, s.id) === peer && topo.isUp(m.link))?.p;
      for (const m of members) {
        const o = topo.other(m.link, s.id);
        if (!topo.isUp(m.link)) continue;
        if (o !== peer) ch.suspended.push({ link: m.link, reason: `${m.p.name} va vers ${topo.devices.get(o).label}, les autres membres du Port-channel${group} vers ${peerDev.label}` });
        else if (channelProtocol(m.p.channelMode ?? 'on') !== channelProtocol(ch.mode)) ch.suspended.push({ link: m.link, reason: `${m.p.name} est en mode ${m.p.channelMode ?? 'on'}, le Port-channel${group} en ${ch.mode} (protocoles différents)` });
        else if (ref && portSignature(m.p) !== portSignature(ref)) ch.suspended.push({ link: m.link, reason: `${m.p.name} (${portSignature(m.p)}) n'a pas les mêmes réglages que le reste du Port-channel${group} (${portSignature(ref)})` });
        else ch.links.push(m.link);
      }
      for (const x of ch.suspended) suspended.set(x.link, `suspendu dans l'EtherChannel de ${s.label} : ${x.reason}`);
      if (!ch.links.length) ch.reason = 'aucun membre actif';
      else if (peerDev.type !== 'switch') ch.reason = `${peerDev.label} n'est pas un switch`;
      else {
        const peerPorts = ch.links.map((l) => topo.switchPort(peer, l));
        if (peerPorts.some((p) => !p.channelGroup)) {
          ch.reason = `${peerDev.label} n'a pas de channel-group sur ${peerPorts.filter((p) => !p.channelGroup).map((p) => p.name).join(', ')}`;
        } else if (new Set(peerPorts.map((p) => p.channelGroup)).size > 1) {
          ch.reason = `en face, ${peerDev.label} répartit ces câbles dans plusieurs channel-group`;
        } else {
          ch.reason = channelMismatch(ch.mode, groupMode(peerPorts.map((p) => p.channelMode ?? 'on')));
        }
      }
      if (!ch.reason) {
        ch.state = 'up';
        ch.protocol = channelProtocol(ch.mode);
      }
      channels.push(ch);
    }
  }
  // Un canal ne monte que si les deux côtés sont d'accord ; les membres d'un canal actif ne comptent qu'une fois
  for (const ch of channels.filter((c) => c.state === 'up')) {
    const other = channels.find((c) => c.device === ch.peer && c.peer === ch.device && c.links.some((l) => ch.links.includes(l)));
    if (!other || other.state !== 'up') {
      ch.state = 'down';
      ch.reason = other?.reason ?? 'le switch d\'en face ne forme pas le canal';
      continue;
    }
    ch.links = ch.links.filter((l) => other.links.includes(l));
    ch.primary = [...ch.links].sort()[0];
    ch.links.filter((l) => l !== ch.primary).forEach((l) => bundled.add(l));
  }
  return { channels, suspended, bundled };
}

// --- VTP ---------------------------------------------------------------------------------------------------
export const vtpOf = (d) => d.config?.vtp ?? null;
export const vtpMode = (d) => vtpOf(d)?.mode ?? 'server';
const participates = (d) => Boolean(vtpOf(d)?.domain) && ['server', 'client'].includes(vtpMode(d));

// Base de VLAN d'un switch : VLAN déclarés ; un serveur crée aussi ceux de ses ports access (comme IOS)
function vlanNames(d) {
  const names = new Map([[1, 'default'], ...(d.config?.vlans ?? []).map((v) => [Number(v.id), v.name])]);
  if (vtpMode(d) !== 'client') {
    for (const p of d.config?.ports ?? []) {
      const v = Number(p.vlan) || 1;
      if (p.mode !== 'trunk' && !names.has(v)) names.set(v, `VLAN${String(v).padStart(4, '0')}`);
    }
  }
  return names;
}

function computeVtp(topo) {
  const switches = [...topo.devices.values()].filter((d) => d.type === 'switch');
  const db = new Map(); // switch -> { vlans: Map(id, nom), from: id du switch dont la base s'impose, revision }
  const seen = new Set();
  for (const s of switches.filter(participates)) {
    if (seen.has(s.id)) continue;
    // Domaine : parcours par les trunks actifs ; un transparent du même domaine relaie sans appliquer
    const domain = [];
    const queue = [s.id];
    const visited = new Set([s.id]);
    const { domain: name, password } = vtpOf(s);
    while (queue.length) {
      const cur = queue.shift();
      const d = topo.devices.get(cur);
      if (participates(d)) domain.push(d);
      for (const l of topo.linksOf.get(cur)) {
        if (!topo.isUp(l) || topo.switchPort(cur, l).mode !== 'trunk') continue;
        const o = topo.other(l, cur);
        const od = topo.devices.get(o);
        if (visited.has(o) || od.type !== 'switch' || topo.switchPort(o, l).mode !== 'trunk') continue;
        const v = vtpOf(od);
        if (!v || v.domain !== name || (v.password ?? '') !== (password ?? '') || vtpMode(od) === 'off') continue;
        visited.add(o);
        queue.push(o);
      }
    }
    domain.forEach((d) => seen.add(d.id));
    const winner = domain.reduce((a, b) => {
      const [ra, rb] = [Number(vtpOf(a).revision) || 0, Number(vtpOf(b).revision) || 0];
      if (rb !== ra) return rb > ra ? b : a;
      return vtpMode(b) === 'server' && vtpMode(a) !== 'server' ? b : a;
    });
    for (const d of domain) db.set(d.id, { vlans: vlanNames(winner), from: winner.id, revision: Number(vtpOf(winner).revision) || 0, domain: domain.map((x) => x.id) });
  }
  return db;
}

// --- Port-security -----------------------------------------------------------------------------------------
export const PS_DEFAULT = { enabled: false, max: 1, violation: 'shutdown', sticky: false, macs: [], stickyMacs: [] };
export const psOf = (p) => ({ ...PS_DEFAULT, ...(p.ps ?? {}) });

// MAC des équipements joints derrière un port de switch (dans l'ordre où le switch les apprendrait)
export function macsBehind(topo, switchId, link) {
  if (!topo.isUp(link)) return [];
  const { endpoints } = flood(topo, switchId, link);
  const out = [];
  for (const e of endpoints) {
    if (e.device === switchId || e.hops.some((h) => h.to === switchId)) continue;
    const d = topo.devices.get(e.device);
    const name = e.svi ? `Vlan${e.svi}` : topo.portName(e.inLink, e.device);
    const mac = macText(macOf(d, name));
    if (!out.some((x) => x.mac === mac)) out.push({ mac, device: e.device, label: d.label, port: name });
  }
  return out;
}

function computeSecurity(topo) {
  const ports = new Map(); // `${switch}|${link}` -> { allowed: [mac], violators: [{ mac, label }], violation, errDisabled }
  for (const s of [...topo.devices.values()].filter((d) => d.type === 'switch')) {
    for (const l of topo.linksOf.get(s.id)) {
      const p = topo.switchPort(s.id, l);
      const ps = psOf(p);
      if (!ps.enabled || p.mode === 'trunk' || !topo.isUp(l)) continue;
      const seen = macsBehind(topo, s.id, l);
      const fixed = [...ps.macs, ...ps.stickyMacs].map((m) => m.toLowerCase());
      const allowed = [...fixed];
      const violators = [];
      for (const x of seen) {
        if (allowed.includes(x.mac)) continue;
        if (allowed.length < ps.max) allowed.push(x.mac);
        else violators.push(x);
      }
      ports.set(`${s.id}|${l}`, { allowed, seen, violators, violation: ps.violation, errDisabled: violators.length > 0 && ps.violation === 'shutdown', max: ps.max, name: p.name });
    }
  }
  return ports;
}

// Calcule tout et branche sur la topologie : liens suspendus ou err-disabled, membres groupés,
// et les règles de VLAN d'un port (carries, ingress, egressTag) utilisées par la diffusion, le STP et les SVI.
export function applySwitching(topo) {
  const ether = computeChannels(topo);
  for (const [link, reason] of ether.suspended) topo.status.set(link, { ...topo.status.get(link), up: false, reason, suspended: true });
  const vtp = computeVtp(topo);
  const vlanExists = (id, vlan) => {
    if (vlan === 1) return true;
    const d = topo.devices.get(id);
    if (participates(d) && vtpMode(d) === 'client') return vtp.get(id)?.vlans.has(vlan) ?? false;
    return true;
  };
  // Le port transporte-t-il ce VLAN ?
  topo.carries = (id, link, vlan) => {
    const p = topo.switchPort(id, link);
    if (p.mode === 'trunk') return (allowedOf(p)?.has(vlan) ?? true) && vlanExists(id, vlan);
    return (Number(p.vlan) || 1) === vlan && vlanExists(id, vlan);
  };
  // VLAN d'une trame entrant par ce port ({ vlan } ou { drop: raison })
  topo.ingress = (id, link, tag) => {
    const p = topo.switchPort(id, link);
    const dev = topo.devices.get(id);
    let vlan;
    if (p.mode === 'trunk') {
      vlan = tag == null ? nativeOf(p) : tag;
      if (!(allowedOf(p)?.has(vlan) ?? true)) return { drop: `${dev.label} ${p.name} : le VLAN ${vlan} n'est pas autorisé sur ce trunk (switchport trunk allowed vlan)` };
    } else {
      if (tag != null) return { drop: `${dev.label} ${p.name} (access) jette une trame étiquetée VLAN ${tag}` };
      vlan = Number(p.vlan) || 1;
    }
    if (!vlanExists(id, vlan)) return { drop: `${dev.label} (client VTP) ne connaît pas le VLAN ${vlan} : le port ${p.name} est inactif` };
    return { vlan };
  };
  topo.egressTag = (id, link, vlan) => {
    const p = topo.switchPort(id, link);
    return p.mode === 'trunk' && vlan !== nativeOf(p) ? vlan : null;
  };
  // Câbles vus par le niveau 2 : un seul par EtherChannel
  topo.l2Links = (id) => topo.linksOf.get(id).filter((l) => !ether.bundled.has(l));
  topo.channels = ether.channels;
  // Câbles d'un EtherChannel monté : affichés « Po1 · LACP » sur le plan
  for (const ch of ether.channels.filter((c) => c.state === 'up')) {
    for (const l of ch.links) topo.status.set(l, { ...topo.status.get(l), channel: `Po${ch.group}${ch.protocol !== 'aucun' ? ` · ${ch.protocol}` : ''}` });
  }
  topo.channelOf = (id, link) => ether.channels.find((c) => c.device === id && c.members.includes(link)) ?? null;
  topo.vtp = vtp;
  topo.vlanExists = vlanExists;

  // Port-security : calculé sur ce niveau 2 (sans STP : il dépend des ports err-disabled)
  const security = computeSecurity(topo);
  for (const [key, st] of security) {
    if (!st.errDisabled) continue;
    const link = key.slice(key.indexOf('|') + 1);
    const label = topo.devices.get(key.slice(0, key.indexOf('|'))).label;
    topo.status.set(link, {
      ...topo.status.get(link), up: false, errDisabled: true,
      reason: `${label} ${st.name} en err-disabled (port-security) : ${st.violators.map((v) => `${v.label} ${v.mac}`).join(', ')} au-delà de ${st.max} adresse(s) autorisée(s)`,
    });
  }
  topo.security = security;
  // restrict / protect : trames d'une MAC en trop jetées à l'entrée
  topo.psDrop = (id, link, mac) => {
    const st = security.get(`${id}|${link}`);
    if (!st || st.errDisabled || !st.violators.some((v) => v.mac === mac)) return null;
    return `${topo.devices.get(id).label} ${st.name} (port-security ${st.violation}) jette les trames de ${mac} : déjà ${st.max} adresse(s) apprise(s)`;
  };
}
