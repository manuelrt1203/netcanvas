// Vue « réseau » d'un schéma exporté (format v3, v2 toléré) : qui est relié à qui, par quel port et
// quel câble, l'état de chaque câble et la config de chaque interface.
import { computeStp } from './stp.js';
import { isValidCidr, isValidIp } from './ip.js';
import { eui64Address, linkLocalOf, normIp6 } from './ip6.js';
import { macCisco, macOf } from './mac.js';
import { devicePorts, isDataMedia, isMikrotik, isSviName, modelId, modelOf } from './catalog.js';
import { autoCable, checkLink } from './cabling.js';

export const HOST_TYPES = new Set(['pc', 'server', 'printer', 'cloud']);
export const NATIVE_VLAN = 1;

export const isHost = (d) => HOST_TYPES.has(d?.type);

// Équipement qui route : routeur, ou switch niveau 3 avec « ip routing »
export const isL3Switch = (d) => d?.type === 'switch' && Boolean(modelOf(d).l3) && Boolean(d.config?.ipRouting);
export const isRouting = (d) => d?.type === 'router' || isL3Switch(d);

// Interface virtuelle toujours active (sauf shutdown) : Loopback0 chez Cisco, lo chez MikroTik
// Routage IPv6 actif : « ipv6 unicast-routing » chez Cisco ; chez MikroTik par défaut (/ipv6 settings forward=yes)
export const v6Forwarding = (d) => (isMikrotik(d) ? !d?.config?.ipv6NoForward : Boolean(d?.config?.ipv6Routing));
export const isLoopbackName = (name) => /^(Lo\d+|lo)$/.test(name ?? '');

