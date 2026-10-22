// Séance de TP en direct, contre le vrai projet Supabase : le prof lance la séance depuis un TP, deux étudiants la
// rejoignent, leur progression remonte dans le tableau du prof, puis clôture et suppression.
// Prérequis : npm run dev (avec .env) et la migration supabase/migrations/20261022000100_live_sessions.sql appliquée.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const APP = process.env.APP_URL || 'http://localhost:5173';
const step = (name) => console.log(`- ${name}`);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const errors = [];
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  return p;
};

step('prof : séance lancée depuis le TP inter-VLAN');
const prof = await newPage();
await prof.goto(APP);
await prof.locator('.welcome .example', { hasText: 'inter-VLAN en panne' }).click();
await prof.click('role=tab[name=/^TP/]');
await prof.click('role=button[name="Lancer une séance en direct…"]');
await prof.getByLabel('Titre de la séance').fill('Séance e2e inter-VLAN');
await prof.click('role=button[name="Lancer la séance"]');
const studentLink = await prof.getByLabel('Lien pour les étudiants').inputValue();
const adminLink = await prof.getByLabel(/Lien de suivi/).inputValue();
assert.match(studentLink, /\/\?live=[a-z0-9]{10}$/);
assert.ok(adminLink.startsWith(`${studentLink}#admin=`));
const liveId = new URL(studentLink).searchParams.get('live');
console.log(`  séance : ${liveId}`);

step('étudiante : nom, bandeau, progression envoyée (sans note ni chrono)');
const alice = await newPage();
await alice.goto(studentLink);
await alice.getByText(/Séance de TP en direct/).waitFor();
await alice.getByLabel('Ton nom et prénom').fill('Alice Martin');
await alice.click('role=button[name="Rejoindre la séance"]');
await alice.locator('.exam-banner', { hasText: 'Alice Martin' }).waitFor();
assert.equal(await alice.locator('.exam-clock').count(), 0, 'pas de chrono');
await alice.click('role=tab[name=/^TP/]');
assert.ok(await alice.locator('.tp-objectives li').count() > 0, 'objectifs visibles');
// Reprise après rechargement : même place, pas de nouvelle saisie du nom
await alice.reload();
await alice.locator('.exam-banner', { hasText: 'Alice Martin' }).waitFor();

step('étudiant 2');
const bob = await newPage();
await bob.goto(studentLink);
await bob.getByLabel('Ton nom et prénom').fill('Bob Durand');
await bob.click('role=button[name="Rejoindre la séance"]');
await bob.locator('.exam-banner', { hasText: 'Bob Durand' }).waitFor();

step('prof : suivi en direct');
const dash = await newPage();
await dash.goto(adminLink);
await dash.locator('.live-table tbody tr').nth(1).waitFor({ timeout: 20000 });
const rows = await dash.locator('.live-table tbody tr').allTextContents();
assert.equal(rows.length, 2);
assert.ok(rows.some((r) => r.includes('Alice Martin')) && rows.some((r) => r.includes('Bob Durand')), rows.join(' / '));
assert.ok(await dash.getByText(/2 étudiants connectés/).isVisible());

step('clôture : un nouvel étudiant est refusé');
await dash.click('role=button[name="Clore la séance"]');
await dash.getByText('séance close').waitFor();
const late = await newPage();
await late.goto(studentLink);
await late.getByText('Cette séance est close').waitFor();

step('suppression : le lien ne marche plus');
await dash.click('role=button[name="Supprimer la séance"]');
const gone = await newPage();
await gone.goto(studentLink);
await gone.getByText(/n'existe pas/).waitFor();

assert.deepEqual(errors, []);
await browser.close();
console.log(`OK ${liveId}`);
