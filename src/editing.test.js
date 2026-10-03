import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, copySelection, duplicate, nextLabel, search } from './editing.js';
import { fromJSON, toJSON } from './serialize.js';
import { BGP_DEMO } from './examples.js';
import { simulatePing } from './net/simulate.js';
import { validate } from './net/validate.js';

test('nextLabel : numéro suivant libre', () => {
  assert.equal(nextLabel('R1', new Set(['R1', 'R2'])), 'R3');
  assert.equal(nextLabel('PC Compta', new Set(['PC Compta'])), 'PC Compta 2');
  assert.equal(nextLabel('SW 9', new Set()), 'SW 10');
});

test('copier-coller : équipements, câbles internes et config, nouveaux identifiants', () => {
  const { nodes, edges } = fromJSON(structuredClone(BGP_DEMO));
  for (const n of nodes) n.selected = ['r1', 'sw1', 'pc1'].includes(n.id);
  const clip = copySelection(nodes, edges);
  assert.equal(clip.nodes.length, 3);
  assert.deepEqual(clip.edges.map((e) => e.id).sort(), ['b1', 'b2']); // pas le câble vers R2

  const pasted = duplicate(clip, nodes);
  assert.deepEqual(pasted.nodes.map((n) => n.data.label), ['PC AS65002', 'SW AS65003', 'R1 (AS 65001) 2']);
  assert.ok(pasted.nodes.every((n) => !nodes.some((m) => m.id === n.id) && n.selected));
  const r1copy = pasted.nodes.find((n) => n.type === 'router');
  assert.deepEqual(r1copy.data.bgp, nodes.find((n) => n.id === 'r1').data.bgp);
  assert.deepEqual(r1copy.position, { x: 32, y: 128 });
  const ids = new Set(pasted.nodes.map((n) => n.id));
  assert.ok(pasted.edges.every((e) => ids.has(e.source) && ids.has(e.target) && e.data.cable));

  // Les adresses sont copiées telles quelles : conflit avec l'original, signalé et sans plantage
  const doc = toJSON([...nodes.map((n) => ({ ...n, selected: false })), ...pasted.nodes], [...edges, ...pasted.edges], 'x');
  const pcCopy = pasted.nodes.find((n) => n.type === 'pc').id;
  assert.ok(simulatePing(doc, pcCopy, '192.168.1.1').ok); // l'îlot copié fonctionne seul
  assert.match(validate(doc).map((i) => i.text).join('\n'), /Adresse 192\.168\.1\.10 en double/);
});

test('aligner et répartir', () => {
  const n = (id, x, y) => ({ id, selected: true, position: { x, y }, data: {} });
  const row = arrange([n('a', 0, 0), n('b', 100, 50), n('c', 300, 100), { ...n('z', 9, 9), selected: false }], 'row');
  assert.deepEqual(row.map((x) => x.position.y), [50, 50, 50, 9]);
  const spread = arrange([n('a', 0, 0), n('b', 10, 0), n('c', 300, 0)], 'spread-x');
  assert.deepEqual(spread.map((x) => x.position.x), [0, 150, 300]);
});

test('recherche par nom, modèle ou IP', () => {
  assert.deepEqual(search(BGP_DEMO, '10.0.23').map((r) => r.id), ['r2', 'r3']);
  assert.equal(search(BGP_DEMO, 'ccr')[0].id, 'r3');
  assert.equal(search(BGP_DEMO, 'serveur')[0].id, 'srv');
  assert.deepEqual(search(BGP_DEMO, ''), []);
});
