// Vue « réseau » d'un schéma exporté (format v3, v2 toléré) : qui est relié à qui, par quel port et
// quel câble, l'état de chaque câble et la config de chaque interface.
import { isValidCidr, isValidIp } from './ip.js';
import { devicePorts, isDataMedia, isSviName, modelId, modelOf } from './catalog.js';
import { autoCable, checkLink } from './cabling.js';

export const HOST_TYPES = new Set(['pc', 'server', 'printer', 'cloud']);
export const NATIVE_VLAN = 1;

export const isHost = (d) => HOST_TYPES.has(d?.type);

// Équipement qui route : routeur, ou switch niveau 3 avec « ip routing »
export const isL3Switch = (d) => d?.type === 'switch' && Boolean(modelOf(d).l3) && Boolean(d.config?.ipRouting);
export const isRouting = (d) => d?.type === 'router' || isL3Switch(d);

// Interface virtuelle toujours active (sauf shutdown) : Loopback0 chez Cisco, lo chez MikroTik
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

  // Interfaces IP configurées et valides ; par défaut seulement celles dont le câble fonctionne
  function l3Ifaces(id, { includeDown = false } = {}) {
    const d = devices.get(id);
    const all = isHost(d) ? [hostIface(id)]
      : d.type === 'router' ? [...linksOf.get(id).map((l) => routerIface(id, l)), ...subIfaces(id), ...loopbacks(id)]
        : d.type === 'switch' ? svis(id) : [];
    const up = (i) => (i.loopback ? !i.shutdown
      : i.svi ? !i.shutdown && sviUp(id, i.vlan)
        : i.link && isUp(i.link) && !i.shutdown);
    return all.filter((i) => isValidIp(i.ip) && isValidCidr(i.mask) && (includeDown || up(i)));
  }

  return {
    devices, ports, links, linksOf, consoleLinks, status, other, portName, isUp,
    hostIface, routerIface, switchPort, l3IfaceOn, l3Ifaces, subIfaces, svis, sviUp,
  };
}
