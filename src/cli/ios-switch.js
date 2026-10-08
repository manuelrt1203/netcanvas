// Terminal IOS des switches : trunk (VLAN natif, VLAN autorisés), port-security, EtherChannel, VTP.
// La config est celle de net/switching.js ; les « show » lisent l'état calculé par la topologie.
import { arg, kw, rest } from './engine.js';
import { dataPorts, getEntry, linkOf, pad, withDevice } from './device.js';
import { buildTopology } from '../net/topology.js';
import { iosLongName, iosSwitchPortLines } from '../export/cisco.js';
import {
  CHANNEL_MODES, PS_DEFAULT, allowedOf, channelProtocol, formatVlanList, macsBehind, nativeOf, parseVlanList, psOf, vtpMode, vtpOf,
} from '../net/switching.js';

const isNum = (min, max) => (t) => /^\d+$/.test(t) && Number(t) >= min && Number(t) <= max;
const isMac = (t) => /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(t);
const isVlanList = (t) => parseVlanList(t) !== null;
const short = (n) => n.replace(/^G(?=\d)/, 'Gi');
const topoOf = (c) => buildTopology(withDevice(c.doc, c.dev));

// Port-channel : un bloc par groupe (réglages communs de ses membres), avant les ports physiques
export function iosPortChannelLines(dev) {
  const groups = new Map();
  for (const p of dataPorts(dev)) {
    const e = getEntry(dev, p.name);
    if (e?.channelGroup && !groups.has(Number(e.channelGroup))) groups.set(Number(e.channelGroup), e);
  }
  return [...groups].sort(([a], [b]) => a - b).flatMap(([g, e]) => [
    `interface Port-channel${g}`,
    ...(e.mode === 'trunk' ? iosSwitchPortLines({ mode: 'trunk', nativeVlan: e.nativeVlan, allowedVlans: e.allowedVlans }) : []),
    ...(e.mode === 'trunk' ? [' switchport mode trunk'] : (Number(e.vlan) || 1) !== 1 ? [` switchport access vlan ${e.vlan}`] : []),
    '!',
  ]);
}

// --- Configuration d'interface -------------------------------------------------------------------------------
const ALL = Array.from({ length: 4094 }, (_, i) => i + 1);

