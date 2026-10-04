import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DHCP_DEMO } from '../examples.js';
import { apipa, computeLeases, withLeases } from './dhcp.js';
import { simulatePing } from './simulate.js';
import { validate } from './validate.js';

const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const sub = (doc, name) => dev(doc, 'r1').config.interfaces.find((i) => i.name === name);
const lastError = (r) => r.log.findLast((l) => l.level === 'error')?.text ?? '';
const lease = (doc, id) => computeLeases(doc).leases.get(id);

test('dhcp : serveur sur le routeur, adresses exclues, relais vers un serveur', () => {
  assert.deepEqual(lease(DHCP_DEMO, 'pc1'), { ip: '192.168.10.10', mask: 24, gateway: '192.168.10.1', dns: '8.8.8.8', server: 'r1', pool: 'PROFS', start: 0, end: 86400 });
  assert.equal(lease(DHCP_DEMO, 'pc2').ip, '192.168.10.11');
  // VLAN 20 : relais G0/0.20 -> serveur 192.168.30.10, pool choisi selon l'adresse du relais
  assert.deepEqual(lease(DHCP_DEMO, 'pc3'), { ip: '192.168.20.2', mask: 24, gateway: '192.168.20.1', dns: '8.8.8.8', server: 'srv', relay: 'r1', pool: 'ELEVES', start: 0, end: 86400 });
  assert.deepEqual(validate(DHCP_DEMO), []);
  const r = simulatePing(DHCP_DEMO, 'pc1', '192.168.20.2');
  assert.ok(r.ok, lastError(r));
});

