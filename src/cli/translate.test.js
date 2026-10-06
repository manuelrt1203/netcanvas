import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMOS } from '../examples.js';
import { shellFor } from './index.js';
import { importConfig } from './import.js';
import { defaultMapping, detectDialect, dialectOf, readForeign, translateConfig, translatedSummary } from './translate.js';
import { computeRouting, prefixText } from '../net/routing.js';
import { devicePorts, isDataMedia, isMikrotik, modelId } from '../net/catalog.js';

// Config affichée par l'équipement : show running-config, /export ou vtysh
function running(dev, doc) {
  const sh = shellFor(dev);
  const s = sh.newSession(dev);
  if (isMikrotik(dev)) return sh.run(s, '/export', structuredClone(dev), doc).out.join('\n');
  if (dialectOf(dev) === 'ios') sh.run(s, 'enable', structuredClone(dev), doc);
  return sh.run(s, 'show running-config', structuredClone(dev), doc).out.join('\n');
}
const blank = (dev) => ({ ...dev, config: { interfaces: [], routes: [] } });
const TARGETS = { ios: 'c7200', routeros7: 'CHR', routeros6: 'CHR-6.49', frr: 'FRR' };
// Routes apprises (hors connectées) de chaque routeur : préfixe -> saut suivant
const learned = (doc, skip) => Object.fromEntries([...computeRouting(doc).ribs].filter(([id]) => id !== skip).map(([id, rib]) => [id,
  Object.fromEntries([...rib.values()].filter((r) => r.nextHop).map((r) => [prefixText(r.net, r.mask), r.nextHop]).sort())]));

test('détection de la marque d\'une config collée', () => {
  assert.equal(detectDialect('hostname R1\ninterface FastEthernet0/0\n ip address 10.0.0.1 255.255.255.0'), 'ios');
  assert.equal(detectDialect('frr version 7.5.1\ninterface eth0\n ip address 10.0.0.1/24'), 'frr');
  assert.equal(detectDialect('interface eth0\n ip address 10.0.0.1/24\nrouter ospf\n network 10.0.0.0/24 area 0'), 'frr');
  assert.equal(detectDialect('/ip address\nadd address=10.0.0.1/24 interface=ether1\n/routing ospf interface-template\nadd networks=10.0.0.0/24'), 'routeros7');
  assert.equal(detectDialect('/routing ospf network\nadd network=10.0.0.0/24 area=backbone'), 'routeros6');
});

test('traduction entre marques : chaque routeur des démos vers Cisco, RouterOS v7, RouterOS v6 et FRR', () => {
  let count = 0;
  let equivalent = 0;
  for (const { doc, label } of DEMOS) {
    for (const dev of doc.devices.filter((d) => d.type === 'router')) {
      const text = running(dev, doc);
      const from = detectDialect(text);
      assert.equal(from, dialectOf(dev), `${label} / ${dev.label} : marque détectée`);
      const src = readForeign(text, from);
      assert.deepEqual(src.ignored.filter((x) => !/bannière/.test(x.reason)), [], `${label} / ${dev.label} : lecture`);
      for (const [to, model] of Object.entries(TARGETS)) {
        if (to === from) continue;
        const where = `${label} / ${dev.label} : ${from} -> ${to}`;
        // L'équipement change de modèle ; ses câbles suivent la correspondance des interfaces
        const target = { ...blank(dev), model, modules: {} };
        const docT = { ...doc, devices: doc.devices.map((d) => (d.id === dev.id ? target : d)) };
        const mapping = defaultMapping(src.device, target, docT);
        const ports = devicePorts(modelId(target), {}).filter((p) => isDataMedia(p.media)).map((p) => p.name);
        const free = ports.filter((p) => !Object.values(mapping).includes(p));
        const portOf = new Map();
        const move = (name) => {
          if (!portOf.has(name)) portOf.set(name, mapping[name] || free.shift());
          return portOf.get(name);
        };
        const links = doc.links.map((l) => ({
          ...l,
          ...(l.source === dev.id ? { sourceIface: move(l.sourceIface) } : {}),
          ...(l.target === dev.id ? { targetIface: move(l.targetIface) } : {}),
        }));
        const docL = { ...docT, links };
        const { device: out, warnings } = translateConfig(src.device, target, docL, mapping);
        // Quelque chose est repris, ou l'import explique pourquoi (sous-interfaces sur FRR…)
        assert.ok(translatedSummary(out.config).length || warnings.length || !Object.keys(mapping).length, where);

        // 1. La config traduite se relit sans erreur dans la syntaxe de la cible, à l'identique
        const docOut = { ...docL, devices: docL.devices.map((d) => (d.id === dev.id ? out : d)) };
        const shown = running(out, docOut);
        const again = importConfig(blank(out), { ...docOut, devices: docOut.devices.map((d) => (d.id === dev.id ? blank(out) : d)) }, shown);
        assert.deepEqual(again.ignored.filter((x) => !/bannière/.test(x.reason)), [], `${where} : relecture`);
        assert.equal(running(again.device, docOut), shown, `${where} : aller-retour`);

        // 2. Rien d'écarté (ACL, NAT, EIGRP…) : les autres routeurs apprennent les mêmes routes, par les mêmes voisins
        if (!warnings.length && !doc.devices.some((d) => d.config?.eigrp)) {
          assert.deepEqual(learned(docOut, dev.id), learned(doc, dev.id), `${where} : routage`);
          equivalent++;
        }
        count++;
      }
    }
  }
  assert.ok(count > 60, `${count} traductions`);
  assert.ok(equivalent > 20, `${equivalent} traductions au routage vérifié`);
});
