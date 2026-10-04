// Terminal IOS : Spanning Tree (PVST+). show spanning-tree, priorités, root primary/secondary,
// désactivation par VLAN, portfast, coût et priorité de port.
import { arg, kw, rest } from './engine.js';
import { pad, withDevice } from './device.js';
import { buildTopology } from '../net/topology.js';
import { DEFAULT_BRIDGE_PRIORITY } from '../net/stp.js';
import { macCisco } from '../net/mac.js';
import { iosLongName } from '../export/cisco.js';

const isNum = (min, max) => (t) => /^\d+$/.test(t) && Number(t) >= min && Number(t) <= max;

// « 1,10-12 » -> [1, 10, 11, 12] ; null si invalide
export function parseVlanList(text) {
  const out = [];
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (a < 1 || b > 4094 || a > b) return null;
    for (let v = a; v <= b; v++) out.push(v);
  }
  return out;
}
const vlanListArg = (node) => arg('vlans', 'WORD', 'vlan range, example: 1,3-5,7,9-11', (t) => parseVlanList(t) !== null, node);

const stpOf = (dev) => (dev.config.stp ??= {});
const shortName = (name) => name.replace(/^G(?=\d)/, 'Gi');

const PRIORITIES = Array.from({ length: 16 }, (_, i) => i * 4096);
function setPriority(c, prio) {
  if (!PRIORITIES.includes(prio)) {
    c.out.push('% Bridge Priority must be in increments of 4096.', '% Allowed values are:', `  ${PRIORITIES.slice(0, 8).join('  ')}`, `  ${PRIORITIES.slice(8).join('  ')}`, '');
    return;
  }
  const stp = stpOf(c.dev);
  for (const v of parseVlanList(c.args.vlans)) {
    if (prio === DEFAULT_BRIDGE_PRIORITY) delete (stp.priority ??= {})[v];
    else (stp.priority ??= {})[v] = prio;
  }
  if (stp.priority && !Object.keys(stp.priority).length) delete stp.priority;
  c.changed = true;
}

// root primary : 24576, ou 4096 de moins que le root actuel s'il est déjà plus bas (comme IOS)
function setRoot(c, secondary) {
  const topo = buildTopology(withDevice(c.doc, c.dev));
  for (const v of parseVlanList(c.args.vlans)) {
    let prio = secondary ? 28672 : 24576;
    const info = topo.stp.vlans.get(v);
    const root = info && [...info.switches.values()].find((s) => s.isRoot);
    if (!secondary && root && info.switches.get(c.dev.id) !== root && root.priority - v <= prio) prio = Math.max(0, root.priority - v - 4096);
    c.args = { ...c.args, vlans: String(v) };
    setPriority(c, prio);
  }
}

export function stpConfigCommand() {
  return kw('spanning-tree', 'Spanning Tree Subsystem', {
    children: [
      kw('mode', 'Spanning tree operating mode', {
        children: [
          kw('pvst', 'Per-Vlan spanning tree mode', { run: (c) => { delete stpOf(c.dev).mode; c.changed = true; } }),
          kw('rapid-pvst', 'Per-Vlan rapid spanning tree mode', { run: (c) => { stpOf(c.dev).mode = 'rapid-pvst'; c.changed = true; } }),
        ],
      }),
      kw('extend', 'Spanning Tree 802.1t extensions', { children: [kw('system-id', 'Extend system-id into priority portion of the bridge id', { run() {} })] }),
      kw('vlan', 'VLAN Switch Spanning Tree', {
        children: [vlanListArg({
          // « spanning-tree vlan 1 » : réactive STP sur ces VLAN
          run: (c) => {
            const stp = stpOf(c.dev);
            const list = parseVlanList(c.args.vlans);
            stp.disabled = (stp.disabled ?? []).filter((v) => !list.includes(v));
            if (!stp.disabled.length) delete stp.disabled;
            c.changed = true;
          },
          children: [
            kw('priority', 'Set the bridge priority for the spanning tree', {
              children: [arg('prio', '<0-61440>', 'bridge priority in increments of 4096', isNum(0, 61440), { run: (c) => setPriority(c, Number(c.args.prio)) })],
            }),
            kw('root', 'Configure switch as root', {
              children: [
                kw('primary', 'Configure this switch as primary root for this spanning tree', { run: (c) => setRoot(c, false) }),
                kw('secondary', 'Configure switch as secondary root', { run: (c) => setRoot(c, true) }),
              ],
            }),
            kw('hello-time', 'Set the hello interval for the spanning tree', { children: [rest('x', '<1-10>', '', () => {})] }),
            kw('forward-time', 'Set the forward delay for the spanning tree', { children: [rest('x', '<4-30>', '', () => {})] }),
            kw('max-age', 'Set the max age interval for the spanning tree', { children: [rest('x', '<6-40>', '', () => {})] }),
          ],
        })],
      }),
    ],
  });
}

export function stpNoConfigCommand() {
  return kw('spanning-tree', 'Spanning Tree Subsystem', {
    children: [kw('vlan', 'VLAN Switch Spanning Tree', {
      children: [vlanListArg({
        run: (c) => {
          const stp = stpOf(c.dev);
          stp.disabled = [...new Set([...(stp.disabled ?? []), ...parseVlanList(c.args.vlans)])].sort((a, b) => a - b);
          c.changed = true;
        },
        children: [kw('priority', 'Set the bridge priority for the spanning tree', {
          run: (c) => setPriority(c, DEFAULT_BRIDGE_PRIORITY),
        })],
      })],
    })],
  });
}

