// Export .gns3project vérifié dans un vrai GNS3 : import par l'API du serveur, démarrage des routeurs Dynamips
// et des VPCS, puis ping de bout en bout depuis la console VPCS.
//   GNS3_URL=http://127.0.0.1:3080 npm run test:gns3-real     (serveur GNS3 2.2 avec les images c7200 et c3725)
// Schéma : PC1 — S1 (VLAN 10) — R1 (2911 converti en c7200) ==série== R2 (c3725, WIC-2T) — PC2
import net from 'node:net';
import { gns3Files } from '../src/gns3/gns3.js';
import { writeZip } from '../src/gns3/zip.js';

const URL = process.env.GNS3_URL ?? 'http://127.0.0.1:3080';
const api = async (method, path, body) => {
  const r = await fetch(`${URL}/v2${path}`, { method, body, headers: body && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {} });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} : ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOC = {
  format: 'netcanvas', version: 3, name: 'NetCanvas GNS3 e2e',
  devices: [
    { id: 'pc1', type: 'pc', model: 'PC-PT', label: 'PC1', position: { x: 0, y: 300 }, config: { ip: '192.168.1.10', mask: 24, gateway: '192.168.1.1' } },
    { id: 's1', type: 'switch', model: '2960-24TT', label: 'S1', position: { x: 0, y: 150 }, config: { ports: [
      { link: 'l1', name: 'Fa0/1', mode: 'access', vlan: 10 }, { link: 'l2', name: 'Fa0/2', mode: 'access', vlan: 10 },
    ], vlans: [{ id: 10, name: 'LAN' }] } },
    { id: 'r1', type: 'router', model: '2911', modules: { 0: 'HWIC-2T' }, label: 'R1', position: { x: 0, y: 0 }, config: { interfaces: [
      { link: 'l2', name: 'G0/0', ip: '192.168.1.1', mask: 24 }, { link: 'l3', name: 'Se0/0/0', ip: '10.0.0.1', mask: 30, clockRate: 64000 },
    ], routes: [{ network: '192.168.2.0', mask: 24, nextHop: '10.0.0.2' }] } },
    { id: 'r2', type: 'router', model: 'c3725', modules: { wic0: 'WIC-2T' }, label: 'R2', position: { x: 300, y: 0 }, config: { interfaces: [
      { link: 'l3', name: 'Se0/0', ip: '10.0.0.2', mask: 30 }, { link: 'l4', name: 'Fa0/0', ip: '192.168.2.1', mask: 24 },
    ], routes: [{ network: '192.168.1.0', mask: 24, nextHop: '10.0.0.1' }] } },
    { id: 'pc2', type: 'pc', model: 'PC-PT', label: 'PC2', position: { x: 300, y: 300 }, config: { ip: '192.168.2.10', mask: 24, gateway: '192.168.2.1' } },
  ],
  links: [
    { id: 'l1', source: 'pc1', target: 's1', cable: 'straight', sourceIface: 'Fa0', targetIface: 'Fa0/1' },
    { id: 'l2', source: 'r1', target: 's1', cable: 'straight', sourceIface: 'G0/0', targetIface: 'Fa0/2' },
    { id: 'l3', source: 'r1', target: 'r2', cable: 'serial', sourceIface: 'Se0/0/0', targetIface: 'Se0/0', dce: 'source' },
    { id: 'l4', source: 'r2', target: 'pc2', cable: 'cross', sourceIface: 'Fa0/0', targetIface: 'Fa0' },
  ],
};

// Console telnet : envoie des lignes, renvoie tout ce qui a été reçu
async function consoleRun(port, lines, { wait = 1500, until = null, timeout = 60000 } = {}) {
  const sock = net.connect(port, '127.0.0.1');
  let out = '';
  sock.on('data', (b) => {
    // Négociation telnet : on refuse tout (IAC DO/WILL -> WONT/DONT)
    const bytes = [...b];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 255 && i + 2 < bytes.length) {
        const [cmd, opt] = [bytes[i + 1], bytes[i + 2]];
        if (cmd === 253) sock.write(Buffer.from([255, 252, opt]));
        if (cmd === 251) sock.write(Buffer.from([255, 254, opt]));
        i += 2;
      } else out += String.fromCharCode(bytes[i]);
    }
  });
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  for (const l of lines) {
    sock.write(`${l}\r`);
    await sleep(wait);
  }
  const start = Date.now();
  while (until && !until.test(out) && Date.now() - start < timeout) await sleep(500);
  sock.destroy();
  return out;
}

