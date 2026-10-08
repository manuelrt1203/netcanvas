// Formulaires des fonctions de commutation (mêmes champs que le terminal IOS, voir net/switching.js) :
// trunk (VLAN natif, VLAN autorisés), port-security et EtherChannel par port ; VTP et VLAN par switch.
import { useId, useState } from 'react';
import { CHANNEL_MODES, PS_DEFAULT, channelProtocol, formatVlanList, parseVlanList } from './net/switching.js';

const isMac = (t) => /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(t);
const clampVlan = (v) => Math.max(1, Math.min(4094, Math.trunc(Number(v)) || 1));

// Trunk : VLAN natif et VLAN autorisés (vide = tous)
export function TrunkFields({ p, patchPort }) {
  const id = useId();
  const [text, setText] = useState(p.allowedVlans ? formatVlanList(p.allowedVlans) : '');
  const list = text.trim() ? parseVlanList(text) : null;
  const invalid = text.trim() !== '' && !list;
  return (
    <div className="field-row">
      <div className="field">
        <label htmlFor={`${id}-native`}>VLAN natif</label>
        <input id={`${id}-native`} type="number" min="1" max="4094" className="cidr" value={p.nativeVlan ?? 1}
          onChange={(e) => patchPort(p, { nativeVlan: clampVlan(e.target.value) === 1 ? undefined : clampVlan(e.target.value) })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-allowed`}>VLAN autorisés</label>
        <input id={`${id}-allowed`} placeholder="tous" value={text} aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-err` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            const next = e.target.value.trim() ? parseVlanList(e.target.value) : null;
            if (!e.target.value.trim()) patchPort(p, { allowedVlans: undefined });
            else if (next) patchPort(p, { allowedVlans: next });
          }} />
        {invalid && <p id={`${id}-err`} className="field-error">Exemple : 1,10,20-25</p>}
      </div>
    </div>
  );
}

// EtherChannel : groupe (vide = aucun) et mode de négociation
export function ChannelFields({ p, patchPort }) {
  const id = useId();
  return (
    <div className="field-row">
      <div className="field">
        <label htmlFor={`${id}-group`}>EtherChannel (groupe)</label>
        <input id={`${id}-group`} type="number" min="1" max="64" className="cidr" placeholder="aucun" value={p.channelGroup ?? ''}
          onChange={(e) => {
            const g = Math.trunc(Number(e.target.value));
            patchPort(p, g >= 1 ? { channelGroup: Math.min(64, g), channelMode: p.channelMode ?? 'active' } : { channelGroup: undefined, channelMode: undefined });
          }} />
      </div>
      {p.channelGroup ? (
        <div className="field">
          <label htmlFor={`${id}-mode`}>Mode</label>
          <select id={`${id}-mode`} value={p.channelMode ?? 'on'} onChange={(e) => patchPort(p, { channelMode: e.target.value })}>
            {CHANNEL_MODES.map((m) => <option key={m} value={m}>{m} ({channelProtocol(m)})</option>)}
          </select>
        </div>
      ) : null}
    </div>
  );
}

