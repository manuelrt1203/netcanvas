// Test de bout en bout dans Chrome. Prérequis : `npm run dev` lancé.
// CHROME_PATH=/chemin/vers/chrome  APP_URL=http://localhost:5173  node e2e/editor.e2e.mjs
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const URL = process.env.APP_URL || 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('dialog', (d) => d.accept());

const step = (name) => console.log(`- ${name}`);
const openDemo = async (label) => {
  await page.click('summary:has-text("Démos")');
  await page.click(`role=menuitem[name="${label}"]`);
};

await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();

step('ajout et connexion d’équipements');
const item = (label) => page.locator('.palette-item', { hasText: new RegExp(`^${label}$`) });
await page.dragAndDrop('.palette-item:has-text("Cisco 2911")', '.canvas', { targetPosition: { x: 400, y: 150 } });
await page.dragAndDrop('.palette-item:has-text("Cisco 2960-24TT")', '.canvas', { targetPosition: { x: 400, y: 400 } });
await item('PC').click(); // PC au clic (alternative clavier)
await item('PC').click(); // 2e PC : ne doit pas recouvrir le 1er
const boxes = await page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map(({ x, y }) => [x, y]));
assert.equal(boxes.length, 4);
assert.notDeepEqual(boxes[2], boxes[3], 'les deux PC se superposent');

const nodes = page.locator('.react-flow__node');
async function connect(i, j, from = 'bottom', to = 'top') {
  await nodes.nth(i).hover();
  const h = await nodes.nth(i).locator(`.react-flow__handle-${from}`).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await nodes.nth(j).hover();
  const t = await nodes.nth(j).locator(`.react-flow__handle-${to}`).boundingBox();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });
  await page.mouse.up();
}
await connect(0, 1);
await connect(1, 2, 'left', 'top');
assert.equal(await page.locator('.react-flow__edge').count(), 2);
assert.ok(await page.getByText('G0/0', { exact: true }).isVisible(), 'nom d’interface du routeur');
assert.ok(await page.getByText('Fa0/1', { exact: true }).isVisible(), 'nom de port du switch');

step('configuration du PC avec la saisie « IP/CIDR »');
await nodes.nth(2).click();
await page.getByLabel('Adresse IP').fill('192.168.1.10/24');
assert.equal(await page.getByLabel('Masque').inputValue(), '24');
assert.ok(await page.getByText('255.255.255.0').isVisible());
await page.getByLabel('Passerelle par défaut').fill('10.0.0.1');
await page.locator('.react-flow__pane').click({ position: { x: 50, y: 50 } });
assert.ok(await page.getByText(/passerelle 10\.0\.0\.1 est hors du réseau/).isVisible(), 'contrôle passerelle');

step('démo + ping réussi animé');
await openDemo('2 VLAN, 2 routeurs (statique)');
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-src', { label: 'PC Compta' });
await page.selectOption('#sim-dst', { label: 'Serveur Web · 172.16.0.10' });
await page.click('text=Lancer le ping');
await page.waitForSelector('.packet', { timeout: 2000 });
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.locator('.sim-verdict.ok').isVisible());
assert.ok(await page.getByText(/TTL 62/).isVisible());
assert.ok((await page.locator('.react-flow__edge-path.sim-reply').count()) >= 5);
await page.screenshot({ path: 'e2e/ping-ok.png' });

step('suppression de la route de retour sur R2 -> échec');
await page.locator('.react-flow__node', { hasText: 'R2' }).click();
await page.click('role=tab[name=/Propriétés/]');
await page.click('text=Retirer la route');
await page.click('role=tab[name="Simulation"]');
assert.ok(await page.getByText(/Le schéma a changé/).isVisible());
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.locator('.sim-verdict.fail').isVisible());
assert.ok(await page.getByText(/R2 : aucune route vers 192\.168\.10\.10/).isVisible());
assert.equal(await page.locator('.device.sim-fail').count(), 1);
await page.screenshot({ path: 'e2e/ping-fail.png' });

step('persistance du brouillon');
await page.reload();
assert.equal(await page.locator('.react-flow__node').count(), 9);

