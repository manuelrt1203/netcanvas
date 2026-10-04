// Invite de commandes d'un PC, serveur ou imprimante (façon Packet Tracer / Windows) : ipconfig, ping.
import { tokenize } from './engine.js';
import { maskToCidr, ping } from './device.js';
import { traceroute } from '../net/traceroute.js';
import { withLeases } from '../net/dhcp.js';
import { cidrToMask, isBroadcastAddress, isNetworkAddress, isValidCidr, isValidIp, sameSubnet } from '../net/ip.js';

const HELP = [
  'Commandes disponibles :',
  '  ipconfig                         affiche la configuration IP',
  '  ipconfig <ip> <masque> [passerelle]  configure l\'adresse IP',
  '  ipconfig /renew | /release       adresse par DHCP / rendre l\'adresse',
  '  ping <ip> [-n nombre]            envoie des echo request',
  '  tracert <ip>                     routeurs traversés jusqu\'à la destination',
  '  cls                              efface l\'écran',
  '',
];

// c : configuration effective (bail DHCP appliqué)
function ipconfig(c, all = false) {
  const ok = isValidIp(c.ip) && isValidCidr(c.mask);
  const lines = ['', 'FastEthernet0 Connection:(default port)', '', '   Connection-specific DNS Suffix..: '];
  if (c.dhcpError) {
    lines.push(`   Autoconfiguration IPv4 Address..: ${c.ip}`, `   Subnet Mask.....................: ${cidrToMask(c.mask)}`,
      '   Default Gateway.................: 0.0.0.0', '', `NetCanvas : pas de bail DHCP, ${c.dhcpError}.`);
  } else {
    lines.push(`   IPv4 Address....................: ${ok ? c.ip : '0.0.0.0'}`, `   Subnet Mask.....................: ${ok ? cidrToMask(c.mask) : '0.0.0.0'}`,
      `   Default Gateway.................: ${isValidIp(c.gateway) ? c.gateway : '0.0.0.0'}`);
    if (all || c.lease) lines.push(`   DHCP Enabled....................: ${c.dhcp ? 'Yes' : 'No'}`);
    if (c.lease?.dns) lines.push(`   DNS Servers.....................: ${c.lease.dns}`);
  }
  return [...lines, ''];
}

