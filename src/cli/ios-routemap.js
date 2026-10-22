// Terminal IOS : route-maps. « route-map NOM [permit|deny] [N] » entre dans le mode, où « match » et « set »
// décrivent la clause (voir net/routemap.js pour ce qui est simulé).
import { arg, kw, rest } from './engine.js';
import { parsePrefixListEntry, prefixListEntryText, showRouteMaps } from '../net/routemap.js';

const isName = (t) => /^[A-Za-z0-9_.-]+$/.test(t);
const isSeq = (t) => /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 65535;
const isNum = (min, max) => (t) => /^\d+$/.test(t) && Number(t) >= min && Number(t) <= max;
const touch = (c) => { c.changed = true; };

const maps = (c) => (c.dev.config.routeMaps ??= {});
const clauseOf = (c) => maps(c)[c.s.rm.name]?.find((x) => x.seq === c.s.rm.seq);

function enter(c, name, action, seq) {
  const rm = (maps(c)[name] ??= []);
  let clause = rm.find((x) => x.seq === seq);
  if (!clause) {
    clause = { seq, action, match: {}, set: {} };
    rm.push(clause);
    rm.sort((a, b) => a.seq - b.seq);
  } else if (clause.action !== action) {
    return c.out.push(`% Cannot change the action of an existing clause : use « no route-map ${name} ${clause.action} ${seq} » first`, '');
  }
  c.s.mode = 'route-map';
  c.s.rm = { name, seq };
  touch(c);
  return undefined;
}

// Configuration globale : « route-map NOM [permit|deny] [N] » (par défaut permit 10)
export function routeMapConfigCommands() {
  const withSeq = (action) => ({
    run: (c) => enter(c, c.args.name, action, 10),
    children: [arg('seq', '<1-65535>', 'Sequence to insert to/delete from existing route-map entry', isSeq, { run: (c) => enter(c, c.args.name, action, Number(c.args.seq)) })],
  });
  const add = kw('route-map', 'Create route-map or enter route-map command mode', {
    children: [arg('name', 'WORD', 'Route map tag', isName, {
      run: (c) => enter(c, c.args.name, 'permit', 10),
      children: [kw('permit', 'Route map permit set', withSeq('permit')), kw('deny', 'Route map deny set', withSeq('deny'))],
    })],
  });
  const drop = (c, seq) => {
    const rm = maps(c)[c.args.name];
    if (!rm) return c.out.push('% Route-map not found', '');
    maps(c)[c.args.name] = seq === undefined ? [] : rm.filter((x) => x.seq !== seq);
    if (!maps(c)[c.args.name].length) delete maps(c)[c.args.name];
    if (!Object.keys(maps(c)).length) delete c.dev.config.routeMaps;
    return touch(c);
  };
  const remove = kw('route-map', 'Create route-map or enter route-map command mode', {
    children: [arg('name', 'WORD', 'Route map tag', isName, {
      run: (c) => drop(c),
      children: ['permit', 'deny'].map((a) => kw(a, '', {
        run: (c) => drop(c),
        children: [arg('seq', '<1-65535>', '', isSeq, { run: (c) => drop(c, Number(c.args.seq)) })],
      })),
    })],
  });
  return { add, remove };
}

