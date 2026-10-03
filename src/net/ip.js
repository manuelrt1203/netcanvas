// Outils d'adressage IPv4. Les adresses sont manipulées en entiers non signés 32 bits.

const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function parseIp(str) {
  if (typeof str !== 'string') return null;
  const parts = str.trim().split('.');
  if (parts.length !== 4 || !parts.every((p) => OCTET.test(p))) return null;
  return parts.reduce((acc, p) => ((acc << 8) | Number(p)) >>> 0, 0);
}

export const isValidIp = (str) => parseIp(str) !== null;

export function formatIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

export function isValidCidr(cidr) {
  return Number.isInteger(cidr) && cidr >= 0 && cidr <= 32;
}

export function maskBits(cidr) {
  return cidr === 0 ? 0 : (0xffffffff << (32 - cidr)) >>> 0;
}

export const cidrToMask = (cidr) => formatIp(maskBits(cidr));

export function networkOf(ip, cidr) {
  return (parseIp(ip) & maskBits(cidr)) >>> 0;
}

export function sameSubnet(ipA, ipB, cidr) {
  return networkOf(ipA, cidr) === networkOf(ipB, cidr);
}

export function networkLabel(ip, cidr) {
  return `${formatIp(networkOf(ip, cidr))}/${cidr}`;
}

export function isNetworkAddress(ip, cidr) {
  return cidr < 31 && parseIp(ip) === networkOf(ip, cidr);
}

export function isBroadcastAddress(ip, cidr) {
  return cidr < 31 && parseIp(ip) === (networkOf(ip, cidr) | (~maskBits(cidr) >>> 0)) >>> 0;
}

// Accepte « 192.168.1.10/24 » dans un champ IP : renvoie { ip, cidr } ou null
export function splitCidr(str) {
  const m = /^\s*([\d.]+)\s*\/\s*(\d{1,2})\s*$/.exec(str || '');
  if (!m) return null;
  const cidr = Number(m[2]);
  return isValidIp(m[1]) && isValidCidr(cidr) ? { ip: m[1], cidr } : null;
}