export function switchInterfaceCommands(forIfaces) {
  const setAllowed = (c, op) => {
    const list = op === 'all' || op === 'none' ? [] : parseVlanList(c.args.list);
    forIfaces(c, (e) => {
      const cur = allowedOf(e);
      const next = {
        set: list, all: null, none: [], except: ALL.filter((v) => !list.includes(v)),
        add: cur ? [...cur, ...list] : null, remove: (cur ? [...cur] : ALL).filter((v) => !list.includes(v)),
      }[op];
      if (next === null || next.length === 4094) delete e.allowedVlans;
      else e.allowedVlans = [...new Set(next)].sort((a, b) => a - b);
    });
  };
  // IOS refuse la port-security sur un port trunk
  const ps = (c, fn) => {
    const bad = c.s.ifaces.find((n) => getEntry(c.dev, n)?.mode === 'trunk');
    if (bad) return c.out.push(`Command rejected: ${iosLongName(bad)} is a trunk port.`, '');
    return forIfaces(c, (e) => {
      e.ps = { ...PS_DEFAULT, ...(e.ps ?? {}) };
      fn(e.ps, e);
    });
  };
  // Apprentissage « sticky » : les MAC présentes derrière le port deviennent des adresses de la config
  const learnSticky = (c) => {
    if (c.s.importing) return;
    const topo = topoOf(c);
    forIfaces(c, (e, name) => {
      const p = psOf(e);
      const link = linkOf(c.doc, c.dev.id, name);
      if (!p.sticky || !link) return;
      const known = new Set([...p.macs, ...p.stickyMacs]);
      for (const x of macsBehind(topo, c.dev.id, link)) {
        if (known.size >= p.max) break;
        if (known.has(x.mac)) continue;
        known.add(x.mac);
        e.ps.stickyMacs = [...(e.ps.stickyMacs ?? []), x.mac];
      }
    });
  };
  const trunk = kw('trunk', 'Set trunking characteristics of the interface', {
    children: [
      kw('native', 'Set trunking native characteristics when interface is in trunking mode', {
        children: [kw('vlan', 'Set native VLAN when interface is in trunking mode', {
          children: [arg('vlan', '<1-4094>', 'VLAN ID of the native VLAN when this port is in trunking mode', isNum(1, 4094), {
            run: (c) => forIfaces(c, (e) => { if (Number(c.args.vlan) === 1) delete e.nativeVlan; else e.nativeVlan = Number(c.args.vlan); }),
          })],
        })],
      }),
      kw('allowed', 'Set allowed VLAN characteristics when interface is in trunking mode', {
        children: [kw('vlan', 'Set allowed VLANs when interface is in trunking mode', {
          children: [
            kw('add', 'add VLANs to the current list', { children: [arg('list', 'WORD', 'VLAN IDs of the allowed VLANs when this port is in trunking mode', isVlanList, { run: (c) => setAllowed(c, 'add') })] }),
            kw('remove', 'remove VLANs from the current list', { children: [arg('list', 'WORD', 'VLAN IDs', isVlanList, { run: (c) => setAllowed(c, 'remove') })] }),
            kw('except', 'all VLANs except the following', { children: [arg('list', 'WORD', 'VLAN IDs', isVlanList, { run: (c) => setAllowed(c, 'except') })] }),
            kw('all', 'all VLANs', { run: (c) => setAllowed(c, 'all') }),
            kw('none', 'no VLANs', { run: (c) => setAllowed(c, 'none') }),
            arg('list', 'WORD', 'VLAN IDs of the allowed VLANs when this port is in trunking mode', isVlanList, { run: (c) => setAllowed(c, 'set') }),
          ],
        })],
      }),
      kw('encapsulation', 'Set trunking encapsulation when interface is in trunking mode', { children: [rest('x', 'LINE', '', () => {})] }),
    ],
  });
  const portSecurity = kw('port-security', 'Security related command', {
    run: (c) => { ps(c, (p) => { p.enabled = true; }); learnSticky(c); },
    children: [
      kw('maximum', 'Max secure addresses', {
        children: [arg('n', '<1-132>', 'Maximum addresses', isNum(1, 132), { run: (c) => ps(c, (p) => { p.max = Number(c.args.n); }) })],
      }),
      kw('violation', 'Security violation mode', {
        children: ['protect', 'restrict', 'shutdown'].map((v) => kw(v, {
          protect: 'Security violation protect mode', restrict: 'Security violation restrict mode', shutdown: 'Security violation shutdown mode',
        }[v], { run: (c) => ps(c, (p) => { p.violation = v; }) })),
      }),
      kw('mac-address', 'Secure mac address', {
        children: [
          kw('sticky', 'Configure dynamic secure addresses as sticky', {
            run: (c) => { ps(c, (p) => { p.sticky = true; }); learnSticky(c); },
            children: [arg('mac', 'H.H.H', '48 bit mac address', isMac, { run: (c) => ps(c, (p) => { p.sticky = true; p.stickyMacs = [...new Set([...p.stickyMacs, c.args.mac.toLowerCase()])]; }) })],
          }),
          arg('mac', 'H.H.H', '48 bit mac address', isMac, { run: (c) => ps(c, (p) => { p.macs = [...new Set([...p.macs, c.args.mac.toLowerCase()])]; }) }),
        ],
      }),
      kw('aging', 'Port-security aging commands', { children: [rest('x', 'LINE', '', () => {})] }),
    ],
  });
  const channelGroup = kw('channel-group', 'Etherchannel/port bundling configuration', {
    children: [arg('g', '<1-6>', 'Channel group number', isNum(1, 64), {
      children: [kw('mode', 'Etherchannel Mode of the interface', {
        children: CHANNEL_MODES.map((m) => kw(m, {
          active: 'Enable LACP unconditionally', passive: 'Enable LACP only if a LACP device is detected',
          desirable: 'Enable PAgP unconditionally', auto: 'Enable PAgP only if a PAgP device is detected', on: 'Enable Etherchannel only',
        }[m], {
          run: (c) => {
            const g = Number(c.args.g);
            const other = dataPorts(c.dev).map((p) => getEntry(c.dev, p.name)).find((e) => Number(e?.channelGroup) === g && (e.channelMode ?? 'on') !== m);
            if (other && channelProtocol(other.channelMode ?? 'on') !== channelProtocol(m)) {
              return c.out.push(`Command rejected (Channel protocol mismatch for interface ${iosLongName(c.s.ifaces[0])} in group ${g}): the interface can not be added to the channel group`, '');
            }
            const exists = dataPorts(c.dev).some((p) => Number(getEntry(c.dev, p.name)?.channelGroup) === g);
            if (!exists) c.out.push(`Creating a port-channel interface Port-channel ${g}`, '');
            forIfaces(c, (e) => { e.channelGroup = g; e.channelMode = m; });
            return undefined;
          },
        })),
      })],
    })],
  });
  const no = [
    kw('channel-group', 'Etherchannel/port bundling configuration', { run: (c) => forIfaces(c, (e) => { delete e.channelGroup; delete e.channelMode; }) }),
  ];
  const noSwitchport = [
    kw('trunk', 'Set trunking characteristics of the interface', {
      children: [
        kw('native', '', { children: [kw('vlan', '', { run: (c) => forIfaces(c, (e) => { delete e.nativeVlan; }) })] }),
        kw('allowed', '', { children: [kw('vlan', '', { run: (c) => forIfaces(c, (e) => { delete e.allowedVlans; }) })] }),
      ],
    }),
    kw('port-security', 'Security related command', {
      run: (c) => forIfaces(c, (e) => { if (e.ps) e.ps.enabled = false; }),
      children: [
        kw('maximum', '', { run: (c) => forIfaces(c, (e) => { if (e.ps) e.ps.max = 1; }) }),
        kw('violation', '', { run: (c) => forIfaces(c, (e) => { if (e.ps) e.ps.violation = 'shutdown'; }), children: [rest('x', 'LINE', '', (c) => forIfaces(c, (e) => { if (e.ps) e.ps.violation = 'shutdown'; }))] }),
        kw('mac-address', '', {
          children: [
            kw('sticky', '', {
              run: (c) => forIfaces(c, (e) => { if (e.ps) Object.assign(e.ps, { sticky: false, stickyMacs: [] }); }),
              children: [arg('mac', 'H.H.H', '', isMac, { run: (c) => forIfaces(c, (e) => { if (e.ps) e.ps.stickyMacs = (e.ps.stickyMacs ?? []).filter((m) => m !== c.args.mac.toLowerCase()); }) })],
            }),
            arg('mac', 'H.H.H', '', isMac, { run: (c) => forIfaces(c, (e) => { if (e.ps) e.ps.macs = (e.ps.macs ?? []).filter((m) => m !== c.args.mac.toLowerCase()); }) }),
          ],
        }),
      ],
    }),
  ];
  return { trunk, portSecurity, channelGroup, no, noSwitchport };
}

