// Vérifie le calcul OSPFv3 de NetCanvas contre un vrai routeur : FRRouting (ospf6d) dans Docker.
// Chaque routeur du schéma devient un conteneur FRR, chaque câble partant d'un routeur un réseau Docker ;
// la config FRR (adresses IPv6, zones, coûts, passive, route par défaut) est tirée de la config NetCanvas.
// Une fois les adjacences montées, on compare les routes OSPFv3 de FRR à celles de NetCanvas :
// préfixe, type (intra, inter-zones, externe), métrique, interface de sortie et routeur voisin.
//   node e2e/frr-ospf6.mjs            (nécessite Docker et l'image frrouting/frr)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { OSPF6_DEMO } from '../src/examples.js';
import { withLeases } from '../src/net/dhcp.js';
import { buildTopology } from '../src/net/topology.js';
import { computeRouting, ospfCost } from '../src/net/routing.js';
import { routeText6 } from '../src/net/routing6.js';
import { normIp6 } from '../src/net/ip6.js';

const IMAGE = process.env.FRR_IMAGE || 'frrouting/frr:latest';
const PREFIX = 'ncfrr';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const quiet = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const areaId = (n) => [24, 16, 8, 0].map((s) => (Number(n) >>> s) & 255).join('.');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() {
  const ids = quiet('ps', '-aq', '--filter', `name=${PREFIX}-`).stdout.trim().split('\n').filter(Boolean);
  if (ids.length) quiet('rm', '-f', ...ids);
  const nets = quiet('network', 'ls', '-q', '--filter', `name=${PREFIX}-`).stdout.trim().split('\n').filter(Boolean);
  if (nets.length) quiet('network', 'rm', ...nets);
}

