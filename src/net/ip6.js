// Outils d'adressage IPv6. Les adresses sont manipulées en BigInt 128 bits.
// Écriture : forme compressée de la RFC 5952 (minuscules, « :: » sur la plus longue suite de zéros).

const FULL = (1n << 128n) - 1n;
const HEX = /^[0-9a-f]{1,4}$/i;

export function parseIp6(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  if (!s || s.includes('%') || (s.match(/::/g) ?? []).length > 1) return null;
  // IPv4 en fin d'adresse (::ffff:192.0.2.1) : deux groupes
  let text = s;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    if (o.some((x) => x > 255) || v4[1].split('.').some((p) => p.length > 1 && p.startsWith('0'))) return null;
    text = s.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  if (tail === null && a.length !== 8) return null;
  if (tail !== null && a.length + b.length > 7) return null;
  const groups = [...a, ...Array(tail === null ? 0 : 8 - a.length - b.length).fill('0'), ...b];
  if (!groups.every((g) => HEX.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

export const isValidIp6 = (str) => parseIp6(str) !== null;

export function formatIp6(n) {
  const groups = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(112 - 16 * i)) & 0xffffn));
  // Plus longue suite d'au moins deux groupes nuls (la première en cas d'égalité)
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best[1] && j - i >= 2) best = [i, j - i];
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best[0] < 0) return hex.join(':');
  return `${hex.slice(0, best[0]).join(':')}::${hex.slice(best[0] + best[1]).join(':')}`;
}

// Forme normalisée d'une adresse saisie (null si invalide)
export const normIp6 = (str) => {
  const n = parseIp6(str);
  return n === null ? null : formatIp6(n);
};

export const isValidPrefix6 = (p) => Number.isInteger(p) && p >= 0 && p <= 128;
export const prefixBits6 = (p) => (p === 0 ? 0n : (FULL << BigInt(128 - p)) & FULL);
export const networkOf6 = (ip, p) => parseIp6(ip) & prefixBits6(p);
export const sameSubnet6 = (a, b, p) => networkOf6(a, p) === networkOf6(b, p);
export const networkLabel6 = (ip, p) => `${formatIp6(networkOf6(ip, p))}/${p}`;
export const inPrefix6 = (ip, network, p) => (parseIp6(ip) & prefixBits6(p)) === (parseIp6(network) & prefixBits6(p));

// Accepte « 2001:db8:1::10/64 » dans un champ : { ip, prefix } ou null
export function splitPrefix6(str) {
  const m = /^\s*([0-9a-f:.]+)\s*\/\s*(\d{1,3})\s*$/i.exec(str || '');
  if (!m) return null;
  const prefix = Number(m[2]);
  return isValidIp6(m[1]) && isValidPrefix6(prefix) ? { ip: normIp6(m[1]), prefix } : null;
}

// Catégorie d'une adresse (pour les explications)
export function kindOf6(ip) {
  const n = parseIp6(ip);
  if (n === null) return null;
  if (n === 0n) return 'unspecified';
  if (n === 1n) return 'loopback';
  const top = n >> 112n;
  if ((top & 0xff00n) === 0xff00n) return 'multicast';
  if ((top & 0xffc0n) === 0xfe80n) return 'link-local';
  if ((top & 0xfe00n) === 0xfc00n) return 'unique-local';
  if ((top & 0xe000n) === 0x2000n) return 'global';
  return 'other';
}
export const isLinkLocal6 = (ip) => kindOf6(ip) === 'link-local';
// Adresse utilisable sur une interface (ni multicast, ni ::, ni ::1)
export const isUnicast6 = (ip) => ['link-local', 'unique-local', 'global', 'other'].includes(kindOf6(ip));

// Identifiant d'interface EUI-64 depuis une MAC « 0050.7966.6801 » / « 00:50:79:66:68:01 » :
// FFFE inséré au milieu, bit U/L (7e bit) inversé
export function eui64(mac) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length !== 12) return null;
  const b = hex.match(/../g).map((x) => parseInt(x, 16));
  b[0] ^= 0x02;
  const bytes = [...b.slice(0, 3), 0xff, 0xfe, ...b.slice(3)];
  return bytes.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
}

// Adresse link-local fe80::/64 + EUI-64 (comme IOS et Packet Tracer)
export const linkLocalOf = (mac) => {
  const id = eui64(mac);
  return id === null ? null : formatIp6((0xfe80n << 112n) | id);
};

// Adresse d'un préfixe /64 complétée par l'EUI-64 (SLAAC, « ipv6 address … eui-64 »)
export function eui64Address(network, mac) {
  const id = eui64(mac);
  const n = parseIp6(network);
  if (id === null || n === null) return null;
  return formatIp6((n & prefixBits6(64)) | id);
}

// Adresse multicast « nœud sollicité » (NDP) : ff02::1:ffXX:XXXX (24 derniers bits)
export const solicitedNode6 = (ip) => formatIp6((0xff02n << 112n) | (0x1ffn << 24n) | (parseIp6(ip) & 0xffffffn));

// MAC multicast IPv6 33:33 + 32 derniers bits (forme Cisco)
export function multicastMac6(ip) {
  const n = parseIp6(ip) & 0xffffffffn;
  const h = n.toString(16).padStart(8, '0');
  return `3333.${h.slice(0, 4)}.${h.slice(4)}`;
}