// --- VTP (mode configuration) ----------------------------------------------------------------------------
const vtpSet = (c, fn) => {
  const v = (c.dev.config.vtp ??= {});
  fn(v);
  c.changed = true;
};

export function vtpCommands() {
  const add = kw('vtp', 'Configure global VTP state', {
    children: [
      kw('domain', 'Set the name of the VTP administrative domain.', {
        children: [arg('name', 'WORD', 'The ascii name for the VTP administrative domain.', null, {
          run: (c) => vtpSet(c, (v) => {
            const old = v.domain ?? 'NULL';
            if (old !== c.args.name) v.revision = 0;
            v.domain = c.args.name;
            c.out.push(`Changing VTP domain name from ${old} to ${c.args.name}`);
          }),
        })],
      }),
      kw('mode', 'Configure VTP device mode', {
        children: ['client', 'server', 'transparent', 'off'].map((m) => kw(m, {
          client: 'Set the device to client mode.', server: 'Set the device to server mode.', transparent: 'Set the device to transparent mode.', off: 'Set the device to off mode.',
        }[m], {
          run: (c) => vtpSet(c, (v) => {
            if (v.mode === m || (!v.mode && m === 'server')) {
              v.mode = m;
              return c.out.push(`Device mode already VTP ${m.toUpperCase()}.`);
            }
            if (m === 'transparent' || m === 'off') v.revision = 0;
            v.mode = m;
            return c.out.push(`Setting device to VTP ${m.toUpperCase()} mode.`);
          }),
        })),
      }),
      kw('password', 'Set the password for the VTP administrative domain', {
        children: [arg('pw', 'WORD', 'The ascii password for the VTP administrative domain.', null, {
          run: (c) => vtpSet(c, (v) => { v.password = c.args.pw; c.out.push(`Setting device VLAN database password to ${c.args.pw}`); }),
        })],
      }),
      kw('version', 'Set the administrative domain to VTP version', {
        children: [arg('n', '<1-2>', 'Set the adminstrative domain VTP version number', isNum(1, 3), {
          run: (c) => vtpSet(c, (v) => { if (Number(c.args.n) === 1) delete v.version; else v.version = Number(c.args.n); }),
        })],
      }),
      kw('pruning', 'Set the administrative domain to permit pruning', { run() {} }),
    ],
  });
  const remove = kw('vtp', 'Configure global VTP state', {
    children: [
      kw('password', '', { run: (c) => vtpSet(c, (v) => { delete v.password; c.out.push('Clearing device VLAN database password.'); }) }),
      kw('mode', '', { run: (c) => vtpSet(c, (v) => { delete v.mode; }), children: [rest('x', 'LINE', '', (c) => vtpSet(c, (v) => { delete v.mode; }))] }),
      kw('pruning', '', { run() {} }),
    ],
  });
  return { add, remove };
}