async function verify(rawDoc) {
  const doc = withLeases(rawDoc);
  const topo = buildTopology(doc);
  const routing = computeRouting(doc, topo);
  const routers = [...routing.routers.values()].filter((r) => r.ospf6.enabled);
  const dir = mkdtempSync(join(tmpdir(), 'ncfrr-'));
  cleanup();

  // Un réseau Docker par câble qui touche un routeur OSPFv3
  const links = [...new Set(routers.flatMap((r) => r.ifaces6.filter((i) => i.link).map((i) => i.link)))];
  links.forEach((l, k) => docker('network', 'create', '--internal', '--subnet', `10.250.${k}.0/24`, `${PREFIX}-${l}`));

  for (const r of routers) {
    const o = r.cfg.ospf6;
    const passive = new Set(o.passive ?? []);
    const conf = ['frr defaults traditional', `hostname ${r.id}`, 'ipv6 forwarding', '!'];
    for (const s of r.cfg.routes6 ?? []) conf.push(`ipv6 route ${normIp6(s.network)}/${s.prefix} ${s.nextHop}`);
    conf.push('!');
    // Les noms Linux sont connus après le branchement : placeholders remplacés plus bas
    for (const x of r.ospf6.ifaces) {
      const i = x.iface;
      conf.push(`interface ${i.loopback ? 'lo' : `@${i.link}`}`);
      if (i.ip) conf.push(` ipv6 address ${i.ip}/${i.loopback ? 128 : i.prefix}`);
      conf.push(` ipv6 ospf6 area ${areaId(x.area)}`, ` ipv6 ospf6 cost ${ospfCost(r.dev, i)}`);
      if (!i.loopback) conf.push(' ipv6 ospf6 hello-interval 1', ' ipv6 ospf6 dead-interval 4');
      if (passive.has(i.name)) conf.push(' ipv6 ospf6 passive');
      conf.push('!');
    }
    // Interfaces IPv6 hors OSPFv3 (vers Internet…) : adresse seulement
    for (const i of r.ifaces6.filter((i) => i.ip && !i.loopback && !r.ospf6.ifaces.some((x) => x.iface.name === i.name))) {
      conf.push(`interface @${i.link}`, ` ipv6 address ${i.ip}/${i.prefix}`, '!');
    }
    conf.push('router ospf6', ` ospf6 router-id ${r.ospf6.routerId}`);
    // FRR annonce la route par défaut en métrique 10 ; IOS (et NetCanvas) en métrique 1, type E2 : on l'impose
    if (o.defaultOriginate) conf.push(` default-information originate${o.defaultOriginate === 'always' ? ' always' : ''} metric 1 metric-type 2`);
    conf.push('!');
    r.frrConf = conf;

    writeFileSync(join(dir, `${r.id}.daemons`), ['zebra=yes', 'ospf6d=yes', 'staticd=yes', 'vtysh_enable=yes',
      'zebra_options="  -A 127.0.0.1 -s 90000000"', 'ospf6d_options=" -A ::1"', 'staticd_options="-A 127.0.0.1"'].join('\n') + '\n');
    const mine = r.ifaces6.filter((i) => i.link).map((i) => i.link);
    docker('run', '-d', '--name', `${PREFIX}-${r.id}`, '--hostname', r.id, '--privileged',
      '--sysctl', 'net.ipv6.conf.all.disable_ipv6=0', '--sysctl', 'net.ipv6.conf.default.disable_ipv6=0', '--sysctl', 'net.ipv6.conf.all.forwarding=1',
      '--network', `${PREFIX}-${mine[0]}`, '-v', `${join(dir, `${r.id}.daemons`)}:/etc/frr/daemons:ro`, IMAGE);
    for (const l of mine.slice(1)) docker('network', 'connect', `${PREFIX}-${l}`, `${PREFIX}-${r.id}`);
  }

  // Nom Linux de chaque câble dans chaque conteneur (par l'adresse MAC Docker)
  for (const r of routers) {
    const nets = JSON.parse(docker('inspect', '-f', '{{json .NetworkSettings.Networks}}', `${PREFIX}-${r.id}`));
    const links6 = JSON.parse(docker('exec', `${PREFIX}-${r.id}`, 'ip', '-j', 'link'));
    r.linux = new Map();
    for (const [net, v] of Object.entries(nets)) {
      const dev = links6.find((x) => x.address === v.MacAddress)?.ifname;
      r.linux.set(net.slice(PREFIX.length + 1), dev);
    }
    // Docker désactive IPv6 sur les interfaces d'un réseau IPv4 : on le réactive (link-local pour OSPFv3)
    for (const dev of r.linux.values()) docker('exec', `${PREFIX}-${r.id}`, 'sysctl', '-qw', `net.ipv6.conf.${dev}.disable_ipv6=0`);
    const conf = r.frrConf.map((l) => l.replace(/@(\S+)/, (_, link) => r.linux.get(link))).join('\n');
    writeFileSync(join(dir, `${r.id}.conf`), `${conf}\n`);
    docker('cp', join(dir, `${r.id}.conf`), `${PREFIX}-${r.id}:/etc/frr/frr.conf`);
    docker('exec', `${PREFIX}-${r.id}`, 'sh', '-c', 'touch /etc/frr/vtysh.conf; chown frr:frr /etc/frr/frr.conf; vtysh -f /etc/frr/frr.conf');
  }

  // Attente de la convergence : toutes les adjacences attendues par NetCanvas en Full, puis tables stables 5 s
  const frrRoutes = (r) => JSON.parse(docker('exec', `${PREFIX}-${r.id}`, 'vtysh', '-c', 'show ipv6 route ospf6 json'));
  const full = (r) => (docker('exec', `${PREFIX}-${r.id}`, 'vtysh', '-c', 'show ipv6 ospf6 neighbor').match(/ Full\//g) ?? []).length;
  for (let t = 0; t < 90 && routers.some((r) => full(r) < r.ospf6.neighbors.length); t++) await sleep(1000);
  for (const r of routers) console.log(`${r.label} : ${full(r)}/${r.ospf6.neighbors.length} adjacence(s) Full`);
  let last = '';
  for (let t = 0, stable = 0; t < 90 && stable < 5; t++) {
    await sleep(1000);
    const now = JSON.stringify(routers.map((r) => Object.keys(frrRoutes(r)).sort()));
    stable = now === last ? stable + 1 : 0;
    last = now;
  }

  // Link-local Linux -> routeur, pour comparer les voisins (les link-local diffèrent de NetCanvas)
  const owner = new Map();
  for (const r of routers) {
    for (const a of JSON.parse(docker('exec', `${PREFIX}-${r.id}`, 'ip', '-j', '-6', 'addr'))) {
      for (const x of a.addr_info) if (x.scope === 'link') owner.set(x.local, r.id);
    }
  }

  const KIND = { O: 'intra', 'O IA': 'inter', 'O E2': 'external', 'O*E2': 'external' };
  let problems = 0;
  for (const r of routers) {
    const ours = new Map([...routing.ribs6.get(r.id).values()].filter((x) => x.proto.startsWith('O')).map((x) => [routeText6(x), x]));
    const theirs = new Map();
    for (const [prefix, entries] of Object.entries(frrRoutes(r))) {
      const e = entries.find((x) => x.selected) ?? entries[0];
      // Un préfixe aussi connecté localement reste connecté chez NetCanvas (distance 0)
      if (!e.selected) continue;
      theirs.set(prefix, e);
    }
    console.log(`\n${r.label} (router-id ${r.ospf6.routerId})`);
    for (const p of new Set([...ours.keys(), ...theirs.keys()])) {
      const a = ours.get(p);
      const b = theirs.get(p);
      const bHops = (b?.nexthops ?? []).map((h) => `${owner.get(h.ip) ?? h.ip} ${[...r.linux].find(([, d]) => d === h.interfaceName)?.[0] ?? h.interfaceName}`);
      const aHop = a && `${topo.devices.get(a.nextHop ? routers.find((x) => x.ifaces6.some((i) => i.linkLocal === a.nextHop))?.id : null)?.id ?? a.nextHop} ${a.link}`;
      const ok = a && b && b.metric === a.metric && bHops.includes(aHop);
      if (!ok) problems++;
      console.log(`  ${ok ? 'OK ' : 'ÉCART'} ${p.padEnd(26)} NetCanvas: ${a ? `${a.proto} métrique ${a.metric} via ${aHop}` : 'absente'}  |  FRR: ${b ? `métrique ${b.metric} via ${bHops.join(', ')}` : 'absente'}`);
      if (a && b) assert.ok(KIND[a.proto]);
    }
  }
  if (!process.env.KEEP) cleanup();
  return problems;
}

// Scénarios : la démo, puis des pannes et des changements de coût que NetCanvas doit prévoir comme FRR
const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const SCENARIOS = [
  ['Démo OSPFv3 2 zones', () => {}],
  ['Zones différentes sur le lien R2-R3 (pas d\'adjacence)', (d) => { dev(d, 'r2').config.ospf6.interfaces.find((x) => x.name === 'G0/1').area = 2; }],
  ['G0/1 de R1 passive (R1 isolé)', (d) => { dev(d, 'r1').config.ospf6.passive.push('G0/1'); }],
  ['Coût 50 sur R2 G0/1, route par défaut « always » sans route ::/0', (d) => {
    dev(d, 'r2').config.interfaces.find((i) => i.name === 'G0/1').ospfCost = 50;
    dev(d, 'r3').config.routes6 = [];
    dev(d, 'r3').config.ospf6.defaultOriginate = 'always';
  }],
];

let total = 0;
try {
  for (const [name, change] of SCENARIOS) {
    console.log(`\n=== ${name} ===`);
    const doc = structuredClone(OSPF6_DEMO);
    change(doc);
    total += await verify(doc);
  }
  console.log(total ? `\n${total} écart(s) entre NetCanvas et FRR` : `\nOK : NetCanvas et FRR ont les mêmes routes OSPFv3 dans les ${SCENARIOS.length} scénarios`);
  process.exitCode = total ? 1 : 0;
} catch (e) {
  cleanup();
  throw e;
}
