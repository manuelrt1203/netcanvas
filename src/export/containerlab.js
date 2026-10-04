// Export Containerlab (.clab.yml) : chaque équipement devient un conteneur Linux configuré au démarrage.
//   routeur : ip_forward + adresses + loopbacks + table de routage. Les conteneurs n'exécutent pas
//             OSPF / RIP / BGP : on installe en statique les routes de l'état convergé calculé par NetCanvas.
//   switch  : bridge Linux avec filtrage VLAN (access = PVID non étiqueté, trunk = VLAN étiquetés + natif 1)
//   hôte    : adresse + route par défaut
// Containerlab réserve eth0 au management : le 1er câble d'un équipement est eth1, le 2e eth2…
import { isValidCidr, isValidIp } from '../net/ip.js';
import { computeRouting, lookup, prefixText } from '../net/routing.js';
import { isL3Switch, isLoopbackName, isRouting } from '../net/topology.js';
import { ascii, interfaceTable, switchVlans, uniqueNames } from './common.js';

export const CLAB_IMAGE = 'nicolaka/netshoot:latest'; // iproute2 + bridge + ping + tcpdump

const ifname = (index) => `eth${index + 1}`;

const nodeName = (d) =>
  ascii(d.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || d.type;

// Commandes de configuration de chaque nœud (aussi utilisées par les tests avec des namespaces Linux)
export function clabCommands(doc) {
  const { table, topo } = interfaceTable(doc);
  const routing = computeRouting(doc, topo);
  const allVlans = [...new Set(doc.devices.filter((d) => d.type === 'switch').flatMap((d) => switchVlans(table.get(d.id))))];
  const commands = new Map();

  // Table de routage calculée -> routes Linux (BGP : next-hop résolu par l'IGP, Linux veut une passerelle directe)
  const routeCmds = (d) => {
    const rib = routing.ribs.get(d.id);
    const out = [];
    for (const route of [...rib.values()].filter((r) => !['C', 'L'].includes(r.proto)).sort((a, b) => a.net - b.net || a.mask - b.mask)) {
      let via = route.nextHop;
      if (route.recursive) {
        const igp = lookup(rib, route.nextHop, (r) => r.proto !== 'B');
        if (!igp) continue;
        if (igp.proto !== 'C') via = igp.nextHop;
      }
      out.push(route.mask === 0 ? `ip route replace default via ${via}` : `ip route replace ${prefixText(route.net, route.mask)} via ${via}`);
    }
    return out;
  };

  for (const d of doc.devices) {
    const rows = table.get(d.id).filter((r) => r.link);
    const cmds = [];
    if (d.type === 'hub') {
      // Hub : bridge sans filtrage VLAN (répète tout)
      cmds.push('ip link add br0 type bridge', 'ip link set br0 up');
      for (const r of rows) cmds.push(`ip link set ${ifname(r.index)} master br0`, `ip link set ${ifname(r.index)} up`);
    } else if (d.type === 'switch') {
      cmds.push('ip link add br0 type bridge vlan_filtering 1', 'ip link set br0 up');
      for (const r of rows) {
        const dev = ifname(r.index);
        cmds.push(`ip link set ${dev} master br0`, `ip link set ${dev} up`);
        if (r.mode === 'trunk') {
          // VLAN 1 reste natif (non étiqueté), les autres passent étiquetés
          for (const v of allVlans) cmds.push(`bridge vlan add vid ${v} dev ${dev}`);
        } else if ((Number(r.vlan) || 1) !== 1) {
          cmds.push(`bridge vlan del vid 1 dev ${dev}`, `bridge vlan add vid ${Number(r.vlan)} dev ${dev} pvid untagged`);
        }
      }
      // Interfaces VLAN (SVI) : br0.10… sur le bridge, routées si « ip routing »
      for (const svi of (d.config?.interfaces ?? []).filter((i) => /^Vlan\d+$/.test(i.name) && isValidIp(i.ip) && !i.shutdown)) {
        const v = Number(svi.name.slice(4));
        const dev = `br0.${v}`;
        cmds.push(`bridge vlan add vid ${v} dev br0 self`, `ip link add link br0 name ${dev} type vlan id ${v}`,
          `ip addr add ${svi.ip}/${svi.mask} dev ${dev}`, `ip link set ${dev} up`);
      }
      if (isL3Switch(d)) cmds.push(...routeCmds(d));
      else if (isValidIp(d.config?.defaultGateway)) cmds.push(`ip route replace default via ${d.config.defaultGateway}`);
    } else {
      for (const r of rows) {
        // Port actif même sans IP (parent des sous-interfaces 802.1Q)
        if (r.hasIp) cmds.push(`ip addr add ${r.ip}/${r.mask} dev ${ifname(r.index)}`);
        cmds.push(`ip link set ${ifname(r.index)} up`);
      }
      if (d.type === 'router') {
        for (const lo of (d.config?.interfaces ?? []).filter((i) => isLoopbackName(i.name) && isValidIp(i.ip) && isValidCidr(i.mask) && !i.shutdown)) {
          cmds.push(`ip addr add ${lo.ip}/${lo.mask} dev lo`);
        }
        // Router-on-a-stick : interface VLAN Linux sur le port parent (eth1.10…)
        for (const sub of (d.config?.interfaces ?? []).filter((i) => i.parent && i.vlan && isValidIp(i.ip) && !i.shutdown)) {
          const parent = rows.find((r) => r.name === sub.parent);
          if (!parent) continue;
          const dev = sub.native ? ifname(parent.index) : `${ifname(parent.index)}.${sub.vlan}`;
          if (!sub.native) cmds.push(`ip link add link ${ifname(parent.index)} name ${dev} type vlan id ${sub.vlan}`);
          cmds.push(`ip addr add ${sub.ip}/${sub.mask} dev ${dev}`, `ip link set ${dev} up`);
        }
        cmds.push(...routeCmds(d));
      } else if (rows[0]?.hasIp && isValidIp(rows[0].gateway)) {
        // Remplace la route par défaut du réseau de management
        cmds.push(`ip route replace default via ${rows[0].gateway}`);
      }
    }
    commands.set(d.id, cmds);
  }
  return commands;
}

const q = (s) => JSON.stringify(String(s)); // chaîne YAML entre guillemets doubles

export function toContainerlab(doc) {
  const names = uniqueNames(doc.devices, nodeName);
  const commands = clabCommands(doc);
  const { table } = interfaceTable(doc);
  const labName = ascii(doc.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'netcanvas';

  const out = [
    `# ${ascii(doc.name)} : topologie generee par NetCanvas`,
    '# Lancer :  sudo containerlab deploy -t <ce fichier>',
    '# Tester :  docker exec -it clab-' + labName + '-<noeud> ping <ip>',
    '# eth0 = management Containerlab ; eth1, eth2... = cables du schema dans l\'ordre',
    '# Routage : les routes OSPF / RIP / BGP calculees par NetCanvas (etat converge) sont installees en statique',
    `name: ${labName}`,
    '',
    'topology:',
    '  defaults:',
    '    kind: linux',
    `    image: ${CLAB_IMAGE}`,
    '  nodes:',
  ];

  for (const d of doc.devices) {
    out.push(`    ${names.get(d.id)}:`);
    out.push(`      labels: { netcanvas-type: ${d.type}, netcanvas-label: ${q(d.label)} }`);
    if (isRouting(d)) {
      out.push('      sysctls:', '        net.ipv4.ip_forward: 1', '        net.ipv4.conf.all.arp_ignore: 1');
    } else if (d.type === 'switch') {
      // Switch sans « ip routing » : ses interfaces VLAN ne doivent pas router (le défaut hérité peut être 1)
      out.push('      sysctls:', '        net.ipv4.ip_forward: 0');
    }
    const cmds = commands.get(d.id);
    if (cmds.length) {
      out.push('      exec:');
      for (const c of cmds) out.push(`        - ${q(c)}`);
    }
  }

  out.push('', '  links:');
  for (const l of doc.links) {
    const a = table.get(l.source)?.find((r) => r.link === l.id);
    const b = table.get(l.target)?.find((r) => r.link === l.id);
    if (!a || !b) continue;
    out.push(`    - endpoints: [${q(`${names.get(l.source)}:${ifname(a.index)}`)}, ${q(`${names.get(l.target)}:${ifname(b.index)}`)}]`);
  }
  return `${out.join('\n')}\n`;
}
