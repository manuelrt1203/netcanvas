// Politique BGP : route-maps, préférence locale, MED, weight, boucle de redistribution, RIB-failure.
// Petits réseaux construits ici (pas de TP de cours) ; les commandes sont tapées dans le terminal IOS comme le ferait un étudiant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLine, shellFor } from '../cli/index.js';
import { computeRouting } from './routing.js';
import { applyRouteMap } from './routemap.js';
import { evaluateExercise } from './exercise.js';

const PORTS = ['G0/0', 'G0/1', 'G0/2'];
// routers : ['R1', ...] ; links : [['R1', 'R2'], ...] -> 10.0.<n>.0/24, premier = .1, second = .2
function network(routers, links) {
  const used = Object.fromEntries(routers.map((r) => [r, 0]));
  const devices = routers.map((r, i) => ({ id: r.toLowerCase(), type: 'router', model: '2911', label: r, position: { x: i * 100, y: 0 }, config: { interfaces: [], routes: [] } }));
  const doc = { format: 'netcanvas', version: 3, name: 'test', devices, links: [] };
  links.forEach(([a, b], n) => {
    const id = `l${n + 1}`;
    const [pa, pb] = [PORTS[used[a]++], PORTS[used[b]++]];
    doc.devices.find((d) => d.label === a).config.interfaces.push({ link: id, name: pa, ip: `10.0.${n + 1}.1`, mask: 24 });
    doc.devices.find((d) => d.label === b).config.interfaces.push({ link: id, name: pb, ip: `10.0.${n + 1}.2`, mask: 24 });
    doc.links.push({ id, source: a.toLowerCase(), target: b.toLowerCase(), cable: 'cross', sourceIface: pa, targetIface: pb });
  });
  return doc;
}
// Terminal sur un routeur : applique les commandes au document partagé
function terminal(state, label) {
  const shell = shellFor(state.doc.devices.find((d) => d.label === label));
  const s = shell.newSession();
  return (...lines) => {
    const out = [];
    for (const line of lines) {
      const dev = state.doc.devices.find((d) => d.label === label);
      const r = runLine(shell, s, line, dev, state.doc);
      if (r.device) state.doc = { ...state.doc, devices: state.doc.devices.map((d) => (d.label === label ? { ...r.device, label: d.label } : d)) };
      out.push(...r.output);
    }
    return out.join('\n');
  };
}
const ip = (n, host) => `10.0.${n}.${host}`;
const bgpRow = (text, prefix) => text.split('\n').filter((l) => l.includes(prefix) || /^ {18,}\d/.test(l) || /^[ *>ri]{3} {17}\d/.test(l));
const rib = (state, label) => computeRouting(state.doc).routers.get(state.doc.devices.find((d) => d.label === label).id);

// Dest (AS 9) annonce 192.0.2.0/24 à Ra (AS 10) et Rb (AS 11) ; R1 (AS 1, relié à Ra) et R3 (AS 1, relié à Rb) sont en iBGP.
function lab() {
  const state = { doc: network(['Rd', 'Ra', 'Rb', 'R1', 'R3'], [['Rd', 'Ra'], ['Rd', 'Rb'], ['Ra', 'R1'], ['Rb', 'R3'], ['R1', 'R3']]) };
  const rd = state.doc.devices.find((d) => d.label === 'Rd');
  rd.config.interfaces.push({ link: 'x', name: 'Lo0', ip: '192.0.2.1', mask: 24, loopback: true });
  const t = Object.fromEntries(['Rd', 'Ra', 'Rb', 'R1', 'R3'].map((r) => [r, terminal(state, r)]));
  const bgp = (r, asn, ...lines) => t[r]('en', 'conf t', `router bgp ${asn}`, ...lines, 'end');
  bgp('Rd', 9, `neighbor ${ip(1, 2)} remote-as 10`, `neighbor ${ip(2, 2)} remote-as 11`, 'network 192.0.2.0 mask 255.255.255.0');
  bgp('Ra', 10, `neighbor ${ip(1, 1)} remote-as 9`, `neighbor ${ip(3, 2)} remote-as 1`);
  bgp('Rb', 11, `neighbor ${ip(2, 1)} remote-as 9`, `neighbor ${ip(4, 2)} remote-as 1`);
  bgp('R1', 1, `neighbor ${ip(3, 1)} remote-as 10`, `neighbor ${ip(5, 2)} remote-as 1`, `neighbor ${ip(5, 2)} next-hop-self`);
  bgp('R3', 1, `neighbor ${ip(4, 1)} remote-as 11`, `neighbor ${ip(5, 1)} remote-as 1`, `neighbor ${ip(5, 1)} next-hop-self`);
  return { state, t, bgp };
}