step('exports : Packet Tracer, CSV, PNG');
await page.click('role=tab[name=/Propriétés/]');
await page.click('button:has-text("Exporter")');
assert.equal(await page.getAttribute('role=tab[name="Export"]', 'aria-selected'), 'true');
await page.selectOption('#export-format', 'packet-tracer');
const ios = await page.getByTestId('export-output').textContent();
assert.match(ios, /hostname R1\n/);
assert.match(ios, /Modules a installer d'abord .*HWIC-2T dans le slot 0/);
assert.match(ios, /interface Serial0\/0\/0\n description Vers R2 Se0\/0\/0\n ip address 10\.0\.0\.1 255\.255\.255\.252\n clock rate 64000/);
assert.match(ios, /ip route 0\.0\.0\.0 0\.0\.0\.0 10\.0\.0\.2/);
// La route retirée plus haut n'apparaît plus sur R2
assert.doesNotMatch(ios, /ip route 192\.168\.0\.0/);

await page.selectOption('#export-format', 'csv');
const [csv] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Télécharger")')]);
assert.equal(csv.suggestedFilename(), 'Demo_2_VLAN_2_routeurs.csv');

await page.selectOption('#export-format', 'png');
assert.ok(await page.locator('img.export-preview').isVisible(), 'aperçu de l’image');
const [png] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Télécharger")')]);
const head = (await (await import('node:fs/promises')).readFile(await png.path())).subarray(0, 8);
assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'signature PNG');
await page.screenshot({ path: 'e2e/export.png' });

step('câblage : croisé automatique entre deux PC, puis mauvais câble');
await page.click('text=Effacer');
await page.click('role=tab[name=/Propriétés/]');
await item('PC').click();
await item('PC').click();
await connect(0, 1, 'right', 'left');
assert.equal(await page.locator('.react-flow__edge-path.cable-cross').count(), 1, 'PC ↔ PC : câble croisé posé automatiquement');
assert.equal(await page.locator('.link-light.on').count(), 2);
await page.locator('.react-flow__edge').first().click({ force: true });
await page.selectOption('#cable-type', 'straight');
assert.match(await page.locator('.cable-status').textContent(), /deux PC se relient avec un câble croisé/, 'explication du mauvais câble');
assert.equal(await page.locator('.link-light.off').count(), 2);

