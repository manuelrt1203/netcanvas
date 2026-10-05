// Collaboration en temps réel, contre le vrai Supabase Realtime : deux éditeurs et un lecteur sur un schéma partagé.
// Présence, modifications croisées sans écrasement, ajout d'équipement, sélection visible, lecteur en direct.
// Prérequis : npm run dev (avec .env).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = process.env.APP_URL || 'http://localhost:5173';
const step = (name) => console.log(`- ${name}`);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const errors = [];
const open = async (url) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  if (url) await p.goto(url);
  return p;
};
const label = (p, id) => p.getByTestId(`rf__node-${id}`).locator('.device-label');
const rename = async (p, id, text) => {
  await p.getByTestId(`rf__node-${id}`).click();
  await p.click('role=tab[name=/Propriétés/]');
  await p.getByLabel('Nom', { exact: true }).fill(text);
};

step('partage d\'un schéma, deux éditeurs et un lecteur');
const a = await open(APP);
await a.locator('.welcome .example', { hasText: '2 VLAN, 2 routeurs' }).click();
await a.click('role=button[name="Partager"]');
await a.waitForSelector('.share-dialog[open]');
const [view, edit] = await a.locator('.share-dialog .copy-row input').evaluateAll((els) => els.map((e) => e.value));
await a.click('.share-dialog >> role=button[name="Fermer"]');
const b = await open(edit);
const v = await open(view);
for (const p of [b, v]) await p.waitForFunction(() => /enregistré en ligne|lecture seule/.test(document.querySelector('.share-banner')?.textContent ?? ''), null, { timeout: 15000 });

step('présence : chaque éditeur voit l\'autre');
await a.locator('.people .person').first().waitFor({ timeout: 15000 });
await b.locator('.people .person').first().waitFor({ timeout: 15000 });

step('modifications croisées sur deux équipements : aucune n\'écrase l\'autre');
await rename(a, 'r1', 'R1 par A');
await rename(b, 'r2', 'R2 par B');
for (const p of [a, b]) {
  await label(p, 'r1').filter({ hasText: 'R1 par A' }).waitFor({ timeout: 10000 });
  await label(p, 'r2').filter({ hasText: 'R2 par B' }).waitFor({ timeout: 10000 });
}

step('ajout d\'un équipement par B, visible chez A et chez le lecteur');
const count = await a.locator('.react-flow__node').count();
await b.locator('.palette-item', { hasText: /^PC$/ }).click();
await a.waitForFunction((n) => document.querySelectorAll('.react-flow__node').length === n + 1, count, { timeout: 10000 });
await v.waitForFunction((n) => document.querySelectorAll('.react-flow__node').length === n + 1, count, { timeout: 10000 });
await label(v, 'r1').filter({ hasText: 'R1 par A' }).waitFor({ timeout: 10000 });
assert.equal(await v.locator('.app.read-only').count(), 1, 'le lecteur reste en lecture seule');

step('sélection visible : A voit l\'équipement sélectionné par B');
await b.getByTestId('rf__node-pc3').click();
await a.getByTestId('rf__node-pc3').locator('.device.peer-selected').waitFor({ timeout: 10000 });

step('attaque : un lecteur publie une fausse modification sur le canal de lecture, les éditeurs l\'ignorent');
{
  const { createClient } = await import('@supabase/supabase-js');
  const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_KEY);
  const id = new URL(view).searchParams.get('d');
  const ch = sb.channel(`nc-view-${id}`);
  await new Promise((resolve) => ch.subscribe((st) => st === 'SUBSCRIBED' && resolve()));
  await ch.send({ type: 'broadcast', event: 'patch', payload: { from: 'pirate', patch: { devices: { r1: null }, links: {} } } });
  await a.waitForTimeout(3000);
  assert.equal(await a.getByTestId('rf__node-r1').count(), 1, 'R1 n\'a pas été supprimé chez l\'éditeur A');
  assert.equal(await b.getByTestId('rf__node-r1').count(), 1, 'ni chez B');
  await sb.removeChannel(ch);
}

step('enregistré en ligne : un nouvel onglet voit tout');
await a.waitForTimeout(2500);
const c = await open(view);
await label(c, 'r1').filter({ hasText: 'R1 par A' }).waitFor({ timeout: 15000 });
await label(c, 'r2').filter({ hasText: 'R2 par B' }).waitFor({ timeout: 15000 });
assert.equal(await c.locator('.react-flow__node').count(), count + 1);

assert.deepEqual(errors, []);
await browser.close();
console.log(`OK ${new URL(view).searchParams.get('d')}`);