export const host = {
  banner: () => ['Packet Tracer PC Command Line 1.0 (simulé par NetCanvas). Tape « help ».', ''],
  newSession: () => ({}),
  prompt: () => 'C:\\>',

  run(s, line, dev, doc) {
    const ctx = { s, dev, doc, out: [], effects: [], changed: false };
    const [cmd, ...args] = tokenize(line).map((t) => t.text);
    if (!cmd) return ctx;
    const out = ctx.out;
    switch (cmd.toLowerCase()) {
      case 'help':
      case '?':
        out.push(...HELP);
        break;
      case 'cls':
        ctx.effects.push({ type: 'clear' });
        break;
      case 'ipconfig': {
        const live = () => withLeases(ctx.doc).devices.find((d) => d.id === dev.id)?.config ?? dev.config ?? {};
        const flag = args[0]?.toLowerCase();
        if (!args.length || flag === '/all') {
          out.push(...ipconfig(live(), flag === '/all'));
          break;
        }
        const released = (rt, on) => ({ ...rt, released: [...new Set([...(rt.released ?? []).filter((x) => x !== dev.id), ...(on ? [dev.id] : [])])] });
        if (flag === '/renew') {
          // Passe en DHCP (si besoin) et redemande une adresse : le bail est calculé sur le schéma
          if (dev.config?.dhcp !== true) {
            dev.config = { ip: null, mask: null, gateway: null, dhcp: true };
            ctx.changed = true;
          }
          ctx.effects.push({ type: 'runtime', update: (rt) => released(rt, false) });
          const next = { ...doc, runtime: released(doc.runtime ?? {}, false), devices: doc.devices.map((d) => (d.id === dev.id ? dev : d)) };
          out.push(...ipconfig(withLeases(next).devices.find((d) => d.id === dev.id).config));
          break;
        }
        if (flag === '/release') {
          if (dev.config?.dhcp !== true) {
            out.push('', 'The operation failed as no adapter is in the state permissible for this operation.', '');
            break;
          }
          // Le bail est rendu au serveur : plus d'adresse jusqu'au prochain /renew
          ctx.effects.push({ type: 'runtime', update: (rt) => ({ ...released(rt, true), leases: Object.fromEntries(Object.entries(rt.leases ?? {}).filter(([id]) => id !== dev.id)) }) });
          out.push('', '   IP Address......................: 0.0.0.0', '   Subnet Mask.....................: 0.0.0.0', '   Default Gateway.................: 0.0.0.0', '');
          break;
        }
        const [ip, mask, gw] = args;
        const cidr = maskToCidr(mask ?? '');
        if (!isValidIp(ip) || cidr === null || cidr === 0) {
          out.push('Invalid command.', 'Usage : ipconfig <adresse IP> <masque> [passerelle], ex. ipconfig 192.168.1.10 255.255.255.0 192.168.1.1', '');
          break;
        }
        if (cidr < 31 && (isNetworkAddress(ip, cidr) || isBroadcastAddress(ip, cidr))) {
          out.push(`Invalid IP address: ${ip} est l'adresse du réseau ou de diffusion.`, '');
          break;
        }
        if (gw && (!isValidIp(gw) || !sameSubnet(ip, gw, cidr))) {
          out.push(`Invalid gateway: ${gw} n'est pas dans le réseau de ${ip}/${cidr}.`, '');
          break;
        }
        const { dhcp, ...rest } = dev.config ?? {};
        dev.config = { ...rest, ip, mask: cidr, gateway: gw ?? (dhcp === true ? null : rest.gateway) ?? null };
        ctx.changed = true;
        break;
      }
      case 'ping': {
        const target = args.find((a) => !a.startsWith('-') && !/^\d+$/.test(a)) ?? args.find((a) => isValidIp(a));
        const n = args.includes('-n') ? Math.min(Number(args[args.indexOf('-n') + 1]) || 4, 10) : 4;
        if (!isValidIp(target)) {
          out.push(`Ping request could not find host ${target ?? ''}. Please check the name and try again.`, '');
          break;
        }
        const r = ping(doc, dev.id, target);
        ctx.effects.push({ type: 'ping', source: dev.id, target });
        out.push('', `Pinging ${target} with 32 bytes of data:`, '');
        for (let i = 0; i < n; i++) out.push(r.ok ? `Reply from ${target}: bytes=32 time<1ms TTL=${r.ttl}` : 'Request timed out.');
        const recv = r.ok ? n : 0;
        out.push('', `Ping statistics for ${target}:`, `    Packets: Sent = ${n}, Received = ${recv}, Lost = ${n - recv} (${r.ok ? 0 : 100}% loss),`);
        if (r.ok) out.push('Approximate round trip times in milli-seconds:', '    Minimum = 0ms, Maximum = 0ms, Average = 0ms');
        else out.push('', `NetCanvas : ${r.reason}`);
        out.push('');
        break;
      }
      case 'tracert': {
        const target = args.find((a) => isValidIp(a));
        if (!target) {
          out.push(`Unable to resolve target system name ${args[0] ?? ''}.`, '');
          break;
        }
        const t = traceroute(doc, dev.id, target);
        ctx.effects.push({ type: 'ping', source: dev.id, target });
        out.push('', `Tracing route to ${target} over a maximum of 30 hops:`, '');
        for (const h of t.hops) out.push(`${String(h.ttl).padStart(3)}   ${h.ip ? `<1 ms     <1 ms     <1 ms     ${h.ip}` : '*         *         *        Request timed out.'}`);
        out.push('', t.ok ? 'Trace complete.' : `NetCanvas : ${t.reason}`, '');
        break;
      }
      default:
        out.push('Invalid Command.', '');
    }
    return ctx;
  },
  help: () => HELP,
  complete(s, line) {
    const words = ['ipconfig', 'ping', 'help', 'cls', 'tracert'];
    if (/\s/.test(line.trim()) || !line.trim()) return line;
    const m = words.filter((w) => w.startsWith(line.trim().toLowerCase()));
    return m.length === 1 ? `${m[0]} ` : line;
  },
};
