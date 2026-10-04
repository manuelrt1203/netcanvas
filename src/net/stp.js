// Spanning Tree (PVST+, comme les switches Cisco par défaut) : un arbre par VLAN.
//
// Modèle : échange de BPDU jusqu'à convergence. Chaque switch garde le meilleur vecteur
// (root, coût vers la racine, bridge émetteur, port émetteur) ; le port qui l'a reçu est son port racine.
// Sur chaque câble entre deux switches, le côté qui annonce le meilleur vecteur est désigné ;
// l'autre bloque (alternate), sauf s'il est port racine.
// Config du switch : config.stp = { mode: 'pvst' | 'rapid-pvst', priority: { [vlan]: n }, disabled: [vlan] }
// Config d'un port : stpCost, stpPriority, portfast
// Sans STP sur un VLAN, une boucle de switches provoque une tempête de diffusion (storms).
import { macOf } from './mac.js';

export const DEFAULT_BRIDGE_PRIORITY = 32768;
export const DEFAULT_PORT_PRIORITY = 128;

// Coût IEEE (méthode courte, celle d'IOS) selon le débit du port
export function portCost(name) {
  if (/^Te/.test(name)) return 2;
  if (/^G/.test(name)) return 4;
  if (/^Fa/.test(name)) return 19;
  return 100;
}

const hex = (m) => m.map((b) => b.toString(16).padStart(2, '0')).join('');
// Identifiant de pont comparable comme une chaîne : priorité (avec l'extension VLAN) puis MAC
export const bridgeKey = (priority, mac) => `${String(priority).padStart(5, '0')}.${hex(mac)}`;

function cmpVector(a, b) {
  return a.root.localeCompare(b.root) || a.cost - b.cost || a.bridge.localeCompare(b.bridge) || a.port - b.port;
}

export const stpEnabled = (dev, vlan) => !(dev.config?.stp?.disabled ?? []).map(Number).includes(Number(vlan));
export const bridgePriority = (dev, vlan) => Number(dev.config?.stp?.priority?.[vlan] ?? DEFAULT_BRIDGE_PRIORITY);

// Le port transporte-t-il ce VLAN, et les deux bouts s'entendent-ils sur l'étiquette ?
function carries(p, vlan) {
  return p.mode === 'trunk' || (Number(p.vlan) || 1) === vlan;
}
function compatible(a, b, vlan) {
  if (!carries(a, vlan) || !carries(b, vlan)) return false;
  if (a.mode === b.mode) return true;
  return vlan === 1; // trunk <-> access : seul le VLAN natif passe (non étiqueté)
}