const { files, warnings } = gns3Files(DOC);
console.log('Avertissements :', warnings);
const zip = writeZip(files);
const projectId = crypto.randomUUID();
let ok = false;
try {
  await api('POST', `/projects/${projectId}/import?name=${encodeURIComponent(`netcanvas-e2e-${Date.now()}`)}`, zip);
  await api('POST', `/projects/${projectId}/open`);
  const nodes = await api('GET', `/projects/${projectId}/nodes`);
  const links = await api('GET', `/projects/${projectId}/links`);
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
  console.log('Nœuds :', nodes.map((n) => `${n.name}=${n.node_type}${n.properties.platform ? `/${n.properties.platform}` : ''}`).join(' '));
  // Noms de ports vus par GNS3 aux deux bouts de chaque câble
  const portName = (nodeId, a, p) => byName[nodes.find((n) => n.node_id === nodeId).name].ports.find((x) => x.adapter_number === a && x.port_number === p)?.short_name;
  const seen = links.map((l) => l.nodes.map((e) => `${nodes.find((n) => n.node_id === e.node_id).name} ${portName(e.node_id, e.adapter_number, e.port_number)}`).join(' — '));
  console.log('Câbles :', seen);
  const expect = ['PC1 e0 — S1 e0', 'R1 f0/0 — S1 e1', 'R1 s1/0 — R2 s0/0', 'R2 f0/0 — PC2 e0'];
  for (const e of expect) if (!seen.includes(e)) throw new Error(`Câble attendu absent : ${e}`);

  // RAM réduite (fichiers mmap plus petits) : on reste léger
  for (const n of nodes.filter((x) => x.node_type === 'dynamips')) {
    await api('PUT', `/projects/${projectId}/nodes/${n.node_id}`, JSON.stringify({ properties: { ram: n.properties.platform === 'c7200' ? 256 : 128 } }));
  }
  await api('POST', `/projects/${projectId}/nodes/start`);
  console.log('Démarrage des routeurs…');
  for (const name of ['R1', 'R2']) {
    const out = await consoleRun(byName[name].console, ['', ''], { until: new RegExp(`${name}[>#]`), timeout: 240000, wait: 3000 });
    if (!new RegExp(`${name}[>#]`).test(out)) throw new Error(`${name} n'a pas démarré avec sa config :\n${out.slice(-800)}`);
  }
  const r1 = await consoleRun(byName.R1.console, ['', 'show ip interface brief | exclude unassigned'], { wait: 3000 });
  console.log(r1.split('\n').filter((l) => /Serial|Fast/.test(l)).join('\n'));
  // Le temps que la liaison série monte
  let ping = '';
  for (let i = 0; i < 12 && !/bytes from 192\.168\.2\.10/.test(ping); i++) {
    await sleep(5000);
    ping = await consoleRun(byName.PC1.console, ['', 'ping 192.168.2.10 -c 3'], { wait: 4000 });
  }
  console.log(ping.split('\n').filter((l) => /192\.168\.2\.10/.test(l)).join('\n'));
  if (!/bytes from 192\.168\.2\.10/.test(ping)) throw new Error('PC1 ne joint pas PC2 dans GNS3.');
  ok = true;
  console.log('OK : projet NetCanvas importé dans GNS3, PC1 joint PC2 à travers R1 (c7200) et R2 (c3725).');
} finally {
  await api('POST', `/projects/${projectId}/nodes/stop`).catch(() => {});
  await api('DELETE', `/projects/${projectId}`).catch(() => {});
}
process.exit(ok ? 0 : 1);
