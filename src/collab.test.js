import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO } from './examples.js';
import { applyPatch, diffDocs } from './collab.js';

const clone = () => structuredClone(DEMO);

test('collaboration : différences par équipement et câble, application sans écraser les autres', () => {
  assert.equal(diffDocs(DEMO, clone()), null, 'rien ne change : rien à envoyer');
  // A renomme R1, B déplace PC Compta : les deux modifications coexistent
  const a = clone();
  a.devices.find((d) => d.id === 'r1').label = 'R1 renommé';
  const b = clone();
  b.devices.find((d) => d.id === 'pc1').position = { x: 1, y: 2 };
  const pa = diffDocs(DEMO, a);
  const pb = diffDocs(DEMO, b);
  assert.deepEqual(Object.keys(pa.devices), ['r1']);
  assert.deepEqual(Object.keys(pb.devices), ['pc1']);
  const merged = applyPatch(applyPatch(DEMO, pa), pb);
  assert.equal(merged.devices.find((d) => d.id === 'r1').label, 'R1 renommé');
  assert.deepEqual(merged.devices.find((d) => d.id === 'pc1').position, { x: 1, y: 2 });
  assert.deepEqual(merged.devices.map((d) => d.id), DEMO.devices.map((d) => d.id), 'ordre conservé');
  // Ajout et suppression
  const c = clone();
  c.devices.push({ id: 'pc9', type: 'pc', model: 'PC-PT', label: 'Nouveau', position: { x: 0, y: 0 }, config: {} });
  c.links = c.links.filter((l) => l.id !== 'l1');
  c.name = 'Autre nom';
  const pc = diffDocs(DEMO, c);
  assert.equal(pc.links.l1, null);
  assert.equal(pc.name, 'Autre nom');
  const after = applyPatch(DEMO, pc);
  assert.ok(after.devices.some((d) => d.id === 'pc9'));
  assert.ok(!after.links.some((l) => l.id === 'l1'));
  assert.equal(diffDocs(after, c), null, 'après application : identiques');
});
