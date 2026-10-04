// Test du partage par lien contre la vraie base Supabase. Prérequis : `npm run dev` lancé.
// Crée un schéma partagé (à supprimer ensuite : son identifiant est affiché).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const APP = process.env.APP_URL || 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const step = (name) => console.log(`- ${name}`);

await page.goto(APP);
await page.evaluate(() => localStorage.clear());
await page.reload();

step('création du lien depuis une démo');
await page.click('summary:has-text("Démos")');
await page.click('role=menuitem[name="NAT / PAT (box, FAI, serveur publié)"]');
await page.click('role=button[name="Partager"]');
await page.waitForSelector('.share-dialog[open]');
const [view, edit] = await page.locator('.share-dialog .copy-row input').evaluateAll((els) => els.map((e) => e.value));
assert.match(view, /\/\?d=[a-z0-9]{10}$/);
assert.ok(edit.startsWith(`${view}#edit=`));
const id = new URL(view).searchParams.get('d');
console.log(`  identifiant : ${id}`);
assert.match(page.url(), /\?d=[a-z0-9]{10}#edit=/, 'l\'adresse devient le lien d\'édition');
await page.click('.share-dialog >> text=Fermer');

step('modification enregistrée en ligne');
const before = await page.locator('.share-banner').textContent();
await page.waitForTimeout(1100); // l'heure affichée change forcément
await page.fill('#name', 'TP NAT partagé');
await page.waitForFunction((b) => {
  const t = document.querySelector('.share-banner')?.textContent ?? '';
  return t !== b && t.includes('enregistré en ligne');
}, before, { timeout: 15000 });

step('lien de lecture : verrouillé, simulation possible');
const ro = await ctx.newPage();
await ro.goto(view);
await ro.waitForSelector('.share-banner:has-text("lecture seule")');
assert.equal(await ro.inputValue('#name'), 'TP NAT partagé');
const box = await ro.getByTestId('rf__node-r1').boundingBox();
// Position dans le plan (le glisser fait défiler la vue, mais l'équipement ne doit pas bouger)
const flowPos = () => ro.getByTestId('rf__node-r1').evaluate((el) => el.style.transform);
const pos0 = await flowPos();
await ro.mouse.move(box.x + 20, box.y + 20);
await ro.mouse.down();
await ro.mouse.move(box.x + 220, box.y + 120, { steps: 5 });
await ro.mouse.up();
assert.equal(await flowPos(), pos0, 'on ne peut pas déplacer');
await ro.getByTestId('rf__node-r1').click();
assert.ok(await ro.locator('.ro-fieldset').evaluate((f) => f.disabled), 'formulaires désactivés');
assert.equal(await ro.locator('role=button[name="Partager"]').count(), 0);
await ro.click('role=tab[name="Simulation"]');
await ro.selectOption('#sim-src', { label: 'PC Maison' });
await ro.selectOption('#sim-dst', { label: 'Serveur Internet · 198.51.100.10' });
await ro.click('text=Lancer le ping');
await ro.waitForSelector('.sim-verdict.ok', { timeout: 15000 });

step('lien d\'édition dans un autre onglet : on retrouve la modification');
const ed = await ctx.newPage();
await ed.goto(edit);
await ed.waitForSelector('.share-banner:has-text("enregistré en ligne")');
assert.equal(await ed.inputValue('#name'), 'TP NAT partagé');

step('retour au brouillon local : il n\'a pas été écrasé');
await page.click('text=Retour à mon brouillon');
assert.equal(new URL(page.url()).search, '');
assert.notEqual(await page.inputValue('#name'), 'TP NAT partagé');

step('lien inconnu');
const bad = await ctx.newPage();
await bad.goto(`${APP}/?d=zzzzzzzzzz`);
await bad.waitForSelector('.error:has-text("n\'existe pas")');

assert.deepEqual(errors, []);
console.log(`OK ${id}`);
await browser.close();
