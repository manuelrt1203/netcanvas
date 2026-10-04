// Terminal IOS : listes de contrôle d'accès (numérotées et nommées), application aux interfaces.
import { arg, kw, rest } from './engine.js';
import { aclTypeOf, parseAclLine, ruleText } from '../net/acl.js';

const isAclNumber = (t) => /^\d+$/.test(t) && aclTypeOf(t) !== null;
const isName = (t) => /^[A-Za-z0-9_-]+$/.test(t);
const touch = (c) => { c.changed = true; };

function addRule(c, name, type, text) {
  const r = parseAclLine(text, type);
  if (r.error) return c.out.push(`% Invalid input detected : ${r.error}.`, '');
  const acls = (c.dev.config.acls ??= {});
  acls[name] ??= { type, rules: [] };
  acls[name].rules.push(r.rule);
  touch(c);
  return undefined;
}

export function showAccessLists(dev, only = null) {
  const out = [];
  for (const [name, acl] of Object.entries(dev.config?.acls ?? {})) {
    if (only && name !== only) continue;
    out.push(`${acl.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${name}`);
    let seq = 0;
    for (const r of acl.rules ?? []) {
      if (r.remark !== undefined) continue;
      seq += 10;
      out.push(`    ${seq} ${ruleText(r, acl.type).replace(/^(permit|deny) (\S+) (\S+)$/, acl.type === 'standard' ? '$1 $2, wildcard bits $3' : '$&')}`);
    }
  }
  return [...out, ''];
}

// Commandes de configuration globale
export function aclConfigCommands() {
  const numbered = kw('access-list', 'Add an access list entry', {
    children: [arg('num', '<1-199>', 'IP access list number', isAclNumber, {
      children: [rest('line', 'LINE', 'permit | deny ...', (c) => addRule(c, c.args.num, aclTypeOf(c.args.num), c.args.line))],
    })],
  });
  const named = kw('access-list', 'Named access-list', {
    children: ['standard', 'extended'].map((type) => kw(type, `${type === 'standard' ? 'Standard' : 'Extended'} Access List`, {
      children: [arg('name', 'WORD', 'Access-list name', isName, {
        run: (c) => {
          const acls = (c.dev.config.acls ??= {});
          if (acls[c.args.name] && acls[c.args.name].type !== type) return c.out.push(`% A ${acls[c.args.name].type} access list named ${c.args.name} already exists`, '');
          acls[c.args.name] ??= { type, rules: [] };
          c.s.mode = type === 'standard' ? 'acl-std' : 'acl-ext';
          c.s.acl = c.args.name;
          touch(c);
          return undefined;
        },
      })],
    })),
  });
  const remove = (c) => { delete c.dev.config.acls?.[c.args.name ?? c.args.num]; touch(c); };
  return {
    numbered,
    ipNamed: named,
    noNumbered: kw('access-list', 'Add an access list entry', { children: [arg('num', '<1-199>', 'IP access list number', isAclNumber, { run: remove })] }),
    noIpNamed: kw('access-list', 'Named access-list', {
      children: ['standard', 'extended'].map((type) => kw(type, '', { children: [arg('name', 'WORD', '', isName, { run: remove })] })),
    }),
  };
}

// Mode « ip access-list standard|extended NOM »
export function aclTree(common) {
  const line = (action) => kw(action, `Specify packets to ${action === 'permit' ? 'forward' : 'reject'}`, {
    children: [rest('line', 'LINE', 'source [destination]', (c) => {
      const acl = c.dev.config.acls[c.s.acl];
      addRule(c, c.s.acl, acl.type, `${action} ${c.args.line}`);
    })],
  });
  return {
    children: [
      line('permit'),
      line('deny'),
      kw('remark', 'Access list entry comment', { children: [rest('text', 'LINE', 'Comment', (c) => { c.dev.config.acls[c.s.acl].rules.push({ remark: c.args.text }); touch(c); })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [arg('seq', '<1-2147483647>', 'Sequence Number', (t) => /^\d+$/.test(t), {
          run: (c) => {
            const acl = c.dev.config.acls[c.s.acl];
            let seq = 0;
            const keep = acl.rules.filter((r) => (r.remark !== undefined ? true : (seq += 10) !== Number(c.args.seq)));
            if (keep.length === acl.rules.length) return c.out.push('% Sequence number not found', '');
            acl.rules = keep;
            touch(c);
            return undefined;
          },
        })],
      }),
      kw('exit', 'Exit from access-list configuration mode', { run: (c) => { c.s.mode = 'config'; } }),
      ...common,
    ],
  };
}

// « ip access-group NOM in|out » sur les interfaces sélectionnées
export function accessGroupCommands(forIfaces) {
  const dir = (set) => ['in', 'out'].map((d) => kw(d, `${d === 'in' ? 'inbound' : 'outbound'} packets`, { run: (c) => set(c, d) }));
  return {
    add: kw('access-group', 'Specify access control for packets', {
      children: [arg('name', '<1-199> | WORD', 'IP access list (standard or extended)', (t) => isAclNumber(t) || isName(t), {
        children: dir((c, d) => forIfaces(c, (e) => { e[d === 'in' ? 'aclIn' : 'aclOut'] = c.args.name; })),
      })],
    }),
    remove: kw('access-group', 'Specify access control for packets', {
      children: [
        ...dir((c, d) => forIfaces(c, (e) => { delete e[d === 'in' ? 'aclIn' : 'aclOut']; })),
        arg('name', '<1-199> | WORD', '', (t) => isAclNumber(t) || isName(t), { children: dir((c, d) => forIfaces(c, (e) => { delete e[d === 'in' ? 'aclIn' : 'aclOut']; })) }),
      ],
    }),
  };
}

export const aclShows = () => [
  kw('access-lists', 'List access lists', {
    run: (c) => c.out.push(...showAccessLists(c.dev)),
    children: [arg('name', '<1-199> | WORD', 'ACL', null, { run: (c) => c.out.push(...showAccessLists(c.dev, c.args.name)) })],
  }),
];

