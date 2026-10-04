import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, NAT_DEMO, ROAS_DEMO } from '../examples.js';
import { simulatePing } from './simulate.js';
import { macCisco, macOf } from './mac.js';

const field = (frame, layer, name) => frame.layers.find((l) => l.name === layer)?.fields.find(([k]) => k === name)?.[1];
const dev = (doc, id) => doc.devices.find((d) => d.id === id);

test('pas à pas : ARP puis ICMP, MAC réécrites et TTL décrémenté au routeur', () => {
  const r = simulatePing(structuredClone(DEMO), 'pc1', '192.168.20.10');
  assert.deepEqual(r.frames.map((f) => f.kind), [
    'arp-request', 'arp-reply', 'arp-reply', 'icmp', 'icmp', // PC -> R1 (requête ARP diffusée sur le VLAN 10)
    'arp-request', 'arp-reply', 'arp-reply', 'icmp', 'icmp', // R1 -> PC Atelier
    'icmp', 'icmp', 'icmp', 'icmp', // retour : tout est déjà en cache
    'done',
  ]);
  const [req, , , first, , , , , out] = r.frames;
  assert.equal(req.hops.length, 3, 'la diffusion atteint PC Compta 2 et R1');
  assert.equal(field(req, 'Ethernet II', 'MAC destination'), 'ffff.ffff.ffff');
  assert.equal(field(req, 'ARP', 'IP cible'), '192.168.10.1');
  assert.equal(field(first, 'Ethernet II', 'MAC destination'), macCisco(macOf(dev(DEMO, 'r1'), 'G0/0')));
  assert.equal(field(first, 'IPv4', 'TTL'), '64');
  assert.equal(field(out, 'Ethernet II', 'MAC source'), macCisco(macOf(dev(DEMO, 'r1'), 'G0/1')));
  assert.equal(field(out, 'IPv4', 'TTL'), '63');
  assert.equal(field(out, 'IPv4', 'Source'), '192.168.10.10');
  assert.ok(req.notes.some((n) => /envoi à la passerelle 192\.168\.10\.1/.test(n.text)));
});

test('pas à pas : trame étiquetée 802.1Q sur le trunk (router-on-a-stick)', () => {
  const r = simulatePing(structuredClone(ROAS_DEMO), 'pc1', '192.168.20.10');
  const tagged = r.frames.filter((f) => f.kind === 'icmp' && f.layers.some((l) => l.name === '802.1Q'));
  assert.deepEqual(tagged.map((f) => [f.phase, field(f, '802.1Q', 'VLAN')]), [['request', '10'], ['request', '20'], ['reply', '20'], ['reply', '10']]);
});

test('pas à pas : liaison série en HDLC, NAT visible dans les en-têtes, trame perdue', () => {
  const serial = simulatePing(structuredClone(DEMO), 'pc1', '172.16.0.10').frames.find((f) => f.layers[0]?.name === 'HDLC');
  assert.ok(serial && !serial.layers.some((l) => l.name === 'Ethernet II'));

  const nat = simulatePing(structuredClone(NAT_DEMO), 'pc1', '198.51.100.10');
  const sources = [...new Set(nat.frames.filter((f) => f.kind === 'icmp' && f.phase === 'request').map((f) => field(f, 'IPv4', 'Source')))];
  assert.equal(sources.length, 2, 'adresse privée puis adresse publique après le NAT');
  assert.equal(sources[0], '192.168.1.10');

  const lost = simulatePing(structuredClone(DEMO), 'pc1', '10.99.0.1');
  const last = lost.frames.at(-1);
  assert.equal(last.kind, 'drop');
  assert.match(last.notes.at(-1).text, /aucune route vers 10\.99\.0\.1/);
});
