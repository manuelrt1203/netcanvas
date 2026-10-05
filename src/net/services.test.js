import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES_DEMO, DHCP_DEMO, DEMO } from '../examples.js';
import { httpGet, resolveName } from './services.js';
import { simulatePing } from './simulate.js';

const dev = (doc, id) => doc.devices.find((d) => d.id === id);
const lastError = (r) => r.log.findLast((l) => l.level === 'error')?.text;

test('DNS : résolution par le serveur, requête UDP 53 sur le vrai chemin', () => {
  const r = resolveName(SERVICES_DEMO, 'pc1', 'www.entreprise.lan');
  assert.equal(r.ok, true);
  assert.equal(r.ip, '172.16.0.10');
  assert.equal(r.query.frames.find((f) => f.kind === 'udp').layers.find((l) => l.name === 'UDP').fields[1][1], '53');
  assert.deepEqual(r.query.frames.find((f) => f.kind === 'udp' && f.phase === 'reply').layers.at(-1).fields[0], ['Réponse', 'www.entreprise.lan A 172.16.0.10']);
  assert.equal(r.log.at(-1).text, 'Serveur Web répond : www.entreprise.lan = 172.16.0.10.');
  // Majuscules et point final ignorés
  assert.equal(resolveName(SERVICES_DEMO, 'pc1', 'WWW.Entreprise.LAN.').ip, '172.16.0.10');
});

