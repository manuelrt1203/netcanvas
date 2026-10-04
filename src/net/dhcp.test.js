import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DHCP_DEMO } from '../examples.js';
import { apipa, computeLeases, withLeases } from './dhcp.js';
import { simulatePing } from './simulate.js';
import { validate } from './validate.js';

const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const sub = (doc, name) => dev(doc, 'r1').config.interfaces.find((i) => i.name === name);
const lastError = (r) => r.log.findLast((l) => l.level === 'error')?.text ?? '';
const lease = (doc, id) => computeLeases(doc).get(id);

test('dhcp : serveur sur le routeur, adresses exclues, relais vers un serveur', () => {
  assert.deepEqual(lease(DHCP_DEMO, 'pc1'), { ip: '192.168.10.10', mask: 24, gateway: '192.168.10.1', dns: '8.8.8.8', server: 'r1', pool: 'PROFS' });
  assert.equal(lease(DHCP_DEMO, 'pc2').ip, '192.168.10.11');
  // VLAN 20 : relais G0/0.20 -> serveur 192.168.30.10, pool choisi selon l'adresse du relais
  assert.deepEqual(lease(DHCP_DEMO, 'pc3'), { ip: '192.168.20.2', mask: 24, gateway: '192.168.20.1', dns: '8.8.8.8', server: 'srv', relay: 'r1', pool: 'ELEVES' });
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