test('sans politique : chaque routeur de l\'AS 1 garde son chemin eBGP (même AS_PATH, eBGP avant iBGP)', () => {
  const { state, t } = lab();
  const r1 = t.R1('en', 'show ip bgp');
  assert.match(r1, /^\*> 192\.0\.2\.0\/24\s+10\.0\.3\.1 .* 0 10 9 i$/m);
  assert.match(r1, /^\* i {17}10\.0\.5\.2 .* 100 .* 0 11 9 i$/m);
  assert.equal(rib(state, 'R1').bgp.routes.find((r) => r.net === 3221225984)?.nextHop ?? '10.0.3.1', '10.0.3.1');
});

test('route-map « set local-preference » en entrée : toute l\'AS suit R3 (préférence locale 200)', () => {
  const { state, t, bgp } = lab();
  t.R3('en', 'conf t', 'route-map PREFER-B permit 10', 'set local-preference 200', 'exit', 'end');
  bgp('R3', 1, `neighbor ${ip(4, 1)} route-map PREFER-B in`);
  const r3 = t.R3('show ip bgp');
  assert.match(r3, /^\*> 192\.0\.2\.0\/24\s+10\.0\.4\.1 .* 200 .* 0 11 9 i$/m);
  // R1 reçoit la préférence locale par iBGP et préfère ce chemin à son eBGP ; la route IGP/RIB reste BGP (aucune autre source)
  const r1 = t.R1('show ip bgp');
  assert.match(r1, /^\*>i192\.0\.2\.0\/24\s+10\.0\.5\.2 .* 200 .* 0 11 9 i$/m);
  assert.match(r1, /^\* {19}10\.0\.3\.1 .* 0 10 9 i$/m);
  assert.match(t.R3('show route-map PREFER-B'), /local-preference 200/);
});

test('route-map : refus (deny), correspondance sur une ACL, prepend de l\'AS_PATH', () => {
  const { state, t, bgp } = lab();
  t.R1('en', 'conf t', 'access-list 10 permit 192.0.2.0 0.0.0.255', 'route-map NO-DEST deny 10', 'match ip address 10', 'route-map NO-DEST permit 20', 'exit', 'end');
  bgp('R1', 1, `neighbor ${ip(3, 1)} route-map NO-DEST in`);
  assert.doesNotMatch(t.R1('show ip bgp'), /10\.0\.3\.1/);
  // prepend : l'AS_PATH s'allonge, ce qui détourne le trafic
  t.R1('en', 'conf t', 'no route-map NO-DEST', 'route-map LONG permit 10', 'set as-path prepend 1 1', 'exit', 'end');
  bgp('R1', 1, `no neighbor ${ip(3, 1)} route-map NO-DEST in`, `neighbor ${ip(3, 1)} route-map LONG in`);
  assert.match(t.R1('show ip bgp'), /^\*>i192\.0\.2\.0\/24\s+10\.0\.5\.2 .* 0 11 9 i$/m);
  assert.match(t.R1('show ip bgp'), /^\* {19}10\.0\.3\.1 .* 0 1 1 10 9 i$/m);
});

