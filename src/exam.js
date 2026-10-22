// Mode examen : notation des copies, statut (en cours, rendue, en retard), export CSV, session de l'étudiant.
// La note est recalculée à partir du schéma rendu et des objectifs du SUJET (jamais ceux de la copie) :
// une copie ne peut pas se donner des points.
import { evaluateExercise } from './net/exercise.js';
import { variantOf } from './net/variant.js';

// Réglages d'un examen. La base ne conserve que durée, indices et progression : les options ajoutées depuis
// (variantes, sel, journal) voyagent dans le sujet lui-même, sous `examOptions`.
export const examSettings = (row) => ({ ...(row?.settings ?? {}), ...(row?.template?.examOptions ?? {}) });

// Objectifs de CET étudiant : ceux du sujet, adaptés à sa variante quand l'examen en a (voir net/variant.js)
export const exerciseFor = (template, student) => (template?.settings?.variants
  ? variantOf(template, template.settings.salt ?? '', student).doc.exercise
  : template.exercise);

export const LATE_GRACE = 60; // secondes de tolérance après la fin de l'épreuve

export function gradeSubmission(sub, template) {
  const minutes = Number(template?.settings?.duration ?? sub.duration ?? 0);
  const started = new Date(sub.started_at).getTime();
  const submitted = sub.submitted_at ? new Date(sub.submitted_at).getTime() : null;
  const late = submitted !== null && minutes > 0 && submitted > started + (minutes * 60 + LATE_GRACE) * 1000;
  const base = { student: sub.student, startedAt: sub.started_at, submittedAt: sub.submitted_at, late };
  if (!sub.doc || submitted === null) return { ...base, status: 'en cours', score: null, total: null, note: null, minutes: null, results: [] };
  const results = evaluateExercise({ ...sub.doc, exercise: exerciseFor(template, sub.student) });
  const score = results.filter((r) => r.ok).length;
  const total = results.length;
  // Note : points des objectifs atteints (poids de chacun, 1 par défaut) sur le total des points
  const points = results.reduce((a, r) => a + (r.ok ? r.weight : 0), 0);
  const max = results.reduce((a, r) => a + r.weight, 0);
  return {
    ...base,
    status: late ? 'en retard' : 'rendue',
    score, total, points, max,
    note: max ? Math.round((200 * points) / max) / 10 : null, // sur 20, au dixième
    minutes: Math.round((submitted - started) / 6000) / 10,
    results,
  };
}

// CSV pour un tableur (séparateur « ; », comme Excel en français)
export function gradesCsv(title, graded) {
  const q = (v) => (v === null || v === undefined ? '' : /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const fmt = (d) => (d ? new Date(d).toLocaleString('fr-FR') : '');
  // Détail par objectif : « O1 (×2) » = premier objectif, de poids 2 ; la case donne les points obtenus (0 si non atteint)
  const shape = graded.find((g) => g.results?.length)?.results ?? [];
  const detail = shape.map((r, i) => `O${i + 1}${r.weight !== 1 ? ` (×${r.weight})` : ''}`);
  const rows = [['Examen', 'Étudiant', 'Objectifs atteints', 'Objectifs', 'Note /20', 'Statut', 'Début', 'Remise', 'Durée (min)', ...detail]];
  for (const g of graded) {
    rows.push([title, g.student, g.score, g.total, g.note === null ? '' : String(g.note).replace('.', ','), g.status, fmt(g.startedAt), fmt(g.submittedAt), g.minutes === null ? '' : String(g.minutes).replace('.', ','),
      ...shape.map((_, i) => (g.results?.[i] ? (g.results[i].ok ? g.results[i].weight : 0) : ''))]);
  }
  return `﻿${rows.map((r) => r.map(q).join(';')).join('\r\n')}\r\n`;
}

// Secondes restantes : départ (serveur) + durée, avec l'écart entre l'horloge du poste et celle du serveur
export const remainingSeconds = (startedAt, minutes, offsetMs, now = Date.now()) =>
  Math.max(0, Math.floor((new Date(startedAt).getTime() + minutes * 60000 - (now + offsetMs)) / 1000));

export const formatClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// Session de l'étudiant sur ce poste : identifiant du poste, nom, départ, copie en cours (reprise après rechargement)
const key = (id) => `netcanvas:exam:${id}`;
export function examSession(id) {
  try {
    return JSON.parse(localStorage.getItem(key(id)) ?? 'null');
  } catch {
    return null;
  }
}
export function saveExamSession(id, session) {
  try {
    localStorage.setItem(key(id), JSON.stringify(session));
  } catch {
    /* stockage indisponible : la copie reste en mémoire jusqu'à la remise */
  }
}
export const newClientId = () => `poste-${crypto.randomUUID()}`;