step('câblage : série sans module, puis HWIC-2T et clock rate');
await page.click('text=Effacer');
await item('Cisco 1941').click();
await item('Cisco 1941').click();
await page.click('role=radio[name="Série"]');
await connect(0, 1, 'right', 'left');
assert.ok(await page.getByText(/Plus de port série libre/).isVisible(), 'pas de port série sans module');
for (const i of [0, 1]) {
  await nodes.nth(i).click();
  await page.selectOption('#slot-0', 'HWIC-2T');
}
await connect(0, 1, 'right', 'left');
assert.equal(await page.locator('.react-flow__edge-path.cable-serial').count(), 1);
await page.locator('.react-flow__edge').first().click({ force: true });
assert.match(await page.locator('.cable-status').textContent(), /n'a pas de clock rate/);
await page.selectOption('#clock-' + (await page.locator('.react-flow__edge').first().getAttribute('data-id')), '64000');
assert.equal(await page.locator('.cable-status').textContent(), 'Lien actif.');
await page.screenshot({ path: 'e2e/serial.png' });

step('câblage : console PC ↔ routeur');
await page.click('role=radio[name="Console"]');
await item('PC').click();
await connect(2, 0, 'top', 'bottom');
assert.equal(await page.locator('.react-flow__edge-path.cable-console').count(), 1);

step('terminal IOS : abréviations, Tab, ping animé, même config que le formulaire');
await openDemo('2 VLAN, 2 routeurs (statique)');
await page.getByTestId('rf__node-r1').click();
await page.click('role=radio[name="Terminal IOS"]');
const cmd = page.getByLabel('Commande');
const type = async (...lines) => {
  for (const l of lines) {
    await cmd.fill(l);
    await cmd.press('Enter');
  }
};
const screenText = () => page.locator('.terminal-screen').textContent();
await cmd.fill('en');
await cmd.press('Enter');
await cmd.fill('conf');
await cmd.press('Tab');
assert.equal(await cmd.inputValue(), 'configure ');
await cmd.fill('sh ip ');
await cmd.press('?');
assert.match(await screenText(), /route\s+IP routing table/);
await type('', 'ping 172.16.0.10');
await page.waitForSelector('.packet', { timeout: 2000 });
assert.match(await screenText(), /!!!!!\nSuccess rate is 100 percent/);
await type('conf t', 'int g0/0', 'ip add 192.168.10.254 255.255.255.0', 'end', 'sh ip int br');
assert.match(await screenText(), /GigabitEthernet0\/0\s+192\.168\.10\.254\s+YES manual up/);
await page.click('role=radio[name="Formulaire"]');
assert.equal(await page.getByLabel('Adresse IP').first().inputValue(), '192.168.10.254');

step('MikroTik : câble droit accepté (auto-MDIX), RouterOS et invite de commandes du PC');
await page.click('text=Effacer');
await item('MikroTik hAP ac²').click();
await item('PC').click();
await page.click('role=radio[name="Droit"]');
await connect(0, 1, 'right', 'left');
assert.equal(await page.locator('.link-light.on').count(), 2, 'PC ↔ MikroTik en câble droit : lien actif');
await nodes.nth(0).click();
await page.click('role=radio[name="Terminal RouterOS"]');
await type('/ip address add address=10.0.0.1/24 interface=ether1', '/ip address print');
assert.match(await screenText(), /0\s+10\.0\.0\.1\/24\s+10\.0\.0\.0\s+ether1/);
await nodes.nth(1).click();
assert.equal(await page.getAttribute('role=radio[name="Invite de commandes"]', 'aria-checked'), 'true', 'le mode terminal est retenu');
await type('ipconfig 10.0.0.2 255.255.255.0', 'ping 10.0.0.1');
assert.match(await screenText(), /Reply from 10\.0\.0\.1: bytes=32 time<1ms TTL=64/);
await page.screenshot({ path: 'e2e/terminal.png' });
await page.click('role=radio[name="Formulaire"]');

step('routage dynamique : démo OSPF, ping inter-zones, show ip ospf neighbor');
await openDemo('OSPF 2 zones (Cisco + MikroTik)');
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-src', { label: 'PC LAN' });
await page.selectOption('#sim-dst', { label: 'Serveur · 172.16.3.10' });
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.locator('.sim-verdict.ok').isVisible());
assert.ok(await page.getByText(/route OSPF inter-zones 172\.16\.3\.0\/24/).first().isVisible());
await page.getByTestId('rf__node-r1').click();
await page.click('role=tab[name=/Propriétés/]');
await page.click('role=radio[name="Terminal IOS"]');
await type('en', 'sh ip ospf nei');
assert.match(await screenText(), /2\.2\.2\.2\s+1\s+FULL\/DR/);
await page.click('role=radio[name="Formulaire"]');

step('routage dynamique : BGP, next-hop-self retiré dans le formulaire -> explication');
await openDemo('BGP eBGP + iBGP');
await page.getByTestId('rf__node-r2').click();
const proto = page.locator('.proto', { hasText: 'BGP' });
assert.match(await proto.textContent(), /Session iBGP avec R1 \(AS 65001\) \(1\.1\.1\.1\) : établie/);
await proto.getByLabel('next-hop-self').first().uncheck();
await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
assert.ok(await page.getByText(/next-hop 10\.0\.23\.2, injoignable/).isVisible(), 'explication dans les contrôles');
await page.screenshot({ path: 'e2e/bgp.png' });

step('router-on-a-stick : sous-interfaces dans le formulaire, ping inter-VLAN');
await openDemo('Router-on-a-stick (802.1Q)');
await page.getByTestId('rf__node-r1').click();
assert.ok(await page.getByText('G0/0.20', { exact: true }).first().isVisible(), 'sous-interface affichée');
await page.locator('.subifs input[type="number"]').nth(2).fill('30'); // VLAN de G0/0.20 -> 30
assert.ok(await page.getByText('G0/0.30', { exact: true }).first().isVisible(), 'renommée selon le VLAN');
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-src', { label: 'PC Profs' });
await page.selectOption('#sim-dst', { label: 'PC Élèves · 192.168.20.10' });
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.getByText(/pas de réponse ARP.*VLAN 30/).first().isVisible(), 'explication : la trame part dans le VLAN 30');
await page.keyboard.press('Control+z');
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.locator('.sim-verdict.ok').isVisible(), 'Ctrl+Z remet le VLAN 20 et le ping passe');