// VLAN modifiables sur ce switch ? (un client VTP ne crée ni ne supprime de VLAN)
export function vlanEditAllowed(c) {
  if (vtpMode(c.dev) !== 'client') return true;
  c.out.push('VTP VLAN configuration not allowed when device is in CLIENT mode.', '');
  return false;
}
// Chaque modification de la base de VLAN d'un serveur VTP augmente le numéro de révision
export function bumpRevision(dev) {
  const v = dev.config?.vtp;
  if (v && vtpMode(dev) === 'server') v.revision = (Number(v.revision) || 0) + 1;
}

// --- Affichages ---------------------------------------------------------------------------------------------
function showEtherchannel(c) {
  const topo = topoOf(c);
  const mine = topo.channels.filter((x) => x.device === c.dev.id).sort((a, b) => a.group - b.group);
  const flag = (ch, l) => {
    if (ch.suspended.some((x) => x.link === l)) return 's';
    if (!topo.isUp(l)) return 'D';
    return ch.state === 'up' && (ch.links.includes(l)) ? 'P' : 'I';
  };
  const rows = [
    'Flags:  D - down        P - bundled in port-channel',
    '        I - stand-alone s - suspended',
    '        H - Hot-standby (LACP only)',
    '        R - Layer3      S - Layer2',
    '        U - in use      f - failed to allocate aggregator',
    '',
    `Number of channel-groups in use: ${mine.length}`,
    `Number of aggregators:           ${mine.length}`,
    '',
    'Group  Port-channel  Protocol    Ports',
    '------+-------------+-----------+-----------------------------------------------',
  ];
  for (const ch of mine) {
    const ports = dataPorts(c.dev).filter((p) => Number(getEntry(c.dev, p.name)?.channelGroup) === ch.group);
    const members = ports.map((p) => {
      const l = linkOf(c.doc, c.dev.id, p.name);
      return `${short(p.name)}(${l ? flag(ch, l) : 'D'})`;
    });
    rows.push(`${pad(ch.group, 7)}${pad(`Po${ch.group}(S${ch.state === 'up' ? 'U' : 'D'})`, 16)}${pad(ch.mode === 'on' ? '-' : channelProtocol(ch.mode), 10)}${members.join('  ')}`);
    if (ch.state !== 'up' && ch.reason) rows.push(`% NetCanvas : Po${ch.group} ne monte pas : ${ch.reason}.`);
    for (const s of ch.suspended) rows.push(`% NetCanvas : ${s.reason}.`);
  }
  // Ports en channel-group sans câble
  for (const p of dataPorts(c.dev)) {
    const e = getEntry(c.dev, p.name);
    if (e?.channelGroup && !mine.some((ch) => ch.group === Number(e.channelGroup))) rows.push(`${pad(e.channelGroup, 7)}${pad(`Po${e.channelGroup}(SD)`, 16)}${pad(e.channelMode === 'on' ? '-' : channelProtocol(e.channelMode), 10)}${short(p.name)}(D)`);
  }
  return [...rows, ''];
}

