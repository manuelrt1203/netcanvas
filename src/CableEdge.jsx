import { memo, useEffect, useState } from 'react';
import { BaseEdge, getStraightPath, useNodesData } from '@xyflow/react';
import { useLinkStatus, useSim } from './SimContext.js';
import { isHost } from './net/topology.js';

export const HOP_MS = 550;

// Étiquette HTML posée dans le SVG du câble. (EdgeLabelRenderer de React Flow refait un querySelector
// pour chaque câble à chaque mise à jour : trop lent sur un grand schéma.)
function Label({ x, y, className, children }) {
  return (
    <foreignObject x={x - 70} y={y - 11} width={140} height={22} className="label-fo">
      <div className="label-center"><div className={className}>{children}</div></div>
    </foreignObject>
  );
}

// Paquet qui glisse d'une extrémité à l'autre du câble pendant HOP_MS
function Packet({ x1, y1, x2, y2, phase }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setT(1);
      return undefined;
    }
    let frame;
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min((now - start) / HOP_MS, 1);
      setT(1 - (1 - p) ** 2); // ease-out
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <circle className={`packet packet-${phase}`} r="7" cx={x1 + (x2 - x1) * t} cy={y1 + (y2 - y1) * t} />;
}

function vlanTag(ends, names) {
  const ports = ends.map((n, i) => (n?.type === 'switch' ? n.data.ports?.[names[i]] ?? {} : null)).filter(Boolean);
  if (ports.some((p) => p.mode === 'trunk')) return 'Trunk';
  const vlan = ports.map((p) => Number(p.vlan) || 1).find((v) => v !== 1);
  return vlan ? `VLAN ${vlan}` : null;
}

function CableEdge({ id, source, target, sourceX, sourceY, targetX, targetY, selected, data }) {
  const sim = useSim();
  const status = useLinkStatus(id);
  const cable = data?.cable ?? 'straight';
  const down = status && !status.up;
  const ends = useNodesData([source, target]);
  const [path, midX, midY] = getStraightPath({ sourceX, sourceY, targetX, targetY });

  const traversed = sim.edges.get(id);
  const hop = sim.hop?.edge === id ? sim.hop : sim.hops?.find((h) => h.edge === id) ?? null;
  const vlan = cable === 'console' ? null : vlanTag(ends, [data?.sourceIface, data?.targetIface]);
  // Membre d'un EtherChannel : le nom du Port-channel remplace « Trunk »
  const tag = status?.channel && !down ? status.channel : vlan;
  const labelAt = (t) => [sourceX + (targetX - sourceX) * t, sourceY + (targetY - sourceY) * t];

  // Nom des ports côté routeur / switch / hub (une carte réseau d'hôte n'a qu'un port)
  const portLabels = [
    [ends[0] && !isHost(ends[0]) ? data?.sourceIface : null, labelAt(0.22)],
    [ends[1] && !isHost(ends[1]) ? data?.targetIface : null, labelAt(0.78)],
  ].filter(([name]) => name);
  // Voyants aux deux bouts, comme dans Packet Tracer : vert = lien actif, rouge = hors service,
  // orange = port bloqué par Spanning Tree
  const lights = [labelAt(0.07), labelAt(0.93)];
  const blockedAt = (device) => status?.stpBlocked?.find((e) => e.device === device)?.vlans ?? null;

  const forward = hop && hop.from === source;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`cable cable-${cable}${down ? ' down' : ''}${selected ? ' selected' : ''}${traversed ? ` sim-${traversed}` : ''}${vlan === 'Trunk' ? ' trunk' : ''}`}
      />
      {cable !== 'console' && lights.map(([x, y], i) => {
        const blocked = !down && blockedAt(i === 0 ? source : target);
        return (
          <circle key={i} className={`link-light ${down ? 'off' : blocked ? 'stp' : 'on'}`} cx={x} cy={y} r="4">
            <title>{down ? status.reason : blocked ? `Port bloqué par Spanning Tree (VLAN ${blocked.join(', ')}) : il casse une boucle` : 'Lien actif'}</title>
          </circle>
        );
      })}
      {hop && (
        <Packet
          key={hop.key}
          phase={hop.phase}
          {...(forward
            ? { x1: sourceX, y1: sourceY, x2: targetX, y2: targetY }
            : { x1: targetX, y1: targetY, x2: sourceX, y2: sourceY })}
        />
      )}
      {tag && <Label x={midX} y={midY} className="edge-tag">{tag}</Label>}
      {portLabels.map(([name, [x, y]], i) => <Label key={i} x={x} y={y} className="port-label">{name}</Label>)}
    </>
  );
}

export default memo(CableEdge);
