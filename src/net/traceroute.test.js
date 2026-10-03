import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BGP_DEMO, DEMO, OSPF_DEMO } from '../examples.js';
import { traceroute } from './traceroute.js';
import { runLine, shellFor } from '../cli/index.js';

const ips = (t) => t.hops.map((h) => h.ip);

test('traceroute : chaque routeur répond depuis son interface d\'entrée', () => {
  assert.deepEqual(ips(traceroute(OSPF_DEMO, 'pc1', '172.16.3.10')), ['192.168.1.1', '10.0.12.2', '10.0.23.2', '172.16.3.10']);
  // R3 répond depuis 10.0.23.2 : sa réponse va vers le PC (route BGP), même si le PC ne pourrait pas lui répondre
  assert.deepEqual(ips(traceroute(BGP_DEMO, 'pc1', '172.16.0.10')), ['192.168.1.1', '10.0.12.2', '10.0.23.2', '172.16.0.10']);
});

test('traceroute : étoiles quand la réponse ne revient pas, raison donnée', () => {
  const doc = structuredClone(DEMO);
  doc.devices.find((d) => d.id === 'r2').config.routes = [];
  const t = traceroute(doc, 'pc1', '172.16.0.10');
  assert.deepEqual(ips(t), ['192.168.10.1', null, null]);
  assert.equal(t.ok, false);
  assert.match(t.reason, /R2 : aucune route vers 192\.168\.10\.10/);
  // Destination inconnue : la trace s'arrête là où le paquet est perdu
  assert.deepEqual(ips(traceroute(DEMO, 'pc1', '8.8.8.8')), ['192.168.10.1', '10.0.0.2', null]);
});

test('traceroute dans les terminaux (IOS, Windows, RouterOS)', () => {
  const run = (doc, id, line) => {
    const dev = doc.devices.find((d) => d.id === id);
    const shell = shellFor(dev);
    const s = shell.newSession();
    if (shell.prompt(s, dev).endsWith('>') && !shell.prompt(s, dev).startsWith('C:') && !shell.prompt(s, dev).startsWith('[')) runLine(shell, s, 'enable', dev, doc);
    return runLine(shell, s, line, dev, doc).output.join('\n');
  };
  assert.match(run(OSPF_DEMO, 'r1', 'traceroute 172.16.3.10'), /Tracing the route to 172\.16\.3\.10\n\n {2}1 10\.0\.12\.2 0 msec 0 msec 0 msec\n {2}2 10\.0\.23\.2 0 msec/);
  assert.match(run(OSPF_DEMO, 'pc1', 'tracert 203.0.113.2'), /Tracing route to 203\.0\.113\.2 over a maximum of 30 hops:\n\n {2}1 {3}<1 ms {5}<1 ms {5}<1 ms {5}192\.168\.1\.1\n[\s\S]*Trace complete\./);
  assert.match(run(OSPF_DEMO, 'r3', '/tool traceroute 192.168.1.10'), / 1 10\.0\.23\.1\s+0%\s+3 0\.5ms\n 2 10\.0\.12\.1/);
});