function knownVlans(topo, dev) {
  const db = topo.vtp.get(dev.id);
  if (db && vtpMode(dev) === 'client') return [...db.vlans.keys()];
  const set = new Set([1, ...(dev.config?.vlans ?? []).map((v) => Number(v.id))]);
  for (const p of dataPorts(dev)) {
    const e = getEntry(dev, p.name);
    if (e?.mode !== 'trunk') set.add(Number(e?.vlan) || 1);
  }
  return [...set];
}

function showTrunk(c) {
  const topo = topoOf(c);
  const trunks = [];
  const groups = new Set();
  for (const p of dataPorts(c.dev)) {
    const e = getEntry(c.dev, p.name);
    const l = linkOf(c.doc, c.dev.id, p.name);
    if (e?.mode !== 'trunk' || !l || !topo.isUp(l)) continue;
    // Un EtherChannel apparaît une fois, sous son nom Po
    if (e.channelGroup) {
      const ch = topo.channelOf(c.dev.id, l);
      if (ch?.state === 'up') {
        if (groups.has(ch.group)) continue;
        groups.add(ch.group);
        trunks.push({ name: `Po${ch.group}`, e, link: ch.primary });
        continue;
      }
    }
    trunks.push({ name: short(p.name), e, link: l });
  }
  if (!trunks.length) return [''];
  const known = knownVlans(topo, c.dev);
  const out = [`${pad('Port', 12)}${pad('Mode', 13)}${pad('Encapsulation', 15)}${pad('Status', 14)}Native vlan`];
  for (const t of trunks) out.push(`${pad(t.name, 12)}${pad('on', 13)}${pad('802.1q', 15)}${pad('trunking', 14)}${nativeOf(t.e)}`);
  out.push('', `${pad('Port', 12)}Vlans allowed on trunk`);
  for (const t of trunks) out.push(`${pad(t.name, 12)}${t.e.allowedVlans ? formatVlanList(t.e.allowedVlans) || 'none' : '1-4094'}`);
  const active = (t) => known.filter((v) => allowedOf(t.e)?.has(v) ?? true);
  out.push('', `${pad('Port', 12)}Vlans allowed and active in management domain`);
  for (const t of trunks) out.push(`${pad(t.name, 12)}${formatVlanList(active(t)) || 'none'}`);
  out.push('', `${pad('Port', 12)}Vlans in spanning tree forwarding state and not pruned`);
  for (const t of trunks) out.push(`${pad(t.name, 12)}${formatVlanList(active(t).filter((v) => !topo.stp.blocked(c.dev.id, t.link, v))) || 'none'}`);
  return [...out, ''];
}

