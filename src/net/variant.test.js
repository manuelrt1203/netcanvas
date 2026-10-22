import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, OSPF_DEMO, TP_CAMPUS, TP_INTERVLAN, TP_OSPF } from '../examples.js';
import { evaluateExercise } from './exercise.js';
import { examSettings, gradeSubmission, exerciseFor } from '../exam.js';
import { makeVariant, normalizeName, variantOf, variantSupport } from './variant.js';

const oks = (doc) => evaluateExercise(doc).map((r) => r.ok);
const withExercise = (doc, exercise) => ({ ...structuredClone(doc), exercise });

test('variante : même comportement, autres adresses, consigne et objectifs suivent', () => {
  for (const tp of [TP_INTERVLAN, TP_OSPF, TP_CAMPUS]) {
    const v = makeVariant(tp, 'etudiant-1');
    assert.ok(v.applied, tp.name);
    assert.notEqual(JSON.stringify(v.doc.devices), JSON.stringify(tp.devices), `${tp.name} : schéma inchangé`);
    assert.deepEqual(oks(v.doc), oks(tp), tp.name);
    assert.equal(v.doc.exercise.objectives.length, tp.exercise.objectives.length);
  }
});

test('variante : déterministe, et différente d\'un étudiant à l\'autre', () => {
  const a = makeVariant(TP_INTERVLAN, 'sel|alice');
  assert.equal(JSON.stringify(makeVariant(TP_INTERVLAN, 'sel|alice').doc), JSON.stringify(a.doc));
  const seeds = ['bob', 'chloe', 'david', 'emma', 'farid', 'gaelle'].map((n) => JSON.stringify(makeVariant(TP_INTERVLAN, `sel|${n}`).doc.exercise));
  assert.ok(new Set([JSON.stringify(a.doc.exercise), ...seeds]).size >= 6, 'les étudiants ont des objectifs différents');
});

test('variante : un sujet réparé reste entièrement réussi', () => {
  const repaired = withExercise(DEMO, TP_INTERVLAN.exercise);
  assert.deepEqual(oks(repaired), [true, true, true, true]);
  for (const n of ['a', 'b', 'c', 'd']) {
    const v = makeVariant(repaired, `sel|${n}`);
    assert.ok(v.applied);
    assert.deepEqual(oks(v.doc), [true, true, true, true], n);
  }
  const ospf = withExercise(OSPF_DEMO, TP_OSPF.exercise);
  const before = oks(ospf);
  assert.deepEqual(oks(makeVariant(ospf, 'sel|x').doc), before);
});

test('variante : VLAN renumérotés partout (ports, trunks, SVI, STP) sans toucher 1', () => {
  const v = makeVariant(TP_CAMPUS, 'sel|vlan', { levels: [{ name: 'VLAN', ip: false, vlan: true, second: false }] });
  assert.equal(v.applied, 'VLAN');
  const ids = (doc) => doc.devices.flatMap((d) => (d.config?.vlans ?? []).map((x) => x.id));
  assert.notDeepEqual(ids(v.doc), ids(TP_CAMPUS));
  const core = v.doc.devices.find((d) => d.id === 'core').config;
  const newIds = core.vlans.map((x) => x.id);
  // Les trunks n'autorisent que des VLAN qui existent encore, le VLAN natif suit, les priorités STP aussi
  for (const p of core.ports.filter((x) => x.mode === 'trunk')) {
    assert.ok(p.allowedVlans.every((n) => newIds.includes(n)));
    assert.ok(newIds.includes(p.nativeVlan));
  }
  assert.deepEqual(Object.keys(core.stp.priority).map(Number).filter((n) => n !== 1).sort(), [...newIds].sort());
  assert.equal(core.stp.priority['1'], 4096);
  assert.deepEqual(oks(v.doc), oks(TP_CAMPUS));
});

test('variante : sans objectif, le sujet reste tel quel', () => {
  const bare = structuredClone(DEMO);
  assert.equal(makeVariant(bare, 's').applied, null);
  assert.equal(makeVariant(bare, 's').doc, bare);
});

test('variantSupport : ce que le sujet permet de changer', () => {
  assert.deepEqual(variantSupport(TP_INTERVLAN), { ip: true, vlan: true });
  assert.equal(variantSupport(TP_OSPF).ip, true);
});

test('normalizeName : accents, casse et espaces ignorés', () => {
  assert.equal(normalizeName('  Élodie   DUPONT '), 'elodie dupont');
});

test('notation : les objectifs de la variante de l\'étudiant, pas ceux du sujet', () => {
  const salt = 'sel42';
  const template = { ...withExercise(DEMO, TP_INTERVLAN.exercise), settings: { duration: 60, variants: true, salt } };
  const sub = { student: 'Élodie Dupont', started_at: '2026-10-22T08:00:00Z', submitted_at: '2026-10-22T08:30:00Z' };
  // L'étudiant reçoit sa variante (sujet réparé pour l'exemple) : tous les objectifs passent
  const mine = variantOf(template, salt, sub.student).doc;
  assert.deepEqual(oks(mine), [true, true, true, true]);
  const good = gradeSubmission({ ...sub, doc: mine }, template);
  assert.equal(good.score, 4);
  // La copie d'un voisin (autre variante, mêmes réparations) ne valide pas les objectifs de cet étudiant
  const neighbour = variantOf(template, salt, 'Bob Martin').doc;
  const copied = gradeSubmission({ ...sub, doc: neighbour }, template);
  assert.ok(copied.score < 4, `copie du voisin : ${copied.score}/4`);
  // Même nom écrit autrement : même variante
  assert.equal(JSON.stringify(exerciseFor(template, '  elodie  DUPONT')), JSON.stringify(exerciseFor(template, sub.student)));
  // Sans variantes : objectifs du sujet
  assert.equal(exerciseFor({ ...template, settings: { variants: false } }, 'x'), template.exercise);
});

test('réglages : durée, indices et progression viennent de la base, le reste du sujet (examOptions)', () => {
  const row = { settings: { duration: 30, hints: false, progress: true }, template: { examOptions: { variants: true, salt: 'abc', log: true } } };
  assert.deepEqual(examSettings(row), { duration: 30, hints: false, progress: true, variants: true, salt: 'abc', log: true });
  assert.deepEqual(examSettings({ settings: { duration: 10 }, template: {} }), { duration: 10 });
  // Les options n'entrent pas dans le calcul de la variante : même variante avec ou sans elles
  const tp = withExercise(DEMO, TP_INTERVLAN.exercise);
  const a = variantOf({ ...tp, examOptions: { variants: true, salt: 'vlan 20' } }, 'sel', 'Alice');
  const b = variantOf(tp, 'sel', 'Alice');
  assert.equal(JSON.stringify(a.doc), JSON.stringify(b.doc));
});
