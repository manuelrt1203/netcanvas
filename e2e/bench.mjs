// Temps de calcul sur de grands schémas (routeurs OSPF en anneau, un switch et K PC par site) : npm run bench
import { buildTopology } from '../src/net/topology.js';
import { computeRouting } from '../src/net/routing.js';
import { validate } from '../src/net/validate.js';
import { simulatePing } from '../src/net/simulate.js';

// N sites : routeur OSPF + switch + K PC ; routeurs en anneau (liens /30)
export function bigDoc(N, K) {
  const devices = [];
  const links = [];
  for (let i = 0; i < N; i++) {
    const r = `r${i}`;
    const s = `s${i}`;
    devices.push({ id: r, type: 'router', model: 'Router-PT', modules: {}, label: `R${i}`, position: { x: i * 200, y: 0 }, config: {
      interfaces: [
        { link: `ls${i}`, name: 'G0/0', ip: `10.${i}.0.1`, mask: 24 },
        { link: `ring${i}`, name: 'G0/1', ip: `172.16.${i}.1`, mask: 30 },
        { link: `ring${(i + N - 1) % N}`, name: 'G0/2', ip: `172.16.${(i + N - 1) % N}.2`, mask: 30 },
      ], routes: [], ospf: { processId: 1, networks: [{ network: '0.0.0.0', wildcard: '255.255.255.255', area: 0 }] } } });
    const ports = [{ link: `ls${i}`, name: 'G0/1', mode: 'access', vlan: 1 }];
    devices.push({ id: s, type: 'switch', model: '2960-48TT', label: `S${i}`, position: { x: i * 200, y: 200 }, config: { ports } });
    links.push({ id: `ls${i}`, source: r, target: s, cable: 'straight', sourceIface: 'G0/0', targetIface: 'G0/1' });
    links.push({ id: `ring${i}`, source: r, target: `r${(i + 1) % N}`, cable: 'cross', sourceIface: 'G0/1', targetIface: 'G0/2' });
    for (let k = 0; k < K; k++) {
      const pc = `pc${i}_${k}`;
      devices.push({ id: pc, type: 'pc', model: 'PC-PT', label: `PC${i}-${k}`, position: { x: i * 200 + k * 10, y: 400 }, config: { ip: `10.${i}.0.${10 + k}`, mask: 24, gateway: `10.${i}.0.1` } });
      ports.push({ link: pc, name: `Fa0/${k + 1}`, mode: 'access', vlan: 1 });
      links.push({ id: pc, source: pc, target: s, cable: 'straight', sourceIface: 'Fa0', targetIface: `Fa0/${k + 1}` });
    }
  }
  return { format: 'netcanvas', version: 3, name: 'bench', devices, links };
}
const time = (label, fn) => { const t = performance.now(); const r = fn(); console.log(`${label.padEnd(28)} ${(performance.now() - t).toFixed(0).padStart(6)} ms`); return r; };
if (process.argv[1].endsWith("bench.mjs")) for (const [N, K] of [[10, 10], [20, 15], [30, 20]]) {
  const doc = bigDoc(N, K);
  console.log(`--- ${N} routeurs, ${N} switches, ${N * K} PC (${doc.devices.length} équipements)`);
  const topo = time('buildTopology', () => buildTopology(doc));
  const routing = time('computeRouting', () => computeRouting(doc, topo));
  time('validate', () => validate(doc, { topo, routing }));
  time('ping bout en bout', () => simulatePing(doc, 'pc0_0', `10.${Math.floor(N / 2)}.0.10`));
}