function showInterfacesStatus(c) {
  const topo = topoOf(c);
  const out = [`${pad('Port', 10)}${pad('Name', 19)}${pad('Status', 13)}${pad('Vlan', 11)}${pad('Duplex', 8)}${pad('Speed', 6)}Type`];
  for (const p of dataPorts(c.dev)) {
    const e = getEntry(c.dev, p.name) ?? {};
    const l = linkOf(c.doc, c.dev.id, p.name);
    const st = l ? topo.status.get(l) : null;
    let status = 'notconnect';
    if (e.shutdown) status = 'disabled';
    else if (st?.errDisabled) status = 'err-disabled';
    else if (st?.suspended) status = 'suspended';
    else if (l && topo.isUp(l)) status = e.mode !== 'trunk' && !topo.vlanExists(c.dev.id, Number(e.vlan) || 1) ? 'inactive' : 'connected';
    const up = status === 'connected';
    const vlan = e.mode === 'trunk' ? 'trunk' : String(Number(e.vlan) || 1);
    out.push(`${pad(short(p.name), 10)}${pad((e.description ?? '').slice(0, 18), 19)}${pad(status, 13)}${pad(vlan, 11)}${pad(up ? 'a-full' : 'auto', 8)}${pad(up ? (/^G/.test(p.name) ? 'a-1000' : 'a-100') : 'auto', 6)}${/^G/.test(p.name) ? '10/100/1000BaseTX' : '10/100BaseTX'}`);
  }
  return [...out, ''];
}

function securityRows(c, topo) {
  return dataPorts(c.dev).map((p) => ({ p, e: getEntry(c.dev, p.name) })).filter(({ e }) => e?.ps?.enabled).map(({ p, e }) => {
    const l = linkOf(c.doc, c.dev.id, p.name);
    const st = l ? topo.security.get(`${c.dev.id}|${l}`) : null;
    return { p, e, ps: psOf(e), st };
  });
}

function showPortSecurity(c, name = null) {
  const topo = topoOf(c);
  const rows = securityRows(c, topo);
  if (name) {
    const r = rows.find((x) => x.p.name === name);
    const e = getEntry(c.dev, name);
    const p = psOf(e ?? {});
    const st = r?.st;
    const last = st?.seen?.at(-1);
    return [
      `Port Security              : ${r ? 'Enabled' : 'Disabled'}`,
      `Port Status                : ${!r ? 'Secure-down' : st?.errDisabled ? 'Secure-shutdown' : st ? 'Secure-up' : 'Secure-down'}`,
      `Violation Mode             : ${p.violation[0].toUpperCase()}${p.violation.slice(1)}`,
      'Aging Time                 : 0 mins',
      'Aging Type                 : Absolute',
      'SecureStatic Address Aging : Disabled',
      `Maximum MAC Addresses      : ${p.max}`,
      `Total MAC Addresses        : ${st ? st.allowed.length : p.macs.length + p.stickyMacs.length}`,
      `Configured MAC Addresses   : ${p.macs.length}`,
      `Sticky MAC Addresses       : ${p.stickyMacs.length}`,
      `Last Source Address:Vlan   : ${last ? `${last.mac}:${Number(e?.vlan) || 1}` : '0000.0000.0000:0'}`,
      `Security Violation Count   : ${st?.violators.length ?? 0}`,
      ...(st?.violators.length ? [`% NetCanvas : en trop : ${st.violators.map((v) => `${v.label} (${v.mac})`).join(', ')}.`] : []),
      '',
    ];
  }
  const out = [
    'Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action',
    '                (Count)       (Count)          (Count)',
    '---------------------------------------------------------------------------',
  ];
  for (const r of rows) {
    out.push(`${short(r.p.name).padStart(11)}  ${String(r.ps.max).padStart(14)}${String(r.st?.allowed.length ?? 0).padStart(13)}${String(r.st?.violators.length ?? 0).padStart(19)}         ${r.ps.violation[0].toUpperCase()}${r.ps.violation.slice(1)}`);
  }
  out.push('---------------------------------------------------------------------------');
  return [...out, ''];
}

function showPortSecurityAddress(c) {
  const topo = topoOf(c);
  const out = [
    '               Secure Mac Address Table',
    '-----------------------------------------------------------------------------',
    'Vlan    Mac Address       Type                          Ports   Remaining Age',
    '                                                                   (mins)',
    '----    -----------       ----                          -----   -------------',
  ];
  for (const r of securityRows(c, topo)) {
    const vlan = Number(r.e.vlan) || 1;
    for (const mac of r.st?.allowed ?? [...r.ps.macs, ...r.ps.stickyMacs]) {
      const type = r.ps.macs.includes(mac) ? 'SecureConfigured' : r.ps.stickyMacs.includes(mac) ? 'SecureSticky' : 'SecureDynamic';
      out.push(`${String(vlan).padStart(4)}    ${pad(mac, 18)}${pad(type, 30)}${pad(short(r.p.name), 8)}    -`);
    }
  }
  out.push('-----------------------------------------------------------------------------');
  return [...out, ''];
}

