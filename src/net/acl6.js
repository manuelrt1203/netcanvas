// ACL IPv6 Cisco : toujours nommées (« ipv6 access-list NOM »), appliquées par « ipv6 traffic-filter NOM in|out ».
// config.acls6 = { [nom]: { rules: [règle] } } ; interface : aclIn6 / aclOut6.
// Règle : { action, protocol: 'ipv6' | 'icmp' | 'tcp' | 'udp', src, dst, srcPort, dstPort, icmpType }
//   src / dst : { any: true } | { prefix: '2001:db8:1::', len: 64 } (« host X » = /128)
// Fin de liste implicite (comme IOS) : permit icmp any any nd-na, permit icmp any any nd-ns, deny ipv6 any any.
// Une ACL appliquée mais inexistante laisse tout passer.
import { inPrefix6, isValidIp6, isValidPrefix6, normIp6, splitPrefix6 } from './ip6.js';
import { matchPort } from './acl.js';

const PROTOCOLS = ['ipv6', 'icmp', 'tcp', 'udp'];
// Types ICMPv6 nommés par IOS
export const ICMP6_TYPES = {
  'echo-request': 128, 'echo-reply': 129, 'router-solicitation': 133, 'router-advertisement': 134, 'nd-ns': 135, 'nd-na': 136,
};

function readSpec(tokens, i) {
  const t = tokens[i]?.toLowerCase();
  if (t === 'any') return { spec: { any: true }, next: i + 1 };
  if (t === 'host') {
    if (!isValidIp6(tokens[i + 1])) return { error: 'adresse IPv6 attendue après « host »' };
    return { spec: { prefix: normIp6(tokens[i + 1]), len: 128 }, next: i + 2 };
  }
  const p = splitPrefix6(tokens[i] ?? '');
  if (!p) return { error: `préfixe (2001:db8:1::/64), « host » ou « any » attendu (« ${tokens[i] ?? ''} »)` };
  return { spec: { prefix: p.ip, len: p.prefix }, next: i + 1 };
}

function readPort(tokens, i) {
  if (['eq', 'neq', 'gt', 'lt'].includes(tokens[i]?.toLowerCase()) && tokens[i + 1]) return { port: `${tokens[i]} ${tokens[i + 1]}`, next: i + 2 };
  if (tokens[i]?.toLowerCase() === 'range' && tokens[i + 2]) return { port: `range ${tokens[i + 1]} ${tokens[i + 2]}`, next: i + 3 };
  return { port: null, next: i };
}

// Une ligne au format IOS (sans « ipv6 access-list ») -> { rule } ou { error }
export function parseAcl6Line(text) {
  const tokens = text.trim().replace(/^sequence\s+\d+\s+/i, '').split(/\s+/).filter(Boolean);
  if (!tokens.length) return { error: 'ligne vide' };
  if (tokens[0].toLowerCase() === 'remark') return { rule: { remark: text.trim().slice(6).trim() } };
  const action = tokens[0].toLowerCase();
  if (action !== 'permit' && action !== 'deny') return { error: `« permit » ou « deny » attendu (« ${tokens[0]} »)` };
  const protocol = tokens[1]?.toLowerCase();
  if (!PROTOCOLS.includes(protocol)) return { error: `protocole attendu : ipv6, icmp, tcp ou udp (« ${tokens[1] ?? ''} »)` };
  const rule = { action, protocol };
  const src = readSpec(tokens, 2);
  if (src.error) return { error: `source : ${src.error}` };
  rule.src = src.spec;
  let i = src.next;
  const sp = readPort(tokens, i);
  if (sp.port) rule.srcPort = sp.port;
  i = sp.next;
  const dst = readSpec(tokens, i);
  if (dst.error) return { error: `destination : ${dst.error}` };
  rule.dst = dst.spec;
  i = dst.next;
  const dp = readPort(tokens, i);
  if (dp.port) rule.dstPort = dp.port;
  i = dp.next;
  if ((rule.srcPort || rule.dstPort) && !['tcp', 'udp'].includes(protocol)) return { error: 'un port (eq, range…) demande tcp ou udp' };
  if (protocol === 'icmp' && tokens[i] && tokens[i].toLowerCase() in ICMP6_TYPES) rule.icmpType = tokens[i++].toLowerCase();
  if (tokens[i]?.toLowerCase() === 'log') i++;
  if (i < tokens.length) return { error: `texte en trop : « ${tokens.slice(i).join(' ')} »` };
  return { rule };
}

const specText = (s) => (s.any ? 'any' : s.len === 128 ? `host ${s.prefix}` : `${s.prefix}/${s.len}`);

export function rule6Text(rule) {
  if (rule.remark !== undefined) return `remark ${rule.remark}`;
  return [rule.action, rule.protocol, specText(rule.src), rule.srcPort, specText(rule.dst), rule.dstPort, rule.icmpType].filter(Boolean).join(' ');
}

const matchSpec6 = (s, ip) => s.any || (isValidIp6(s.prefix) && isValidPrefix6(s.len) && inPrefix6(ip, s.prefix, s.len));

// Verdict pour un paquet { src, dst, proto ('icmp' = ICMPv6), sport, dport, icmpType } :
// { permit, line (10, 20…) | null, text }
export function evaluateAcl6(acl, packet) {
  const proto = packet.proto ?? 'icmp';
  let seq = 0;
  for (const rule of acl.rules ?? []) {
    if (rule.remark !== undefined) continue;
    seq += 10;
    if (rule.protocol !== 'ipv6' && rule.protocol !== proto) continue;
    if (rule.icmpType && rule.icmpType !== (packet.icmpType ?? null)) continue;
    if (!matchPort(rule.srcPort, packet.sport) || !matchPort(rule.dstPort, packet.dport)) continue;
    if (!matchSpec6(rule.src, packet.src) || !matchSpec6(rule.dst, packet.dst)) continue;
    return { permit: rule.action === 'permit', line: seq, text: rule6Text(rule) };
  }
  if (proto === 'icmp' && ['nd-ns', 'nd-na'].includes(packet.icmpType)) return { permit: true, line: null, text: `permit icmp any any ${packet.icmpType} (implicite)` };
  return { permit: false, line: null, text: 'deny ipv6 any any (refus implicite)' };
}

// Une ligne explicite « deny ipv6 any any » masque les permissions NDP implicites : sur IOS, la
// découverte des voisins est alors bloquée sur l'interface (piège classique). Renvoie le n° de ligne ou null.
export function blocksNdp(acl) {
  let seq = 0;
  for (const rule of acl.rules ?? []) {
    if (rule.remark !== undefined) continue;
    seq += 10;
    const any = rule.src.any && rule.dst.any;
    if (rule.action === 'permit' && rule.protocol === 'icmp' && any && (!rule.icmpType || rule.icmpType.startsWith('nd-'))) return null;
    if (rule.action === 'deny' && (rule.protocol === 'ipv6' || (rule.protocol === 'icmp' && !rule.icmpType)) && any) return seq;
  }
  return null;
}
