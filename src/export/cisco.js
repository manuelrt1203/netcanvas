// Génération de configurations Cisco IOS.
//   target 'packet-tracer' : scripts à coller dans le CLI (routeur 2911, switch 2960, PC configurés à la main)
//   target 'gns3'          : startup-config de routeurs c7200 (Dynamips), ports du switch intégré, scripts VPCS
import { cidrToMask } from '../net/ip.js';
import { MODELS, MODULES, isMikrotik, modelId, modelOf } from '../net/catalog.js';
import { routerosScript } from '../cli/routeros.js';
import { ascii, interfaceTable, switchVlans, uniqueNames } from './common.js';

const LONG = {
  g: 'GigabitEthernet', gi: 'GigabitEthernet', gig: 'GigabitEthernet', gigabitethernet: 'GigabitEthernet',
  f: 'FastEthernet', fa: 'FastEthernet', fastethernet: 'FastEthernet',
  e: 'Ethernet', eth: 'Ethernet', ethernet: 'Ethernet',
  s: 'Serial', se: 'Serial', serial: 'Serial',
};

// « G0/1 » -> « GigabitEthernet0/1 » ; null si le nom n'est pas un nom Cisco
export function iosInterfaceName(name) {
  const m = /^\s*([a-z]+)\s*(\d+(?:\/\d+){1,2})\s*$/i.exec(name || '');
  return m && LONG[m[1].toLowerCase()] ? `${LONG[m[1].toLowerCase()]}${m[2]}` : null;
}

// c7200 sous GNS3 : slot 0 = C7200-IO-2FE (Fa0/0, Fa0/1), slots 1 à 6 = PA-2FE-TX (2 ports chacun)
export const C7200_MAX_PORTS = 14;
export function c7200Port(index) {
  const slot = Math.floor(index / 2);
  const port = index % 2;
  return { adapter: slot, port, name: `FastEthernet${slot}/${port}` };
}

// Nom d'hôte IOS : lettres, chiffres, tirets, commence par une lettre
export function hostname(label, type) {
  const base = ascii(label).replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!base) return { router: 'R', switch: 'SW', hub: 'HUB', pc: 'PC', server: 'SRV', printer: 'PRN', cloud: 'NET' }[type] ?? 'DEV';
  return /^[A-Za-z]/.test(base) ? base : `${type === 'switch' ? 'SW' : 'R'}-${base}`;
}

// Nom du port d'en face dans GNS3 (le c7200 renumérote les interfaces, VPCS n'a que e0)
function gns3PortName(table, peer, link) {
  const row = table.get(peer.id)?.find((r) => r.link === link);
  if (!row) return peer.port;
  if (peer.type === 'router') return row.index < C7200_MAX_PORTS ? c7200Port(row.index).name : peer.port;
  if (peer.type === 'switch' || peer.type === 'hub') return `port ${row.index}`;
  return 'e0';
}

const desc = (row, peerPort) =>
  row.peer ? ` description Vers ${ascii(row.peer.label)} ${ascii(peerPort ?? row.peer.port)}`.trimEnd() : null;

// Les ports de la topologie existent sur le modèle (sinon le câble est signalé hors service)
const genericWarning = (d) =>
  modelOf(d).generic ? [`${modelOf(d).label} : choisis un modèle Cisco pour que les noms de ports correspondent à Packet Tracer.`] : [];

