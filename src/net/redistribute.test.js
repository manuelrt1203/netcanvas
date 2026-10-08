import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRouting } from './routing.js';
import { parseRedistOptions, redistLines } from './redistribute.js';
import { runLine, shellFor } from '../cli/index.js';
import { importConfig } from '../cli/import.js';

// R1 (OSPF + RIP, redistribue dans les deux sens) entre R2 (OSPF seul) et R3 (RIP seul), comme le TP3 :
//   LAN2 10.0.2.0/24 — R2 —(10.0.10.0/30, OSPF)— R1 —(10.0.30.0/30, RIP)— R3 — LAN3 10.0.3.0/24
function lab({ ospf = {}, rip = {} } = {}) {
  const r = (id, ifaces, config) => ({ id, type: 'router', model: '2911', modules: {}, label: id.toUpperCase(), position: { x: 0, y: 0 },
    config: { interfaces: ifaces.map(([link, name, ip, mask]) => ({ link, name, ip, mask })), routes: [], ...config } });
  return {
    format: 'netcanvas', version: 3, name: 'redistribution',
    devices: [
      r('r1', [['a', 'G0/0', '10.0.10.1', 30], ['b', 'G0/1', '10.0.30.1', 30]], {
        ospf: { processId: 1, networks: [{ network: '10.0.10.0', wildcard: '0.0.0.3', area: 0 }], ...ospf },
        rip: { version: 2, networks: ['10.0.0.0'], ...rip },
      }),
      r('r2', [['a', 'G0/0', '10.0.10.2', 30], ['l2', 'G0/1', '10.0.2.1', 24]], {
        ospf: { processId: 1, networks: [{ network: '10.0.0.0', wildcard: '0.255.255.255', area: 0 }] },
      }),
      r('r3', [['b', 'G0/0', '10.0.30.2', 30], ['l3', 'G0/1', '10.0.3.1', 24]], { rip: { version: 2, networks: ['10.0.0.0'] } }),
      { id: 'pc2', type: 'pc', model: 'PC-PT', label: 'PC2', position: { x: 0, y: 0 }, config: { ip: '10.0.2.10', mask: 24, gateway: '10.0.2.1' } },
      { id: 'pc3', type: 'pc', model: 'PC-PT', label: 'PC3', position: { x: 0, y: 0 }, config: { ip: '10.0.3.10', mask: 24, gateway: '10.0.3.1' } },
    ],
    links: [
      { id: 'a', source: 'r1', target: 'r2', cable: 'cross', sourceIface: 'G0/0', targetIface: 'G0/0' },
      { id: 'b', source: 'r1', target: 'r3', cable: 'cross', sourceIface: 'G0/1', targetIface: 'G0/0' },
      { id: 'l2', source: 'pc2', target: 'r2', cable: 'cross', sourceIface: 'Fa0', targetIface: 'G0/1' },
      { id: 'l3', source: 'pc3', target: 'r3', cable: 'cross', sourceIface: 'Fa0', targetIface: 'G0/1' },
    ],
  };
}
const route = (res, id, prefix) => [...res.ribs.get(id).values()].find((x) => `${x.net >>> 24}.${(x.net >>> 16) & 255}.${(x.net >>> 8) & 255}.${x.net & 255}/${x.mask}` === prefix);
const issues = (res) => res.issues.map((i) => i.text).join('\n');

test('options de redistribution', () => {
  assert.deepEqual(parseRedistOptions(['metric', '20', 'metric-type', '1', 'subnets'], 'ospf').opts, { metric: 20, metricType: 1, subnets: true });
  assert.deepEqual(parseRedistOptions(['metric', '100000', '100', '255', '1', '1500'], 'eigrp').opts, { metric: [100000, 100, 255, 1, 1500] });
  assert.ok(parseRedistOptions(['subnets'], 'rip').error);
  assert.deepEqual(redistLines({ redistribute: { static: true, bgp: { metric: 20, metricType: 1, subnets: true } } }, 'ospf', { bgp: 100 }),
    [' redistribute static subnets', ' redistribute bgp 100 metric 20 metric-type 1 subnets']);
});

test('OSPF <-> RIP : redistribution mutuelle, « subnets » et métrique RIP', () => {
  // Sans « subnets » : les /24 et /30 de RIP ne passent pas dans OSPF (expliqué)
  let res = computeRouting(lab({ ospf: { redistribute: { rip: { metric: 20 } } }, rip: { redistribute: { ospf: { process: 1, metric: 2 } } } }));
  assert.equal(route(res, 'r2', '10.0.3.0/24'), undefined);
  assert.match(issues(res), /sans « subnets » : seuls les réseaux par classe passent dans OSPF/);
  // R3 reçoit les réseaux OSPF (dont le LAN de R2) en RIP, métrique d'amorce 2
  const r3 = route(res, 'r3', '10.0.2.0/24');
  assert.equal(r3.proto, 'R');
  assert.equal(r3.metric, 2);

  // Avec « subnets » : R2 apprend le LAN de R3 en O E2 métrique 20
  res = computeRouting(lab({ ospf: { redistribute: { rip: { metric: 20, subnets: true } } }, rip: { redistribute: { ospf: { process: 1, metric: 2 } } } }));
  const r2 = route(res, 'r2', '10.0.3.0/24');
  assert.equal(r2.proto, 'O E2');
  assert.equal(r2.metric, 20);

  // Vers RIP sans métrique : annoncé à 16, donc absent chez R3
  res = computeRouting(lab({ rip: { redistribute: { ospf: { process: 1 } } } }));
  assert.equal(route(res, 'r3', '10.0.2.0/24'), undefined);
  assert.match(issues(res), /dans RIP sans « metric » ni « default-metric »/);
  // … sauf avec default-metric
  res = computeRouting(lab({ rip: { redistribute: { ospf: { process: 1 } }, defaultMetric: 3 } }));
  assert.equal(route(res, 'r3', '10.0.2.0/24').metric, 3);
});

