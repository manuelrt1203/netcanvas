// Mode examen, contre le vrai projet Supabase : le prof crée l'examen depuis un TP, une étudiante rend sa copie,
// une autre est ramassée automatiquement à la fin du temps (examen d'1 minute), puis suivi, copie, CSV et clôture.
// Prérequis : npm run dev (avec .env). Dure environ 2 minutes (attente de la fin du temps).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = process.env.APP_URL || 'http://localhost:5173';
const step = (name) => console.log(`- ${name}`);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const errors = [];
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  return p;
};

step('prof : examen d\'1 minute créé depuis le TP inter-VLAN');
const prof = await newPage();
await prof.goto(APP);
await prof.locator('.welcome .example', { hasText: 'inter-VLAN en panne' }).click();
await prof.click('role=tab[name=/^TP/]');
await prof.click('role=button[name="Créer un examen chronométré…"]');
await prof.getByLabel('Titre').fill('Examen e2e inter-VLAN');
await prof.getByLabel('Durée (minutes)').fill('1');
await prof.click('role=button[name="Créer l\'examen"]');
const studentLink = await prof.getByLabel('Lien pour les étudiants').inputValue();
const adminLink = await prof.getByLabel(/Lien de suivi/).inputValue();
assert.match(studentLink, /\/\?exam=[a-z0-9]{10}$/);
assert.ok(adminLink.startsWith(`${studentLink}#admin=`));
const examId = new URL(studentLink).searchParams.get('exam');
console.log(`  examen : ${examId}`);

step('étudiante 1 : nom, épreuve, objectifs sans statut, remise');
const alice = await newPage();
await alice.goto(studentLink);
await alice.getByText('Durée : 1 minutes').waitFor();
await alice.getByLabel('Ton nom et prénom').fill('Alice Martin');
await alice.click('role=button[name="Commencer l\'épreuve"]');
await alice.locator('.exam-clock').waitFor();
assert.equal(await alice.locator('summary:has-text("Fichier")').count(), 0, 'pas de menu Fichier pendant l\'épreuve');
await alice.click('role=tab[name=/^TP/]');
assert.ok(await alice.getByText('la vérification des objectifs est masquée').isVisible());
assert.equal(await alice.locator('.tp-objectives li.ok').count(), 0, 'aucun statut affiché');
assert.equal(await alice.getByRole('button', { name: 'Indice' }).count(), 0, 'pas d\'indice');
// Reprise après rechargement : même chrono (départ du serveur)
const before = await alice.locator('.exam-clock').textContent();
await alice.reload();
await alice.locator('.exam-clock').waitFor();
assert.ok((await alice.locator('.exam-clock').textContent()) <= before, 'le chrono ne repart pas de zéro');
await alice.click('role=button[name="Rendre ma copie"]');
await alice.getByText(/Copie rendue à/).waitFor();
assert.equal(await alice.locator('.app.read-only').count(), 1, 'copie verrouillée');

step('étudiant 2 : ramassé automatiquement à la fin du temps');
const bob = await newPage();
await bob.goto(studentLink);
await bob.getByLabel('Ton nom et prénom').fill('Bob Durand');
await bob.click('role=button[name="Commencer l\'épreuve"]');
await bob.getByText(/Copie rendue à/).waitFor({ timeout: 90000 });

step('suivi du prof : notes recalculées, copie, CSV, clôture');
await prof.goto(adminLink);
await prof.locator('.exam-table tbody tr').nth(1).waitFor();
const rows = await prof.locator('.exam-table tbody tr').allTextContents();
assert.equal(rows.length, 2);
assert.ok(rows.every((r) => /\/20/.test(r) && /rendue/.test(r)), rows.join('\n'));
const [download] = await Promise.all([prof.waitForEvent('download'), prof.click('role=button[name="Exporter les notes (CSV)"]')]);
const csv = readFileSync(await download.path(), 'utf8');
assert.match(csv, /Examen e2e inter-VLAN;Alice Martin;\d+;\d+;[\d,]+;rendue/);
await prof.locator('.exam-table tr', { hasText: 'Alice Martin' }).getByRole('button', { name: 'Voir la copie' }).click();
await prof.getByText('Copie de Alice Martin').waitFor();
assert.equal(await prof.locator('.app.read-only').count(), 1);
await prof.click('role=button[name="Retour au suivi"]');
await prof.click('role=button[name="Clore l\'examen"]');
await prof.getByText('examen clos').waitFor();
const late = await newPage();
await late.goto(studentLink);
await late.getByText('Cet examen est clos').waitFor();

assert.deepEqual(errors, []);
await browser.close();
console.log(`OK ${examId}`);
