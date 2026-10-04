// Formulaires DHCP : serveur (pools, adresses exclues) et état du client. Même config que les terminaux.
import { useId, useState } from 'react';
import { isValidIp } from './net/ip.js';
import { isMikrotik } from './net/catalog.js';

const num = (v) => (v === '' ? '' : Number(v));

function Input({ label, ip, ...props }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={ip && props.value && !isValidIp(props.value) ? true : undefined} {...props} />
    </div>
  );
}

// État du client DHCP (bail ou raison de l'échec), d'après le document effectif
export function DhcpClientStatus({ live, labels }) {
  if (!live) return null;
  if (live.dhcpError) {
    return (
      <div className="routing-status">
        <p className="field-error">Pas de bail : {live.dhcpError}.</p>
        <p className="hint">Adresse automatique {live.ip} (APIPA), sans passerelle.</p>
      </div>
    );
  }
  const l = live.lease;
  if (!l) return null;
  return (
    <div className="routing-status">
      <p className="ok-text">Bail obtenu : {l.ip}/{l.mask}, passerelle {l.gateway ?? 'aucune'}{l.dns ? `, DNS ${l.dns}` : ''}.</p>
      <p className="hint">Servi par {labels.get(l.server) ?? l.server}{l.relay ? ` via le relais ${labels.get(l.relay) ?? l.relay}` : ''} (pool {l.pool}).</p>
    </div>
  );
}

// Plages exclues : texte libre, appliqué seulement quand toutes les lignes sont valides
function Excluded({ ranges, onValid }) {
  const id = useId();
  const [text, setText] = useState(ranges.map(([a, b]) => (b && b !== a ? `${a}-${b}` : a)).join('\n'));
  const parse = (t) => t.split('\n').filter((l) => l.trim()).map((l) => l.split('-').map((v) => v.trim()));
  const bad = parse(text).filter(([a, b]) => !isValidIp(a) || (b !== undefined && !isValidIp(b)));
  return (
    <div className="field">
      <label htmlFor={id}>Adresses exclues (une plage par ligne : début-fin)</label>
      <textarea id={id} className="rules" rows={2} spellCheck="false" placeholder="192.168.1.1-192.168.1.9" value={text} aria-invalid={bad.length > 0}
        onChange={(e) => {
          setText(e.target.value);
          const r = parse(e.target.value);
          if (r.every(([a, b]) => isValidIp(a) && (b === undefined || isValidIp(b)))) onValid(r.map(([a, b]) => [a, b ?? a]));
        }} />
      {bad.length > 0 && <p className="field-error">Plage invalide : {bad.map((x) => x.join('-')).join(', ')}</p>}
    </div>
  );
}

export function DhcpServerForm({ node, update }) {
  const dhcp = node.data.dhcp && node.data.dhcp !== true ? node.data.dhcp : null;
  const mk = isMikrotik({ type: node.type, model: node.data.model });
  const set = (fn) => update((d) => ({ ...d, dhcp: fn(d.dhcp && d.dhcp !== true ? d.dhcp : { pools: [] }) }));
  const pools = dhcp?.pools ?? [];
  const patchPool = (i, patch) => set((x) => ({ ...x, pools: x.pools.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  return (
    <details className="proto" open={Boolean(pools.length)}>
      <summary>Serveur DHCP {pools.length > 0 && <span className="badge-on">{pools.length} pool{pools.length > 1 ? 's' : ''}</span>}</summary>
      {pools.map((p, i) => (
        <fieldset key={i} className="iface">
          <legend>Pool {p.name ?? i + 1}</legend>
          <div className="field-row">
            <Input label="Nom" value={p.name ?? ''} onChange={(e) => patchPool(i, { name: e.target.value.replace(/\s/g, '') })} />
            <Input label="Réseau" ip placeholder="192.168.1.0" value={p.network ?? ''} onChange={(e) => patchPool(i, { network: e.target.value.trim() })} />
            <Input label="/" type="number" min="1" max="30" className="cidr" value={p.mask ?? ''} onChange={(e) => patchPool(i, { mask: num(e.target.value) })} />
          </div>
          <div className="field-row">
            <Input label="Passerelle (default-router)" ip placeholder="192.168.1.1" value={p.defaultRouter ?? ''} onChange={(e) => patchPool(i, { defaultRouter: e.target.value.trim() || undefined })} />
            <Input label="DNS" ip placeholder="8.8.8.8" value={p.dns ?? ''} onChange={(e) => patchPool(i, { dns: e.target.value.trim() || undefined })} />
          </div>
          {mk && (
            <div className="field-row">
              <Input label="Interface du serveur" placeholder="ether2" value={p.iface ?? ''} onChange={(e) => patchPool(i, { iface: e.target.value.trim() || undefined })} />
              <Input label="Plage (début-fin)" placeholder="192.168.1.100-192.168.1.200" value={p.range ? p.range.join('-') : ''}
                onChange={(e) => { const [a, b] = e.target.value.split('-').map((x) => x.trim()); patchPool(i, { range: a ? [a, b || a] : undefined }); }} />
            </div>
          )}
          <button type="button" className="ghost small" onClick={() => set((x) => ({ ...x, pools: x.pools.filter((_, j) => j !== i) }))}>Retirer le pool</button>
        </fieldset>
      ))}
      <button type="button" className="ghost small" onClick={() => set((x) => ({ ...x, pools: [...(x.pools ?? []), { name: `POOL${pools.length + 1}`, network: '', mask: 24 }] }))}>
        Ajouter un pool
      </button>
      {!mk && <Excluded ranges={dhcp?.excluded ?? []} onValid={(excluded) => set((x) => ({ ...x, excluded }))} />}
      <p className="hint">Le premier serveur ou relais du VLAN répond ; l'adresse donnée est la première libre du pool.</p>
    </details>
  );
}
