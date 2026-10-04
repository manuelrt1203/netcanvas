// Export Containerlab (.clab.yml) : chaque équipement devient un conteneur Linux configuré au démarrage.
//   routeur : ip_forward + adresses + loopbacks + table de routage. Les conteneurs n'exécutent pas
//             OSPF / RIP / BGP : on installe en statique les routes de l'état convergé calculé par NetCanvas.
//   switch  : bridge Linux avec filtrage VLAN (access = PVID non étiqueté, trunk = VLAN étiquetés + natif 1)
//   hôte    : adresse + route par défaut
// Containerlab réserve eth0 au management : le 1er câble d'un équipement est eth1, le 2e eth2…
import { isValidCidr, isValidIp } from '../net/ip.js';
import { computeRouting, lookup, prefixText } from '../net/routing.js';
import { isL3Switch, isLoopbackName, isRouting } from '../net/topology.js';
import { isMikrotik } from '../net/catalog.js';
import { wildcardToCidr } from '../net/routing.js';
import { withLeases } from '../net/dhcp.js';
import { ascii, interfaceTable, switchVlans, uniqueNames } from './common.js';

export const CLAB_IMAGE = 'nicolaka/netshoot:latest'; // iproute2 + bridge + ping + tcpdump

const ifname = (index) => `eth${index + 1}`;

const nodeName = (d) =>
  ascii(d.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || d.type;

// Commandes de configuration de chaque nœud (aussi utilisées par les tests avec des namespaces Linux)
export function clabCommands(rawDoc) {
  // Clients DHCP : on installe l'adresse du bail calculé (pas de serveur DHCP dans les conteneurs)
  const doc = withLeases(rawDoc);
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
    const filters = () => [...natCmds(d, rows), ...filterCmds(d, rows)];
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
      if (isL3Switch(d)) cmds.push(...routeCmds(d), ...filters());
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
        cmds.push(...routeCmds(d), ...filters());
      } else if (rows[0]?.hasIp && isValidIp(rows[0].gateway)) {
        // Remplace la route par défaut du réseau de management
        cmds.push(`ip route replace default via ${rows[0].gateway}`);
      }
    }
    commands.set(d.id, cmds);
  }
  return commands;
}

// --- ACL Cisco et pare-feu MikroTik -> iptables ------------------------------------------------
// Nom Linux d'une interface du schéma : eth1…, eth1.10 (sous-interface), br0.10 (SVI), lo
function linuxDev(d, rows, name) {
  if (/^Vlan\d+$/.test(name)) return `br0.${name.slice(4)}`;
  if (isLoopbackName(name)) return 'lo';
  const sub = (d.config?.interfaces ?? []).find((i) => i.name === name && i.parent);
  const row = rows.find((r) => r.name === (sub?.parent ?? name));
  if (!row) return null;
  return sub && !sub.native ? `${ifname(row.index)}.${sub.vlan}` : ifname(row.index);
}

const ipt = (spec, flag) => {
  if (!spec || spec.any) return '';
  const cidr = wildcardToCidr(spec.wildcard);
  return cidr === null ? null : ` ${flag} ${spec.ip}/${cidr}`;
};