export function buildTopology(doc) {
  const devices = new Map(doc.devices.map((d) => [d.id, d]));
  const ports = new Map(doc.devices.map((d) => [d.id, devicePorts(modelId(d), d.modules)]));
  const links = new Map();
  const linksOf = new Map(doc.devices.map((d) => [d.id, []])); // câbles de données (cuivre, fibre, série)
  const consoleLinks = [];
  const status = new Map();
  const names = new Map(); // `${linkId}|${deviceId}` -> nom du port

  // Config d'une interface : rattachée au câble, ou au nom du port (configurée avant d'être câblée)
  const cfgEntry = (id, linkId, name = names.get(`${linkId}|${id}`)) => {
    const d = devices.get(id);
    const c = d.config ?? {};
    const all = (d.type === 'switch' ? c.ports : c.interfaces) ?? [];
    return all.find((i) => i.link === linkId) ?? (name ? all.find((i) => !i.link && i.name === name) : undefined);
  };

  // v2 : le nom du port est dans la config de l'équipement ; un hôte utilise sa carte réseau
  function legacyName(id, linkId) {
    const d = devices.get(id);
    if (isHost(d) || d.type === 'hub') {
      const used = new Set([...names.entries()].filter(([k]) => k.endsWith(`|${id}`)).map(([, v]) => v));
      return ports.get(id).find((p) => isDataMedia(p.media) && !used.has(p.name))?.name ?? '?';
    }
    return cfgEntry(id, linkId)?.name ?? '?';
  }

  const used = new Map(); // `${deviceId}|${port}` -> linkId
  for (const l of doc.links) {
    if (!devices.has(l.source) || !devices.has(l.target) || l.source === l.target) continue;
    const [a, b] = [devices.get(l.source), devices.get(l.target)];
    const nameA = l.sourceIface ?? legacyName(a.id, l.id);
    names.set(`${l.id}|${a.id}`, nameA);
    const nameB = l.targetIface ?? legacyName(b.id, l.id);
    names.set(`${l.id}|${b.id}`, nameB);
    const portA = ports.get(a.id).find((p) => p.name === nameA) ?? null;
    const portB = ports.get(b.id).find((p) => p.name === nameB) ?? null;
    const [endA, endB] = [
      { label: a.label, type: a.type, mdi: modelOf(a).mdi, port: portA, portName: nameA },
      { label: b.label, type: b.type, mdi: modelOf(b).mdi, port: portB, portName: nameB },
    ];
    const cable = l.cable ?? (portA && portB ? autoCable(endA, portA, endB, portB) : null) ?? 'straight';
    const dce = l.dce === 'target' ? 'b' : 'a';
    const clockRate = cable === 'serial' ? cfgEntry(dce === 'a' ? a.id : b.id, l.id, dce === 'a' ? nameA : nameB)?.clockRate ?? null : null;

    let st = checkLink(endA, endB, cable, { dce, clockRate });
    // Interface désactivée (shutdown) à un bout
    for (const [dev, name] of [[a, nameA], [b, nameB]]) {
      if (st.up && st.data && cfgEntry(dev.id, l.id, name)?.shutdown) {
        st = { ...st, up: false, reason: `${dev.label} ${name} est désactivée (shutdown).` };
      }
    }
    // Un port ne reçoit qu'un câble
    for (const [dev, name] of [[a, nameA], [b, nameB]]) {
      const key = `${dev.id}|${name}`;
      if (used.has(key)) st = { ...st, up: false, reason: `${dev.label} ${name} a déjà un câble.` };
      else used.set(key, l.id);
    }

    links.set(l.id, { ...l, cable });
    status.set(l.id, st);
    if (st.data) {
      linksOf.get(a.id).push(l.id);
      linksOf.get(b.id).push(l.id);
    } else consoleLinks.push(l.id);
  }

  const other = (linkId, deviceId) => {
    const l = links.get(linkId);
    return l.source === deviceId ? l.target : l.source;
  };
  const portName = (linkId, deviceId) => names.get(`${linkId}|${deviceId}`) ?? '?';
  const isUp = (linkId) => status.get(linkId)?.up ?? false;

  // Un hôte n'a qu'une carte réseau : elle est branchée sur son premier câble de données.
  function hostIface(id) {
    const c = devices.get(id).config || {};
    const link = linksOf.get(id)[0] ?? null;
    const name = link ? portName(link, id) : ports.get(id).find((p) => isDataMedia(p.media))?.name ?? 'eth0';
    return { link, name, ip: c.ip, mask: c.mask, gateway: c.gateway, dhcp: c.dhcp === true, dhcpError: c.dhcpError ?? null, lease: c.lease ?? null };
  }

  function routerIface(id, linkId) {
    return { ip: '', mask: null, ...cfgEntry(id, linkId), link: linkId, name: portName(linkId, id) };
  }

  function switchPort(id, linkId) {
    return { mode: 'access', vlan: NATIVE_VLAN, ...cfgEntry(id, linkId), link: linkId, name: portName(linkId, id) };
  }

  // Interface de niveau 3 de l'équipement sur ce câble (null si aucune)
  // Interface de niveau 3 de l'équipement sur ce câble, pour une trame étiquetée `tag` ou non (null)
  function l3IfaceOn(id, linkId, tag = null) {
    const d = devices.get(id);
    if (isHost(d)) {
      const i = hostIface(id);
      return tag == null && i.link === linkId ? i : null;
    }
    if (d.type !== 'router') return null;
    const subs = subIfaces(id).filter((s) => s.link === linkId);
    if (tag != null) return subs.find((s) => !s.native && Number(s.vlan) === tag) ?? null;
    return subs.find((s) => s.native) ?? routerIface(id, linkId);
  }

  function loopbacks(id) {
    return (devices.get(id).config?.interfaces ?? [])
      .filter((i) => isLoopbackName(i.name))
      .map((i) => ({ ...i, link: null, loopback: true }));
  }

  // Sous-interfaces 802.1Q (router-on-a-stick) : G0/0.10 chez Cisco, vlan10 chez MikroTik.
  // Elles partagent le câble de leur interface parente.
  function subIfaces(id) {
    return (devices.get(id).config?.interfaces ?? [])
      .filter((i) => i.parent && i.vlan)
      .map((i) => ({ ...i, sub: true, link: linksOf.get(id).find((l) => portName(l, id) === i.parent) ?? null }));
  }

  // Interfaces VLAN d'un switch (SVI) : Vlan10…
  function svis(id) {
    return (devices.get(id).config?.interfaces ?? [])
      .filter((i) => isSviName(i.name))
      .map((i) => ({ ...i, svi: true, link: null, vlan: Number(i.name.slice(4)) }));
  }

  // Une SVI est active si un port actif du switch transporte son VLAN (comme sur IOS)
  function sviUp(id, vlan) {
    return linksOf.get(id).some((l) => {
      if (!isUp(l)) return false;
      const p = switchPort(id, l);
      return p.mode === 'trunk' || (Number(p.vlan) || NATIVE_VLAN) === vlan;
    });
  }

  // Toutes les interfaces de niveau 3 possibles, et leur état
  function allIfaces(id) {
    const d = devices.get(id);
    return isHost(d) ? [hostIface(id)]
      : d.type === 'router' ? [...linksOf.get(id).map((l) => routerIface(id, l)), ...subIfaces(id), ...loopbacks(id)]
        : d.type === 'switch' ? svis(id) : [];
  }
  const ifaceUp = (id, i) => (i.loopback ? !i.shutdown
    : i.svi ? !i.shutdown && sviUp(id, i.vlan)
      : i.link && isUp(i.link) && !i.shutdown);

  // Interfaces IP configurées et valides ; par défaut seulement celles dont le câble fonctionne
  function l3Ifaces(id, { includeDown = false } = {}) {
    return allIfaces(id).filter((i) => isValidIp(i.ip) && isValidCidr(i.mask) && (includeDown || ifaceUp(id, i)));
  }

  // IPv6 : interfaces où IPv6 est actif, avec leur adresse link-local (manuelle ou EUI-64) et leur
  // adresse globale ({ ...interface, ip, prefix, linkLocal, gateway (hôte) }). Un hôte a toujours sa link-local.
  function v6View(id, i) {
    const d = devices.get(id);
    const c = d.config ?? {};
    const mac = i.loopback ? null : macCisco(macOf(d, i.name));
    if (isHost(d)) {
      const auto = c.slaac === true;
      return {
        ...i, ip: auto ? c.slaac6?.ip ?? null : normIp6(c.ipv6), prefix: auto ? c.slaac6?.prefix ?? null : c.prefix6 ?? null,
        gateway: auto ? c.slaac6?.gateway ?? null : normIp6(c.gateway6), slaac: auto, slaacError: c.slaacError ?? null, linkLocal: linkLocalOf(mac),
      };
    }
    if (!i.ipv6 && !i.ipv6Enable && !i.linkLocal) return null;
    const ip = i.ipv6 && (i.eui64 ? eui64Address(i.ipv6, mac) : normIp6(i.ipv6));
    return { ...i, ip: ip ?? null, prefix: i.prefix6 ?? null, linkLocal: normIp6(i.linkLocal) ?? (mac ? linkLocalOf(mac) : null) };
  }
  function l3Ifaces6(id, { includeDown = false } = {}) {
    return allIfaces(id).map((i) => v6View(id, i)).filter((i) => i && (includeDown || ifaceUp(id, i)));
  }
  // Interface IPv6 de l'équipement sur ce câble (même règle que l3IfaceOn)
  function l3IfaceOn6(id, linkId, tag = null) {
    const i = l3IfaceOn(id, linkId, tag);
    return i ? v6View(id, i) : null;
  }

  const topo = {
    devices, ports, links, linksOf, consoleLinks, status, other, portName, isUp,
    hostIface, routerIface, switchPort, l3IfaceOn, l3Ifaces, subIfaces, svis, sviUp, l3Ifaces6, l3IfaceOn6,
  };
  // Spanning Tree : ports bloqués par VLAN, tempêtes de diffusion ; noté aussi sur l'état des câbles (voyants)
  topo.stp = computeStp(topo);
  for (const [id, st] of status) {
    const l = links.get(id);
    const ends = [l.source, l.target].map((d) => ({ device: d, vlans: topo.stp.blockedVlans(d, id) })).filter((e) => e.vlans.length);
    if (ends.length) status.set(id, { ...st, stpBlocked: ends });
  }
  return topo;
}
