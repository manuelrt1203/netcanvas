// Listes de contrôle d'accès (ACL) Cisco et pare-feu MikroTik, appliqués aux paquets du simulateur :
// packet = { src, dst, proto: 'icmp' | 'udp' | 'tcp' (icmp par défaut), sport, dport }
//
// Cisco : config.acls = { [nom]: { type: 'standard' | 'extended', rules: [règle] } },
//         interface : aclIn / aclOut (nom de l'ACL). Première ligne qui correspond, sinon refus implicite.
//         Une ACL appliquée mais inexistante laisse tout passer (comme IOS).
// MikroTik : config.firewall = [{ chain, action, protocol, src, dst, inIface, outIface }], tout passe par défaut.
import { isValidIp, maskBits, parseIp, splitCidr } from './ip.js';

// 1-99 et 1300-1999 : standard ; 100-199 et 2000-2699 : étendue
export function aclTypeOf(name) {
  const n = Number(name);
  if ((n >= 1 && n <= 99) || (n >= 1300 && n <= 1999)) return 'standard';
  if ((n >= 100 && n <= 199) || (n >= 2000 && n <= 2699)) return 'extended';
  return null;
}

const PROTOCOLS = ['ip', 'icmp', 'tcp', 'udp'];

// « any » | « host A » | « A W » (W facultatif en standard : A seul = un hôte)
function readSpec(tokens, i, optionalWildcard) {
  const t = tokens[i]?.toLowerCase();
  if (t === 'any') return { spec: { any: true }, next: i + 1 };
  if (t === 'host') {
    if (!isValidIp(tokens[i + 1])) return { error: `adresse attendue après « host »` };
    return { spec: { ip: tokens[i + 1], wildcard: '0.0.0.0' }, next: i + 2 };
  }
  if (!isValidIp(tokens[i])) return { error: `adresse, « host » ou « any » attendu (« ${tokens[i] ?? ''} »)` };
  if (isValidIp(tokens[i + 1])) return { spec: { ip: tokens[i], wildcard: tokens[i + 1] }, next: i + 2 };
  if (!optionalWildcard) return { error: `wildcard attendu après ${tokens[i]} (ex. 0.0.0.255, ou « host ${tokens[i]} »)` };
  return { spec: { ip: tokens[i], wildcard: '0.0.0.0' }, next: i + 1 };
}

// Noms de ports reconnus par IOS (« eq www », « eq domain »…)
export const PORT_NAMES = {
  ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, bootps: 67, bootpc: 68, tftp: 69, www: 80, http: 80,
  pop3: 110, ntp: 123, snmp: 161, https: 443, 443: 443,
};
const portNum = (t) => (/^\d+$/.test(t) ? Number(t) : PORT_NAMES[t?.toLowerCase()] ?? null);

// Le port correspond-il à « eq 80 », « gt 1023 », « range 20 21 »… ? (pas de condition : oui)
export function matchPort(spec, port) {
  if (!spec) return true;
  if (port == null) return false;
  const [op, a, b] = spec.split(/\s+/);
  const x = portNum(a);
  if (op === 'eq') return port === x;
  if (op === 'neq') return port !== x;
  if (op === 'gt') return port > x;
  if (op === 'lt') return port < x;
  if (op === 'range') return port >= x && port <= portNum(b);
  return false;
}

// « eq 80 », « eq www »… (TCP/UDP)
function readPort(tokens, i) {
  if (['eq', 'neq', 'gt', 'lt'].includes(tokens[i]?.toLowerCase()) && tokens[i + 1]) return { port: `${tokens[i]} ${tokens[i + 1]}`, next: i + 2 };
  if (tokens[i]?.toLowerCase() === 'range' && tokens[i + 2]) return { port: `range ${tokens[i + 1]} ${tokens[i + 2]}`, next: i + 3 };
  return { port: null, next: i };
}

// Une ligne d'ACL au format IOS (sans « access-list N ») -> { rule } ou { error }
export function parseAclLine(text, type) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { error: 'ligne vide' };
  if (tokens[0].toLowerCase() === 'remark') return { rule: { remark: text.trim().slice(6).trim() } };
  const action = tokens[0].toLowerCase();
  if (action !== 'permit' && action !== 'deny') return { error: `« permit » ou « deny » attendu (« ${tokens[0]} »)` };
  let i = 1;
  const rule = { action };
  if (type === 'extended') {
    rule.protocol = tokens[1]?.toLowerCase();
    if (!PROTOCOLS.includes(rule.protocol)) return { error: `protocole attendu : ip, icmp, tcp ou udp (« ${tokens[1] ?? ''} »)` };
    i = 2;
  }
  const src = readSpec(tokens, i, type === 'standard');
  if (src.error) return { error: `source : ${src.error}` };
  rule.src = src.spec;
  i = src.next;
  if (type === 'extended') {
    const sp = readPort(tokens, i);
    if (sp.port) rule.srcPort = sp.port;
    i = sp.next;
    const dst = readSpec(tokens, i, false);
    if (dst.error) return { error: `destination : ${dst.error}` };
    rule.dst = dst.spec;
    i = dst.next;
    const dp = readPort(tokens, i);
    if (dp.port) rule.dstPort = dp.port;
    i = dp.next;
  }
  if (tokens[i]?.toLowerCase() === 'log') i++;
  if (i < tokens.length) return { error: `texte en trop : « ${tokens.slice(i).join(' ')} »` };
  return { rule };
}