function routerConfig(d, rows, { target, table, topo }) {
  const warnings = target === 'gns3' ? [] : genericWarning(d);
  const lines = [];
  const cfg = d.config ?? {};
  const end = target === 'gns3' ? '!' : ' exit';
  // GNS3 renumérote les interfaces : les commandes de routage doivent suivre
  const renamed = new Map();

  for (const lo of (cfg.interfaces ?? []).filter((i) => /^Lo\d+$/.test(i.name) && i.ip)) {
    lines.push(`interface ${iosLongName(lo.name)}`, ` ip address ${lo.ip} ${cidrToMask(lo.mask)}`, ...iosInterfaceExtras(cfg, lo));
    if (lo.shutdown) lines.push(' shutdown');
    lines.push(end);
  }

  for (const row of rows) {
    let ifname;
    if (target === 'gns3') {
      if (row.index >= C7200_MAX_PORTS) {
        warnings.push(`${row.name} ignorée : un c7200 a au plus ${C7200_MAX_PORTS} ports FastEthernet.`);
        continue;
      }
      ifname = c7200Port(row.index).name;
      if (topo.links.get(row.link)?.cable === 'serial') {
        warnings.push(`${row.name} : liaison série remplacée par ${ifname} (Ethernet) sur le c7200.`);
      }
    } else {
      ifname = iosInterfaceName(row.name) ?? row.name;
    }
    renamed.set(row.name, ifname);
    lines.push(`interface ${ifname}`);
    const description = row.description ? ` description ${row.description}` : desc(row, target === 'gns3' && row.peer ? gns3PortName(table, row.peer, row.link) : null);
    if (description) lines.push(description);
    const subs = (cfg.interfaces ?? []).filter((i) => i.parent === row.name && i.vlan);
    if (row.hasIp) lines.push(` ip address ${row.ip} ${cidrToMask(row.mask)}`);
    else if (subs.length) lines.push(' no ip address'); // trunk vers les sous-interfaces
    else warnings.push(`${ifname} (vers ${ascii(row.peer?.label)}) n'a pas d'adresse IP.`);
    lines.push(...iosInterfaceExtras(cfg, row));
    // Liaison série : le côté DCE fournit l'horloge
    const link = topo.links.get(row.link);
    const isDce = link?.cable === 'serial' && (link.dce === 'target' ? link.target : link.source) === d.id;
    if (target !== 'gns3' && isDce) {
      if (row.clockRate) lines.push(` clock rate ${row.clockRate}`);
      else warnings.push(`${ifname} est le côté DCE de la liaison série mais n'a pas de clock rate.`);
    }
    lines.push(row.shutdown ? ' shutdown' : ' no shutdown', end);
    // Router-on-a-stick : une sous-interface par VLAN
    for (const sub of subs) {
      const subName = `${ifname}.${sub.name.split('.')[1] ?? sub.vlan}`;
      renamed.set(sub.name, subName);
      lines.push(`interface ${subName}`, ` encapsulation dot1Q ${sub.vlan}${sub.native ? ' native' : ''}`);
      if (sub.ip) lines.push(` ip address ${sub.ip} ${cidrToMask(sub.mask)}`);
      lines.push(...iosInterfaceExtras(cfg, sub));
      if (sub.shutdown) lines.push(' shutdown');
      lines.push(end);
    }
  }

  for (const r of d.config?.routes ?? []) {
    if (r.network && r.mask !== null && r.mask !== undefined && r.nextHop) {
      lines.push(`ip route ${r.network} ${cidrToMask(r.mask)} ${r.nextHop}`);
    }
  }
  lines.push(...iosRoutingLines(cfg, (n) => renamed.get(n) ?? iosLongName(n)).map((l) => (l === '!' && target !== 'gns3' ? ' exit' : l)));
  return { lines, warnings };
}

function switchConfig(d, rows) {
  const warnings = genericWarning(d);
  const lines = [];
  for (const v of switchVlans(rows)) lines.push(`vlan ${v}`, ` name VLAN${v}`, ' exit');
  for (const row of rows) {
    const ifname = iosInterfaceName(row.name) ?? row.name;
    lines.push(`interface ${ifname}`);
    const description = desc(row);
    if (description) lines.push(description);
    if (row.mode === 'trunk') lines.push(' switchport mode trunk');
    else {
      lines.push(' switchport mode access');
      const vlan = Number(row.vlan) || 1;
      if (vlan !== 1) lines.push(` switchport access vlan ${vlan}`);
    }
    if (row.shutdown) lines.push(' shutdown');
    lines.push(' exit');
  }
  // Niveau 3 / administration : interfaces VLAN, ip routing, passerelle, routes, protocoles
  const c = d.config ?? {};
  for (const svi of (c.interfaces ?? []).filter((i) => /^Vlan\d+$/.test(i.name) && i.ip)) {
    lines.push(`interface ${svi.name}`, ` ip address ${svi.ip} ${cidrToMask(svi.mask)}`, ...iosInterfaceExtras(c, svi), svi.shutdown ? ' shutdown' : ' no shutdown', ' exit');
  }
  if (c.ipRouting) lines.push('ip routing');
  if (c.defaultGateway) lines.push(`ip default-gateway ${c.defaultGateway}`);
  for (const r of c.routes ?? []) {
    if (r.network && r.mask != null && r.nextHop) lines.push(`ip route ${r.network} ${cidrToMask(r.mask)} ${r.nextHop}`);
  }
  lines.push(...iosRoutingLines(c).map((l) => (l === '!' ? ' exit' : l)));
  return { lines, warnings };
}

