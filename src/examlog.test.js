import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO } from './examples.js';
import { LOG_MAX, analyzeLog, cut, logSummary, pushEntry, summarizeEdit } from './examlog.js';

const doc = () => ({ devices: structuredClone(DEMO.devices), links: structuredClone(DEMO.links) });

test('journal : les modifications répétées se fondent en une ligne', () => {
  let log = [];
  for (let t = 10; t < 16; t += 1) log = pushEntry(log, { t, k: 'edit', x: 'R1 : interfaces' });
  log = pushEntry(log, { t: 40, k: 'edit', x: 'R1 : interfaces' }); // trop tard : nouvelle ligne
  assert.equal(log.length, 2);
  assert.equal(log[0].n, 6);
  assert.equal(log[1].n, undefined);
});

test('journal : les textes longs sont coupés, le journal est plafonné', () => {
  assert.equal(cut('x'.repeat(300)).length, 120);
  let log = [];
  for (let i = 0; i < LOG_MAX + 50; i += 1) log = pushEntry(log, { t: i, k: 'cmd', x: `c${i}` });
  assert.equal(log.length, LOG_MAX + 1);
  assert.equal(log.at(-1).k, 'stop');
});

test('modification du schéma : seulement ce qui a changé (pas les déplacements)', () => {
  const a = doc();
  const b = doc();
  assert.equal(summarizeEdit(a, b), null);
  const r1 = b.devices.find((d) => d.id === 'r1');
  r1.config = { ...r1.config, routes: [] };
  assert.equal(summarizeEdit(a, b), 'R1 : routes');
  b.devices.pop();
  assert.match(summarizeEdit(a, b), /retrait : Internet/);
});

test('analyse : collages, copies, sorties et rafales sont signalés', () => {
  const calm = [
    { t: 5, k: 'cmd', x: 'R1 › show ip route' }, { t: 60, k: 'cmd', x: 'R1 › conf t' }, { t: 120, k: 'cmd', x: 'R1 › ip route 0.0.0.0 0.0.0.0 10.0.0.2' },
  ];
  assert.deepEqual(analyzeLog(calm).flags, []);
  assert.equal(logSummary(calm).text, '3 cmd · 0 collage · 0 sortie');
  const suspect = [
    { t: 30, k: 'paste', x: 'collé', len: 420 },
    { t: 31, k: 'copy', x: 'copié', len: 80 },
    { t: 40, k: 'out', x: 'sortie', dur: 90 }, { t: 200, k: 'out', x: 'sortie', dur: 20 }, { t: 400, k: 'out', x: 'sortie', dur: 30 },
    ...Array.from({ length: 9 }, (_, i) => ({ t: 500 + i, k: 'cmd', x: `c${i}` })),
  ];
  const a = analyzeLog(suspect);
  assert.equal(a.pastes, 1);
  assert.equal(a.burst, 9);
  assert.equal(a.outSeconds, 140);
  assert.equal(a.flags.length, 4);
  assert.match(a.flags[0], /1 collage \(420 caractères\)/);
  // Un petit collage (un mot) n'est pas signalé
  assert.deepEqual(analyzeLog([{ t: 1, k: 'paste', x: 'x', len: 6 }]).flags, []);
  assert.equal(logSummary([]), null);
});
