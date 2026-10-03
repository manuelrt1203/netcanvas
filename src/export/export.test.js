import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO } from '../examples.js';
import { ciscoBundle, ciscoConfigs, c7200Port, hostname, iosInterfaceName } from './cisco.js';
import { toCsv } from './csv.js';
import { toDrawio } from './drawio.js';
import { toContainerlab } from './containerlab.js';
import { toSvg } from './svg.js';
import { FORMATS, fileName } from './index.js';

const clone = () => structuredClone(DEMO);
const config = (configs, id) => configs.find((c) => c.id === id);
const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const count = (s, re) => (s.match(re) ?? []).length;

test('cisco : noms d\'interfaces et d\'hôtes', () => {
  assert.equal(iosInterfaceName('G0/1'), 'GigabitEthernet0/1');
  assert.equal(iosInterfaceName('fa 0/24'), 'FastEthernet0/24');
  assert.equal(iosInterfaceName('Se0/0/0'), 'Serial0/0/0');
  assert.equal(iosInterfaceName('eth0'), null);
  assert.equal(hostname('SW Étage', 'switch'), 'SW-Etage');
  assert.equal(hostname('2e étage', 'router'), 'R-2e-etage');
  assert.equal(hostname('???', 'switch'), 'SW');
  assert.deepEqual(c7200Port(2), { adapter: 1, port: 0, name: 'FastEthernet1/0' });
});