step('switch niveau 3 : formulaire (ip routing) et ping inter-VLAN');
await openDemo('Switch niveau 3 (SVI, ip routing)');
await page.getByTestId('rf__node-sw').click();
await page.click('role=tab[name=/Propriétés/]');
assert.ok(await page.locator('legend', { hasText: /^Vlan30$/ }).isVisible(), 'SVI affichée');
await page.getByLabel('Routage IP entre les VLAN (ip routing)').uncheck();
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-src', { label: 'PC Compta' });
await page.selectOption('#sim-dst', { label: 'Serveur · 192.168.30.10' });
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.getByText(/le routage IP n'est pas activé/).first().isVisible());
await page.click('role=tab[name=/Propriétés/]');
await page.getByLabel('Routage IP entre les VLAN (ip routing)').check();
await page.click('role=tab[name="Simulation"]');
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.locator('.sim-verdict.ok').isVisible());

step('NAT : démo, ping vers Internet, NAT inside décoché dans le formulaire');
await openDemo('NAT / PAT (box, FAI, serveur publié)');
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-src', { label: 'PC Maison' });
await page.selectOption('#sim-dst', { label: 'Serveur Internet · 198.51.100.10' });
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.getByText(/source 192\.168\.1\.10 traduite en 203\.0\.113\.1/).first().isVisible());
await page.getByTestId('rf__node-r1').click();
await page.click('role=tab[name=/Propriétés/]');
await page.getByLabel('NAT inside').first().uncheck();
assert.ok(await page.getByText(/aucune interface « ip nat inside »/).first().isVisible(), 'avertissement dans le formulaire');
await page.click('role=tab[name="Simulation"]');
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.getByText(/adresse privée : elle ne circule pas sur Internet/).first().isVisible());

