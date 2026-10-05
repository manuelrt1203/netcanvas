// Test de l'application de bureau (Electron) : ouverture d'un .netcanvas passé en argument (double-clic),
// modification, Enregistrer / Enregistrer sous par les menus, fichiers récents, fermeture avec modifications.
// Prérequis : npm run build. Sous Linux sans écran : xvfb-run -a node e2e/desktop.e2e.mjs
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NAT_DEMO } from '../src/examples.js';

const dir = mkdtempSync(join(tmpdir(), 'ncdesk-'));
const file = join(dir, 'tp-nat.netcanvas');
writeFileSync(file, JSON.stringify({ ...NAT_DEMO, name: 'TP NAT' }));
const step = (name) => console.log(`- ${name}`);

// NETCANVAS_EXE : tester l'application empaquetée (release/linux-unpacked/netcanvas) au lieu des sources
const exe = process.env.NETCANVAS_EXE;
const app = await electron.launch({
  ...(exe ? { executablePath: exe, args: [file, '--no-sandbox'] } : { args: ['.', file, '--no-sandbox'] }),
  // Profil isolé : fichiers récents et brouillon dans un dossier temporaire
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NETCANVAS_USER_DATA: join(dir, 'profil') },
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const menu = (cmd) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu', c), cmd);
const title = () => page.title();

step('ouverture du fichier passé en argument');
await page.waitForFunction(() => document.title.includes('tp-nat.netcanvas'));
assert.equal(await page.locator('.react-flow__node').count(), NAT_DEMO.devices.length);
assert.equal(await page.locator('.welcome').count(), 0, 'pas d\'accueil quand un fichier est ouvert');
assert.equal(await title(), 'tp-nat.netcanvas — NetCanvas');

step('modification : titre marqué, Enregistrer réécrit le fichier');
await page.fill('#name', 'TP NAT corrigé');
await page.waitForFunction(() => document.title.startsWith('• '));
await menu('save');
await page.waitForFunction(() => !document.title.startsWith('• '));
assert.equal(JSON.parse(readFileSync(file, 'utf8')).name, 'TP NAT corrigé');

step('Enregistrer sous (boîte de dialogue simulée), fichier récent');
const copy = join(dir, 'copie');
await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, copy);
await menu('save-as');
await page.waitForFunction(() => document.title.includes('copie.netcanvas'));
assert.equal(JSON.parse(readFileSync(`${copy}.netcanvas`, 'utf8')).devices.length, NAT_DEMO.devices.length);
const recent = await page.evaluate(() => window.netcanvas.recentFiles());
assert.deepEqual(recent.map((r) => r.name), ['copie.netcanvas', 'tp-nat.netcanvas']);

step('accueil depuis le menu : exemples et récents');
await menu('welcome');
assert.ok(await page.locator('.welcome-recents').getByText('tp-nat.netcanvas').isVisible());
await page.locator('.welcome .example', { hasText: 'OSPFv3' }).click();
await page.waitForFunction(() => document.title.includes('NetCanvas') && !document.querySelector('.welcome'));

step('fermeture avec modifications : question, « Ne pas enregistrer » ferme');
await page.fill('#name', 'brouillon');
await page.waitForFunction(() => document.title.startsWith('• '));
await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
const closed = app.waitForEvent('close');
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
await closed;
assert.deepEqual(errors, []);
console.log('OK');
