// Invite de commandes d'un PC, serveur ou imprimante (façon Packet Tracer / Windows) : ipconfig, ping, nslookup, curl.
import { tokenize } from './engine.js';
import { maskToCidr, ping } from './device.js';
import { traceroute } from '../net/traceroute.js';
import { withLeases } from '../net/dhcp.js';
import { arpRows, clearArp } from '../net/tables.js';
import { macWindows } from '../net/mac.js';
import { dnsServerOf, httpGet, isHostname, resolveName } from '../net/services.js';
import { cidrToMask, isBroadcastAddress, isNetworkAddress, isValidCidr, isValidIp, sameSubnet } from '../net/ip.js';

const HELP = [
  'Commandes disponibles :',
  '  ipconfig                         affiche la configuration IP',
  '  ipconfig <ip> <masque> [passerelle]  configure l\'adresse IP',
  '  ipconfig /renew | /release       adresse par DHCP / rendre l\'adresse',
  '  ping <ip|nom> [-n nombre]        envoie des echo request',
  '  tracert <ip|nom>                 routeurs traversés jusqu\'à la destination',
  '  nslookup <nom> [serveur]         demande l\'adresse d\'un nom au serveur DNS',
  '  curl http://<nom|ip>             demande une page web (navigateur)',
  '  arp -a | arp -d                  cache ARP : afficher / vider',
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
    const dns = c.lease?.dns ?? c.dns;
    if (dns) lines.push(`   DNS Servers.....................: ${dns}`);
  }
  return [...lines, ''];
}

// Animation de la requête DNS (vers le serveur configuré), même si elle échoue
function dnsEffect(dev, doc) {
  const server = dnsServerOf(withLeases(doc).devices.find((d) => d.id === dev.id));
  return isValidIp(server) ? [{ type: 'ping', source: dev.id, target: server, options: { proto: 'udp', dport: 53 } }] : [];
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
        const asked = args.find((a) => !a.startsWith('-') && !/^\d+$/.test(a)) ?? args.find((a) => isValidIp(a));
        const n = args.includes('-n') ? Math.min(Number(args[args.indexOf('-n') + 1]) || 4, 10) : 4;
        // Un nom est d'abord résolu par le serveur DNS (requête simulée)
        const named = isHostname(asked) ? resolveName(doc, dev.id, asked) : null;
        if (named && !named.ok) {
          ctx.effects.push(...dnsEffect(dev, doc));
          out.push(`Ping request could not find host ${asked}. Please check the name and try again.`, '', `NetCanvas : ${named.log.at(-1).text}`, '');
          break;
        }
        const target = named ? named.ip : asked;
        if (!isValidIp(target)) {
          out.push(`Ping request could not find host ${asked ?? ''}. Please check the name and try again.`, '');
          break;
        }
        const r = ping(doc, dev.id, target);
        ctx.effects.push({ type: 'ping', source: dev.id, target });
        out.push('', named ? `Pinging ${asked} [${target}] with 32 bytes of data:` : `Pinging ${target} with 32 bytes of data:`, '');
        for (let i = 0; i < n; i++) out.push(r.ok ? `Reply from ${target}: bytes=32 time<1ms TTL=${r.ttl}` : 'Request timed out.');
        const recv = r.ok ? n : 0;
        out.push('', `Ping statistics for ${target}:`, `    Packets: Sent = ${n}, Received = ${recv}, Lost = ${n - recv} (${r.ok ? 0 : 100}% loss),`);
        if (r.ok) out.push('Approximate round trip times in milli-seconds:', '    Minimum = 0ms, Maximum = 0ms, Average = 0ms');
        else out.push('', `NetCanvas : ${r.reason}`);
        out.push('');
        break;
      }
      case 'arp': {
        const flag = args[0]?.toLowerCase();
        if (flag === '-d') {
          ctx.effects.push({ type: 'runtime', update: clearArp(dev.id) });
          out.push('');
          break;
        }
        if (flag !== '-a' && flag !== '-g') {
          out.push('Usage : arp -a (afficher) | arp -d (vider)', '');
          break;
        }
        const live = withLeases(doc).devices.find((d) => d.id === dev.id) ?? dev;
        const rows = arpRows(live, doc);
        if (!rows.length) {
          out.push('No ARP Entries Found', '');
          break;
        }
        out.push('', `Interface: ${live.config?.ip ?? '0.0.0.0'} --- 0x2`, '  Internet Address      Physical Address      Type');
        for (const e of rows) out.push(`  ${e.ip.padEnd(22)}${macWindows(e.mac).padEnd(22)}dynamic`);
        out.push('');
        break;
      }
      case 'nslookup': {
        const name = args[0];
        if (!name) {
          out.push('Usage : nslookup <nom> [serveur]', '');
          break;
        }
        const live = withLeases(doc);
        const self = live.devices.find((d) => d.id === dev.id);
        // « nslookup nom serveur » : interroge ce serveur plutôt que celui de la configuration
        const asked = args[1] && isValidIp(args[1]) ? { ...live, devices: live.devices.map((d) => (d.id === dev.id ? { ...d, config: { ...d.config, dns: args[1], lease: d.config.lease && { ...d.config.lease, dns: args[1] } } } : d)) } : live;
        const server = args[1] ?? dnsServerOf(self);
        const r = resolveName(asked, dev.id, name);
        if (server) ctx.effects.push({ type: 'ping', source: dev.id, target: server, options: { proto: 'udp', dport: 53 } });
        out.push(`Server:  ${server ?? 'Unknown'}`, `Address:  ${server ?? '0.0.0.0'}`, '');
        if (r.ok) out.push(`Name:    ${name}`, `Address:  ${r.ip}`, '');
        else out.push(r.log.at(-1).text.includes('NXDOMAIN') ? `*** ${server} can't find ${name}: Non-existent domain` : `*** Request to ${server ?? 'Unknown'} timed-out`, '', `NetCanvas : ${r.log.at(-1).text}`, '');
        break;
      }
      case 'curl':
      case 'web': {
        const url = args.find((a) => !a.startsWith('-'));
        if (!url) {
          out.push('Usage : curl http://<nom ou adresse>', '');
          break;
        }
        const r = httpGet(doc, dev.id, url);
        if (r.ip) ctx.effects.push({ type: 'ping', source: dev.id, target: r.ip, options: { proto: 'tcp', dport: 80 } });
        if (r.ok) {
          out.push('<html>', `  <head><title>${r.page.title}</title></head>`, `  <body>${r.page.body}</body>`, '</html>', '');
        } else {
          const why = r.log.findLast((l) => l.level === 'error')?.text ?? 'échec';
          out.push(r.dns.ok ? `curl: (7) Failed to connect to ${url.replace(/^https?:\/\//, '').split('/')[0]} port 80` : `curl: (6) Could not resolve host: ${url.replace(/^https?:\/\//, '').split('/')[0]}`, '', `NetCanvas : ${why}`, '');
        }
        break;
      }
      case 'tracert': {
        const asked = args.find((a) => !a.startsWith('-'));
        const named = isHostname(asked) ? resolveName(doc, dev.id, asked) : null;
        const target = named?.ok ? named.ip : args.find((a) => isValidIp(a));
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
    const words = ['ipconfig', 'ping', 'help', 'cls', 'tracert', 'nslookup', 'curl', 'arp'];
    if (/\s/.test(line.trim()) || !line.trim()) return line;
    const m = words.filter((w) => w.startsWith(line.trim().toLowerCase()));
    return m.length === 1 ? `${m[0]} ` : line;
  },
};
