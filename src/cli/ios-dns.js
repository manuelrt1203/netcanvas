// Terminal IOS : résolution de noms (ip name-server, ip host, show hosts) et ping / traceroute vers un nom.
import { arg, kw } from './engine.js';
import { pad, withDevice } from './device.js';
import { isValidIp } from '../net/ip.js';
import { isHostname, resolveName } from '../net/services.js';

const isIp = (t) => isValidIp(t);
const norm = (n) => n.toLowerCase().replace(/\.$/, '');

function setHost(c) {
  const name = norm(c.args.name);
  const hosts = (c.dev.config.hosts ?? []).filter((h) => norm(h.name) !== name);
  c.dev.config.hosts = [...hosts, { name, ip: c.args.ip }];
  c.changed = true;
}

function removeHost(c) {
  const name = norm(c.args.name);
  const hosts = (c.dev.config.hosts ?? []).filter((h) => norm(h.name) !== name);
  if (hosts.length) c.dev.config.hosts = hosts;
  else delete c.dev.config.hosts;
  c.changed = true;
}

// « ip name-server » et « ip host » (remove : sous « no ip »)
export function dnsConfigCommands(remove = false) {
  return [
    kw('name-server', 'Specify address of name server to use', {
      ...(remove ? { run: (c) => { delete c.dev.config.nameServer; c.changed = true; } } : {}),
      children: [arg('ip', 'A.B.C.D', 'Domain server IP address', isIp, {
        run: (c) => {
          if (remove) delete c.dev.config.nameServer;
          else c.dev.config.nameServer = c.args.ip;
          c.changed = true;
        },
      })],
    }),
    kw('host', 'Add an entry to the ip hostname table', {
      children: [arg('name', 'WORD', 'Name of host', isHostname, {
        ...(remove ? { run: removeHost } : {}),
        children: [arg('ip', 'A.B.C.D', 'Host IP address', isIp, { run: remove ? removeHost : setHost })],
      })],
    }),
  ];
}

export function showHosts(dev) {
  const c = dev.config ?? {};
  return [
    'Default domain is not set',
    `Name/address lookup uses domain service`,
    `Name servers are ${c.nameServer ?? '255.255.255.255'}`,
    '',
    'Codes: UN - unknown, EX - expired, OK - OK, ?? - revalidate',
    '       temp - temporary, perm - permanent',
    '       NA - Not Applicable None - Not defined',
    '',
    `${pad('Host', 24)}${pad('Port', 6)}${pad('Flags', 14)}${pad('Age', 5)}${pad('Type', 6)}Address(es)`,
    ...(c.hosts ?? []).map((h) => `${pad(h.name, 24)}${pad('None', 6)}${pad('(perm, OK)', 14)}${pad('0', 5)}${pad('IP', 6)}${h.ip}`),
    '',
  ];
}

export const showHostsCommand = () => kw('hosts', 'IP domain-name, lookup style, nameservers, and host table', { run: (c) => c.out.push(...showHosts(c.dev)) });

// Nom -> adresse avant un ping / traceroute ; null (message déjà affiché) si la résolution échoue
export function resolveTarget(c, target) {
  if (isValidIp(target)) return target;
  const r = resolveName(withDevice(c.doc, c.dev), c.dev.id, target);
  // Entrée « ip host » : pas de requête DNS
  if (r.ok && !r.query) return r.ip;
  c.out.push(`Translating "${target}"...domain server (${c.dev.config?.nameServer ?? '255.255.255.255'})${r.ok ? ' [OK]' : ''}`);
  if (r.query) c.effects.push({ type: 'ping', source: c.dev.id, target: c.dev.config.nameServer, options: { proto: 'udp', dport: 53 } });
  if (r.ok) return r.ip;
  c.out.push('% Unrecognized host or address, or protocol not running.', '', `% NetCanvas : ${r.log.at(-1).text}`, '');
  return null;
}

// Destination de ping / traceroute : une adresse ou un nom
export const isTarget = (t) => isValidIp(t) || isHostname(t);