step('ACL : création dans le formulaire, ping bloqué');
await page.keyboard.press('Control+z');
await page.click('role=tab[name=/Propriétés/]');
await page.fill('#new-acl', '100');
await page.click('role=button[name="Créer"]');
await page.getByLabel('Règles (syntaxe IOS, une par ligne)').last().fill('deny icmp any host 198.51.100.10\npermit ip any');
assert.ok(await page.getByText(/Ligne 2 : destination/).isVisible(), 'erreur de syntaxe affichée');
await page.getByLabel('Règles (syntaxe IOS, une par ligne)').last().fill('deny icmp any host 198.51.100.10\npermit ip any any');
await page.selectOption('#aclOut-G0\\/1', '100');
await page.click('role=tab[name="Simulation"]');
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.getByText(/refusé en sortie de G0\/1 par l'ACL 100, ligne 10/).first().isVisible());

step('DHCP : bail affiché, relais retiré -> APIPA et explication');
await openDemo('DHCP (serveur et relais)');
await page.getByTestId('rf__node-pc3').click();
await page.click('role=tab[name=/Propriétés/]');
assert.match(await page.locator('.routing-status').textContent(), /Bail obtenu : 192\.168\.20\.2\/24.*via le relais R1/);
await page.getByTestId('rf__node-r1').click();
await page.getByLabel('Relais DHCP (ip helper-address)').nth(0).waitFor();
const helpers = page.getByLabel('Relais DHCP (ip helper-address)');
for (let k = 0; k < await helpers.count(); k++) await helpers.nth(k).fill('');
await page.getByTestId('rf__node-pc3').click();
assert.match(await page.locator('.routing-status').textContent(), /Pas de bail : .*n'a ni pool DHCP.*APIPA/);

step('temps simulé : la traduction NAT d\'un ping expire après 60 s');
await openDemo('NAT / PAT (box, FAI, serveur publié)');
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-src', { label: 'PC Maison' });
await page.selectOption('#sim-dst', { label: 'Serveur Internet · 198.51.100.10' });
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
await page.getByTestId('rf__node-r1').click();
await page.click('role=tab[name=/Propriétés/]');
await page.click('role=radio[name="Terminal IOS"]');
await type('en', 'show ip nat translations');
assert.match(await screenText(), /icmp 203\.0\.113\.1:1\s+192\.168\.1\.10:1/);
await page.click('role=button[name="+1 min"]');
assert.match(await page.locator('.clock-time').textContent(), /00:01:00/);
await type('show ip nat translations');
const afterMinute = (await screenText()).split('show ip nat translations').at(-1);
assert.doesNotMatch(afterMinute, /icmp 203/, 'entrée expirée');
await page.click('role=radio[name="Formulaire"]');

step('tables : ARP et MAC remplies par un ping, puis vieillissement');
await openDemo('2 VLAN, 2 routeurs (statique)');
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-src', { label: 'PC Compta' });
await page.selectOption('#sim-dst', { label: 'PC Atelier · 192.168.20.10' });
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
await page.getByTestId('rf__node-sw1').click();
await page.click('role=tab[name="Tables"]');
const macTable = page.locator('.table-block', { hasText: 'Table MAC' });
assert.equal(await macTable.locator('tbody tr').count(), 4);
await page.getByTestId('rf__node-r1').click();
assert.equal(await page.locator('.table-block', { hasText: 'Cache ARP' }).getByRole('cell', { name: '192.168.20.10', exact: true }).count(), 1);
await page.screenshot({ path: 'e2e/tables.png' });
await page.getByTestId('rf__node-sw1').click();
await page.click('role=button[name="+1 h"]');
assert.ok(await macTable.getByText(/Vide : le switch apprend/).isVisible(), 'table MAC vidée par le vieillissement');

step('STP : port bloqué sur le plan, tables, tempête sans STP');
await openDemo('STP (triangle de switches)');
assert.equal(await page.locator('.link-light.stp').count(), 1, 'un seul port bloqué (orange)');
await page.getByTestId('rf__node-sw3').click();
await page.click('role=tab[name="Tables"]');
const stpTable = page.locator('.table-block', { hasText: 'Spanning Tree · VLAN 1' });
assert.match(await stpTable.locator('h3').textContent(), /root SW Cœur \(priorité 4097\), coût 4/);
assert.equal(await stpTable.locator('.stp-blocked').count(), 1);
await page.click('role=tab[name=/^Propriétés/]');
for (const id of ['sw1', 'sw2', 'sw3']) {
  await page.getByTestId(`rf__node-${id}`).click();
  const stpBox = page.locator('details.proto', { hasText: 'Spanning Tree' });
  if (!(await stpBox.evaluate((e) => e.open))) await stpBox.locator('summary').click();
  await stpBox.getByLabel('VLAN 1', { exact: true }).uncheck();
}
assert.equal(await page.locator('.link-light.stp').count(), 0);
await page.getByTestId('rf__pane').click({ position: { x: 20, y: 20 } }).catch(() => {});
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-src', { label: 'PC A' });
await page.selectOption('#sim-dst', { label: 'PC B · 192.168.1.20' });
await page.click('text=Lancer le ping');
await page.waitForSelector('.sim-verdict.fail', { timeout: 15000 });
assert.match(await page.locator('.sim-log .log-error').last().textContent(), /^Tempête de diffusion dans le VLAN 1/);

step('import d\'une config Cisco dans un routeur');
await openDemo('2 VLAN, 2 routeurs (statique)');
await page.click('role=tab[name=/^Propriétés/]');
await page.getByTestId('rf__node-r1').click();
await page.click('role=button[name="Importer une config…"]');
const importDialog = page.locator('.import-dialog');
await importDialog.getByLabel('Configuration').fill([
  'Building configuration...', '!', 'hostname R1-Import', '!',
  'interface GigabitEthernet0/0', ' ip address 192.168.10.1 255.255.255.0', ' no shutdown', '!',
  'interface GigabitEthernet0/1', ' ip address 192.168.20.1 255.255.255.0', '!',
  'interface Serial0/0/0', ' ip address 10.0.0.1 255.255.255.252', ' clock rate 64000', '!',
  'interface Serial9/9', ' ip address 10.9.9.1 255.255.255.0', '!',
  'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'end',
].join('\n'));
assert.match(await importDialog.locator('.import-report').textContent(), /10 lignes appliquées, 2 ignorées/);
assert.match(await importDialog.locator('.import-ignored').textContent(), /ligne 16 interface Serial9\/9 Invalid interface type and number/);
await importDialog.getByRole('button', { name: 'Appliquer' }).click();

assert.ok(await page.getByTestId('rf__node-r1').getByText('R1-Import').isVisible());
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-src', { label: 'PC Compta' });
await page.selectOption('#sim-dst', { label: 'PC Atelier · 192.168.20.10' });
await page.click('text=Lancer le ping');
await page.waitForSelector('.sim-verdict.ok', { timeout: 15000 });

step('simulation pas à pas : trames, en-têtes, plan');
await openDemo('2 VLAN, 2 routeurs (statique)');
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-src', { label: 'PC Compta' });
await page.selectOption('#sim-dst', { label: 'PC Atelier · 192.168.20.10' });
await page.click('role=button[name="Pas à pas"]');
assert.equal(await page.locator('.stepper-count').textContent(), 'Trame 1 / 15');
assert.match(await page.locator('.frame-summary').textContent(), /ARP request \(diffusion\) : qui a 192\.168\.10\.1 \?/);
assert.equal(await page.locator('.layer', { hasText: 'Ethernet II' }).locator('dd').first().textContent(), 'ffff.ffff.ffff');
assert.equal(await page.locator('.packet-arp').count(), 3, 'diffusion ARP : trois câbles');
await page.click('role=button[name="Trame suivante"]');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
assert.match(await page.locator('.frame-summary').textContent(), /ICMP echo request 192\.168\.10\.10 → 192\.168\.20\.10/);
assert.equal(await page.locator('.layer').filter({ has: page.locator('summary', { hasText: /^IPv4$/ }) }).locator('dd').nth(2).textContent(), '64');
await page.locator('.frame-row').last().click();
assert.match(await page.locator('.frame-summary').textContent(), /Ping réussi/);
await page.locator('.frame-row').nth(9).click();
await page.screenshot({ path: 'e2e/pas-a-pas.png' });

step('DNS et web : page par nom, ACL par port, enregistrement ajouté dans le formulaire');
await openDemo('DNS et web (ACL par port)');
await page.click('role=tab[name="Simulation"]');
await page.selectOption('#sim-kind', 'web');
await page.selectOption('#sim-src', { label: 'PC Atelier' });
await page.fill('#sim-name', 'www.entreprise.lan');
await page.click('role=button[name="Ouvrir la page"]');
await page.waitForSelector('button:has-text("Ouvrir la page"):not([disabled])', { timeout: 20000 });
assert.match(await page.locator('.sim-verdict').textContent(), /Page reçue de 172\.16\.0\.10/);
assert.match(await page.locator('.web-page').textContent(), /Intranet de l'entreprise/);
assert.ok(await page.locator('h3.phase-dns').isVisible(), 'étape DNS affichée');
// Ping depuis le VLAN 20 : refusé par l'ACL (le web, lui, passe)
await page.selectOption('#sim-kind', 'ping');
await page.selectOption('#sim-dst', { label: 'Serveur Web · 172.16.0.10' });
await page.click('text=Lancer le ping');
await page.waitForSelector('button:has-text("Lancer le ping"):not([disabled])', { timeout: 15000 });
assert.ok(await page.getByText(/refusé en sortie de G0\/0 par l'ACL 110, ligne 30/).first().isVisible());
// Nom inconnu, puis ajouté dans le formulaire du serveur
await page.selectOption('#sim-kind', 'dns');
await page.fill('#sim-name', 'mail.entreprise.lan');
await page.click('role=button[name="Résoudre le nom"]');
await page.waitForSelector('button:has-text("Résoudre le nom"):not([disabled])', { timeout: 15000 });
assert.ok(await page.getByText(/ne connaît pas mail\.entreprise\.lan \(NXDOMAIN\)/).isVisible());
await page.getByTestId('rf__node-srv').click();
await page.click('role=tab[name=/Propriétés/]');
await page.click('role=button[name="Ajouter un enregistrement"]');
await page.getByLabel('Nom 3').fill('mail.entreprise.lan');
await page.getByLabel('Adresse (A)').nth(2).fill('172.16.0.10');
await page.click('role=tab[name="Simulation"]');
await page.click('role=button[name="Résoudre le nom"]');
await page.waitForSelector('button:has-text("Résoudre le nom"):not([disabled])', { timeout: 15000 });
assert.match(await page.locator('.sim-verdict').textContent(), /mail\.entreprise\.lan = 172\.16\.0\.10/);
await page.screenshot({ path: 'e2e/dns-web.png' });

step('TP : objectifs en direct, indices, ajout d\'un objectif');
await openDemo('TP : inter-VLAN en panne (3 pannes)');
await page.click('role=tab[name=/^TP/]');
assert.equal(await page.locator('#tab-tp .badge').textContent(), '0/4');
const first = page.locator('.tp-objectives li').first();
await first.getByRole('button', { name: 'Indice' }).click();
await first.getByRole('button', { name: 'Indice suivant' }).click();
assert.equal(await first.locator('.tp-hint').textContent(), 'Regarde du côté de R1. Voir');
await first.getByRole('button', { name: 'Indice suivant' }).click();
assert.match(await first.locator('.tp-hint').textContent(), /pas de réponse ARP/);
await page.click('role=button[name="Modifier"]');
await page.click('role=button[name="Ajouter un objectif"]');
const added = page.locator('fieldset.iface').last();
await added.getByLabel('Depuis').selectOption({ label: 'PC Compta' });
await added.getByLabel('Vers').fill('192.168.10.11');
await page.click('role=button[name="Vue élève"]');
assert.equal(await page.locator('#tab-tp .badge').textContent(), '1/5');
assert.ok(await page.locator('.tp-objectives li.ok').getByText('PC Compta ping 192.168.10.11').isVisible());

step('édition : annuler / rétablir, copier-coller, sélection multiple, recherche');
await page.click('text=Effacer');
await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
await item('PC').click();
await page.waitForTimeout(500); // l'historique regroupe les modifications rapprochées
await item('Cisco 2911').click();
await page.waitForTimeout(500);
assert.equal(await nodes.count(), 2);
await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
await page.keyboard.press('Control+z');
assert.equal(await nodes.count(), 1, 'Ctrl+Z retire le routeur');
await page.keyboard.press('Control+y');
assert.equal(await nodes.count(), 2, 'Ctrl+Y le remet');
await page.click('role=button[name="Annuler (Ctrl+Z)"]');
assert.equal(await nodes.count(), 1);
await page.click('role=button[name="Rétablir (Ctrl+Y)"]');
assert.equal(await nodes.count(), 2);

await nodes.nth(0).click();
await nodes.nth(1).click({ modifiers: ['Shift'] });
assert.match(await page.locator('.panel h2').first().textContent(), /2 équipements sélectionnés/);
await page.keyboard.press('Control+c');
await page.keyboard.press('Control+v');
assert.equal(await nodes.count(), 4, 'Ctrl+V colle les 2 équipements');
assert.ok(await page.getByText('Routeur 2', { exact: true }).isVisible(), 'renommage automatique');
await page.click('text=Aligner en ligne');
const ys = await page.locator('.react-flow__node.selected').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
assert.equal(new Set(ys).size, 1, 'les 2 copies sont alignées');
await page.click('text=Supprimer les 2 équipements');
assert.equal(await nodes.count(), 2);

await page.keyboard.press('Control+k');
await page.keyboard.type('rout');
await page.keyboard.press('Enter');
assert.match(await page.locator('.panel h2').first().textContent(), /Routeur/);
await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
await page.keyboard.press('?');
assert.ok(await page.locator('dialog[aria-labelledby="help-title"]').isVisible());
await page.click('dialog[aria-labelledby="help-title"] >> text=Fermer');

assert.deepEqual(errors, [], `erreurs console : ${errors.join(' | ')}`);
console.log('OK');
await browser.close();