const specText = (s, standard) => (s.any ? 'any'
  : s.wildcard === '0.0.0.0' ? (standard ? s.ip : `host ${s.ip}`)
    : `${s.ip} ${s.wildcard}`);

export function ruleText(rule, type) {
  if (rule.remark !== undefined) return `remark ${rule.remark}`;
  if (type === 'standard') return `${rule.action} ${specText(rule.src, true)}`;
  return [rule.action, rule.protocol, specText(rule.src), rule.srcPort, specText(rule.dst), rule.dstPort].filter(Boolean).join(' ');
}

export function matchSpec(spec, ip) {
  if (spec.any) return true;
  const w = parseIp(spec.wildcard) ?? 0;
  return ((parseIp(ip) & ~w) >>> 0) === ((parseIp(spec.ip) & ~w) >>> 0);
}

// Verdict d'une ACL pour un paquet : { permit, line (n° IOS : 10, 20…) | null, text }
export function evaluateAcl(acl, packet) {
  const pproto = packet.proto ?? 'icmp';
  let seq = 0;
  for (const rule of acl.rules ?? []) {
    if (rule.remark !== undefined) continue;
    seq += 10;
    const proto = acl.type === 'standard' || rule.protocol === 'ip' || rule.protocol === pproto;
    const ports = acl.type === 'standard' || (matchPort(rule.srcPort, packet.sport) && matchPort(rule.dstPort, packet.dport));
    const hit = proto && ports && matchSpec(rule.src, packet.src) && (acl.type === 'standard' || matchSpec(rule.dst, packet.dst));
    if (hit) return { permit: rule.action === 'permit', line: seq, text: ruleText(rule, acl.type) };
  }
  return { permit: false, line: null, text: 'deny any (refus implicite)' };
}

// --- MikroTik -----------------------------------------------------------------------
const inCidr = (cidr, ip) => {
  if (!cidr) return true;
  const s = splitCidr(cidr) ?? (isValidIp(cidr) ? { ip: cidr, cidr: 32 } : null);
  if (!s) return false;
  return ((parseIp(ip) & maskBits(s.cidr)) >>> 0) === ((parseIp(s.ip) & maskBits(s.cidr)) >>> 0);
};

export function firewallRuleText(r) {
  return [
    `chain=${r.chain}`, `action=${r.action}`, r.protocol && `protocol=${r.protocol}`,
    r.src && `src-address=${r.src}`, r.dst && `dst-address=${r.dst}`, r.dstPort && `dst-port=${r.dstPort}`,
    r.inIface && `in-interface=${r.inIface}`, r.outIface && `out-interface=${r.outIface}`,
  ].filter(Boolean).join(' ');
}

// Une règle « chain=forward action=drop protocol=icmp src-address=… » -> { rule } ou { error }
export function parseFirewallRule(text) {
  const named = Object.fromEntries(text.trim().split(/\s+/).filter((t) => t.includes('=')).map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)]));
  const rule = {
    chain: named.chain, action: named.action ?? 'accept', protocol: named.protocol,
    src: named['src-address'], dst: named['dst-address'], inIface: named['in-interface'], outIface: named['out-interface'],
    dstPort: named['dst-port'],
  };
  if (rule.dstPort && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(rule.dstPort)) return { error: 'dst-port invalide (ex. 80, 80,443 ou 1000-2000)' };
  if (!['forward', 'input'].includes(rule.chain)) return { error: 'chain=forward ou chain=input attendu' };
  if (!['accept', 'drop', 'reject'].includes(rule.action)) return { error: 'action=accept, drop ou reject attendu' };
  for (const k of ['src', 'dst']) {
    if (rule[k] && !splitCidr(rule[k]) && !isValidIp(rule[k])) return { error: `${k}-address invalide` };
  }
  return { rule: Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== undefined)) };
}

// Première règle de la chaîne qui correspond ; par défaut tout passe
export function evaluateFirewall(rules, chain, packet, inIface, outIface) {
  let n = -1;
  for (const r of rules ?? []) {
    n++;
    if (r.chain !== chain) continue;
    if (r.protocol && r.protocol !== (packet.proto ?? 'icmp')) continue;
    if (r.dstPort && !r.dstPort.split(',').some((part) => {
      const [a, b = a] = part.split('-').map(Number);
      return packet.dport >= a && packet.dport <= b;
    })) continue;
    if (!inCidr(r.src, packet.src) || !inCidr(r.dst, packet.dst)) continue;
    if (r.inIface && r.inIface !== inIface) continue;
    if (r.outIface && r.outIface !== outIface) continue;
    return { permit: r.action === 'accept', line: n, text: firewallRuleText(r) };
  }
  return { permit: true, line: null, text: null };
}
