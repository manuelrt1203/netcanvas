// NAT / PAT pour le simulateur.
//
// Cisco : interfaces « ip nat inside » / « ip nat outside » (natInside / natOutside) et config.nat :
//   { statics: [{ local, global }], dynamic: [{ acl, iface | pool, overload }], pools: { [nom]: { start, end, mask } } }
//   La source est traduite quand le paquet passe d'une interface inside vers une interface outside ;
//   la destination d'un NAT statique est traduite à l'entrée par une interface outside.
// MikroTik : config.natRules = [{ chain: 'srcnat' | 'dstnat', action: 'masquerade' | 'src-nat' | 'dst-nat',
//   src, dst, inIface, outIface, toAddresses }]
// Les réponses sont « dé-traduites » grâce à la table des traductions du ping (suivi de connexion).
import { evaluateAcl } from './acl.js';
import { isMikrotik } from './catalog.js';
import { formatIp, isValidIp, maskBits, parseIp, splitCidr } from './ip.js';

const ifaceCfg = (dev, name) => (dev.config?.interfaces ?? []).find((i) => i.name === name);
const inCidr = (cidr, ip) => {
  if (!cidr) return true;
  const s = splitCidr(cidr) ?? (isValidIp(cidr) ? { ip: cidr, cidr: 32 } : null);
  return Boolean(s) && ((parseIp(ip) & maskBits(s.cidr)) >>> 0) === ((parseIp(s.ip) & maskBits(s.cidr)) >>> 0);
};

export const hasNat = (dev) => Boolean(dev.config?.nat || dev.config?.natRules?.length);

// Adresses publiques auxquelles le routeur répond en ARP sur une interface (NAT statique / dst-nat)
export function natGlobals(dev, ifName) {
  if (isMikrotik(dev)) {
    return (dev.config?.natRules ?? []).filter((r) => r.chain === 'dstnat' && isValidIp(r.dst) && (!r.inIface || r.inIface === ifName)).map((r) => r.dst);
  }
  if (!ifaceCfg(dev, ifName)?.natOutside) return [];
  // Adresses des pools (bornées) : IOS y répond aussi en ARP
  const pools = Object.values(dev.config?.nat?.pools ?? {}).flatMap((p) => {
    const [a, b] = [parseIp(p.start), parseIp(p.end)];
    if (a === null || b === null || b < a || b - a > 1024) return [];
    return Array.from({ length: b - a + 1 }, (_, i) => formatIp(a + i));
  });
  return [...(dev.config?.nat?.statics ?? []).map((s) => s.global).filter(isValidIp), ...pools];
}

// Traduction de la destination à l'entrée (NAT statique, dst-nat, ou réponse d'une traduction dynamique)
// table : traductions actives [{ router, insideLocal, insideGlobal, outsideGlobal, dynamic }]
// isReply : seule une réponse (echo reply) suit une traduction dynamique, comme le suivi de connexion
export function destNat(dev, inIface, packet, table, isReply) {
  const found = isReply && table.find((t) => t.router === dev.id && t.insideGlobal === packet.dst && t.outsideGlobal === packet.src && t.dynamic);
  const back = found && { inside: found.insideLocal, outside: found.insideGlobal };
  if (isMikrotik(dev)) {
    if (back) return { dst: back.inside, how: `retour de la traduction ${back.inside} ↔ ${back.outside}` };
    const r = (dev.config?.natRules ?? []).find((x) => x.chain === 'dstnat' && x.action === 'dst-nat' && x.dst === packet.dst && (!x.inIface || x.inIface === inIface) && inCidr(x.src, packet.src));
    return r && isValidIp(r.toAddresses) ? { dst: r.toAddresses, how: `dst-nat ${r.dst} → ${r.toAddresses}` } : null;
  }
  if (!ifaceCfg(dev, inIface)?.natOutside) return null;
  if (back) return { dst: back.inside, how: `retour de la traduction ${back.inside} ↔ ${back.outside}` };
  const st = (dev.config?.nat?.statics ?? []).find((s) => s.global === packet.dst);
  return st ? { dst: st.local, how: `NAT statique ${st.global} → ${st.local}` } : null;
}

// Traduction de la source à la sortie. outIp : adresse de l'interface de sortie (PAT « interface … overload »)
export function sourceNat(dev, inIface, outIface, outIp, packet) {
  if (isMikrotik(dev)) {
    for (const r of dev.config?.natRules ?? []) {
      if (r.chain !== 'srcnat' || (r.outIface && r.outIface !== outIface) || !inCidr(r.src, packet.src) || !inCidr(r.dst, packet.dst)) continue;
      if (r.action === 'masquerade') return { src: outIp, dynamic: true, how: `masquerade sur ${outIface}` };
      if (r.action === 'src-nat' && isValidIp(r.toAddresses)) return { src: r.toAddresses, dynamic: true, how: `src-nat vers ${r.toAddresses}` };
    }
    return null;
  }
  const nat = dev.config?.nat;
  if (!nat || !ifaceCfg(dev, inIface)?.natInside || !ifaceCfg(dev, outIface)?.natOutside) return null;
  const st = (nat.statics ?? []).find((s) => s.local === packet.src);
  if (st) return { src: st.global, dynamic: false, how: `NAT statique ${st.local} → ${st.global}` };
  for (const d of nat.dynamic ?? []) {
    const acl = dev.config?.acls?.[d.acl];
    if (!acl || !evaluateAcl(acl, packet).permit) continue;
    if (d.iface) {
      if (d.iface !== outIface) continue;
      return { src: outIp, dynamic: true, how: `PAT (overload) sur ${d.iface}, ACL ${d.acl}` };
    }
    const pool = nat.pools?.[d.pool];
    if (pool && isValidIp(pool.start)) return { src: pool.start, dynamic: true, how: `pool ${d.pool}${d.overload ? ' (overload)' : ''}, ACL ${d.acl}` };
  }
  return null;
}

// Pourquoi une source privée n'a pas été traduite (pour expliquer un échec plus loin)
export function natHint(dev, inIface, outIface, packet) {
  if (isMikrotik(dev)) return null;
  const nat = dev.config?.nat;
  if (!nat) return null;
  const inside = ifaceCfg(dev, inIface)?.natInside;
  const outside = ifaceCfg(dev, outIface)?.natOutside;
  if (!inside) return `${inIface} n'est pas « ip nat inside »`;
  if (!outside) return `${outIface} n'est pas « ip nat outside »`;
  const missing = (nat.dynamic ?? []).find((d) => !dev.config?.acls?.[d.acl]);
  if (missing) return `l'ACL ${missing.acl} de la règle NAT n'existe pas`;
  return `${packet.src} n'est autorisée par aucune ACL de NAT`;
}

const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
export const isPrivate = (ip) => PRIVATE.some((c) => inCidr(c, ip));