test('cisco Packet Tracer : config complète de la démo, sans avertissement', () => {
  const configs = ciscoConfigs(clone());
  assert.deepEqual(configs.flatMap((c) => c.warnings), []);

  const r1 = config(configs, 'r1').text;
  assert.match(r1, /^hostname R1$/m);
  assert.match(r1, /^! R1 : Cisco 2911\n! Modules a installer d'abord .* : HWIC-2T dans le slot 0$/m);
  assert.match(r1, /interface Serial0\/0\/0\n description Vers R2 Se0\/0\/0\n ip address 10\.0\.0\.1 255\.255\.255\.252\n clock rate 64000\n no shutdown/);
  // Côté DTE : pas de clock rate
  assert.doesNotMatch(config(configs, 'r2').text, /clock rate/);
  assert.match(r1, /^ip route 0\.0\.0\.0 0\.0\.0\.0 10\.0\.0\.2$/m);
  assert.match(r1, /^write memory$/m);

  const sw1 = config(configs, 'sw1').text;
  assert.match(sw1, /^vlan 10\n name VLAN10/m);
  assert.match(sw1, /interface FastEthernet0\/3\n description Vers PC Atelier Fa0\n switchport mode access\n switchport access vlan 20/);
  // VLAN 1 : pas de ligne « access vlan » inutile
  assert.doesNotMatch(config(configs, 'sw2').text, /access vlan/);

  assert.match(config(configs, 'pc1').text, /Subnet Mask {5}: 255\.255\.255\.0/);
});

test('cisco Packet Tracer : avertissements (modèle générique, clock rate, IP manquante)', () => {
  const doc = clone();
  dev(doc, 'sw2').model = 'Switch-PT';
  delete dev(doc, 'r1').config.interfaces.find((i) => i.link === 'l6').clockRate;
  doc.devices.push({ id: 'pc9', type: 'pc', model: 'PC-PT', label: 'PC9', position: { x: 0, y: 0 }, config: { ip: null, mask: null, gateway: null } });
  doc.links.push({ id: 'l10', source: 'pc9', target: 'sw1', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/5' });

  const configs = ciscoConfigs(doc);
  assert.match(config(configs, 'sw2').warnings.join(), /Switch générique : choisis un modèle Cisco/);
  assert.match(config(configs, 'r1').warnings.join(), /Serial0\/0\/0 est le côté DCE .* pas de clock rate/);
  assert.match(config(configs, 'pc9').warnings.join(), /pas d'adresse IP/);
  assert.match(ciscoBundle(doc), /^! ATTENTION : Serial0\/0\/0 est le cote DCE/m);
});

test('export MikroTik : script RouterOS dans les fichiers Packet Tracer et GNS3', () => {
  const doc = clone();
  doc.devices.push({ id: 'mk', type: 'router', model: 'RB4011', label: 'MK', position: { x: 0, y: 0 },
    config: { interfaces: [{ link: 'lm', name: 'ether1', ip: '172.16.0.20', mask: 24 }], routes: [{ network: '0.0.0.0', mask: 0, nextHop: '172.16.0.1' }] } });
  doc.links.push({ id: 'lm', source: 'mk', target: 'sw2', cable: 'straight', sourceIface: 'ether1', targetIface: 'Fa0/2' });

  const pt = ciscoConfigs(doc).find((c) => c.id === 'mk');
  assert.equal(pt.kind, 'routeros');
  assert.match(pt.warnings[0], /n'existe pas dans Packet Tracer/);
  assert.match(pt.text, /^\/ip address\nadd address=172\.16\.0\.20\/24 interface=ether1 network=172\.16\.0\.0$/m);
  assert.match(pt.text, /^add dst-address=0\.0\.0\.0\/0 gateway=172\.16\.0\.1$/m);
  // Dans le fichier unique, le script n'est pas commenté (on le colle tel quel)
  assert.match(ciscoBundle(doc, 'gns3'), /^# GNS3 : appliance MikroTik CHR.*\n# NetCanvas : export RouterOS$/m);
  assert.deepEqual(ciscoConfigs(doc, { target: 'gns3' }).find((c) => c.id === 'mk').warnings, []);
});

test('cisco : trunk et noms en double', () => {
  const doc = clone();
  dev(doc, 'sw1').config.ports[3] = { link: 'l4', name: 'Fa0/23', mode: 'trunk' };
  doc.devices.find((d) => d.id === 'r2').label = 'R1';
  const configs = ciscoConfigs(doc);
  assert.match(config(configs, 'sw1').text, /interface FastEthernet0\/23\n description Vers R1 G0\/0\n switchport mode trunk\n exit/);
  assert.equal(config(configs, 'r2').name, 'R1-2');
});

test('cisco GNS3 : interfaces c7200, switch intégré, VPCS', () => {
  const configs = ciscoConfigs(clone(), { target: 'gns3' });
  const r2 = config(configs, 'r2').text;
  assert.match(r2, /interface FastEthernet0\/0\n description Vers R1 FastEthernet1\/0\n/);
  assert.match(r2, /interface FastEthernet1\/0\n description Vers Internet e0\n ip address 203\.0\.113\.1/);
  assert.doesNotMatch(r2, /write memory|configure terminal/);

  const sw1 = config(configs, 'sw1');
  assert.equal(sw1.kind, 'manual');
  assert.match(sw1.text, /^2 {5}access {2}20 {4}PC Atelier e0$/m);
  assert.match(config(configs, 'pc1').text, /^ip 192\.168\.10\.10 192\.168\.10\.1 24$/m);

  // Dans le fichier unique, tout ce qui n'est pas de l'IOS est en commentaire
  const bundle = ciscoBundle(clone(), 'gns3');
  assert.match(bundle, /^! set pcname PC-Compta$/m);
  assert.doesNotMatch(bundle, /^(?!!)[^\n]*switch Ethernet/m);
});

test('csv : plan d\'adressage lisible par Excel', () => {
  const doc = clone();
  doc.devices.find((d) => d.id === 'pc1').label = 'PC "Compta"; RDC';
  const csv = toCsv(doc);
  assert.ok(csv.startsWith('\ufeffÉquipement;Modèle;Interface;'));
  assert.ok(csv.split('\r\n')[0].endsWith(';Relié à;Câble'));
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 1 + 18); // en-tête + une ligne par interface
  assert.equal(lines[1], '"PC ""Compta""; RDC";PC;Fa0;192.168.10.10;255.255.255.0;/24;192.168.10.0/24;192.168.10.1;10;;SW Étage Fa0/1;Droit');
  assert.ok(lines.includes('R1;Cisco 2911;Se0/0/0;10.0.0.1;255.255.255.252;/30;10.0.0.0/30;;;;R2 Se0/0/0;Série'));
  assert.ok(lines.includes('SW Étage;Cisco 2960-24TT;Fa0/23;;;;;;10;access;R1 G0/0;Droit'));

  // Câble hors service signalé dans le plan
  dev(doc, 'r1').config.interfaces.find((i) => i.link === 'l6').clockRate = null;
  assert.match(toCsv(doc), /;R2 Se0\/0\/0;Série \(hors service\)\r\n/);
});

test('csv : hôte sans câble présent dans le plan', () => {
  const doc = clone();
  doc.devices.push({ id: 'x', type: 'server', label: 'NAS', position: { x: 0, y: 0 }, config: { ip: '10.1.1.1', mask: 24, gateway: null } });
  assert.match(toCsv(doc), /\r\nNAS;Serveur;Fa0;10\.1\.1\.1;255\.255\.255\.0;\/24;10\.1\.1\.0\/24;;;;;\r\n$/);
});

test('draw.io : un nœud par équipement, un câble par lien, texte échappé', () => {
  const doc = clone();
  doc.devices.find((d) => d.id === 'srv').label = 'Web <prod> & co';
  const xml = toDrawio(doc);
  assert.equal(count(xml, /<mxCell id="n-/g), doc.devices.length);
  assert.equal(count(xml, /edge="1"/g), doc.links.length);
  assert.match(xml, /shape=mxgraph\.cisco\.routers\.router/);
  assert.match(xml, /value="&lt;b&gt;Web &amp;lt;prod&amp;gt; &amp;amp; co&lt;\/b&gt;/);
  assert.match(xml, /<mxCell id="e-l4"[^>]*value="VLAN 10"/);
  assert.doesNotMatch(xml, /<b>|<prod>/);
});

test('containerlab : nœuds, câbles et commandes', () => {
  const yml = toContainerlab(clone());
  assert.match(yml, /^name: demo-2-vlan-2-routeurs$/m);
  assert.match(yml, /^ {4}sw-etage:\n {6}labels: \{ netcanvas-type: switch, netcanvas-label: "SW Étage" \}/m);
  assert.match(yml, /^ {4}- endpoints: \["r1:eth3", "r2:eth1"\]$/m);
  assert.equal(count(yml, /- endpoints:/g), clone().links.length);
  assert.match(yml, /"bridge vlan add vid 20 dev eth3 pvid untagged"/);
  assert.match(yml, /"ip route replace 192\.168\.0\.0\/16 via 10\.0\.0\.1"/);
  assert.match(yml, /net\.ipv4\.ip_forward: 1/);
});

test('svg : image autonome avec tous les équipements', () => {
  const doc = clone();
  doc.name = 'Réseau <test>';
  const svg = toSvg(doc);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+" viewBox="-?\d+ -?\d+ \d+ \d+">/);
  assert.equal(count(svg, /<g data-id=/g), doc.devices.length);
  assert.equal(count(svg, /<line /g), doc.links.length);
  assert.match(svg, /<title>Réseau &lt;test&gt;<\/title>/);
  assert.match(svg, />VLAN 10, 20</);
  assert.match(svg, />10\.0\.0\.1\/30</);
  assert.equal(toSvg({ ...doc, devices: [], links: [] }).includes('width="200"'), true);
});

test('catalogue : chaque format produit un fichier non vide', () => {
  const doc = clone();
  for (const f of FORMATS) assert.ok(f.build(doc).length > 100, f.id);
  assert.equal(fileName(doc, FORMATS.find((f) => f.id === 'containerlab')), 'Demo_2_VLAN_2_routeurs.clab.yml');
});