// GNS3 : le switch Ethernet intégré n'a pas de CLI, on donne le tableau de ses ports
function gns3Switch(d, rows, table) {
  const lines = [
    `${d.label} (switch Ethernet integre de GNS3)`,
    'Clic droit > Configure : regler chaque port comme ci-dessous',
    'Port  Type    VLAN  Relie a',
  ];
  for (const r of rows) {
    const type = r.mode === 'trunk' ? 'dot1q' : 'access';
    const vlan = r.mode === 'trunk' ? 1 : Number(r.vlan) || 1;
    const peer = r.peer ? `${ascii(r.peer.label)} ${gns3PortName(table, r.peer, r.link)}` : '';
    lines.push(`${String(r.index).padEnd(6)}${type.padEnd(8)}${String(vlan).padEnd(6)}${peer}`);
  }
  return [...lines, ''].join('\n');
}

export function ciscoConfigs(doc, { target = 'packet-tracer' } = {}) {
  const { table, topo } = interfaceTable(doc);
  const names = uniqueNames(doc.devices, (d) => hostname(d.label, d.type));

  return doc.devices.map((d) => {
    const rows = table.get(d.id);
    const name = names.get(d.id);

    // MikroTik : script RouterOS (pas de MikroTik dans Packet Tracer ; appliance CHR dans GNS3)
    if (isMikrotik(d)) {
      const warnings = target === 'gns3'
        ? []
        : [`${modelOf(d).label} n'existe pas dans Packet Tracer : remplace-le par un routeur Cisco, ou utilise GNS3 (MikroTik CHR).`];
      const intro = target === 'gns3' ? '# GNS3 : appliance MikroTik CHR, coller ce script dans la console' : '# Script RouterOS (WinBox > New Terminal, ou SSH)';
      return { id: d.id, label: d.label, type: d.type, name, kind: 'routeros', text: [intro, ...routerosScript(d), ''].join('\n'), warnings };
    }

    if (d.type === 'hub') {
      return { id: d.id, label: d.label, type: d.type, name, kind: 'manual', text: `${d.label} (hub) : rien a configurer.\n`, warnings: [] };
    }

    if (d.type === 'switch' && target === 'gns3') {
      return { id: d.id, label: d.label, type: d.type, name, kind: 'manual', text: gns3Switch(d, rows, table), warnings: [] };
    }

    if (d.type === 'router' || d.type === 'switch') {
      const { lines, warnings } = d.type === 'router' ? routerConfig(d, rows, { target, table, topo }) : switchConfig(d, rows);
      let text;
      if (target === 'gns3') {
        // startup-config chargée au démarrage du c7200
        text = ['!', `hostname ${name}`, '!', 'no ip domain-lookup', '!', ...lines.map((l) => (l === ' exit' ? '!' : l)), '!', 'end', ''].join('\n');
      } else {
        const modules = Object.entries(d.modules ?? {}).filter(([, m]) => MODULES[m]);
        text = [
          `! ${name} : ${modelOf(d).label}`,
          ...(modules.length
            ? [`! Modules a installer d'abord (onglet Physical, equipement eteint) : ${modules.map(([slot, m]) => `${m} dans le slot ${slot}`).join(', ')}`]
            : []),
          '! Packet Tracer : onglet CLI, repondre "no" au dialogue initial, puis coller ce bloc.',
          'enable',
          'configure terminal',
          `hostname ${name}`,
          'no ip domain-lookup',
          ...lines,
          'end',
          'write memory',
          '',
        ].join('\n');
      }
      return { id: d.id, label: d.label, type: d.type, name, kind: d.type, text, warnings };
    }

    // Hôtes : configuration manuelle (Packet Tracer) ou script VPCS (GNS3)
    const i = rows[0] ?? {};
    const warnings = i.hasIp ? [] : [`${d.label} n'a pas d'adresse IP.`];
    let text;
    if (target === 'gns3') {
      text = [`set pcname ${name}`, i.hasIp ? `ip ${i.ip}${i.gateway ? ` ${i.gateway}` : ''} ${i.mask}` : '# pas d\'adresse IP', ''].join('\n');
    } else {
      text = [
        `${d.label} (${MODELS[modelId(d)].type === 'cloud' ? 'Cloud-PT' : modelId(d)})`,
        'Desktop > IP Configuration > Static',
        `  IPv4 Address    : ${i.hasIp ? i.ip : '(non configurée)'}`,
        `  Subnet Mask     : ${i.hasIp ? cidrToMask(i.mask) : ''}`,
        `  Default Gateway : ${i.gateway || ''}`,
        '',
      ].join('\n');
    }
    return { id: d.id, label: d.label, type: d.type, name, kind: 'manual', text, warnings };
  });
}

