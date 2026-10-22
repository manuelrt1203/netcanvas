// Journal d'actions d'une épreuve : commandes tapées, modifications du schéma, collages, sorties de la fenêtre.
// Il est enregistré sur le poste de l'étudiant et remis avec la copie. C'est un INDICE pour le prof, pas une preuve :
// un poste modifié peut le désactiver, et rien ne voit un autre appareil.
export const LOG_MAX = 600;
const TEXT_MAX = 120;

// Entrée : { t: secondes depuis le début, k: genre, x: texte, n: répétitions }
export const cut = (text, max = TEXT_MAX) => (String(text).length > max ? `${String(text).slice(0, max - 1)}…` : String(text));

// Ajoute une entrée en fusionnant une répétition proche (saisie dans un formulaire = beaucoup de petites modifications)
export function pushEntry(log, entry) {
  const last = log.at(-1);
  if (last && last.k === entry.k && last.x === entry.x && entry.t - (last.t + (last.span ?? 0)) <= 10 && entry.k === 'edit') {
    return [...log.slice(0, -1), { ...last, n: (last.n ?? 1) + 1, span: entry.t - last.t }];
  }
  if (log.length >= LOG_MAX) return log.at(-1)?.k === 'stop' ? log : [...log, { t: entry.t, k: 'stop', x: 'Journal plein : la suite n\'est pas enregistrée.' }];
  return [...log, { ...entry, x: cut(entry.x) }];
}

// Résumé d'une modification du schéma (null si seule la position a changé)
export function summarizeEdit(prev, next) {
  if (!prev || !next || prev === next) return null;
  const label = (d) => d.label ?? d.id;
  const before = new Map(prev.devices.map((d) => [d.id, d]));
  const after = new Map(next.devices.map((d) => [d.id, d]));
  const parts = [];
  const added = next.devices.filter((d) => !before.has(d.id)).map(label);
  const removed = prev.devices.filter((d) => !after.has(d.id)).map(label);
  if (added.length) parts.push(`ajout : ${added.join(', ')}`);
  if (removed.length) parts.push(`retrait : ${removed.join(', ')}`);
  const dl = next.links.length - prev.links.length;
  if (dl) parts.push(`${dl > 0 ? '+' : ''}${dl} câble${Math.abs(dl) > 1 ? 's' : ''}`);
  for (const d of next.devices) {
    const o = before.get(d.id);
    if (!o) continue;
    const keys = [...new Set([...Object.keys(o.config ?? {}), ...Object.keys(d.config ?? {})])]
      .filter((k) => JSON.stringify(o.config?.[k]) !== JSON.stringify(d.config?.[k]));
    if (keys.length) parts.push(`${label(d)} : ${keys.join(', ')}`);
    if (o.label !== d.label) parts.push(`${label(o)} renommé`);
  }
  return parts.length ? parts.join(' · ') : null;
}

// Lecture du journal pour le prof
export function analyzeLog(log = []) {
  const count = (k) => log.filter((e) => e.k === k);
  const sum = (list, f) => list.reduce((a, e) => a + f(e), 0);
  const commands = count('cmd');
  const pastes = count('paste');
  const copies = count('copy');
  const outs = count('out');
  // Rafale : plus de commandes en 10 secondes qu'on n'en tape
  let burst = 0;
  for (let i = 0; i < commands.length; i += 1) {
    let j = i;
    while (j + 1 < commands.length && commands[j + 1].t - commands[i].t <= 10) j += 1;
    burst = Math.max(burst, j - i + 1);
  }
  const out = { commands: commands.length, edits: sum(count('edit'), (e) => e.n ?? 1), pastes: pastes.length, pastedChars: sum(pastes, (e) => e.len ?? 0), copies: copies.length, outs: outs.length, outSeconds: sum(outs, (e) => e.dur ?? 0), burst, flags: [] };
  if (pastes.some((e) => (e.len ?? 0) >= 40)) out.flags.push(`${pastes.length} collage${pastes.length > 1 ? 's' : ''} (${out.pastedChars} caractères)`);
  if (copies.length) out.flags.push(`${copies.length} texte${copies.length > 1 ? 's' : ''} copié${copies.length > 1 ? 's' : ''} depuis la page`);
  if (outs.length >= 3 || out.outSeconds >= 120) out.flags.push(`${outs.length} sortie${outs.length > 1 ? 's' : ''} de la fenêtre (${out.outSeconds} s au total)`);
  if (burst >= 8) out.flags.push(`${burst} commandes en 10 secondes`);
  return out;
}

export function logSummary(log) {
  if (!Array.isArray(log) || !log.length) return null;
  const a = analyzeLog(log);
  return { text: `${a.commands} cmd · ${a.pastes} collage${a.pastes > 1 ? 's' : ''} · ${a.outs} sortie${a.outs > 1 ? 's' : ''}`, flags: a.flags };
}

export const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
