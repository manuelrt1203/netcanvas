// Terminal IOS : NAT / PAT (ip nat inside/outside, ip nat inside source …, ip nat pool …).
import { arg, kw } from './engine.js';
import { pad } from './device.js';
import { isValidIp } from '../net/ip.js';
import { maskToCidr } from './device.js';
import { parseInterfaces } from './ios.js';
import { iosLongName } from '../export/cisco.js';

const isIp = (t) => isValidIp(t);
const isName = (t) => /^[A-Za-z0-9_-]+$/.test(t);
const natOf = (c) => (c.dev.config.nat ??= { statics: [], dynamic: [] });
const touch = (c) => { c.changed = true; };

// « ip nat inside | outside » sur les interfaces sélectionnées
export function natInterfaceCommands(forIfaces) {
  const side = (on) => ['inside', 'outside'].map((x) => kw(x, `${x === 'inside' ? 'Inside' : 'Outside'} interface for address translation`, {
    run: (c) => forIfaces(c, (e) => {
      const key = x === 'inside' ? 'natInside' : 'natOutside';
      if (on) e[key] = true;
      else delete e[key];
    }),
  }));
  return { add: kw('nat', 'NAT interface commands', { children: side(true) }), remove: kw('nat', 'NAT interface commands', { children: side(false) }) };
}

// « ip nat … » en configuration globale ; remove : version « no »
export function natConfigCommand(remove = false) {
  const dynamic = (target) => (c) => {
    const nat = natOf(c);
    let rule = { acl: c.args.acl, overload: Boolean(c.args.overload) };
    if (target === 'iface') {
      const r = parseInterfaces(c.args.ifname, c.dev);
      if (r.error) return c.out.push(r.error, '');
      rule = { ...rule, iface: r.names[0] };
    } else rule = { ...rule, pool: c.args.pool };
    const same = (d) => d.acl === rule.acl;
    nat.dynamic = (nat.dynamic ?? []).filter((d) => !same(d));
    if (!remove) nat.dynamic.push(rule);
    touch(c);
    return undefined;
  };
  const withOverload = (run) => ({ run, children: [kw('overload', 'Overload an address translation', { run: (c) => { c.args.overload = true; run(c); } })] });
  return kw('nat', 'NAT configuration commands', {
    children: [
      kw('inside', 'Inside address translation', {
        children: [kw('source', 'Source address translation', {
          children: [
            kw('static', 'Specify static local->global mapping', {
              children: [arg('local', 'A.B.C.D', 'Inside local IP address', isIp, {
                children: [arg('global', 'A.B.C.D', 'Inside global IP address', isIp, {
                  run: (c) => {
                    const nat = natOf(c);
                    nat.statics = (nat.statics ?? []).filter((s) => s.local !== c.args.local);
                    if (!remove) nat.statics.push({ local: c.args.local, global: c.args.global });
                    touch(c);
                  },
                })],
              })],
            }),
            kw('list', 'Specify access list describing local addresses', {
              children: [arg('acl', '<1-199> | WORD', 'Access list number or name for local addresses', isName, {
                ...(remove ? { run: dynamic('any') } : {}),
                children: [
                  kw('interface', 'Specify interface for global address', { children: [arg('ifname', 'WORD', 'Interface', null, withOverload(dynamic('iface')))] }),
                  kw('pool', 'Name pool of global addresses', { children: [arg('pool', 'WORD', 'Pool name for global addresses', isName, withOverload(dynamic('pool')))] }),
                ],
              })],
            }),
          ],
        })],
      }),
      kw('pool', 'Define pool of addresses', {
        children: [arg('name', 'WORD', 'Pool name', isName, {
          ...(remove ? { run: (c) => { delete natOf(c).pools?.[c.args.name]; touch(c); } } : {}),
          children: remove ? [] : [arg('start', 'A.B.C.D', 'Start IP address', isIp, {
            children: [arg('end', 'A.B.C.D', 'End IP address', isIp, {
              children: [kw('netmask', 'Specify the network mask', {
                children: [arg('mask', 'A.B.C.D', 'Network mask', isIp, {
                  run: (c) => {
                    const mask = maskToCidr(c.args.mask);
                    if (mask === null) return c.out.push('%Invalid netmask', '');
                    (natOf(c).pools ??= {})[c.args.name] = { start: c.args.start, end: c.args.end, mask };
                    touch(c);
                    return undefined;
                  },
                })],
              })],
            })],
          })],
        })],
      }),
    ],
  });
}

export function showNatTranslations(dev) {
  const rows = [`${pad('Pro', 5)}${pad('Inside global', 19)}${pad('Inside local', 19)}${pad('Outside local', 19)}Outside global`];
  for (const s of dev.config?.nat?.statics ?? []) rows.push(`${pad('---', 5)}${pad(s.global, 19)}${pad(s.local, 19)}${pad('---', 19)}---`);
  const dyn = dev.config?.nat?.dynamic ?? [];
  if (dyn.length) rows.push('', `% NetCanvas : ${dyn.length} règle(s) dynamique(s) (${dyn.map((d) => `ACL ${d.acl} → ${d.iface ? iosLongName(d.iface) : `pool ${d.pool}`}`).join(', ')}) : les traductions apparaissent dans le journal d'un ping.`);
  return [...rows, ''];
}
