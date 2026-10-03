import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Icon, iconName } from './devices.jsx';
import { TYPES, modelOf } from './net/catalog.js';
import { useSim } from './SimContext.js';

// Un point de connexion sur chaque côté ; ConnectionMode.Loose permet de relier n'importe lesquels.
const SIDES = [
  ['t', Position.Top],
  ['r', Position.Right],
  ['b', Position.Bottom],
  ['l', Position.Left],
];

// Résumé d'adressage affiché sous le nom (config par port, câblé ou non)
function summary(type, data) {
  const withMask = (ip, mask) => `${ip}${mask !== '' && mask != null ? `/${mask}` : ''}`;
  if (type === 'router') {
    return Object.values(data.ifaces ?? {}).filter((i) => i?.ip).map((i) => withMask(i.ip, i.mask));
  }
  if (type === 'switch') {
    const vlans = [...new Set(Object.values(data.ports ?? {}).filter((p) => p?.mode !== 'trunk').map((p) => Number(p?.vlan) || 1))];
    return vlans.length ? [`VLAN ${vlans.sort((a, b) => a - b).join(', ')}`] : [];
  }
  return data.ip ? [withMask(data.ip, data.mask)] : [];
}

function DeviceNode({ id, data, type, selected }) {
  const sim = useSim();
  const model = modelOf({ type, model: data.model });
  const lines = summary(type, data);
  const state = sim.failedAt === id ? ' sim-fail' : sim.nodes.has(id) ? ' sim-hit' : '';

  return (
    <div className={`device device-${type}${selected ? ' selected' : ''}${state}`}>
      <div className="device-icon"><Icon name={iconName(type, data.model)} /></div>
      <div className="device-label">{data.label}</div>
      {model.label !== TYPES[type].label && <div className="device-model">{model.short}</div>}
      {lines.map((l) => (
        <div key={l} className="device-ip">{l}</div>
      ))}
      {SIDES.map(([hid, pos]) => (
        <Handle key={hid} id={hid} type="source" position={pos} />
      ))}
    </div>
  );
}

export default memo(DeviceNode);