test('weight : prime sur tout, local au routeur (pas transmis en iBGP)', () => {
  const { state, t, bgp } = lab();
  bgp('R1', 1, `neighbor ${ip(5, 2)} weight 500`);
  assert.match(t.R1('show ip bgp'), /^\*>i192\.0\.2\.0\/24\s+10\.0\.5\.2\s+0\s+100\s+500 11 9 i$/m);
  assert.match(t.R3('show ip bgp'), /^\*> 192\.0\.2\.0\/24\s+10\.0\.4\.1 .* 0 11 9 i$/m); // R3 n'a pas hérité du weight
});

test('RIB-failure : une route statique (distance 1) garde la table de routage, BGP marque « r »', () => {
  const { state, t, bgp } = lab();
  t.R1('en', 'conf t', `ip route 192.0.2.0 255.255.255.0 ${ip(3, 2)}`, 'end');
  assert.match(t.R1('show ip bgp'), /^r>?\s?.*192\.0\.2\.0\/24/m);
  assert.match(t.R1('show ip route 192.0.2.0'.replace(' 192.0.2.0', '')), /^S .*192\.0\.2\.0/m);
});

test('show running-config reprend les route-maps et les options du voisin', () => {
  const { t } = lab();
  t.R3('en', 'conf t', 'route-map PREFER-B permit 10', 'match tag 7', 'set local-preference 200', 'set metric 5', 'exit', 'end');
  const run = t.R3('show running-config');
  assert.match(run, /route-map PREFER-B permit 10\n match tag 7\n set local-preference 200\n set metric 5/);
});

test('applyRouteMap : première clause qui correspond, refus implicite en fin de liste', () => {
  const dev = { config: { acls: { 5: { type: 'standard', rules: [{ action: 'permit', src: { ip: '10.0.0.0', wildcard: '0.0.255.255' } }] } }, routeMaps: { M: [
    { seq: 10, action: 'deny', match: { tag: [200] }, set: {} },
    { seq: 20, action: 'permit', match: { acl: ['5'] }, set: { localPref: 150, tag: 9 } },
  ] } } };
  const net = (a, b, c) => ((a << 24) | (b << 16) | (c << 8)) >>> 0;
  assert.equal(applyRouteMap(dev, 'M', { net: net(10, 0, 1), mask: 24, tag: 200 }).permitted, false);
  const ok = applyRouteMap(dev, 'M', { net: net(10, 0, 1), mask: 24 });
  assert.deepEqual([ok.permitted, ok.route.localPref, ok.route.tag], [true, 150, 9]);
  assert.equal(applyRouteMap(dev, 'M', { net: net(11, 0, 1), mask: 24 }).permitted, false); // ni la clause 10 ni la 20 : refus implicite
  assert.equal(applyRouteMap(dev, 'ABSENTE', { net: 0, mask: 0 }).missing, true);
});

test('objectifs BGP : chemin préféré et attribut du meilleur chemin', () => {
  const { state, t, bgp } = lab();
  const check = (objective) => evaluateExercise({ ...state.doc, exercise: { title: 't', instructions: '', objectives: [{ id: 'o', ...objective }] } })[0];
  const id = (l) => state.doc.devices.find((d) => d.label === l).id;
  assert.equal(check({ type: 'bgpBest', router: id('R1'), to: '192.0.2.0/24', via: ip(3, 1) }).ok, true);
  const before = check({ type: 'bgpBest', router: id('R1'), to: '192.0.2.0/24', via: ip(5, 2) });
  assert.equal(before.ok, false);
  assert.match(before.why, /10\.0\.3\.1/);
  t.R3('en', 'conf t', 'route-map P permit 10', 'set local-preference 200', 'exit', 'end');
  bgp('R3', 1, `neighbor ${ip(4, 1)} route-map P in`);
  assert.equal(check({ type: 'bgpBest', router: id('R1'), to: '192.0.2.0/24', via: ip(5, 2) }).ok, true);
  assert.equal(check({ type: 'bgpAttr', router: id('R1'), to: '192.0.2.0/24', attr: 'local-pref', value: '200' }).ok, true);
  assert.equal(check({ type: 'bgpAttr', router: id('R1'), to: '192.0.2.0/24', attr: 'med', value: '0' }).ok, true);
  assert.match(check({ type: 'bgpAttr', router: id('R1'), to: '192.0.2.0/24', attr: 'couleur', value: '1' }).why, /Attribut inconnu/);
});