// Port-security d'un port access ; state : état calculé (adresses apprises, en trop, err-disabled)
export function PortSecurityFields({ p, patchPort, state }) {
  const id = useId();
  const ps = { ...PS_DEFAULT, ...(p.ps ?? {}) };
  const [mac, setMac] = useState('');
  const set = (patch) => patchPort(p, { ps: { ...ps, ...patch } });
  const learned = state?.allowed.filter((m) => !ps.macs.includes(m) && !ps.stickyMacs.includes(m)) ?? [];
  return (
    <details className="proto" open={ps.enabled}>
      <summary>Port-security {ps.enabled ? <span className="badge-on">actif</span> : null}</summary>
      <label className="check">
        <input type="checkbox" checked={ps.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Limiter les adresses MAC (switchport port-security)
      </label>
      {ps.enabled && (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor={`${id}-max`}>Maximum</label>
              <input id={`${id}-max`} type="number" min="1" max="132" className="cidr" value={ps.max}
                onChange={(e) => set({ max: Math.max(1, Math.min(132, Math.trunc(Number(e.target.value)) || 1)) })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-viol`}>En cas de violation</label>
              <select id={`${id}-viol`} value={ps.violation} onChange={(e) => set({ violation: e.target.value })}>
                <option value="shutdown">shutdown : port err-disabled</option>
                <option value="restrict">restrict : trames jetées, compteur</option>
                <option value="protect">protect : trames jetées</option>
              </select>
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={ps.sticky} onChange={(e) => set({ sticky: e.target.checked, ...(e.target.checked ? { stickyMacs: [...new Set([...ps.stickyMacs, ...learned])].slice(0, ps.max) } : { stickyMacs: [] }) })} />
            Sticky : mémoriser dans la config les MAC apprises
          </label>
          <ul className="mac-list">
            {ps.macs.map((m) => (
              <li key={m}><code>{m}</code> statique <button type="button" className="ghost small-btn" aria-label={`Retirer ${m}`} onClick={() => set({ macs: ps.macs.filter((x) => x !== m) })}>×</button></li>
            ))}
            {ps.stickyMacs.map((m) => (
              <li key={m}><code>{m}</code> sticky <button type="button" className="ghost small-btn" aria-label={`Oublier ${m}`} onClick={() => set({ stickyMacs: ps.stickyMacs.filter((x) => x !== m) })}>×</button></li>
            ))}
            {learned.map((m) => <li key={m}><code>{m}</code> apprise</li>)}
          </ul>
          <div className="field-row">
            <div className="field">
              <label htmlFor={`${id}-mac`}>Ajouter une MAC autorisée</label>
              <input id={`${id}-mac`} placeholder="0001.0203.0405" value={mac} aria-invalid={mac !== '' && !isMac(mac)} onChange={(e) => setMac(e.target.value.trim())} />
            </div>
            <button type="button" className="ghost" disabled={!isMac(mac)} onClick={() => { set({ macs: [...new Set([...ps.macs, mac.toLowerCase()])] }); setMac(''); }}>Ajouter</button>
          </div>
          {state?.violators.length > 0 && (
            <p className="field-error" role="status">
              {state.errDisabled ? 'Port err-disabled' : 'Trames jetées'} : {state.violators.map((v) => `${v.label} (${v.mac})`).join(', ')} au-delà du maximum.
            </p>
          )}
        </>
      )}
    </details>
  );
}

// VTP et base de VLAN du switch
export function VtpForm({ node, update, db, labelOf }) {
  const id = useId();
  const vtp = node.data.vtp ?? {};
  const mode = vtp.mode ?? 'server';
  const vlans = Object.entries(node.data.vlans ?? {}).map(([v, name]) => [Number(v), name]).sort(([a], [b]) => a - b);
  const [newVlan, setNewVlan] = useState('');
  const setVtp = (patch) => update((d) => {
    const next = { ...(d.vtp ?? {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
    return { ...d, vtp: Object.keys(next).length ? next : undefined };
  });
  // Modifier la base de VLAN d'un serveur VTP augmente son numéro de révision
  const editVlans = (fn) => update((d) => ({
    ...d,
    vlans: fn({ ...(d.vlans ?? {}) }),
    ...(d.vtp && (d.vtp.mode ?? 'server') === 'server' ? { vtp: { ...d.vtp, revision: (Number(d.vtp.revision) || 0) + 1 } } : {}),
  }));
  const client = mode === 'client';
  return (
    <details className="proto" open={Boolean(node.data.vtp)}>
      <summary>VLAN et VTP {vtp.domain ? <span className="badge-on">{vtp.domain}</span> : null}</summary>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`${id}-domain`}>Domaine VTP</label>
          <input id={`${id}-domain`} placeholder="aucun" value={vtp.domain ?? ''} onChange={(e) => setVtp({ domain: e.target.value.trim() || undefined, revision: 0 })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-mode`}>Mode</label>
          <select id={`${id}-mode`} value={mode} onChange={(e) => setVtp({ mode: e.target.value === 'server' && !vtp.domain ? undefined : e.target.value, ...(['transparent', 'off'].includes(e.target.value) ? { revision: 0 } : {}) })}>
            <option value="server">server</option>
            <option value="client">client</option>
            <option value="transparent">transparent</option>
            <option value="off">off</option>
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`${id}-pw`}>Mot de passe</label>
          <input id={`${id}-pw`} value={vtp.password ?? ''} onChange={(e) => setVtp({ password: e.target.value || undefined })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-rev`}>Révision</label>
          <input id={`${id}-rev`} type="number" min="0" className="cidr" value={vtp.revision ?? 0} onChange={(e) => setVtp({ revision: Math.max(0, Math.trunc(Number(e.target.value)) || 0) })} />
        </div>
      </div>
      {db && db.from !== node.id && <p className="hint">Base de VLAN reçue de {labelOf(db.from)} (révision {db.revision}) : {[...db.vlans].filter(([v]) => v !== 1).map(([v, n]) => `${v} ${n}`).join(', ') || 'aucun VLAN'}.</p>}
      {db && db.from === node.id && db.domain.length > 1 && <p className="hint">Sa base de VLAN s'impose aux {db.domain.length - 1} autre(s) switch(es) du domaine (révision la plus haute).</p>}
      <h4>VLAN {client ? '(un client ne les modifie pas)' : ''}</h4>
      {vlans.map(([v, name]) => (
        <div key={v} className="field-row">
          <div className="field">
            <label htmlFor={`${id}-v${v}`}>VLAN {v}</label>
            <input id={`${id}-v${v}`} value={name} disabled={client} onChange={(e) => editVlans((x) => ({ ...x, [v]: e.target.value }))} />
          </div>
          <button type="button" className="ghost" disabled={client} aria-label={`Supprimer le VLAN ${v}`} onClick={() => editVlans((x) => { delete x[v]; return x; })}>Supprimer</button>
        </div>
      ))}
      {!client && (
        <div className="field-row">
          <div className="field">
            <label htmlFor={`${id}-new`}>Nouveau VLAN</label>
            <input id={`${id}-new`} type="number" min="2" max="4094" className="cidr" value={newVlan} onChange={(e) => setNewVlan(e.target.value)} />
          </div>
          <button type="button" className="ghost" disabled={!(Number(newVlan) >= 2 && Number(newVlan) <= 4094) || vlans.some(([v]) => v === Number(newVlan))}
            onClick={() => { editVlans((x) => ({ ...x, [Number(newVlan)]: `VLAN${String(newVlan).padStart(4, '0')}` })); setNewVlan(''); }}>Créer</button>
        </div>
      )}
      <p className="hint">Dans un domaine (switches reliés par des trunks, même nom et même mot de passe), la base du serveur ou client à la révision la plus haute s'impose. Un client n'a que ces VLAN : un port dans un VLAN absent est inactif.</p>
    </details>
  );
}