// Tout dans un seul fichier texte
export function ciscoBundle(doc, target = 'packet-tracer') {
  const configs = ciscoConfigs(doc, { target });
  const head = [
    `! ${ascii(doc.name)} : configurations generees par NetCanvas`,
    target === 'gns3' ? '! Cible : GNS3 (routeurs c7200, switch Ethernet integre, PC VPCS)' : '! Cible : Cisco Packet Tracer (routeur 2911, switch 2960, PC-PT)',
    '!',
  ];
  const blocks = configs.map((c) => {
    const warn = c.warnings.map((w) => `! ATTENTION : ${ascii(w)}`);
    const body = c.kind === 'manual' ? c.text.split('\n').map((l) => (l ? `! ${ascii(l)}` : '!')).join('\n') : c.text;
    return [`! ==================== ${c.name} ====================`, ...warn, body].join('\n');
  });
  return [...head, ...blocks].join('\n');
}

// --- Routage dynamique (partagé avec le terminal : show running-config) -------------------------
const loName = (n) => (/^Lo(\d+)$/.test(n) ? `Loopback${n.slice(2)}` : null);
export function iosLongName(n) {
  // Sous-interface : « G0/0.10 » -> « GigabitEthernet0/0.10 »
  const sub = /^(.+)(\.\d+)$/.exec(n ?? '');
  if (sub) return `${iosLongName(sub[1])}${sub[2]}`;
  return loName(n) ?? iosInterfaceName(n) ?? n;
}

// Lignes propres à une interface : bande passante, OSPF
export function iosInterfaceExtras(cfg, entry) {
  const out = [];
  if (entry?.bandwidth) out.push(` bandwidth ${entry.bandwidth}`);
  if (entry?.ospfCost) out.push(` ip ospf cost ${entry.ospfCost}`);
  const o = cfg.ospf?.interfaces?.find((x) => x.name === entry?.name);
  if (o) out.push(` ip ospf ${cfg.ospf.processId ?? 1} area ${o.area}`);
  return out;
}

// Blocs « router ospf / rip / bgp » ; ifName traduit les noms d'interfaces (GNS3 renumérote)
export function iosRoutingLines(cfg, ifName = iosLongName) {
  const out = [];
  const o = cfg.ospf;
  if (o) {
    out.push(`router ospf ${o.processId ?? 1}`);
    if (o.routerId) out.push(` router-id ${o.routerId}`);
    out.push(' log-adjacency-changes');
    if (o.redistribute?.connected) out.push(' redistribute connected subnets');
    if (o.redistribute?.static) out.push(' redistribute static subnets');
    for (const p of o.passive ?? []) out.push(` passive-interface ${ifName(p)}`);
    for (const n of o.networks ?? []) out.push(` network ${n.network} ${n.wildcard} area ${n.area}`);
    if (o.defaultOriginate) out.push(` default-information originate${o.defaultOriginate === 'always' ? ' always' : ''}`);
    out.push('!');
  }
  const r = cfg.rip;
  if (r) {
    out.push('router rip');
    if (r.version) out.push(` version ${r.version}`);
    if (r.redistribute?.static) out.push(' redistribute static');
    for (const p of r.passive ?? []) out.push(` passive-interface ${ifName(p)}`);
    for (const n of r.networks ?? []) out.push(` network ${n}`);
    if (r.defaultOriginate) out.push(' default-information originate');
    if (!r.autoSummary) out.push(' no auto-summary');
    out.push('!');
  }
  const b = cfg.bgp;
  if (b?.asn) {
    out.push(`router bgp ${b.asn}`);
    if (b.routerId) out.push(` bgp router-id ${b.routerId}`);
    out.push(' bgp log-neighbor-changes');
    for (const n of b.neighbors ?? []) {
      out.push(` neighbor ${n.ip} remote-as ${n.remoteAs}`);
      if (n.ebgpMultihop) out.push(` neighbor ${n.ip} ebgp-multihop ${n.ebgpMultihop}`);
      if (n.updateSource) out.push(` neighbor ${n.ip} update-source ${ifName(n.updateSource)}`);
      if (n.nextHopSelf) out.push(` neighbor ${n.ip} next-hop-self`);
    }
    for (const n of b.networks ?? []) out.push(` network ${n.network} mask ${cidrToMask(n.mask)}`);
    for (const p of ['connected', 'static']) if (b.redistribute?.[p]) out.push(` redistribute ${p}`);
    if (b.redistribute?.ospf) out.push(` redistribute ospf ${cfg.ospf?.processId ?? 1}`);
    out.push('!');
  }
  return out;
}