test('DNS : nom inconnu, pas de serveur, serveur sans service DNS', () => {
  assert.match(lastError(resolveName(SERVICES_DEMO, 'pc1', 'mail.entreprise.lan')), /ne connaît pas mail\.entreprise\.lan \(NXDOMAIN\)/);
  assert.match(lastError(resolveName(DEMO, 'pc1', 'www.entreprise.lan')), /PC Compta : aucun serveur DNS configuré/);
  const off = structuredClone(SERVICES_DEMO);
  dev(off, 'srv').config.services.dns.enabled = false;
  assert.match(lastError(resolveName(off, 'pc1', 'www.entreprise.lan')), /aucun service n'écoute sur UDP 53 \(serveur DNS\) : il répond « port injoignable »/);
});

test('DNS : serveur reçu par DHCP (bail)', () => {
  const doc = structuredClone(DHCP_DEMO);
  const r = resolveName(doc, 'pc1', 'www.exemple.fr');
  // 8.8.8.8 donné par le bail, injoignable dans cette démo : l'erreur le dit
  assert.equal(r.ok, false);
  assert.match(lastError(r), /requête DNS n'aboutit pas/);
});

test('web : page obtenue par nom, ACL par port (web autorisé, ping refusé)', () => {
  const ok = httpGet(SERVICES_DEMO, 'pc3', 'http://www.entreprise.lan/');
  assert.equal(ok.ok, true);
  assert.equal(ok.page.title, "Intranet de l'entreprise");
  assert.ok(ok.log.some((l) => /requête HTTP \(TCP 80\)/.test(l.text)));
  // Le ping depuis le VLAN 20 vers le serveur est refusé par la 3e ligne de l'ACL 110
  const ping = simulatePing(SERVICES_DEMO, 'pc3', '172.16.0.10');
  assert.equal(ping.ok, false);
  assert.match(lastError(ping), /paquet 192\.168\.20\.10 → 172\.16\.0\.10 \(ICMP\) refusé en sortie de G0\/0 par l'ACL 110, ligne 30/);
  // Le VLAN 10 n'est pas concerné
  assert.equal(simulatePing(SERVICES_DEMO, 'pc1', '172.16.0.10').ok, true);
  // Sans la ligne « permit tcp … eq www », le web est refusé aussi
  const noWeb = structuredClone(SERVICES_DEMO);
  dev(noWeb, 'r2').config.acls[110].rules.splice(1, 1);
  const r = httpGet(noWeb, 'pc3', 'www.entreprise.lan');
  assert.equal(r.ok, false);
  assert.match(lastError(r.result), /:80 \(TCP\) refusé/);
});

test('web : serveur sans service HTTP = connexion refusée', () => {
  const doc = structuredClone(SERVICES_DEMO);
  dev(doc, 'srv').config.services.http.enabled = false;
  const r = httpGet(doc, 'pc1', 'www.entreprise.lan');
  assert.equal(r.ok, false);
  assert.match(lastError(r.result), /aucun service n'écoute sur TCP 80 \(serveur HTTP\) : il répond « connexion refusée » \(TCP RST\)/);
});

test('IOS : ip host, ip name-server, ping par nom, show hosts, show run, import', async () => {
  const { runLine, shellFor } = await import('../cli/index.js');
  const { importConfig } = await import('../cli/import.js');
  let doc = structuredClone(SERVICES_DEMO);
  const shell = shellFor(dev(doc, 'r1'));
  const s = shell.newSession();
  const run = (line) => {
    const r = runLine(shell, s, line, dev(doc, 'r1'), doc);
    if (r.device) doc = { ...doc, devices: doc.devices.map((d) => (d.id === 'r1' ? r.device : d)) };
    return { text: r.output.join('\n'), effects: r.effects };
  };
  run('enable');
  // Sans serveur : la raison est donnée
  assert.match(run('ping www.entreprise.lan').text, /Unrecognized host[\s\S]*aucun serveur DNS \(« ip name-server »\)/);
  run('configure terminal');
  run('ip host srv 172.16.0.10');
  run('ip name-server 172.16.0.10');
  run('end');
  assert.deepEqual(dev(doc, 'r1').config.hosts, [{ name: 'srv', ip: '172.16.0.10' }]);
  assert.equal(dev(doc, 'r1').config.nameServer, '172.16.0.10');
  // Table locale : pas de requête DNS
  const local = run('ping srv');
  assert.doesNotMatch(local.text, /Translating/);
  assert.match(local.text, /Success rate is 100 percent/);
  // Par le serveur DNS : requête UDP 53 animée
  const named = run('ping www.entreprise.lan');
  assert.match(named.text, /Translating "www.entreprise.lan"\.\.\.domain server \(172\.16\.0\.10\) \[OK\][\s\S]*ICMP Echos to 172\.16\.0\.10/);
  assert.ok(named.effects.some((e) => e.options?.dport === 53));
  assert.match(run('show hosts').text, /Name servers are 172\.16\.0\.10[\s\S]*srv\s+None\s+\(perm, OK\)\s+0\s+IP\s+172\.16\.0\.10/);
  const conf = run('show running-config').text;
  assert.match(conf, /ip host srv 172\.16\.0\.10\nip name-server 172\.16\.0\.10/);
  // Retrait
  run('configure terminal');
  run('no ip host srv');
  run('no ip name-server');
  run('end');
  assert.equal(dev(doc, 'r1').config.hosts, undefined);
  assert.equal(dev(doc, 'r1').config.nameServer, undefined);
  // Import de la config affichée
  const fresh = structuredClone(SERVICES_DEMO);
  const r1 = importConfig(dev(fresh, 'r1'), fresh, conf).device;
  assert.equal(r1.config.nameServer, '172.16.0.10');
  assert.deepEqual(r1.config.hosts, [{ name: 'srv', ip: '172.16.0.10' }]);
});

test('sérialisation : DNS du PC, services du serveur, ip host / name-server du routeur', async () => {
  const { fromJSON, toJSON } = await import('../serialize.js');
  const doc = structuredClone(SERVICES_DEMO);
  Object.assign(dev(doc, 'r1').config, { nameServer: '172.16.0.10', hosts: [{ name: 'srv', ip: '172.16.0.10' }] });
  const { nodes, edges } = fromJSON(doc);
  const back = toJSON(nodes, edges);
  assert.deepEqual(dev(back, 'srv').config.services, dev(doc, 'srv').config.services);
  assert.equal(dev(back, 'pc1').config.dns, '172.16.0.10');
  assert.equal(dev(back, 'r1').config.nameServer, '172.16.0.10');
  assert.deepEqual(dev(back, 'r1').config.hosts, [{ name: 'srv', ip: '172.16.0.10' }]);
});

test('contrôles en direct : serveur DNS sans service, enregistrements invalides', async () => {
  const { validate } = await import('./validate.js');
  assert.deepEqual(validate(SERVICES_DEMO).filter((i) => /DNS/.test(i.text)), []);
  const doc = structuredClone(SERVICES_DEMO);
  dev(doc, 'srv').config.services.dns.enabled = false;
  dev(doc, 'pc2').config.dns = '192.168.10.1';
  const texts = validate(doc).map((i) => i.text);
  assert.ok(texts.some((t) => /PC Compta : le serveur DNS 172\.16\.0\.10 est Serveur Web, qui n'a pas de service DNS actif/.test(t)), texts.join('\n'));
  assert.ok(texts.some((t) => /le serveur DNS 192\.168\.10\.1 est R1/.test(t)));
  const bad = structuredClone(SERVICES_DEMO);
  bad.devices.find((d) => d.id === 'srv').config.services.dns.records.push({ name: 'www..lan', ip: '1.2.3.4' }, { name: 'WWW.entreprise.lan', ip: '172.16.0.11' }, { name: 'x.lan', ip: '300.1.1.1' });
  const t2 = validate(bad).map((i) => i.text);
  assert.ok(t2.some((t) => /« www\.\.lan » : nom invalide/.test(t)));
  assert.ok(t2.some((t) => /enregistré deux fois/.test(t)));
  assert.ok(t2.some((t) => /x\.lan : adresse « 300\.1\.1\.1 » invalide/.test(t)));
});

test('panneau de simulation : DNS puis HTTP mis bout à bout', async () => {
  const { runService } = await import('./services.js');
  const web = runService(SERVICES_DEMO, 'pc3', 'web', 'www.entreprise.lan');
  assert.equal(web.ok, true);
  assert.equal(web.service.page.title, "Intranet de l'entreprise");
  const kinds = web.frames.map((f) => f.kind).filter((k) => k === 'udp' || k === 'tcp');
  assert.equal(kinds[0], 'udp');
  assert.equal(kinds.at(-1), 'tcp');
  assert.ok(web.hops.length > 4);
  assert.equal(web.log[0].phase, 'dns');
  const nx = runService(SERVICES_DEMO, 'pc1', 'dns', 'nope.lan');
  assert.equal(nx.ok, false);
  assert.equal(nx.failedAt, 'srv');
  assert.match(nx.log.at(-1).text, /NXDOMAIN/);
  const none = runService(DEMO, 'pc1', 'dns', 'x.lan');
  assert.equal(none.failedAt, 'pc1');
  assert.equal(none.hops.length, 0);
});

test('routeur serveur DNS (ip dns server) : table locale, sinon relais vers son serveur', () => {
  const doc = structuredClone(SERVICES_DEMO);
  dev(doc, 'pc1').config.dns = '192.168.10.1';
  // R1 sans service DNS : port injoignable, et le contrôle le signale
  assert.match(lastError(resolveName(doc, 'pc1', 'www.entreprise.lan')), /aucun service n'écoute sur UDP 53/);
  Object.assign(dev(doc, 'r1').config, { dnsServer: true, hosts: [{ name: 'imprimante.lan', ip: '192.168.10.50' }] });
  // Entrée statique : réponse directe
  const local = resolveName(doc, 'pc1', 'imprimante.lan');
  assert.equal(local.ip, '192.168.10.50');
  // Pas de serveur à relayer : NXDOMAIN avec la solution
  assert.match(lastError(resolveName(doc, 'pc1', 'www.entreprise.lan')), /ne connaît pas www\.entreprise\.lan \(NXDOMAIN\) : ajoute une entrée statique ou un serveur DNS à relayer/);
  // Relais vers le serveur web
  dev(doc, 'r1').config.nameServer = '172.16.0.10';
  const fwd = resolveName(doc, 'pc1', 'www.entreprise.lan');
  assert.equal(fwd.ok, true);
  assert.equal(fwd.ip, '172.16.0.10');
  assert.ok(fwd.log.some((l) => /R1 n'a pas www\.entreprise\.lan dans sa table locale : il relaie la question à 172\.16\.0\.10/.test(l.text)));
  assert.match(fwd.log.at(-1).text, /R1 transmet la réponse : www\.entreprise\.lan = 172\.16\.0\.10/);
});

test('MikroTik : /ip dns set, /ip dns static, ping par nom, export et import', async () => {
  const { runLine, shellFor } = await import('../cli/index.js');
  const { importConfig } = await import('../cli/import.js');
  const { OSPF_DEMO } = await import('../examples.js');
  let doc = structuredClone(OSPF_DEMO);
  const shell = shellFor(dev(doc, 'r3'));
  const s = shell.newSession();
  const run = (line) => {
    const r = runLine(shell, s, line, dev(doc, 'r3'), doc);
    if (r.device) doc = { ...doc, devices: doc.devices.map((d) => (d.id === 'r3' ? r.device : d)) };
    return r.output.join('\n');
  };
  assert.match(run('/ping r2.lan'), /could not get answer[\s\S]*aucun serveur DNS \(\/ip dns set servers=\) ni entrée statique/);
  run('/ip dns static add name=r2.lan address=10.0.23.1');
  assert.match(run('/ip dns static add name=R2.lan address=10.0.23.1'), /already exists/);
  run('/ip dns set servers=172.16.0.10 allow-remote-requests=yes');
  const c = dev(doc, 'r3').config;
  assert.deepEqual(c.hosts, [{ name: 'r2.lan', ip: '10.0.23.1' }]);
  assert.equal(c.nameServer, '172.16.0.10');
  assert.equal(c.dnsServer, true);
  assert.match(run('/ping r2.lan count=2'), /10\.0\.23\.1[\s\S]*received=2/);
  assert.match(run('/ip dns print'), /servers: 172\.16\.0\.10\n\s+allow-remote-requests: yes/);
  assert.match(run('/ip dns static print'), /0  r2\.lan\s+10\.0\.23\.1/);
  const exported = run('/export');
  assert.match(exported, /\/ip dns\nset allow-remote-requests=yes servers=172\.16\.0\.10\n\/ip dns static\nadd address=10\.0\.23\.1 name=r2\.lan/);
  const fresh = structuredClone(OSPF_DEMO);
  const back = importConfig(dev(fresh, 'r3'), fresh, exported);
  assert.deepEqual(back.ignored.filter((l) => /dns|name=r2/.test(l.text)), []);
  assert.deepEqual(back.device.config.hosts, c.hosts);
  assert.equal(back.device.config.dnsServer, true);
  run('/ip dns static remove 0');
  run('/ip dns set servers="" allow-remote-requests=no');
  assert.equal(dev(doc, 'r3').config.hosts, undefined);
  assert.equal(dev(doc, 'r3').config.nameServer, undefined);
  assert.equal(dev(doc, 'r3').config.dnsServer, undefined);
});