function filterCmds(d, rows) {
  const out = [];
  if (isMikrotik(d)) {
    for (const r of d.config?.firewall ?? []) {
      const parts = [`iptables -A ${r.chain === 'input' ? 'INPUT' : 'FORWARD'}`];
      if (r.protocol) parts.push(`-p ${r.protocol}`);
      if (r.src) parts.push(`-s ${r.src}`);
      if (r.dst) parts.push(`-d ${r.dst}`);
      for (const [key, flag] of [['inIface', '-i'], ['outIface', '-o']]) {
        if (!r[key]) continue;
        const dev = linuxDev(d, rows, r[key]);
        if (dev) parts.push(`${flag} ${dev}`);
      }
      parts.push(`-j ${r.action === 'accept' ? 'ACCEPT' : 'DROP'}`);
      out.push(parts.join(' '));
    }
    return out;
  }
  const acls = d.config?.acls ?? {};
  const used = new Set();
  for (const i of d.config?.interfaces ?? []) {
    for (const [key, hooks] of [['aclIn', (dev) => [`INPUT -i ${dev}`, `FORWARD -i ${dev}`]], ['aclOut', (dev) => [`FORWARD -o ${dev}`]]]) {
      const acl = acls[i[key]];
      const dev = acl && linuxDev(d, rows, i.name);
      if (!dev) continue;
      const chain = `acl-${i[key]}`.replace(/[^\w-]/g, '_').slice(0, 28);
      if (!used.has(chain)) {
        used.add(chain);
        out.push(`iptables -N ${chain}`);
        for (const r of acl.rules ?? []) {
          if (r.remark !== undefined) continue;
          const src = ipt(r.src, '-s');
          const dst = acl.type === 'extended' ? ipt(r.dst, '-d') : '';
          if (src === null || dst === null) continue; // wildcard non contigu : pas d'équivalent iptables
          const proto = acl.type === 'extended' && r.protocol !== 'ip' ? ` -p ${r.protocol}` : '';
          // permit -> RETURN : le paquet continue vers les autres contrôles (ACL de sortie), comme sur IOS
          out.push(`iptables -A ${chain}${proto}${src}${dst} -j ${r.action === 'permit' ? 'RETURN' : 'DROP'}`);
        }
        out.push(`iptables -A ${chain} -j DROP`); // refus implicite
      }
      for (const h of hooks(dev)) out.push(`iptables -A ${h} -j ${chain}`);
    }
  }
  return out;
}

// --- NAT -> iptables -t nat ---------------------------------------------------------------------
function natCmds(d, rows) {
  const out = [];
  if (isMikrotik(d)) {
    for (const r of d.config?.natRules ?? []) {
      const parts = [`iptables -t nat -A ${r.chain === 'dstnat' ? 'PREROUTING' : 'POSTROUTING'}`];
      if (r.inIface && linuxDev(d, rows, r.inIface)) parts.push(`-i ${linuxDev(d, rows, r.inIface)}`);
      if (r.outIface && linuxDev(d, rows, r.outIface)) parts.push(`-o ${linuxDev(d, rows, r.outIface)}`);
      if (r.src) parts.push(`-s ${r.src}`);
      if (r.dst) parts.push(`-d ${r.dst}`);
      parts.push(r.action === 'masquerade' ? '-j MASQUERADE' : r.action === 'src-nat' ? `-j SNAT --to-source ${r.toAddresses}` : `-j DNAT --to-destination ${r.toAddresses}`);
      out.push(parts.join(' '));
    }
    return out;
  }
  const nat = d.config?.nat;
  const ifs = d.config?.interfaces ?? [];
  // Comme sur IOS : sans interface inside ET outside, rien n'est traduit
  if (!nat || !ifs.some((i) => i.natInside) || !ifs.some((i) => i.natOutside)) return out;
  const outside = ifs.filter((i) => i.natOutside).map((i) => linuxDev(d, rows, i.name)).filter(Boolean);
  for (const st of nat.statics ?? []) {
    for (const dev of outside) {
      out.push(`ip addr add ${st.global}/32 dev ${dev}`, `iptables -t nat -A PREROUTING -i ${dev} -d ${st.global} -j DNAT --to-destination ${st.local}`,
        `iptables -t nat -A POSTROUTING -o ${dev} -s ${st.local} -j SNAT --to-source ${st.global}`);
    }
  }
  for (const r of nat.dynamic ?? []) {
    const acl = d.config?.acls?.[r.acl];
    if (!acl) continue;
    const chain = `nat-${r.acl}`.replace(/[^\w-]/g, '_').slice(0, 28);
    const pool = r.pool ? nat.pools?.[r.pool] : null;
    const target = r.iface ? '-j MASQUERADE' : pool ? `-j SNAT --to-source ${pool.start}` : null;
    if (!target) continue;
    out.push(`iptables -t nat -N ${chain}`);
    for (const rule of acl.rules ?? []) {
      if (rule.remark !== undefined) continue;
      const src = ipt(rule.src, '-s');
      if (src === null) continue;
      out.push(`iptables -t nat -A ${chain}${src} ${rule.action === 'permit' ? target : '-j RETURN'}`);
    }
    const devs = r.iface ? [linuxDev(d, rows, r.iface)].filter(Boolean) : outside;
    for (const dev of devs) {
      if (pool) for (const ip of [pool.start]) out.push(`ip addr add ${ip}/32 dev ${dev}`);
      out.push(`iptables -t nat -A POSTROUTING -o ${dev} -j ${chain}`);
    }
  }
  return out;
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