test('dhcp : sans ip helper-address, APIPA et explication', () => {
  const doc = structuredClone(DHCP_DEMO);
  delete sub(doc, 'G0/0.20').helperAddress;
  const eff = dev(withLeases(doc), 'pc3').config;
  assert.equal(eff.ip, apipa('pc3'));
  assert.match(eff.ip, /^169\.254\./);
  assert.match(eff.dhcpError, /R1 G0\/0\.20 n'a ni pool DHCP pour ce réseau ni « ip helper-address »/);
  const r = simulatePing(doc, 'pc3', '192.168.10.1');
  assert.match(lastError(r), /PC Élèves n'a pas obtenu d'adresse DHCP : .*Il s'est donné 169\.254\.\d+\.\d+ \(APIPA\), sans passerelle\./);
  assert.match(validate(doc).map((i) => i.text).join('\n'), /PC Élèves n'obtient pas d'adresse DHCP/);
});

test('dhcp : relais vers un serveur sans pool pour ce réseau', () => {
  const doc = structuredClone(DHCP_DEMO);
  dev(doc, 'srv').config.dhcp.pools[0].network = '192.168.21.0';
  assert.match(lease(doc, 'pc3').error, /le serveur Serveur DHCP n'a pas de pool pour le réseau 192\.168\.20\.0\/24 \(adresse du relais 192\.168\.20\.1\)/);
});

test('dhcp : relais vers une adresse injoignable', () => {
  const doc = structuredClone(DHCP_DEMO);
  sub(doc, 'G0/0.20').helperAddress = '10.9.9.9';
  assert.match(lease(doc, 'pc3').error, /R1 relaie vers 10\.9\.9\.9, mais aucun équipement actif n'a cette adresse/);
});

test('dhcp : pool épuisé', () => {
  const doc = structuredClone(DHCP_DEMO);
  dev(doc, 'r1').config.dhcp.excluded = [['192.168.10.1', '192.168.10.253']];
  assert.equal(lease(doc, 'pc1').ip, '192.168.10.254');
  assert.match(lease(doc, 'pc2').error, /le pool PROFS de R1 est épuisé/);
});

test('dhcp : mauvais VLAN, le PC tombe dans le VLAN des serveurs', () => {
  const doc = structuredClone(DHCP_DEMO);
  dev(doc, 'sw1').config.ports.find((p) => p.name === 'Fa0/1').vlan = 30;
  // Le serveur du VLAN 30 n'a pas de pool pour son propre réseau, et R1 G0/0.30 n'est pas relais
  assert.match(lease(doc, 'pc1').error, /R1 G0\/0\.30 n'a ni pool DHCP pour ce réseau ni « ip helper-address »/);
});

// Fait « vivre » le schéma : on enregistre les baux calculés, puis on avance le temps
const step = (doc, patch = {}) => {
  const next = { ...doc, ...patch, runtime: { ...doc.runtime, ...patch.runtime } };
  return { ...next, runtime: withLeases(next).runtime };
};

test('dhcp dans le temps : adresse conservée, renouvellement à mi-bail', () => {
  let doc = step(structuredClone(DHCP_DEMO));
  assert.deepEqual(doc.runtime.leases.pc1, { ip: '192.168.10.10', mask: 24, gateway: '192.168.10.1', dns: '8.8.8.8', server: 'r1', pool: 'PROFS', start: 0, end: 86400 });
  // Un nouveau client placé avant PC1 dans le schéma ne lui prend pas son adresse
  doc.devices.unshift({ ...structuredClone(dev(doc, 'pc2')), id: 'pc0', label: 'PC Profs 0' });
  doc.links.push({ id: 'h9', source: 'pc0', target: 'sw1', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/9' });
  dev(doc, 'sw1').config.ports.push({ link: 'h9', name: 'Fa0/9', mode: 'access', vlan: 10 });
  doc = step(doc);
  assert.equal(doc.runtime.leases.pc1.ip, '192.168.10.10');
  assert.equal(doc.runtime.leases.pc0.ip, '192.168.10.12');
  // Avant mi-bail : mêmes dates ; après : renouvelé
  doc = step(doc, { runtime: { time: 40000 } });
  assert.deepEqual([doc.runtime.leases.pc1.start, doc.runtime.leases.pc1.end], [0, 86400]);
  doc = step(doc, { runtime: { time: 50000 } });
  assert.deepEqual([doc.runtime.leases.pc1.start, doc.runtime.leases.pc1.end], [50000, 136400]);
});

test('dhcp dans le temps : un PC parti garde son adresse jusqu\'à expiration', () => {
  let doc = structuredClone(DHCP_DEMO);
  const pool = dev(doc, 'r1').config.dhcp.pools[0];
  pool.leaseTime = 3600;
  dev(doc, 'r1').config.dhcp.excluded = [['192.168.10.1', '192.168.10.252']]; // reste .253 et .254
  doc = step(doc);
  assert.deepEqual([doc.runtime.leases.pc1.ip, doc.runtime.leases.pc2.ip], ['192.168.10.253', '192.168.10.254']);
  // PC1 part (supprimé) ; un nouveau PC arrive : le pool est encore occupé par le bail de PC1
  doc.devices = doc.devices.filter((d) => d.id !== 'pc1');
  doc.links = doc.links.map((l) => (l.id === 'h1' ? { ...l, source: 'pc4' } : l));
  doc.devices.push({ ...structuredClone(dev(doc, 'pc2')), id: 'pc4', label: 'PC Nouveau' });
  doc = step(doc, { runtime: { time: 1800 } });
  assert.match(lease(doc, 'pc4').error, /le pool PROFS de R1 est épuisé/);
  assert.equal(doc.runtime.leases.pc1.ip, '192.168.10.253'); // bail fantôme
  // Une fois le bail expiré, l'adresse est libérée
  doc = step(doc, { runtime: { time: 3601 } });
  assert.equal(lease(doc, 'pc4').ip, '192.168.10.253');
  assert.equal(doc.runtime.leases.pc1, undefined);
});

test('dhcp : ipconfig /release puis /renew', () => {
  let doc = step(structuredClone(DHCP_DEMO));
  doc = step(doc, { runtime: { released: ['pc1'] } });
  const eff = dev(withLeases(doc), 'pc1').config;
  assert.equal(eff.ip, null);
  assert.match(eff.dhcpError, /ipconfig \/release/);
  assert.equal(doc.runtime.leases.pc1, undefined);
  doc = step(doc, { runtime: { released: [] } });
  assert.equal(doc.runtime.leases.pc1.ip, '192.168.10.10');
});
