// Invite de commandes d'un PC, serveur ou imprimante (façon Packet Tracer / Windows) : ipconfig, ping.
import { tokenize } from './engine.js';
import { maskToCidr, ping } from './device.js';
import { cidrToMask, isBroadcastAddress, isNetworkAddress, isValidCidr, isValidIp, sameSubnet } from '../net/ip.js';

const HELP = [
  'Commandes disponibles :',
  '  ipconfig                         affiche la configuration IP',
  '  ipconfig <ip> <masque> [passerelle]  configure l\'adresse IP',
  '  ping <ip> [-n nombre]            envoie des echo request',
  '  cls                              efface l\'écran',
  '',
];

function ipconfig(dev) {
  const c = dev.config ?? {};
  const ok = isValidIp(c.ip) && isValidCidr(c.mask);
  return [
    '',
    'FastEthernet0 Connection:(default port)',
    '',
    '   Connection-specific DNS Suffix..: ',
    `   IPv4 Address....................: ${ok ? c.ip : '0.0.0.0'}`,
    `   Subnet Mask.....................: ${ok ? cidrToMask(c.mask) : '0.0.0.0'}`,
    `   Default Gateway.................: ${isValidIp(c.gateway) ? c.gateway : '0.0.0.0'}`,
    '',
  ];
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
        if (!args.length || args[0].toLowerCase() === '/all') {
          out.push(...ipconfig(dev));
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
        dev.config = { ...dev.config, ip, mask: cidr, gateway: gw ?? dev.config?.gateway ?? null };
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
      case 'tracert':
        out.push('NetCanvas : tracert n\'est pas encore simulé.', '');
        break;
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