function showVtp(c) {
  const topo = topoOf(c);
  const v = vtpOf(c.dev) ?? {};
  const mode = vtpMode(c.dev);
  const db = topo.vtp.get(c.dev.id);
  const vlans = db && mode !== 'transparent' ? db.vlans.size : knownVlans(topo, c.dev).length;
  const revision = db ? db.revision : Number(v.revision) || 0;
  const out = [
    `VTP Version                     : running VTP${v.version ?? 1}`,
    `Configuration Revision          : ${mode === 'transparent' || mode === 'off' ? 0 : revision}`,
    'Maximum VLANs supported locally : 255',
    `Number of existing VLANs        : ${vlans + 4}`,
    `VTP Operating Mode              : ${mode[0].toUpperCase()}${mode.slice(1)}`,
    `VTP Domain Name                 : ${v.domain ?? ''}`,
    'VTP Pruning Mode                : Disabled',
    `VTP V2 Mode                     : ${Number(v.version) >= 2 ? 'Enabled' : 'Disabled'}`,
    'VTP Traps Generation            : Disabled',
    `MD5 digest                      : ${v.password ? '0x3F 0x37 0x45 0x9A 0x37 0x53 0xA6 0xDE' : '0x7D 0x5A 0xA6 0x0E 0x9A 0x72 0xA0 0x3A'}`,
  ];
  if (db && db.from !== c.dev.id) out.push(`% NetCanvas : base de VLAN reçue de ${topo.devices.get(db.from).label} (révision ${db.revision}), domaine de ${db.domain.length} switch(es).`);
  else if (db && db.domain.length > 1) out.push(`% NetCanvas : cette base de VLAN s'impose au domaine (${db.domain.length} switches, révision la plus haute).`);
  else if (v.domain && mode !== 'transparent' && mode !== 'off') out.push('% NetCanvas : aucun autre switch du domaine joint par un trunk (même nom de domaine et même mot de passe).');
  return [...out, ''];
}

export function switchShows(parseInterfaces) {
  return [
    kw('etherchannel', 'EtherChannel information', {
      run: (c) => c.out.push(...showEtherchannel(c)),
      children: [kw('summary', 'One-line summary per channel-group', { run: (c) => c.out.push(...showEtherchannel(c)) })],
    }),
    kw('port-security', 'Show secure port information', {
      run: (c) => c.out.push(...showPortSecurity(c)),
      children: [
        kw('address', 'Show secure address', { run: (c) => c.out.push(...showPortSecurityAddress(c)) }),
        kw('interface', 'Show secure interface', {
          children: [rest('spec', 'WORD', 'Interface', (c) => {
            const r = parseInterfaces(c.args.spec, c.dev);
            if (r.error || r.names.length !== 1) return c.out.push('% Invalid interface type and number', '');
            return c.out.push(...showPortSecurity(c, r.names[0]));
          })],
        }),
      ],
    }),
    kw('vtp', 'VTP information', {
      children: [kw('status', 'VTP domain status', { run: (c) => c.out.push(...showVtp(c)) }), kw('password', 'VTP password', { run: (c) => c.out.push(`VTP Password: ${vtpOf(c.dev)?.password ?? ''}`, '') })],
    }),
  ];
}

// « show interfaces trunk », « show interfaces status » (sous « show interfaces »)
export const interfacesShows = () => [
  kw('trunk', 'Show interface trunk information', { run: (c) => c.out.push(...showTrunk(c)) }),
  kw('status', 'Show interface line status', { run: (c) => c.out.push(...showInterfacesStatus(c)) }),
];
