// Import / export GNS3 dans l'interface. Prérequis : `npm run dev` lancé.
// CHROME_PATH=/chemin/vers/chrome  APP_URL=http://localhost:5173  node e2e/gns3.e2e.mjs
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeZip, readZip } from '../src/gns3/zip.js';

const URL = process.env.APP_URL || 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('dialog', (d) => d.accept());
const step = (name) => console.log(`- ${name}`);

// Projet portable GNS3 : c3725 — switch (VLAN 10) — VPCS, avec configs
const node = (node_id, name, node_type, properties, x, y) => ({ node_id, name, node_type, properties, x, y });
const project = {
  type: 'topology', name: 'TP GNS3', revision: 9, version: '2.2.61',
  topology: {
    nodes: [
      node('r1', 'R1', 'dynamips', { platform: 'c3725', slot0: 'GT96100-FE', dynamips_id: 1 }, 0, -100),
      node('sw', 'Switch1', 'ethernet_switch', { ports_mapping: [
        { name: 'Ethernet0', port_number: 0, type: 'access', vlan: 10 }, { name: 'Ethernet1', port_number: 1, type: 'access', vlan: 10 },
      ] }, 0, 50),
      node('pc', 'PC1', 'vpcs', {}, 0, 200),
    ],
    links: [
      { link_id: 'a', nodes: [{ node_id: 'r1', adapter_number: 0, port_number: 0 }, { node_id: 'sw', adapter_number: 0, port_number: 0 }] },
      { link_id: 'b', nodes: [{ node_id: 'pc', adapter_number: 0, port_number: 0 }, { node_id: 'sw', adapter_number: 0, port_number: 1 }] },
    ],
  },
};
const zip = writeZip([
  { name: 'project.gns3', data: JSON.stringify(project) },
  { name: 'project-files/dynamips/r1/configs/i1_startup-config.cfg', data: 'hostname R1\ninterface FastEthernet0/0\n ip address 192.168.10.1 255.255.255.0\n no shutdown\n!\nend\n' },
  { name: 'project-files/vpcs/pc/startup.vpc', data: 'set pcname PC1\nip 192.168.10.10 192.168.10.1 24\n' },
]);

await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.click('role=button[name="Nouveau projet"]');

step('menu Fichier > Importer depuis GNS3, projet portable');
await page.click('summary:has-text("Fichier")');
await page.click('role=menuitem[name=/^Importer depuis GNS3/]');
const dialog = page.locator('dialog[aria-labelledby="gns3-title"]');
assert.ok(await dialog.isVisible());
await dialog.locator('input[type=file][accept]').setInputFiles({ name: 'tp.gns3project', mimeType: 'application/zip', buffer: Buffer.from(zip) });
const result = dialog.getByTestId('gns3-result');
await result.waitFor();
assert.match(await result.textContent(), /TP GNS3 : 3 équipement\(s\), 2 câble\(s\), 2 config\(s\) reprise\(s\)/);
await result.getByRole('button', { name: 'Ouvrir dans NetCanvas' }).click();
assert.equal(await page.locator('.react-flow__node').count(), 3);
assert.equal(await page.locator('.react-flow__edge').count(), 2);
assert.ok(!(await dialog.isVisible()));

step('modèle GNS3 du routeur importé');
await page.locator('.react-flow__node', { hasText: 'R1' }).click();
assert.ok(await page.getByText('Cisco 3725 (GNS3)').first().isVisible());

step('import du dossier d\'un projet (GNS3/projects/<nom>)');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-gns3-'));
const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
put('TP GNS3.gns3', JSON.stringify(project));
put('project-files/dynamips/r1/configs/i1_startup-config.cfg', 'hostname R1\ninterface FastEthernet0/0\n ip address 192.168.10.1 255.255.255.0\n!\nend\n');
put('project-files/vpcs/pc/startup.vpc', 'set pcname PC1\nip 192.168.10.10 192.168.10.1 24\n');
await page.click('summary:has-text("Fichier")');
await page.click('role=menuitem[name=/^Importer depuis GNS3/]');
await dialog.locator('input[webkitdirectory]').setInputFiles(dir);
await result.waitFor();
assert.match(await result.textContent(), /3 équipement\(s\), 2 câble\(s\), 2 config\(s\) reprise\(s\)/);
await result.getByRole('button', { name: 'Ouvrir dans NetCanvas' }).click();
assert.equal(await page.locator('.react-flow__node').count(), 3);
fs.rmSync(dir, { recursive: true });

step('export en projet GNS3 (.gns3project)');
await page.click('role=button[name="Exporter"]');
await page.selectOption('#export-format', 'gns3project');
assert.match(await page.getByTestId('export-output').textContent(), /"node_type": "dynamips"/);
const [download] = await Promise.all([page.waitForEvent('download'), page.click('role=button[name=/Télécharger/]')]);
assert.match(download.suggestedFilename(), /\.gns3project$/);
const bytes = new Uint8Array(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c)));
const files = readZip(bytes);
const back = JSON.parse(new TextDecoder().decode(await files.get('project.gns3')()));
assert.deepEqual(back.topology.nodes.map((n) => n.node_type).sort(), ['dynamips', 'ethernet_switch', 'vpcs']);
assert.equal(back.topology.links.length, 2);
const cfg = [...files.keys()].find((k) => /i1_startup-config\.cfg$/.test(k));
assert.match(new TextDecoder().decode(await files.get(cfg)()), /ip address 192\.168\.10\.1 255\.255\.255\.0/);

assert.deepEqual(errors, [], `erreurs console : ${errors.join(' | ')}`);
console.log('OK');
await browser.close();