export function stpInterfaceCommands(forIfaces) {
  return {
    add: kw('spanning-tree', 'Spanning Tree Subsystem', {
      children: [
        kw('portfast', 'Portfast options for the interface', {
          run: (c) => {
            forIfaces(c, (e) => { e.portfast = true; });
            c.out.push('%Warning: portfast should only be enabled on ports connected to a single', ' host. Connecting hubs, concentrators, switches, bridges, etc... to this', ' interface  when portfast is enabled, can cause temporary bridging loops.', ' Use with CAUTION', '');
          },
        }),
        kw('cost', 'Change an interface\'s spanning tree port path cost', {
          children: [arg('cost', '<1-200000000>', 'port path cost', isNum(1, 200000000), { run: (c) => forIfaces(c, (e) => { e.stpCost = Number(c.args.cost); }) })],
        }),
        kw('port-priority', 'Change an interface\'s spanning tree port priority', {
          children: [arg('prio', '<0-240>', 'port priority in increments of 16', (t) => isNum(0, 240)(t) && Number(t) % 16 === 0, {
            run: (c) => forIfaces(c, (e) => { if (Number(c.args.prio) === 128) delete e.stpPriority; else e.stpPriority = Number(c.args.prio); }),
          })],
        }),
        kw('bpduguard', 'Don\'t accept BPDUs on this interface', { children: [rest('x', 'LINE', '', () => {})] }),
      ],
    }),
    remove: kw('spanning-tree', 'Spanning Tree Subsystem', {
      children: [
        kw('portfast', '', { run: (c) => forIfaces(c, (e) => { delete e.portfast; }) }),
        kw('cost', '', { run: (c) => forIfaces(c, (e) => { delete e.stpCost; }) }),
        kw('port-priority', '', { run: (c) => forIfaces(c, (e) => { delete e.stpPriority; }) }),
      ],
    }),
  };
}

const ROLE = { root: 'Root', designated: 'Desg', alternate: 'Altn' };
const STATE = { forwarding: 'FWD', blocking: 'BLK' };

export function showSpanningTree(dev, doc, only = null) {
  const topo = buildTopology(withDevice(doc, dev));
  const mode = dev.config?.stp?.mode === 'rapid-pvst' ? 'rstp' : 'ieee';
  const out = [];
  const vlans = only ?? [...topo.stp.vlans.keys()];
  for (const v of vlans) {
    const info = topo.stp.vlans.get(v);
    const me = info?.switches.get(dev.id);
    if (!me || !me.enabled) {
      out.push(`Spanning tree instance(s) for vlan ${v} does not exist.`);
      continue;
    }
    const root = [...info.switches.values()].find((s) => s.bridge === me.root);
    const rootPort = me.rootPort && info.ports.get(`${dev.id}|${me.rootPort}`);
    const timers = '             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec';
    out.push(`VLAN${String(v).padStart(4, '0')}`, `  Spanning tree enabled protocol ${mode}`,
      `  Root ID    Priority    ${root.priority}`, `             Address     ${macCisco(root.mac)}`);
    if (me.isRoot) out.push('             This bridge is the root');
    else out.push(`             Cost        ${me.rootCost}`, `             Port        ${rootPort.portId & 255}(${iosLongName(rootPort.name)})`);
    out.push(timers, '',
      `  Bridge ID  Priority    ${me.priority}  (priority ${me.priority - v} sys-id-ext ${v})`,
      `             Address     ${macCisco(me.mac)}`, timers, '             Aging Time  20', '',
      `${pad('Interface', 17)}${pad('Role', 5)}${pad('Sts', 4)}${pad('Cost', 10)}${pad('Prio.Nbr', 9)}Type`,
      `${'-'.repeat(16)} ${'-'.repeat(4)} ${'-'.repeat(3)} ${'-'.repeat(9)} ${'-'.repeat(8)} ${'-'.repeat(32)}`);
    const ports = [...info.ports].filter(([k]) => k.startsWith(`${dev.id}|`)).map(([, p]) => p)
      .sort((a, b) => (a.portId & 255) - (b.portId & 255));
    for (const p of ports) {
      const edge = p.portfast;
      out.push(`${pad(shortName(p.name), 17)}${pad(ROLE[p.role], 5)}${pad(STATE[p.state], 4)}${pad(p.cost, 10)}${pad(`${p.portId >> 8}.${p.portId & 255}`, 9)}P2p${edge ? ' Edge' : ''}`);
    }
    out.push('');
  }
  return [...out, ''];
}

export function stpShowCommand() {
  return kw('spanning-tree', 'Spanning tree topology', {
    run: (c) => c.out.push(...showSpanningTree(c.dev, c.doc)),
    children: [kw('vlan', 'VLAN Switch Spanning Trees', {
      children: [vlanListArg({ run: (c) => c.out.push(...showSpanningTree(c.dev, c.doc, parseVlanList(c.args.vlans))) })],
    })],
  });
}
