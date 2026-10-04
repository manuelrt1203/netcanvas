// Terminal IOS : serveur DHCP (ip dhcp pool, ip dhcp excluded-address), relais (ip helper-address), show ip dhcp.
import { arg, kw } from './engine.js';
import { maskToCidr, pad } from './device.js';
import { isValidIp } from '../net/ip.js';
import { computeLeases } from '../net/dhcp.js';
import { formatDuration, formatTime } from '../net/runtime.js';

const isIp = (t) => isValidIp(t);
const isName = (t) => /^[A-Za-z0-9_-]+$/.test(t);
const dhcpOf = (c) => {
  if (!c.dev.config.dhcp || c.dev.config.dhcp === true) c.dev.config.dhcp = { pools: [] };
  return c.dev.config.dhcp;
};
const touch = (c) => { c.changed = true; };
const poolOf = (c) => (dhcpOf(c).pools ??= []).find((p) => (p.name ?? p.network) === c.s.pool);

// « ip dhcp … » en configuration globale (remove : version « no »)
export function dhcpConfigCommand(remove = false) {
  const excluded = (c) => {
    const range = [c.args.from, c.args.to ?? c.args.from];
    const d = dhcpOf(c);
    d.excluded = (d.excluded ?? []).filter(([a, b]) => !(a === range[0] && (b ?? a) === range[1]));
    if (!remove) d.excluded.push(range);
    touch(c);
  };
  return kw('dhcp', 'Configure DHCP server and relay parameters', {
    children: [
      kw('pool', 'Configure DHCP address pools', {
        children: [arg('name', 'WORD', 'Pool name', isName, {
          run: (c) => {
            const d = dhcpOf(c);
            if (remove) d.pools = (d.pools ?? []).filter((p) => (p.name ?? p.network) !== c.args.name);
            else {
              if (!(d.pools ?? []).some((p) => p.name === c.args.name)) (d.pools ??= []).push({ name: c.args.name, network: null, mask: null });
              c.s.mode = 'dhcp';
              c.s.pool = c.args.name;
            }
            touch(c);
          },
        })],
      }),
      kw('excluded-address', 'Prevent DHCP from assigning certain addresses', {
        children: [arg('from', 'A.B.C.D', 'Low IP address', isIp, { run: excluded, children: [arg('to', 'A.B.C.D', 'High IP address', isIp, { run: excluded })] })],
      }),
    ],
  });
}

// Mode « ip dhcp pool NOM »
export function dhcpTree(common) {
  const set = (key, value) => (c) => { const p = poolOf(c); p[key] = value(c); touch(c); };
  return {
    children: [
      kw('network', 'Network number and mask', {
        children: [arg('net', 'A.B.C.D', 'Network number in dotted-decimal notation', isIp, {
          children: [arg('mask', 'A.B.C.D', 'Network mask', isIp, {
            run: (c) => {
              const mask = maskToCidr(c.args.mask);
              if (mask === null) return c.out.push('% Invalid network mask', '');
              const p = poolOf(c);
              Object.assign(p, { network: c.args.net, mask });
              touch(c);
              return undefined;
            },
          })],
        })],
      }),
      kw('default-router', 'Default routers', { children: [arg('gw', 'A.B.C.D', 'Router\'s IP address', isIp, { run: set('defaultRouter', (c) => c.args.gw) })] }),
      kw('dns-server', 'DNS servers', { children: [arg('dns', 'A.B.C.D', 'Server\'s IP address', isIp, { run: set('dns', (c) => c.args.dns) })] }),
      kw('domain-name', 'Domain name', { children: [arg('x', 'WORD', '', null, { run() {} })] }),
      kw('lease', 'Address lease time', {
        children: [
          kw('infinite', 'Infinite lease', { run: set('leaseTime', () => 'infinite') }),
          arg('days', '<0-365>', 'Days', (t) => /^\d+$/.test(t) && Number(t) <= 365, {
            run: set('leaseTime', (c) => Number(c.args.days) * 86400),
            children: [arg('hours', '<0-23>', 'Hours', (t) => /^\d+$/.test(t) && Number(t) <= 23, {
              run: set('leaseTime', (c) => Number(c.args.days) * 86400 + Number(c.args.hours) * 3600),
              children: [arg('minutes', '<0-59>', 'Minutes', (t) => /^\d+$/.test(t) && Number(t) <= 59, {
                run: set('leaseTime', (c) => Number(c.args.days) * 86400 + Number(c.args.hours) * 3600 + Number(c.args.minutes) * 60),
              })],
            })],
          }),
        ],
      }),
      kw('exit', 'Exit from DHCP pool configuration mode', { run: (c) => { c.s.mode = 'config'; } }),
      ...common,
    ],
  };
}

// « clear ip dhcp binding * | A » : libère les baux de ce serveur
export const clearDhcpCommand = () => {
  const clear = (ip) => (c) => c.effects.push({
    type: 'runtime',
    update: (rt) => ({ ...rt, leases: Object.fromEntries(Object.entries(rt.leases ?? {}).filter(([, l]) => !(l.server === c.dev.id && (ip === '*' || l.ip === ip(c))))) }),
  });
  return kw('dhcp', 'Delete items from the DHCP database', {
    children: [kw('binding', 'DHCP address bindings', {
      children: [
        kw('*', 'Clear all automatic bindings', { run: clear('*') }),
        arg('ip', 'A.B.C.D', 'Clear a specific binding', isIp, { run: clear((c) => c.args.ip) }),
      ],
    })],
  });
};

// « ip helper-address A » sur les interfaces sélectionnées
export function helperCommands(forIfaces) {
  return {
    add: kw('helper-address', 'Specify a destination address for UDP broadcasts', {
      children: [arg('ip', 'A.B.C.D', 'IP destination address', isIp, { run: (c) => forIfaces(c, (e) => { e.helperAddress = c.args.ip; }) })],
    }),
    remove: kw('helper-address', '', { run: (c) => forIfaces(c, (e) => { delete e.helperAddress; }) }),
  };
}

export function showDhcp(dev, doc, what) {
  if (what === 'pool') {
    const out = [];
    for (const p of dev.config?.dhcp?.pools ?? []) {
      out.push('', `Pool ${p.name ?? p.network} :`, ` Network                        : ${p.network ?? '(non défini)'}/${p.mask ?? ''}`,
        ` Lease                          : ${p.leaseTime === 'infinite' ? 'infinite' : formatDuration(Number(p.leaseTime) || 86400)}`,
        ` Default router                 : ${p.defaultRouter ?? '-'}`, ` DNS server                     : ${p.dns ?? '-'}`);
    }
    return [...out, ''];
  }
  const rows = [`${pad('IP address', 17)}${pad('Client-ID/', 24)}${pad('Lease expiration', 24)}Type`, `${' '.repeat(17)}Hardware address`];
  // Tous les baux en cours, y compris ceux d'hôtes débranchés (ils occupent l'adresse jusqu'à expiration)
  const { store } = computeLeases(doc);
  for (const [id, l] of Object.entries(store)) {
    if (l.server !== dev.id) continue;
    const label = doc.devices.find((d) => d.id === id)?.label ?? `${id} (parti)`;
    rows.push(`${pad(l.ip, 17)}${pad(label, 24)}${pad(l.end == null ? 'Infinite' : formatTime(l.end), 24)}Automatic`);
  }
  return [...rows, ''];
}
