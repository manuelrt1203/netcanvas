import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TP_INTERVLAN, DEMO } from './examples.js';
import { formatClock, gradeSubmission, gradesCsv, remainingSeconds } from './exam.js';

const template = { ...TP_INTERVLAN, settings: { duration: 30 } };
const at = (min) => new Date(Date.UTC(2026, 9, 6, 8, 0) + min * 60000).toISOString();

test('examen : note recalculée depuis la copie, objectifs du sujet, retard', () => {
  // Copie non réparée : objectifs du sujet évalués sur la copie
  const broken = gradeSubmission({ student: 'Alice', started_at: at(0), submitted_at: at(20), doc: TP_INTERVLAN }, template);
  assert.equal(broken.status, 'rendue');
  assert.ok(broken.score < broken.total);
  // Une copie qui retire tous ses objectifs n'y gagne rien : ce sont ceux du sujet qui comptent
  const cheat = gradeSubmission({ student: 'Bob', started_at: at(0), submitted_at: at(10), doc: { ...TP_INTERVLAN, exercise: { title: 'x', objectives: [] } } }, template);
  assert.equal(cheat.total, broken.total);
  assert.equal(cheat.score, broken.score);
  // Réseau qui marche (démo de référence) : tous les objectifs ping atteints
  const fixed = gradeSubmission({ student: 'Chloé', started_at: at(0), submitted_at: at(25), doc: DEMO }, template);
  assert.ok(fixed.score >= broken.score);
  assert.equal(fixed.minutes, 25);
  assert.equal(fixed.note, Math.round((200 * fixed.score) / fixed.total) / 10);
  // Retard : au-delà de 30 min + 1 min de tolérance
  assert.equal(gradeSubmission({ student: 'D', started_at: at(0), submitted_at: at(31), doc: DEMO }, template).late, false);
  assert.equal(gradeSubmission({ student: 'E', started_at: at(0), submitted_at: at(32), doc: DEMO }, template).status, 'en retard');
  // Pas encore rendue
  assert.equal(gradeSubmission({ student: 'F', started_at: at(0), submitted_at: null, doc: null }, template).status, 'en cours');
});

test('examen : CSV pour tableur, chrono calé sur le serveur', () => {
  const g = [gradeSubmission({ student: 'Martin; "Léa"', started_at: at(0), submitted_at: at(12.5), doc: DEMO }, template)];
  const csv = gradesCsv('TP inter-VLAN', g);
  assert.ok(csv.startsWith('﻿Examen;Étudiant;'));
  assert.match(csv, /TP inter-VLAN;"Martin; ""Léa""";\d+;\d+;[\d,]+;rendue;[^;]+;[^;]+;12,5\r\n$/);
  // Horloge du poste en avance de 2 h : l'écart corrige le chrono
  const offset = -2 * 3600000;
  assert.equal(remainingSeconds(at(0), 30, offset, new Date(at(10)).getTime() + 2 * 3600000), 20 * 60);
  assert.equal(remainingSeconds(at(0), 30, 0, new Date(at(45)).getTime()), 0);
  assert.equal(formatClock(605), '10:05');
});
