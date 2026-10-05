// Comptes et historique, contre le vrai projet Supabase : connexion, partage rattaché au compte,
// versions (création, restauration), réouverture sans lien d'édition, « Mes schémas », suppression.
// Prérequis : npm run dev ; un compte confirmé : NETCANVAS_TEST_EMAIL et NETCANVAS_TEST_PASSWORD.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const APP = process.env.APP_URL || 'http://localhost:5173';
const EMAIL = process.env.NETCANVAS_TEST_EMAIL;
const PASSWORD = process.env.NETCANVAS_TEST_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('NETCANVAS_TEST_EMAIL et NETCANVAS_TEST_PASSWORD sont requis');
const step = (name) => console.log(`- ${name}`);
const NAME = `Schéma e2e ${Date.now()}`; // unique : une exécution interrompue ne gêne pas la suivante

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(`${NAME} renommé`) : d.accept()));
const saved = () => page.waitForFunction(() => /enregistré en ligne/.test(document.querySelector('.share-banner')?.textContent ?? ''), null, { timeout: 15000 });

await page.goto(APP);
await page.evaluate(() => localStorage.clear());
await page.reload();

step('connexion (mauvais mot de passe, puis bon)');
await page.click('.welcome >> role=button[name="Se connecter"]');
const dlg = page.locator('.account-dialog');
await dlg.getByLabel('Adresse e-mail').fill(EMAIL);
await dlg.getByLabel('Mot de passe').fill('mauvais-mot-de-passe');
await dlg.getByRole('button', { name: 'Se connecter' }).click();
await dlg.getByText('e-mail ou mot de passe incorrect').waitFor();
await dlg.getByLabel('Mot de passe').fill(PASSWORD);
await dlg.getByRole('button', { name: 'Se connecter' }).click();
await dlg.getByText(`Connecté en tant que ${EMAIL}`).waitFor();
await dlg.getByRole('button', { name: 'Fermer' }).click();

step('partage d\'un exemple : il appartient au compte');
// L'accueil est resté ouvert derrière la fenêtre de compte
assert.ok(await page.locator('.welcome').getByRole('button', { name: 'Mes schémas en ligne' }).isVisible());
await page.locator('.welcome .example', { hasText: 'DHCP (serveur et relais)' }).click();
await page.fill('#name', NAME);
await page.click('role=button[name="Partager"]');
await page.waitForSelector('.share-dialog[open]');
const view = await page.locator('.share-dialog .copy-row input').first().inputValue();
const id = new URL(view).searchParams.get('d');
assert.ok(await page.getByText('Ce schéma est dans ton compte').isVisible());

step('historique : version nommée, modification, restauration');
const share = page.locator('.share-dialog');
await share.getByPlaceholder(/Nom de la version/).fill('avant modif');
await share.getByRole('button', { name: 'Créer une version' }).click();
await share.locator('.version-list li', { hasText: 'avant modif' }).waitFor();
await share.getByRole('button', { name: 'Fermer' }).click();
await page.fill('#name', 'Schéma modifié');
await saved();
await page.waitForTimeout(500);
await page.click('role=button[name="Liens et historique"]');
await share.locator('.version-list li', { hasText: 'avant modif' }).getByRole('button', { name: 'Restaurer' }).click();
await page.waitForFunction((n) => document.querySelector('#name').value === n, NAME);
await share.locator('.version-list li', { hasText: 'avant restauration' }).waitFor();
await share.getByRole('button', { name: 'Fermer' }).click();
await saved();

step('réouverture par le lien de lecture : modifiable car c\'est mon schéma');
const other = await ctx.newPage();
await other.goto(`${APP}/?d=${id}`);
await other.waitForFunction(() => /Schéma de ton compte/.test(document.querySelector('.share-banner')?.textContent ?? ''), null, { timeout: 15000 });
assert.equal(await other.locator('.app.read-only').count(), 0, 'propriétaire : pas en lecture seule');
await other.close();

step('Mes schémas : présent, renommer, supprimer');
await page.click('role=button[name="Mon compte"]');
const row = dlg.locator('.my-diagrams li', { hasText: NAME });
await row.waitFor();
await row.getByRole('button', { name: 'Renommer' }).click();
const renamed = dlg.locator('.my-diagrams li', { hasText: `${NAME} renommé` });
await renamed.waitFor();
await renamed.getByRole('button', { name: 'Supprimer' }).click();
await renamed.waitFor({ state: 'detached' });

step('déconnexion');
await dlg.getByRole('button', { name: 'Se déconnecter' }).click();
await dlg.getByRole('button', { name: 'Se connecter' }).waitFor();
assert.deepEqual(errors, []);
await browser.close();
console.log('OK');
