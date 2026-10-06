import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHostConfig, parseHostConfig } from './host-import.js';
import { simulatePing } from '../net/simulate.js';
import { DEMO } from '../examples.js';

const cases = [
  ['VPCS (commandes)', 'set pcname PC1\nip 192.168.1.10 192.168.1.1 24\nip dns 8.8.8.8\nsave', 'vpcs',
    { ip: '192.168.1.10', mask: 24, gateway: '192.168.1.1', dns: '8.8.8.8' }, 'PC1'],
  ['VPCS (CIDR, IPv6)', 'ip 192.168.1.10/24 192.168.1.1\nip 2001:db8:1::10/64', 'vpcs',
    { ip: '192.168.1.10', mask: 24, gateway: '192.168.1.1', ipv6: '2001:db8:1::10', prefix6: 64 }, null],
  ['VPCS show ip', 'PC1> show ip\n\nNAME        : PC1[1]\nIP/MASK     : 192.168.14.10/24\nGATEWAY     : 192.168.14.1\nDNS         : \nMAC         : 00:50:79:66:68:00', 'vpcs',
    { ip: '192.168.14.10', mask: 24, gateway: '192.168.14.1' }, 'PC1'],
  ['VPCS DHCP', 'ip dhcp', 'vpcs', { dhcp: true }, null],
  ['ipconfig (français)', 'Carte Ethernet Ethernet :\n\n   Adresse IPv6 de liaison locale. . . . .: fe80::1%12\n   Adresse IPv4. . . . . . . . . . . . . .: 192.168.1.10(préféré)\n   Masque de sous-réseau. . . . . . . . . : 255.255.255.0\n   Passerelle par défaut. . . . . . . . . : 192.168.1.1\n   Serveurs DNS. . .  . . . . . . . . . . : 8.8.8.8\n                                       8.8.4.4',
    'windows', { ip: '192.168.1.10', mask: 24, gateway: '192.168.1.1', dns: '8.8.8.8' }, null],
  ['ipconfig /all (anglais, DHCP)', '   Host Name . . . . . . . . . . . . : PC-LABO\n   DHCP Enabled. . . . . . . . . . . : Yes\n   IPv4 Address. . . . . . . . . . . : 10.0.0.23(Preferred)\n   Subnet Mask . . . . . . . . . . . : 255.255.255.0\n   Default Gateway . . . . . . . . . : 10.0.0.1',
    'windows', { dhcp: true }, 'PC-LABO'],
  ['Linux ip a + ip route', '1: lo: <LOOPBACK,UP>\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST>\n    inet 192.168.1.20/24 brd 192.168.1.255 scope global eth0\n    inet6 2001:db8::20/64 scope global\n    inet6 fe80::1/64 scope link\ndefault via 192.168.1.1 dev eth0',
    'linux', { ip: '192.168.1.20', mask: 24, ipv6: '2001:db8::20', prefix6: 64, gateway: '192.168.1.1' }, null],
  ['/etc/network/interfaces', 'auto eth0\niface eth0 inet static\n    address 10.1.1.5\n    netmask 255.255.255.0\n    gateway 10.1.1.1\n    dns-nameservers 1.1.1.1',
    'linux', { ip: '10.1.1.5', mask: 24, gateway: '10.1.1.1', dns: '1.1.1.1' }, null],
  ['netplan', 'network:\n  ethernets:\n    eth0:\n      addresses:\n        - 172.16.0.5/24\n      routes:\n        - to: default\n          via: 172.16.0.1\n      nameservers:\n        addresses: [9.9.9.9]',
    'linux', { ip: '172.16.0.5', mask: 24, gateway: '172.16.0.1', dns: '9.9.9.9' }, null],
  ['ifconfig', 'eth0: flags=4163<UP>  mtu 1500\n        inet 192.168.5.7  netmask 255.255.255.0  broadcast 192.168.5.255', 'linux', { ip: '192.168.5.7', mask: 24 }, null],
];

for (const [name, text, format, config, label] of cases) {
  test(`import PC : ${name}`, () => {
    const r = parseHostConfig(text);
    assert.equal(r.format, format);
    assert.deepEqual(r.config, config);
    assert.equal(r.label, label);
    assert.deepEqual(r.warnings, []);
  });
}

test('import PC : passerelle hors du réseau signalée, config appliquée au PC du schéma qui ping alors son routeur', () => {
  assert.match(parseHostConfig('ip 192.168.1.10/24 192.168.2.1').warnings[0], /n'est pas dans le réseau/);
  // PC A de la démo : on lui recolle sa propre config en VPCS
  const pc = DEMO.devices.find((d) => d.type === 'pc');
  const { ip, mask, gateway } = pc.config;
  const blankPc = { ...pc, config: {} };
  const parsed = parseHostConfig(`set pcname ${pc.label.replace(/\s/g, '-')}\nip ${ip}/${mask} ${gateway}`);
  const dev = applyHostConfig(blankPc, parsed);
  assert.deepEqual(dev.config, { ip, mask, gateway });
  const doc = { ...DEMO, devices: DEMO.devices.map((d) => (d.id === pc.id ? dev : d)) };
  assert.equal(simulatePing(doc, pc.id, gateway).ok, true);
});