// Mode « (config-route-map)# »
export function routeMapTree(common) {
  const list = (text) => text.trim().split(/\s+/).filter(Boolean);
  const set = (c, name, value) => {
    const cl = clauseOf(c);
    if (!cl) return c.out.push('% Route-map clause not found', '');
    cl.set ??= {};
    if (value === undefined) delete cl.set[name]; else cl.set[name] = value;
    return touch(c);
  };
  const num = (key, word, help, max) => kw(word, help, {
    children: [arg('n', `<0-${max}>`, help, isNum(0, max), { run: (c) => set(c, key, Number(c.args.n)) })],
  });
  const match = kw('match', 'Match values from routing table', {
    children: [
      kw('ip', 'IP specific information', {
        children: [kw('address', 'Match address of route or match packet', {
          children: [
            kw('prefix-list', 'Match entries of prefix-lists', {
              children: [rest('names', 'WORD', 'IP prefix-list name', (c) => { const cl = clauseOf(c); if (cl) { (cl.match ??= {}).prefixList = list(c.args.names); touch(c); } })],
            }),
            rest('names', '<1-199> | WORD', 'IP access-list number or name', (c) => { const cl = clauseOf(c); if (cl) { (cl.match ??= {}).acl = list(c.args.names); touch(c); } }),
          ],
        })],
      }),
      kw('tag', 'Match tag of route', {
        children: [rest('tags', '<0-4294967295>', 'Tag value', (c) => {
          const tags = list(c.args.tags);
          if (!tags.every(isNum(0, 4294967295))) return c.out.push("% Invalid input detected at '^' marker.", '');
          const cl = clauseOf(c);
          if (cl) { (cl.match ??= {}).tag = tags.map(Number); touch(c); }
          return undefined;
        })],
      }),
    ],
  });
  const setCmd = kw('set', 'Set values in destination routing protocol', {
    children: [
      num('localPref', 'local-preference', 'BGP local preference path attribute', 4294967295),
      num('metric', 'metric', 'Metric value for destination routing protocol', 4294967295),
      num('weight', 'weight', 'BGP weight for routing table', 65535),
      num('tag', 'tag', 'Tag value for destination routing protocol', 4294967295),
      kw('as-path', 'Prepend string for a BGP AS-path attribute', {
        children: [kw('prepend', 'Prepend to the as-path', {
          children: [rest('asns', '<1-65535>', 'AS number', (c) => {
            const asns = list(c.args.asns);
            if (!asns.every(isNum(1, 4294967295))) return c.out.push("% Invalid input detected at '^' marker.", '');
            return set(c, 'prepend', asns.map(Number));
          })],
        })],
      }),
      kw('ip', 'IP specific information', {
        children: [kw('next-hop', 'Next hop address', {
          children: [arg('addr', 'A.B.C.D', 'IP address of next hop', (t) => /^\d+\.\d+\.\d+\.\d+$/.test(t), { run: (c) => set(c, 'nextHop', c.args.addr) })],
        })],
      }),
    ],
  });
  const undo = (key) => (c) => {
    const cl = clauseOf(c);
    if (!cl) return;
    if (key === 'match') cl.match = {}; else delete cl.set?.[key];
    touch(c);
  };
  const no = kw('no', 'Negate a command or set its defaults', {
    children: [
      kw('match', '', { children: [rest('x', 'LINE', '', undo('match'))] }),
      kw('set', '', {
        children: [
          kw('local-preference', '', { run: undo('localPref'), children: [rest('x', 'LINE', '', undo('localPref'))] }),
          kw('metric', '', { run: undo('metric'), children: [rest('x', 'LINE', '', undo('metric'))] }),
          kw('weight', '', { run: undo('weight'), children: [rest('x', 'LINE', '', undo('weight'))] }),
          kw('tag', '', { run: undo('tag'), children: [rest('x', 'LINE', '', undo('tag'))] }),
          kw('as-path', '', { children: [rest('x', 'LINE', '', undo('prepend'))] }),
          kw('ip', '', { children: [rest('x', 'LINE', '', undo('nextHop'))] }),
        ],
      }),
    ],
  });
  return {
    children: [
      match,
      setCmd,
      no,
      kw('exit', 'Exit from route-map configuration mode', { run: (c) => { c.s.mode = 'config'; delete c.s.rm; } }),
      ...common,
    ],
  };
}

export const routeMapShows = () => [
  kw('route-map', 'route-map information', {
    run: (c) => c.out.push(...showRouteMaps(c.dev), ''),
    children: [arg('name', 'WORD', 'route-map name', null, { run: (c) => c.out.push(...showRouteMaps(c.dev, c.args.name), '') })],
  }),
];

// « ip prefix-list NOM [seq N] permit|deny A.B.C.D/len [ge N] [le N] » ; « no ip prefix-list NOM [seq N] »
export function prefixListCommands() {
  const lists = (c) => (c.dev.config.prefixLists ??= {});
  const add = kw('prefix-list', 'Build a prefix list', {
    children: [arg('name', 'WORD', 'Name of a prefix list', isName, {
      children: [rest('entry', 'seq N | permit | deny ...', 'Prefix list entry', (c) => {
        const list = lists(c)[c.args.name] ?? [];
        const r = parsePrefixListEntry(c.args.entry, (list.length ? Math.max(...list.map((e) => e.seq)) : 0) + 5);
        if (r.error) return c.out.push(`% Invalid input : ${r.error}`, '');
        lists(c)[c.args.name] = [...list.filter((e) => e.seq !== r.entry.seq), r.entry].sort((a, b) => a.seq - b.seq);
        return touch(c);
      })],
    })],
  });
  const remove = kw('prefix-list', 'Build a prefix list', {
    children: [arg('name', 'WORD', 'Name of a prefix list', isName, {
      run: (c) => { delete c.dev.config.prefixLists?.[c.args.name]; if (!Object.keys(c.dev.config.prefixLists ?? {}).length) delete c.dev.config.prefixLists; touch(c); },
      children: [kw('seq', 'sequence number of an entry', { children: [arg('n', '<1-4294967294>', 'Sequence number', (t) => /^\d+$/.test(t), {
        run: (c) => {
          const rest = (c.dev.config.prefixLists?.[c.args.name] ?? []).filter((e) => e.seq !== Number(c.args.n));
          if (rest.length) c.dev.config.prefixLists[c.args.name] = rest; else delete c.dev.config.prefixLists?.[c.args.name];
          if (!Object.keys(c.dev.config.prefixLists ?? {}).length) delete c.dev.config.prefixLists;
          touch(c);
        },
      })] })],
    })],
  });
  const show = kw('prefix-list', 'List IP prefix list', {
    run: (c) => c.out.push(...showPrefixLists(c.dev), ''),
    children: [arg('name', 'WORD', 'Name of a prefix list', null, { run: (c) => c.out.push(...showPrefixLists(c.dev, c.args.name), '') })],
  });
  return { add, remove, show };
}

function showPrefixLists(dev, only = null) {
  const out = [];
  for (const [name, entries] of Object.entries(dev.config?.prefixLists ?? {})) {
    if (only && name !== only) continue;
    out.push(`ip prefix-list ${name}: ${entries.length} entries`, ...entries.map((e) => `   ${prefixListEntryText(e)}`));
  }
  return out.length ? out : [only ? `%Prefix-list ${only} not found` : ''];
}