test('filtres de sortie IOS : include, exclude, begin, section ; commandes de détail', () => {
  const { t } = lab();
  const inc = t.R1('en', 'show ip bgp | include 192.0.2');
  assert.equal(inc.split('\n').filter(Boolean).length, 1); // le réseau n'est écrit que sur la première ligne de ses chemins
  assert.match(inc, /^\*> 192\.0\.2\.0\/24/);
  assert.doesNotMatch(t.R1('show ip bgp | exclude Status|Origin|codes'), /Status codes/);
  assert.match(t.R1('show ip bgp | begin Network'), /^ {3}Network/);
  const sec = t.R1('show running-config | section router bgp');
  assert.match(sec, /^router bgp 1\n bgp log-neighbor-changes\n neighbor 10\.0\.3\.1 remote-as 10/);
  assert.doesNotMatch(sec, /interface/);
  assert.match(t.R1('show ip route 10.0.3.1'), /^Routing entry for 10\.0\.3\.0\/24\n {2}Known via "connected"/);
  const detail = t.R1('show ip bgp 192.0.2.0');
  assert.match(detail, /Paths: \(2 available, best #1, table Default-IP-Routing-Table\)/);
  assert.match(detail, /Origin IGP, metric 0, localpref 100, valid, external, best/);
  assert.match(t.R1('show ip bgp neighbors 10.0.3.1'), /BGP state = Established/);
  assert.equal(t.R1('clear ip bgp *', 'clear ip bgp * soft', 'clear ip bgp 10.0.3.1 out'), '');
});

test('EIGRP « network 0.0.0.0 » seul (forme de show run) couvre toutes les interfaces', () => {
  const state = { doc: network(['Ra', 'Rb'], [['Ra', 'Rb']]) };
  for (const r of ['Ra', 'Rb']) terminal(state, r)('en', 'conf t', 'router eigrp 10', 'network 0.0.0.0', 'end');
  const id = (l) => state.doc.devices.find((d) => d.label === l).id;
  const res = evaluateExercise({ ...state.doc, exercise: { title: 't', instructions: '', objectives: [{ id: 'o', type: 'eigrp', a: id('Ra'), b: id('Rb') }] } })[0];
  assert.equal(res.ok, true);
});

test('prefix-list : création, correspondance dans une route-map, show run', () => {
  const { t, bgp } = lab();
  assert.match(t.R1('en', 'conf t', 'ip prefix-list DEST seq 5 permit 192.0.2.0/24', 'ip prefix-list DEST seq 10 permit 198.51.100.0/24 le 28', 'end', 'show ip prefix-list DEST'), /ip prefix-list DEST: 2 entries\n {3}seq 5 permit 192\.0\.2\.0\/24\n {3}seq 10 permit 198\.51\.100\.0\/24 le 28/);
  assert.match(t.R1('conf t', 'ip prefix-list BAD permit 300.0.0.0/8'), /Invalid input/);
  t.R1('conf t', 'route-map NODEST deny 10', 'match ip address prefix-list DEST', 'route-map NODEST permit 20', 'exit', 'end');
  bgp('R1', 1, `neighbor ${ip(3, 1)} route-map NODEST in`);
  assert.doesNotMatch(t.R1('show ip bgp'), /10\.0\.3\.1/);
  assert.match(t.R1('show running-config | include prefix-list'), /ip prefix-list DEST seq 5 permit 192\.0\.2\.0\/24/);
  t.R1('conf t', 'no ip prefix-list DEST seq 5', 'end');
  assert.match(t.R1('show running-config | include prefix-list'), /seq 10 permit 198\.51\.100\.0\/24 le 28/);
});