export function computeStp(topo) {
  const switches = [...topo.devices.values()].filter((d) => d.type === 'switch');
  const vlans = new Set([1]);
  for (const s of switches) {
    for (const v of s.config?.vlans ?? []) vlans.add(Number(v.id));
    for (const l of topo.linksOf.get(s.id)) {
      const p = topo.switchPort(s.id, l);
      if (p.mode !== 'trunk') vlans.add(Number(p.vlan) || 1);
    }
  }
  const portIndex = (id, link) => topo.ports.get(id).findIndex((p) => p.name === topo.portName(link, id)) + 1;

  const result = { vlans: new Map(), storms: [] };
  const blockedSet = new Set(); // `${device}|${link}|${vlan}`

  for (const vlan of [...vlans].sort((a, b) => a - b)) {
    const members = switches.filter((s) => topo.linksOf.get(s.id).some((l) => topo.isUp(l) && carries(topo.switchPort(s.id, l), vlan)));
    if (!members.length) continue;
    const enabled = new Set(members.filter((s) => stpEnabled(s, vlan)).map((s) => s.id));
    const info = new Map(); // switch -> { bridge, priority, best, rootPort }
    for (const s of members) {
      const priority = bridgePriority(s, vlan) + vlan; // extension « sys-id » de PVST+
      const bridge = bridgeKey(priority, macOf(s, 'Vlan1'));
      info.set(s.id, { bridge, priority, mac: macOf(s, 'Vlan1'), best: { root: bridge, cost: 0, bridge, port: 0, via: null }, enabled: enabled.has(s.id) });
    }
    // Câbles entre deux switches du VLAN (tous, pour détecter les boucles)
    const segments = [];
    for (const s of members) {
      for (const l of topo.linksOf.get(s.id)) {
        const o = topo.other(l, s.id);
        if (o < s.id || !info.has(o) || !topo.isUp(l)) continue;
        const pa = topo.switchPort(s.id, l);
        const pb = topo.switchPort(o, l);
        if (!compatible(pa, pb, vlan)) continue;
        segments.push({ link: l, a: s.id, b: o, pa, pb });
      }
    }
    const portId = (id, link, p) => (Number(p.stpPriority ?? DEFAULT_PORT_PRIORITY) << 8) + portIndex(id, link);
    const cost = (p) => Number(p.stpCost) || portCost(p.name);

    // Domaines BPDU : câble direct entre deux switches STP, ou « nuage » de switches sans STP
    // (ils relaient les BPDU comme des trames ordinaires) reliant plusieurs ports de switches STP
    const domains = [];
    for (const g of segments) {
      if (enabled.has(g.a) && enabled.has(g.b)) domains.push([{ dev: g.a, link: g.link, p: g.pa }, { dev: g.b, link: g.link, p: g.pb }]);
    }
    const seenCloud = new Set();
    for (const s of members.filter((m) => !enabled.has(m.id))) {
      if (seenCloud.has(s.id)) continue;
      const cloud = new Set([s.id]);
      const queue = [s.id];
      const boundary = [];
      while (queue.length) {
        const cur = queue.shift();
        for (const g of segments.filter((x) => x.a === cur || x.b === cur)) {
          const [other, pOther] = g.a === cur ? [g.b, g.pb] : [g.a, g.pa];
          if (enabled.has(other)) boundary.push({ dev: other, link: g.link, p: pOther });
          else if (!cloud.has(other)) {
            cloud.add(other);
            queue.push(other);
          }
        }
      }
      cloud.forEach((id) => seenCloud.add(id));
      if (boundary.length >= 2) domains.push(boundary);
    }

    // Échange de BPDU jusqu'à convergence
    for (let round = 0, changed = true; changed && round <= members.length + 1; round++) {
      changed = false;
      for (const ports of domains) {
        for (const from of ports) {
          for (const to of ports) {
            if (from.dev === to.dev) continue;
            const f = info.get(from.dev).best;
            const cand = { root: f.root, cost: f.cost + cost(to.p), bridge: info.get(from.dev).bridge, port: portId(from.dev, from.link, from.p), via: to.link, localPort: portId(to.dev, to.link, to.p) };
            const t = info.get(to.dev);
            if (cand.root === t.bridge) continue; // BPDU qui revient au root
            const cur = t.best;
            if (cmpVector(cand, cur) < 0 || (cmpVector(cand, cur) === 0 && cand.localPort < (cur.localPort ?? Infinity))) {
              t.best = cand;
              changed = true;
            }
          }
        }
      }
    }

    // Rôles des ports : désigné par défaut (vers un hôte, un routeur…)
    const ports = new Map(); // `${switch}|${link}` -> { role, state, cost, portId }
    for (const s of members) {
      for (const l of topo.linksOf.get(s.id)) {
        if (!topo.isUp(l)) continue;
        const p = topo.switchPort(s.id, l);
        if (!carries(p, vlan)) continue;
        ports.set(`${s.id}|${l}`, { role: 'designated', state: 'forwarding', cost: cost(p), portId: portId(s.id, l, p), name: p.name, link: l, portfast: Boolean(p.portfast) });
      }
    }
    // Dans chaque domaine, le port qui annonce le meilleur vecteur est désigné ; les autres sont port racine ou bloqués
    const offered = (x) => ({ root: info.get(x.dev).best.root, cost: info.get(x.dev).best.cost, bridge: info.get(x.dev).bridge, port: portId(x.dev, x.link, x.p) });
    for (const dom of domains) {
      const best = dom.reduce((a, b) => (cmpVector(offered(b), offered(a)) < 0 ? b : a));
      for (const x of dom) {
        if (x === best) continue;
        const entry = ports.get(`${x.dev}|${x.link}`);
        if (!entry) continue;
        if (info.get(x.dev).best.via === x.link) entry.role = 'root';
        else {
          entry.role = 'alternate';
          entry.state = 'blocking';
          blockedSet.add(`${x.dev}|${x.link}|${vlan}`);
        }
      }
    }

    // Boucle restante dans les liens qui transmettent (STP désactivé quelque part) : tempête de diffusion
    const parent = new Map(members.map((s) => [s.id, s.id]));
    const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
    for (const g of segments) {
      if (blockedSet.has(`${g.a}|${g.link}|${vlan}`) || blockedSet.has(`${g.b}|${g.link}|${vlan}`)) continue;
      const [ra, rb] = [find(g.a), find(g.b)];
      if (ra === rb) {
        const loop = [...new Set(segments.filter((x) => !blockedSet.has(`${x.a}|${x.link}|${vlan}`) && !blockedSet.has(`${x.b}|${x.link}|${vlan}`)).flatMap((x) => [x.a, x.b]))];
        result.storms.push({ vlan, switches: loop.filter((id) => find(id) === ra), link: g.link });
        break;
      }
      parent.set(ra, rb);
    }

    result.vlans.set(vlan, {
      switches: new Map([...info].map(([id, x]) => [id, {
        bridge: x.bridge, priority: x.priority, mac: x.mac, enabled: x.enabled,
        root: x.best.root, rootCost: x.best.cost, rootPort: x.best.via, isRoot: x.enabled && x.best.root === x.bridge,
      }])),
      ports,
    });
  }

  result.blocked = (device, link, vlan) => blockedSet.has(`${device}|${link}|${vlan}`);
  result.storm = (device, vlan) => result.storms.find((s) => s.vlan === vlan && s.switches.includes(device)) ?? null;
  // VLAN bloqués d'un port (pour l'affichage sur le plan)
  result.blockedVlans = (device, link) => [...result.vlans.keys()].filter((v) => blockedSet.has(`${device}|${link}|${v}`));
  return result;
}