test('OSPF E1 : métrique externe + coût interne ; mauvais numéro de processus expliqué', () => {
  const res = computeRouting(lab({ ospf: { redistribute: { rip: { metric: 20, metricType: 1, subnets: true } } } }));
  const r2 = route(res, 'r2', '10.0.3.0/24');
  assert.equal(r2.proto, 'O E1');
  assert.equal(r2.metric, 21, '20 + coût du lien Gigabit (1)');
  const bad = computeRouting(lab({ rip: { redistribute: { ospf: { process: 2, metric: 1 } } } }));
  assert.match(issues(bad), /redistribute ospf 2.*le processus est 1/);
});

test('EIGRP : un autre protocole exige une métrique ; BGP : weight', () => {
  const doc = lab();
  const r1 = doc.devices.find((d) => d.id === 'r1');
  delete r1.config.rip;
  const r3 = doc.devices.find((d) => d.id === 'r3');
  r3.config = { ...r3.config, rip: undefined, eigrp: { asn: 10, networks: [{ network: '10.0.0.0' }] } };
  r1.config.eigrp = { asn: 10, networks: [{ network: '10.0.30.0', wildcard: '0.0.0.3' }], redistribute: { ospf: { process: 1 } } };
  let res = computeRouting(doc);
  assert.equal(route(res, 'r3', '10.0.2.0/24'), undefined);
  assert.match(issues(res), /dans EIGRP sans « metric » ni « default-metric »/);
  r1.config.eigrp.redistribute.ospf.metric = [100000, 100, 255, 1, 1500];
  res = computeRouting(doc);
  assert.equal(route(res, 'r3', '10.0.2.0/24').proto, 'D EX');
});

test('ip ospf network point-to-point : la loopback est annoncée avec son masque', () => {
  const doc = lab();
  const r1 = doc.devices.find((d) => d.id === 'r1');
  r1.config.interfaces.push({ link: null, name: 'Lo0', ip: '192.168.100.1', mask: 24 });
  r1.config.ospf.networks.push({ network: '192.168.100.0', wildcard: '0.0.0.255', area: 0 });
  assert.ok(route(computeRouting(doc), 'r2', '192.168.100.1/32'));
  r1.config.interfaces.at(-1).ospfNetwork = 'point-to-point';
  assert.ok(route(computeRouting(doc), 'r2', '192.168.100.0/24'));
});

test('terminal IOS : redistribute, default-metric, ip ospf network, neighbor weight, puis import du show run', () => {
  let doc = lab();
  const shell = shellFor(doc.devices.find((d) => d.id === 'r1'));
  const s = shell.newSession();
  const run = (line) => {
    const r = runLine(shell, s, line, doc.devices.find((d) => d.id === 'r1'), doc);
    if (r.device) doc = { ...doc, devices: doc.devices.map((d) => (d.id === 'r1' ? r.device : d)) };
    return r.output.join('\n');
  };
  ['enable', 'configure terminal'].forEach(run);
  assert.match(run('router ospf 1'), /^$/);
  assert.match(run('redistribute rip metric 20'), /Only classful networks will be redistributed/);
  run('redistribute bgp 100 metric 20 metric-type 1 subnets');
  run('exit');
  run('router rip');
  run('redistribute ospf 1 metric 2');
  run('default-metric 3');
  run('exit');
  run('router bgp 100');
  run('neighbor 10.0.10.2 remote-as 200');
  run('neighbor 10.0.10.2 weight 100');
  run('exit');
  run('interface g0/0');
  run('ip ospf network point-to-point');
  run('end');
  const text = run('show running-config');
  for (const l of [' redistribute rip metric 20', ' redistribute bgp 100 metric 20 metric-type 1 subnets', ' redistribute ospf 1 metric 2', ' default-metric 3', ' neighbor 10.0.10.2 weight 100', ' ip ospf network point-to-point']) {
    assert.ok(text.includes(`\n${l}\n`), `${l} absent de :\n${text}`);
  }
  // Import de ce show run sur un routeur vierge : rien d'ignoré, même config
  const r1 = doc.devices.find((d) => d.id === 'r1');
  const blank = { ...r1, config: { interfaces: r1.config.interfaces.map((i) => ({ link: i.link, name: i.name })), routes: [] } };
  const imported = importConfig(blank, { ...doc, devices: doc.devices.map((d) => (d.id === 'r1' ? blank : d)) }, text);
  assert.deepEqual(imported.ignored.filter((x) => !/bannière/.test(x.reason)), []);
  assert.deepEqual(imported.device.config.ospf.redistribute, r1.config.ospf.redistribute);
  assert.deepEqual(imported.device.config.rip.redistribute, r1.config.rip.redistribute);
});
