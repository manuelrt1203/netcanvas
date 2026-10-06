// Import de la configuration d'un PC (ou serveur, imprimante) : VPCS de GNS3 (commandes ou « show ip »),
// « ipconfig » de Windows (français ou anglais), Linux (ip a, ip route, ifconfig, /etc/network/interfaces,
// netplan, resolv.conf). On en tire l'adresse, le masque, la passerelle, le DNS, DHCP, IPv6 et le nom.
import { maskToCidr } from './device.js';
import { isBroadcastAddress, isNetworkAddress, isValidIp, sameSubnet } from '../net/ip.js';
import { isLinkLocal6, isValidIp6, normIp6 } from '../net/ip6.js';

const FORMATS = { vpcs: 'VPCS (GNS3)', windows: 'ipconfig (Windows)', linux: 'Linux' };

// « 24 », « /24 », « 255.255.255.0 » -> 24
const toCidr = (m) => {
  if (m === undefined || m === null) return null;
  const t = String(m).replace(/^\//, '');
  if (/^\d{1,2}$/.test(t) && Number(t) <= 32) return Number(t);
  return isValidIp(t) ? maskToCidr(t) : null;
};
// Valeur après les « . . . : » de ipconfig, sans « (Préféré) »
const value = (line) => line.slice(line.indexOf(':') + 1).trim().replace(/\((preferred|préféré|deprecated|déconseillé)\)/i, '').trim();

export function detectHostFormat(text) {
  if (/^\s*(set pcname|ip (dhcp|auto|\d))|^NAME\s*:|^IP\/MASK\s*:/im.test(text)) return 'vpcs';
  if (/(IPv4 Address|Adresse IPv4|Subnet Mask|Masque de sous-réseau|Default Gateway|Passerelle par défaut)[ .]*:/i.test(text)) return 'windows';
  if (/\binet6? \S+\/\d+|default via|\bnetmask\b|^\s*(address|gateway|iface|nameserver|addresses:|gateway4:|dhcp4:)/im.test(text)) return 'linux';
  return null;
}

// Renvoie { format, config (champs reconnus), label, used: [{ n, text, what }], ignored: [{ n, text, reason }], warnings }
export function parseHostConfig(text) {
  const format = detectHostFormat(text);
  const c = {};
  let label = null;
  const used = [];
  const ignored = [];
  const take = (n, line, what) => used.push({ n, text: line, what });
  const lines = text.replace(/\r/g, '').split('\n');
  let lastKey = null; // ipconfig : DNS sur plusieurs lignes
  let inNameservers = false; // netplan

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line || /^#/.test(line) || /^-+$/.test(line)) return;
    let m;
    if (format === 'vpcs') {
      if ((m = /^set pcname (\S+)/i.exec(line))) { label = m[1]; return take(n, line, `nom ${m[1]}`); }
      if (/^ip dhcp\b/i.test(line)) { c.dhcp = true; return take(n, line, 'DHCP'); }
      if (/^ip auto\b/i.test(line)) { c.slaac = true; return take(n, line, 'IPv6 automatique (SLAAC)'); }
      if ((m = /^ip dns6? (\S+)/i.exec(line))) { c.dns = m[1]; return take(n, line, `DNS ${m[1]}`); }
      // « ip 192.168.1.10 192.168.1.1 24 », « ip 192.168.1.10/24 192.168.1.1 », « ip 192.168.1.10 255.255.255.0 192.168.1.1 »
      if ((m = /^ip (\d+\.\d+\.\d+\.\d+)(\/\d+)?(?:\s+(\S+))?(?:\s+(\S+))?/i.exec(line))) {
        const rest = [m[3], m[4]].filter(Boolean);
        const gw = rest.find((x) => isValidIp(x) && toCidr(x) === null) ?? rest.find((x) => isValidIp(x) && rest.length === 2 && x !== rest.find((y) => toCidr(y) !== null));
        const mask = toCidr(m[2]) ?? toCidr(rest.find((x) => x !== gw)) ?? 24;
        Object.assign(c, { ip: m[1], mask, ...(gw ? { gateway: gw } : {}) });
        delete c.dhcp;
        return take(n, line, `adresse ${m[1]}/${mask}${gw ? `, passerelle ${gw}` : ''}`);
      }
      if ((m = /^ip ([0-9a-f:]+)\/(\d+)(?:\s+([0-9a-f:]+))?/i.exec(line)) && isValidIp6(m[1])) {
        Object.assign(c, { ipv6: normIp6(m[1]), prefix6: Number(m[2]), ...(m[3] && isValidIp6(m[3]) ? { gateway6: m[3] } : {}) });
        return take(n, line, `IPv6 ${m[1]}/${m[2]}`);
      }
      // « show ip » de VPCS
      if ((m = /^NAME\s*:\s*([^[\s]+)/i.exec(line))) { label = m[1]; return take(n, line, `nom ${m[1]}`); }
      if ((m = /^IP\/MASK\s*:\s*(\d+\.\d+\.\d+\.\d+)\/(\d+)/i.exec(line))) {
        if (m[1] !== '0.0.0.0') Object.assign(c, { ip: m[1], mask: Number(m[2]) });
        return take(n, line, `adresse ${m[1]}/${m[2]}`);
      }
      if ((m = /^GATEWAY\s*:\s*(\d+\.\d+\.\d+\.\d+)/i.exec(line))) { if (m[1] !== '0.0.0.0') c.gateway = m[1]; return take(n, line, `passerelle ${m[1]}`); }
      if ((m = /^DNS\s*:\s*(\d+\.\d+\.\d+\.\d+)/i.exec(line))) { c.dns = m[1]; return take(n, line, `DNS ${m[1]}`); }
      if ((m = /^DHCP SERVER\s*:\s*(\d+\.\d+\.\d+\.\d+)/i.exec(line))) { c.dhcp = true; return take(n, line, 'DHCP'); }
      if (/^(save|clear|show|MAC|LPORT|RHOST|MTU|DHCP|DOMAIN|ping|trace|version|\S+> )/i.test(line)) return;
    }

    if (format === 'windows') {
      const key = line.split(':')[0].replace(/[ .]+$/, '').trim().toLowerCase();
      const v = line.includes(':') ? value(line) : '';
      if (!line.includes(':') && lastKey === 'dns' && isValidIp(line)) return; // 2e serveur DNS
      lastKey = null;
      if (/^(host name|nom de l'hôte)/.test(key)) { label = v; return take(n, line, `nom ${v}`); }
      if (/^(ipv4 address|adresse ipv4|ip address|adresse ip)$/.test(key) && isValidIp(v)) { c.ip = v; return take(n, line, `adresse ${v}`); }
      if (/^(autoconfiguration ipv4 address|adresse ipv4 de configuration automatique)/.test(key)) return ignored.push({ n, text: line, reason: 'adresse APIPA (169.254…) : pas de serveur DHCP joint' });
      if (/^(subnet mask|masque de sous-réseau)$/.test(key) && toCidr(v) !== null) { c.mask = toCidr(v); return take(n, line, `masque /${c.mask}`); }
      if (/^(default gateway|passerelle par défaut)$/.test(key)) {
        if (isValidIp(v)) { c.gateway = v; return take(n, line, `passerelle ${v}`); }
        if (isValidIp6(v.split('%')[0])) { c.gateway6 = v.split('%')[0]; return take(n, line, `passerelle IPv6 ${c.gateway6}`); }
        return;
      }
      if (/^(dns servers|serveurs dns)$/.test(key) && isValidIp(v)) { c.dns = v; lastKey = 'dns'; return take(n, line, `DNS ${v}`); }
      if (/^(dhcp enabled|dhcp activé)$/.test(key)) {
        if (/^(yes|oui)$/i.test(v)) { c.dhcp = true; return take(n, line, 'DHCP'); }
        return;
      }
      if (/^(ipv6 address|adresse ipv6)$/.test(key)) {
        const ip6 = v.split('%')[0].split('/')[0];
        if (isValidIp6(ip6) && !isLinkLocal6(ip6)) { Object.assign(c, { ipv6: normIp6(ip6), prefix6: 64 }); return take(n, line, `IPv6 ${ip6}/64`); }
        return;
      }
      return;
    }

    if (format === 'linux') {
      // ip a : « inet 192.168.1.10/24 brd … scope global eth0 » ; commande « ip addr add 192.168.1.10/24 dev eth0 »
      if ((m = /\binet (\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(line)) || (m = /\baddr(?:ess)? add (\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(line))) {
        if (m[1].startsWith('127.')) return;
        Object.assign(c, { ip: m[1], mask: Number(m[2]) });
        if (/\bdynamic\b/.test(line)) c.dhcp = true;
        return take(n, line, `adresse ${m[1]}/${m[2]}${c.dhcp ? ' (DHCP)' : ''}`);
      }
      if ((m = /\binet6 ([0-9a-f:]+)\/(\d+)/i.exec(line)) || (m = /\baddr(?:ess)? add ([0-9a-f:]+)\/(\d+)/i.exec(line))) {
        if (!isValidIp6(m[1]) || isLinkLocal6(m[1]) || m[1] === '::1') return;
        Object.assign(c, { ipv6: normIp6(m[1]), prefix6: Number(m[2]) });
        if (/\bdynamic\b|mngtmpaddr/.test(line)) c.slaac = true;
        return take(n, line, `IPv6 ${m[1]}/${m[2]}`);
      }
      // ifconfig : « inet 192.168.1.10  netmask 255.255.255.0 »
      if ((m = /\binet (?:addr:)?(\d+\.\d+\.\d+\.\d+)\s+(?:netmask|Mask:)\s*(\S+)/.exec(line))) {
        if (m[1].startsWith('127.')) return;
        Object.assign(c, { ip: m[1], mask: toCidr(m[2]) ?? 24 });
        return take(n, line, `adresse ${m[1]}/${c.mask}`);
      }
      // ip route / route add : passerelle par défaut
      if ((m = /^(?:ip (?:-6 )?route(?: add)? )?default via ([0-9a-f.:]+)/i.exec(line)) || (m = /route add default gw (\S+)/.exec(line))) {
        if (isValidIp(m[1])) { c.gateway = m[1]; return take(n, line, `passerelle ${m[1]}`); }
        if (isValidIp6(m[1])) { c.gateway6 = m[1]; return take(n, line, `passerelle IPv6 ${m[1]}`); }
      }
      if ((m = /^nameserver (\S+)/.exec(line)) && isValidIp(m[1])) { c.dns = m[1]; return take(n, line, `DNS ${m[1]}`); }
      // /etc/network/interfaces
      if ((m = /^iface (\S+) inet (dhcp|static)/.exec(line))) {
        if (m[2] === 'dhcp') { c.dhcp = true; return take(n, line, 'DHCP'); }
        return;
      }
      if (/^iface \S+ inet6 auto/.test(line)) { c.slaac = true; return take(n, line, 'IPv6 automatique (SLAAC)'); }
      if ((m = /^address (\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?$/.exec(line))) {
        Object.assign(c, { ip: m[1], ...(m[2] ? { mask: Number(m[2]) } : {}) });
        return take(n, line, `adresse ${m[1]}${m[2] ? `/${m[2]}` : ''}`);
      }
      if ((m = /^netmask (\S+)$/.exec(line)) && toCidr(m[1]) !== null) { c.mask = toCidr(m[1]); return take(n, line, `masque /${c.mask}`); }
      if ((m = /^gateway4?:? (\d+\.\d+\.\d+\.\d+)$/.exec(line))) { c.gateway = m[1]; return take(n, line, `passerelle ${m[1]}`); }
      if ((m = /^dns-nameservers (\S+)/.exec(line))) { c.dns = m[1]; return take(n, line, `DNS ${m[1]}`); }
      // netplan : « addresses: [192.168.1.10/24] », « - 192.168.1.10/24 », « via: », bloc « nameservers: »
      if (/^nameservers:/.test(line)) { inNameservers = true; return; }
      if (/^(dhcp4):\s*(true|yes)/.test(line)) { c.dhcp = true; return take(n, line, 'DHCP'); }
      if ((m = /^via:\s*(\d+\.\d+\.\d+\.\d+)$/.exec(line))) { c.gateway = m[1]; return take(n, line, `passerelle ${m[1]}`); }
      const listed = /^(?:addresses:\s*\[|- ?)\s*(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?/.exec(line);
      if (listed && inNameservers && !listed[2]) { c.dns = listed[1]; return take(n, line, `DNS ${listed[1]}`); }
      if (listed && listed[2]) {
        Object.assign(c, { ip: listed[1], mask: Number(listed[2]) });
        return take(n, line, `adresse ${listed[1]}/${listed[2]}`);
      }
      if (/^\S+:$/.test(line) && !/^addresses:$/.test(line)) inNameservers = false;
      return;
    }
  });

  // DHCP : l'adresse affichée vient du bail, le PC repasse en client DHCP
  if (c.dhcp) for (const k of ['ip', 'mask', 'gateway']) delete c[k];
  const warnings = [];
  if (c.ip && c.mask === undefined) c.mask = 24;
  if (c.ip && c.mask < 31 && (isNetworkAddress(c.ip, c.mask) || isBroadcastAddress(c.ip, c.mask))) warnings.push(`${c.ip}/${c.mask} est l'adresse du réseau ou de diffusion.`);
  if (c.ip && c.gateway && !sameSubnet(c.ip, c.gateway, c.mask)) warnings.push(`La passerelle ${c.gateway} n'est pas dans le réseau de ${c.ip}/${c.mask} : le PC ne pourra pas sortir de son réseau.`);
  if (format === 'windows' && c.ip?.startsWith('169.254.')) delete c.ip;
  return { format, formatLabel: FORMATS[format] ?? null, config: c, label, used, ignored, warnings };
}

// Applique la config lue au PC (replace : on repart d'une carte vierge)
export function applyHostConfig(device, parsed, { replace = true } = {}) {
  const base = replace ? {} : { ...device.config };
  const c = parsed.config;
  const next = { ...base };
  if (c.dhcp) Object.assign(next, { dhcp: true, ip: null, mask: null, gateway: null });
  else if (c.ip) Object.assign(next, { ip: c.ip, mask: c.mask, gateway: c.gateway ?? null, dhcp: undefined });
  else if (c.gateway) next.gateway = c.gateway;
  if (c.dns) next.dns = c.dns;
  if (c.slaac) Object.assign(next, { slaac: true, ipv6: undefined, prefix6: undefined });
  else if (c.ipv6) Object.assign(next, { ipv6: c.ipv6, prefix6: c.prefix6 ?? 64, slaac: undefined });
  if (c.gateway6) next.gateway6 = c.gateway6;
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  return { ...device, label: parsed.label || device.label, config: next };
}
