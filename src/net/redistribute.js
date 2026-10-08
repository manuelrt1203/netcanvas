// Redistribution entre protocoles de routage, comme IOS 12.4 / 15 :
//   config.<ospf|rip|eigrp|bgp>.redistribute = { [source]: true | { process?, metric?, metricType?, subnets? } }
//   source : static, connected, ospf, rip, eigrp, bgp ; process = n° de processus OSPF ou d'AS (EIGRP, BGP).
//   config.<rip|eigrp>.defaultMetric : métrique des routes redistribuées sans « metric »
//     (RIP : nombre de sauts ; EIGRP : [bande passante kbit/s, délai en dizaines de µs, fiabilité, charge, MTU]).
// Pièges reproduits : vers OSPF sans « subnets », seuls les réseaux par classe passent ; vers RIP sans métrique,
// les routes d'un autre protocole partent à 16 (injoignables) ; vers EIGRP sans métrique, rien n'est redistribué.
export const SOURCES = ['static', 'connected', 'ospf', 'rip', 'eigrp', 'bgp'];
export const WITH_PROCESS = new Set(['ospf', 'eigrp', 'bgp']);

// true (anciens schémas : « redistribute static subnets ») -> objet
export function redistOf(conf, source) {
  const v = conf?.redistribute?.[source];
  if (!v) return null;
  return v === true ? { subnets: true } : v;
}
export const redistSources = (conf) => SOURCES.filter((s) => redistOf(conf, s));

// Options après « redistribute ospf 1 » : metric N (EIGRP : 5 valeurs), metric-type 1|2, subnets, route-map…
// Renvoie { opts, error, notes }
export function parseRedistOptions(tokens, target) {
  const opts = {};
  const notes = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (t === 'subnets' && target === 'ospf') opts.subnets = true;
    else if (t === 'metric-type' && target === 'ospf' && /^[12]$/.test(tokens[i + 1] ?? '')) opts.metricType = Number(tokens[++i]);
    else if (t === 'metric' && target === 'eigrp') {
      const vals = tokens.slice(i + 1, i + 6).map(Number);
      if (vals.length !== 5 || vals.some((v) => !Number.isInteger(v) || v < 0)) return { error: '% Incomplete command.' };
      opts.metric = vals;
      i += 5;
    } else if (t === 'metric' && /^\d+$/.test(tokens[i + 1] ?? '')) opts.metric = Number(tokens[++i]);
    else if ((t === 'route-map' || t === 'tag') && tokens[i + 1]) {
      notes.push(`% NetCanvas : « ${t} ${tokens[i + 1]} » n'est pas simulé, toutes les routes sont redistribuées.`);
      i++;
    } else if (t === 'match') {
      notes.push('% NetCanvas : « match » n\'est pas simulé (routes internes et externes redistribuées).');
      while (tokens[i + 1] && !['metric', 'metric-type', 'subnets', 'route-map', 'tag'].includes(tokens[i + 1].toLowerCase())) i++;
    } else return { error: "% Invalid input detected at '^' marker." };
  }
  if (target === 'rip' && opts.metric !== undefined && (opts.metric < 0 || opts.metric > 16)) return { error: '% Invalid input detected at \'^\' marker.' };
  return { opts, notes };
}

// Lignes de config IOS (show run, export)
export function redistLines(conf, target, processes = {}) {
  const out = [];
  for (const s of redistSources(conf)) {
    const v = { ...redistOf(conf, s) };
    if (WITH_PROCESS.has(s) && !v.process && processes[s]) v.process = processes[s];
    const metric = v.metric === undefined ? '' : ` metric ${Array.isArray(v.metric) ? v.metric.join(' ') : v.metric}`;
    out.push(` redistribute ${s}${WITH_PROCESS.has(s) && v.process ? ` ${v.process}` : ''}${metric}${v.metricType === 1 ? ' metric-type 1' : ''}${target === 'ospf' && v.subnets ? ' subnets' : ''}`);
  }
  if (conf?.defaultMetric !== undefined) out.push(` default-metric ${Array.isArray(conf.defaultMetric) ? conf.defaultMetric.join(' ') : conf.defaultMetric}`);
  return out;
}
