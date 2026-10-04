// Onglet « Tables » : toutes les tables de l'équipement sélectionné (routage, ARP, MAC, NAT, DHCP,
// voisins OSPF, sessions BGP), remplies par la simulation et vieillissantes avec le temps simulé.
import { arpRows, clearArp, clearMac, macRows } from './net/tables.js';
import { macCisco, macColon, macWindows } from './net/mac.js';
import { prefixText } from './net/routing.js';
import { activeNat, formatDuration, formatTime, runtimeOf } from './net/runtime.js';
import { isMikrotik } from './net/catalog.js';
import { computeLeases } from './net/dhcp.js';
import { buildTopology, isHost } from './net/topology.js';

const STP_ROLE = { root: 'racine', designated: 'désigné', alternate: 'alternatif' };

function Table({ title, head, rows, empty, action }) {
  return (
    <section className="table-block">
      <div className="table-title">
        <h3>{title}</h3>
        {action}
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table className="data">
            <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : <p className="hint">{empty}</p>}
    </section>
  );
}

export default function TablesPanel({ device, doc, routing, labels, onRuntime, readOnly }) {
  if (!device) {
    return (
      <>
        <h2>Tables</h2>
        <p className="hint">Sélectionne un équipement pour voir ses tables : routage, ARP, MAC, NAT, baux DHCP, voisins.</p>
        <p className="hint">Elles se remplissent avec les pings (onglet Simulation ou terminal) et vieillissent avec le temps simulé.</p>
      </>
    );
  }
  const rt = runtimeOf(doc);
  const fmt = isMikrotik(device) ? macColon : isHost(device) ? macWindows : macCisco;
  const age = (s) => formatDuration(s);
  const clear = (update) => !readOnly && (
    <button type="button" className="ghost small-btn" onClick={() => onRuntime(update)}>Vider</button>
  );
  const r = routing?.routers.get(device.id);
  const blocks = [];

  if (r) {
    blocks.push(
      <Table key="rib" title="Table de routage" head={['Code', 'Réseau', 'Via', 'Interface', 'AD/métrique']}
        empty="Aucune route."
        rows={[...r.rib.values()].sort((a, b) => a.net - b.net || a.mask - b.mask).map((x) => [
          x.proto, prefixText(x.net, x.mask), x.nextHop ?? 'connecté', x.iface ?? '', `${x.ad}/${x.metric}`,
        ])} />,
    );
  }
  if (device.type !== 'cloud' && device.type !== 'hub' && (isHost(device) || device.type === 'router' || device.config?.interfaces?.length)) {
    const rows = arpRows(device, doc);
    blocks.push(
      <Table key="arp" title="Cache ARP" head={['Adresse IP', 'MAC', 'Interface', 'Âge', 'Expire dans']}
        empty="Vide : lance un ping depuis ou vers cet équipement." action={rows.some((e) => !e.own) && clear(clearArp(device.id))}
        rows={rows.map((e) => [e.ip, <code key="m">{fmt(e.mac)}</code>, e.iface ?? '', e.own ? 'locale' : age(e.age), e.own ? '—' : age(e.expiresIn)])} />,
    );
  }
  if (device.type === 'switch') {
    const rows = macRows(device, doc);
    blocks.push(
      <Table key="mac" title="Table MAC (CAM)" head={['VLAN', 'MAC', 'Port', 'Âge', 'Expire dans']}
        empty="Vide : le switch apprend les adresses des trames qui le traversent (5 min de vieillissement)." action={rows.length > 0 && clear(clearMac(device.id))}
        rows={rows.map((e) => [e.vlan, <code key="m">{macCisco(e.mac)}</code>, e.port, age(e.age), age(e.expiresIn)])} />,
    );
  }
  if (device.type === 'switch') {
    const stp = buildTopology(doc).stp;
    for (const [vlan, info] of stp.vlans) {
      const me = info.switches.get(device.id);
      if (!me) continue;
      const root = [...info.switches.values()].find((s) => s.bridge === me.root);
      const title = !me.enabled ? `Spanning Tree · VLAN ${vlan} (désactivé)`
        : me.isRoot ? `Spanning Tree · VLAN ${vlan} · root bridge (priorité ${me.priority})`
          : `Spanning Tree · VLAN ${vlan} · root ${labels.get([...info.switches].find(([, s]) => s === root)?.[0])} (priorité ${root.priority}), coût ${me.rootCost}`;
      const rows = [...info.ports].filter(([k]) => k.startsWith(`${device.id}|`)).map(([, p]) => p)
        .sort((a, b) => (a.portId & 255) - (b.portId & 255));
      blocks.push(
        <Table key={`stp-${vlan}`} title={title} head={['Port', 'Rôle', 'État', 'Coût', 'Prio.N°']}
          empty={me.enabled ? 'Aucun port dans ce VLAN.' : 'STP désactivé sur ce VLAN : une boucle provoquerait une tempête de diffusion.'}
          rows={me.enabled ? rows.map((p) => [p.name, STP_ROLE[p.role], p.state === 'blocking' ? <span key="b" className="stp-blocked">bloqué</span> : 'transmet', p.cost, `${p.portId >> 8}.${p.portId & 255}`]) : []} />,
      );
    }
  }
  if (device.config?.nat || device.config?.natRules?.length) {
    const rows = activeNat(rt).filter((e) => e.router === device.id);
    blocks.push(
      <Table key="nat" title="Traductions NAT" head={['Proto', 'Inside global', 'Inside local', 'Outside', 'Expire dans']}
        empty="Aucune traduction active (elles apparaissent avec les pings, 60 s)."
        action={rows.length > 0 && clear((x) => ({ ...x, nat: (x.nat ?? []).filter((e) => e.router !== device.id) }))}
        rows={[
          ...rows.map((e) => [e.proto, `${e.insideGlobal}:${e.id}`, `${e.insideLocal}:${e.id}`, `${e.outsideGlobal}:${e.id}`, age(e.expires - rt.time)]),
          ...(device.config?.nat?.statics ?? []).map((s) => ['statique', s.global, s.local, '—', '—']),
        ]} />,
    );
  }
  const pools = device.config?.dhcp && device.config.dhcp !== true;
  if (pools) {
    const leases = Object.entries(computeLeases(doc).store).filter(([, l]) => l.server === device.id);
    blocks.push(
      <Table key="dhcp" title="Baux DHCP distribués" head={['Adresse', 'Client', 'Pool', 'Expire']}
        empty="Aucun bail."
        rows={leases.map(([id, l]) => [l.ip, labels.get(id) ?? `${id} (parti)`, l.pool, l.end == null ? 'jamais' : formatTime(l.end)])} />,
    );
  }
  if (r?.ospf.enabled) {
    blocks.push(
      <Table key="ospf" title="Voisins OSPF" head={['Router-ID', 'Voisin', 'Interface', 'Zone', 'État']}
        empty="Aucun voisin (voir les contrôles)."
        rows={r.ospf.neighbors.map((n) => [n.peer.ospf.routerId, n.peer.label, n.iface.name, n.area, n.p2p ? 'FULL' : `FULL/${n.role}`])} />,
    );
  }
  if (r?.bgp.enabled) {
    blocks.push(
      <Table key="bgp" title="Sessions BGP" head={['Voisin', 'AS', 'État', 'Préfixes reçus']}
        empty="Aucun voisin configuré."
        rows={r.bgp.sessions.map((s) => [s.neighbor, s.remoteAs, s.state === 'Established' ? 'Established' : <span key="e" className="field-error" title={s.reason}>Active</span>, s.state === 'Established' ? r.bgp.adjIn?.get(s.peer.id)?.size ?? 0 : '—'])} />,
    );
  }

  return (
    <>
      <h2>{device.label} <span className="muted">· tables à {formatTime(rt.time)}</span></h2>
      {blocks.length ? blocks : <p className="hint">Cet équipement n'a pas de table.</p>}
    </>
  );
}
