import { useId, useState } from 'react';
import { edgePort, freePorts, linksOfNode, portsOf } from './serialize.js';
import { cidrToMask, isValidCidr, isValidIp, splitCidr } from './net/ip.js';
import { HOST_TYPES } from './net/topology.js';
import { CABLES, CLOCK_RATES, MEDIA_LABEL, MODELS, MODULES, TYPES, devicePorts, modelId, modelsOfType } from './net/catalog.js';
import { useLinkStatus } from './SimContext.js';
import { LoopbacksForm, RoutingForm, SubInterfaces } from './RoutingForm.jsx';
import { InterfaceSecurity, SecurityForm } from './SecurityForm.jsx';
import { DhcpClientStatus, DhcpServerForm } from './DhcpForm.jsx';

const otherEnd = (e, id) => (e.source === id ? e.target : e.source);
// Côté DCE d'une liaison série : l'équipement source, sauf indication contraire
const dceOf = (e) => (e.data?.dce === 'target' ? e.target : e.source);
const formatRate = (r) => (r >= 1e6 ? `${r / 1e6} Mbit/s` : `${r / 1000} kbit/s`);

const toCidr = (v) => (v === '' ? '' : Math.max(0, Math.min(32, Math.trunc(Number(v)))));

function Field({ label, error, hint, ...input }) {
  const id = useId();
  const msg = error || hint;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={Boolean(error)} aria-describedby={msg ? `${id}-msg` : undefined} {...input} />
      {msg && <p id={`${id}-msg`} className={error ? 'field-error' : 'field-hint'}>{msg}</p>}
    </div>
  );
}

const ipError = (v) => (v && !isValidIp(v) ? 'Format attendu : 192.168.1.10' : null);
const maskHint = (m) => (m !== '' && isValidCidr(m) ? cidrToMask(m) : null);

// Champ IP qui accepte aussi « 192.168.1.10/24 » et remplit le masque
function IpCidrFields({ ip, mask, onChange, ipLabel = 'Adresse IP' }) {
  return (
    <div className="field-row">
      <Field
        label={ipLabel}
        placeholder="192.168.1.10"
        value={ip ?? ''}
        error={ipError(ip)}
        inputMode="decimal"
        onChange={(e) => {
          const split = splitCidr(e.target.value);
          onChange(split ? { ip: split.ip, mask: split.cidr } : { ip: e.target.value.trim() });
        }}
      />
      <Field
        label="Masque"
        type="number"
        min="0"
        max="32"
        placeholder="/24"
        className="cidr"
        value={mask ?? ''}
        hint={maskHint(mask)}
        onChange={(e) => onChange({ mask: toCidr(e.target.value) })}
      />
    </div>
  );
}

function HostForm({ node, update, live, labels }) {
  const d = node.data;
  const isClient = d.dhcp === true;
  return (
    <>
      <div className="field">
        <label htmlFor={`addr-${node.id}`}>Adressage</label>
        <select id={`addr-${node.id}`} value={isClient ? 'dhcp' : 'static'}
          onChange={(e) => update((x) => {
            const { dhcp, ...rest } = x;
            // Un serveur DHCP (Server-PT) garde ses pools en adressage statique
            if (e.target.value === 'dhcp') return { ...rest, dhcp: true, ip: '', mask: '', gateway: '' };
            return dhcp && dhcp !== true ? x : rest;
          })}>
          <option value="static">Statique</option>
          <option value="dhcp">Automatique (DHCP)</option>
        </select>
      </div>
      {isClient ? (
        <DhcpClientStatus live={live} labels={labels} />
      ) : (
        <>
          <IpCidrFields ip={d.ip} mask={d.mask} onChange={(patch) => update((x) => ({ ...x, ...patch }))} />
          <Field
            label="Passerelle par défaut"
            placeholder="192.168.1.254"
            value={d.gateway ?? ''}
            error={ipError(d.gateway)}
            inputMode="decimal"
            onChange={(e) => update((x) => ({ ...x, gateway: e.target.value.trim() }))}
          />
        </>
      )}
      {node.type === 'server' && !isClient && <DhcpServerForm node={node} update={update} />}
    </>
  );
}

// Routes statiques (routeur ou switch niveau 3)
function StaticRoutes({ routes, update }) {
  const patchRoute = (i, patch) =>
    update((d) => ({ ...d, routes: d.routes.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  return (
    <>
      <h3>Routes statiques</h3>
      {routes.map((r, i) => (
        <fieldset key={i} className="iface">
          <legend>Route {i + 1}</legend>
          <IpCidrFields ipLabel="Réseau" ip={r.network} mask={r.mask}
            onChange={(patch) => patchRoute(i, { ...('ip' in patch ? { network: patch.ip } : {}), ...('mask' in patch ? { mask: patch.mask } : {}) })} />
          <Field label="Saut suivant" placeholder="10.0.0.2" value={r.nextHop ?? ''} error={ipError(r.nextHop)}
            onChange={(e) => patchRoute(i, { nextHop: e.target.value.trim() })} />
          <button type="button" className="ghost small" onClick={() => update((d) => ({ ...d, routes: d.routes.filter((_, j) => j !== i) }))}>
            Retirer la route
          </button>
        </fieldset>
      ))}
      <button type="button" className="ghost" onClick={() => update((d) => ({ ...d, routes: [...(d.routes ?? []), { network: '', mask: '', nextHop: '' }] }))}>
        Ajouter une route
      </button>
      <p className="hint">Route par défaut : réseau 0.0.0.0, masque 0.</p>
    </>
  );
}

function RouterForm({ node, edges, labels, update, routing, issues }) {
  const ports = portsOf(node, edges);
  const routes = node.data.routes ?? [];

  const patchIface = (p, patch) =>
    update((d) => ({ ...d, ifaces: { ...d.ifaces, [p.name]: { ...d.ifaces?.[p.name], ...patch } } }));

  return (
    <>
      <h3>Interfaces</h3>
      {!ports.length && <p className="hint">Relie ce routeur à un équipement pour configurer ses interfaces.</p>}
      {ports.map((p) => {
        const serial = p.edge.data?.cable === 'serial';
        const dce = serial && dceOf(p.edge) === node.id;
        return (
          <fieldset key={p.link} className="iface">
            <legend>
              {p.name} <span className="muted">vers {labels.get(otherEnd(p.edge, node.id))}{serial ? ` · série ${dce ? 'DCE' : 'DTE'}` : ''}</span>
            </legend>
            <IpCidrFields ip={p.ip} mask={p.mask} onChange={(patch) => patchIface(p, patch)} />
            <InterfaceSecurity node={node} name={p.name} patch={(patch) => patchIface(p, patch)} />
            {!serial && !MODELS[modelId({ type: node.type, model: node.data.model })].vendor && (
              <Field label="Relais DHCP (ip helper-address)" placeholder="adresse du serveur DHCP" value={p.helperAddress ?? ''} error={ipError(p.helperAddress)}
                onChange={(e) => patchIface(p, { helperAddress: e.target.value.trim() || undefined })} />
            )}
            {!serial && <SubInterfaces node={node} parent={p.name} update={update} />}
            {dce && <ClockRate link={p.link} value={p.clockRate} onChange={(clockRate) => patchIface(p, { clockRate })} />}
            {node.data.ospf && (
              <Field label="Coût OSPF (vide = selon le débit)" type="number" min="1" max="65535" className="cidr" value={p.ospfCost ?? ''}
                onChange={(e) => patchIface(p, { ospfCost: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })} />
            )}
          </fieldset>
        );
      })}

      <StaticRoutes routes={routes} update={update} />
      <LoopbacksForm node={node} update={update} />
      <RoutingForm node={node} update={update} ports={ports} state={routing} />
      <SecurityForm node={node} update={update} issues={issues} ifaceNames={ports.map((p) => p.name)} />
      <DhcpServerForm node={node} update={update} />
    </>
  );
}

// Interfaces VLAN (SVI) d'un switch : administration, ou routage inter-VLAN sur un niveau 3
function SviForm({ node, update }) {
  const svis = Object.entries(node.data.ifaces ?? {}).filter(([n]) => /^Vlan\d+$/.test(n)).sort(([a], [b]) => Number(a.slice(4)) - Number(b.slice(4)));
  const set = (name, patch) => update((d) => ({ ...d, ifaces: { ...d.ifaces, [name]: { ...d.ifaces?.[name], ...patch } } }));
  const rename = (name, vlan) => update((d) => {
    const ifaces = { ...d.ifaces };
    const cur = ifaces[name];
    delete ifaces[name];
    ifaces[`Vlan${vlan}`] = cur;
    return { ...d, ifaces };
  });
  const remove = (name) => update((d) => {
    const ifaces = { ...d.ifaces };
    delete ifaces[name];
    return { ...d, ifaces };
  });
  const add = () => {
    let v = 1;
    while (svis.some(([n]) => n === `Vlan${v}`)) v = v === 1 ? 10 : v + 10;
    set(`Vlan${v}`, { ip: '', mask: 24 });
  };
  return (
    <>
      <h3>Interfaces VLAN (SVI)</h3>
      {svis.map(([name, i]) => (
        <fieldset key={name} className="iface">
          <legend>{name}</legend>
          <div className="field-row">
            <Field label="VLAN" type="number" min="1" max="4094" className="cidr" value={name.slice(4)}
              onChange={(e) => { const v = Math.max(1, Math.min(4094, Number(e.target.value) || 1)); if (!svis.some(([n]) => n === `Vlan${v}`)) rename(name, v); }} />
          </div>
          <IpCidrFields ip={i.ip} mask={i.mask} onChange={(patch) => set(name, patch)} />
          <button type="button" className="ghost small" onClick={() => remove(name)}>Retirer {name}</button>
        </fieldset>
      ))}
      <button type="button" className="ghost" onClick={add}>Ajouter une interface VLAN</button>
    </>
  );
}

function SwitchForm({ node, edges, labels, update, routing }) {
  const l3 = MODELS[modelId({ type: node.type, model: node.data.model })].l3;
  const ports = portsOf(node, edges);
  const patchPort = (p, patch) =>
    update((d) => ({ ...d, ports: { ...d.ports, [p.name]: { mode: 'access', vlan: 1, ...d.ports?.[p.name], ...patch } } }));

  return (
    <>
      <h3>Ports</h3>
      {!ports.length && <p className="hint">Relie des équipements à ce switch pour configurer ses ports.</p>}
      {ports.map((p) => {
        const mode = p.mode ?? 'access';
        return (
          <fieldset key={p.link} className="iface">
            <legend>
              {p.name} <span className="muted">vers {labels.get(otherEnd(p.edge, node.id))}</span>
            </legend>
            <div className="field-row">
              <div className="field">
                <label htmlFor={`mode-${p.link}`}>Mode</label>
                <select id={`mode-${p.link}`} value={mode} onChange={(e) => patchPort(p, { mode: e.target.value })}>
                  <option value="access">Access</option>
                  <option value="trunk">Trunk (802.1Q)</option>
                </select>
              </div>
              {mode === 'access' && (
                <Field label="VLAN" type="number" min="1" max="4094" className="cidr" value={p.vlan ?? 1}
                  onChange={(e) => patchPort(p, { vlan: Math.max(1, Math.min(4094, Math.trunc(Number(e.target.value)) || 1)) })} />
              )}
            </div>
          </fieldset>
        );
      })}
      <p className="hint">Un trunk transporte tous les VLAN ; le VLAN 1 (natif) passe sans étiquette.</p>
      <SviForm node={node} update={update} />
      {l3 && (
        <label className="check">
          <input type="checkbox" checked={Boolean(node.data.ipRouting)} onChange={(e) => update((d) => ({ ...d, ipRouting: e.target.checked || undefined }))} />
          Routage IP entre les VLAN (ip routing)
        </label>
      )}
      {l3 && node.data.ipRouting ? (
        <>
          <StaticRoutes routes={node.data.routes ?? []} update={update} />
          <DhcpServerForm node={node} update={update} />
          <RoutingForm node={node} update={update} state={routing}
            ports={Object.keys(node.data.ifaces ?? {}).filter((n) => /^Vlan\d+$/.test(n)).map((name) => ({ name }))} />
        </>
      ) : (
        <Field label="Passerelle par défaut (ip default-gateway)" placeholder="192.168.1.254" value={node.data.defaultGateway ?? ''}
          error={ipError(node.data.defaultGateway)} onChange={(e) => update((d) => ({ ...d, defaultGateway: e.target.value.trim() || undefined }))} />
      )}
      {!l3 && <p className="hint">Un switch de niveau 2 ne route pas : choisis un 3560 ou un 3650 pour le routage inter-VLAN.</p>}
    </>
  );
}

function ClockRate({ link, value, onChange }) {
  return (
    <div className="field">
      <label htmlFor={`clock-${link}`}>Clock rate (côté DCE)</label>
      <select id={`clock-${link}`} value={value ?? ''} aria-invalid={!value}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">Aucun : la liaison reste down</option>
        {CLOCK_RATES.map((r) => <option key={r} value={r}>{r} ({formatRate(r)})</option>)}
      </select>
    </div>
  );
}

// Modèle et modules : refusés s'ils retirent un port qui a un câble
function Hardware({ node, edges, update }) {
  const [error, setError] = useState('');
  const model = modelId({ type: node.type, model: node.data.model });
  const spec = MODELS[model];
  const usedPorts = linksOfNode(edges, node.id).map((e) => edgePort(e, node.id));

  const apply = (nextModel, nextModules) => {
    const available = new Set(devicePorts(nextModel, nextModules).map((p) => p.name));
    const missing = usedPorts.filter((n) => !available.has(n));
    if (missing.length) {
      setError(`Impossible : ${missing.join(', ')} ${missing.length > 1 ? 'ont' : 'a'} un câble et n'existerai${missing.length > 1 ? 'ent' : 't'} plus. Débranche d'abord.`);
      return;
    }
    setError('');
    update((d) => ({ ...d, model: nextModel, ...(node.type === 'router' ? { modules: nextModules } : {}) }));
  };

  const changeModel = (next) => {
    // On garde les modules si le nouveau modèle a les mêmes emplacements
    const keep = MODELS[next].slots?.kind === spec.slots?.kind
      ? Object.fromEntries(Object.entries(node.data.modules ?? {}).filter(([slot]) => MODELS[next].slots.ids.includes(Number(slot))))
      : {};
    apply(next, keep);
  };

  const setModule = (slot, mod) => {
    const next = { ...node.data.modules };
    if (mod) next[slot] = mod;
    else delete next[slot];
    apply(model, next);
  };

  const options = modelsOfType(node.type);
  const ports = devicePorts(model, node.data.modules);
  const taken = new Map(linksOfNode(edges, node.id).map((e) => [edgePort(e, node.id), e]));

  return (
    <>
      {options.length > 1 && (
        <div className="field">
          <label htmlFor="model">Modèle</label>
          <select id="model" value={model} onChange={(e) => changeModel(e.target.value)}>
            {options.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}
      {spec.slots && (
        <>
          <h3>Modules</h3>
          {spec.slots.ids.map((slot) => (
            <div className="field" key={slot}>
              <label htmlFor={`slot-${slot}`}>Emplacement {spec.slots.kind === 'nim' ? 'NIM' : 'EHWIC'} {slot}</label>
              <select id={`slot-${slot}`} value={node.data.modules?.[slot] ?? ''} onChange={(e) => setModule(slot, e.target.value)}>
                <option value="">Vide</option>
                {Object.entries(MODULES).filter(([, m]) => m.slot === spec.slots.kind).map(([id, m]) => (
                  <option key={id} value={id}>{m.label}</option>
                ))}
              </select>
            </div>
          ))}
        </>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <details className="ports-list">
        <summary>Ports physiques ({taken.size}/{ports.length} utilisés)</summary>
        <ul>
          {ports.map((p) => (
            <li key={p.name}>
              <code>{p.name}</code> <span className={`media media-${p.media}`}>{MEDIA_LABEL[p.media]}</span>
              {taken.has(p.name) && <span className="muted"> → {taken.get(p.name).data?.cable ? CABLES[taken.get(p.name).data.cable]?.label.toLowerCase() : ''}</span>}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

// Formulaire ou terminal : les deux modifient la même configuration
function ModeSwitch({ mode, onMode, vendor }) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Mode de configuration">
      <button type="button" role="radio" aria-checked={mode === 'form'} onClick={() => onMode('form')}>Formulaire</button>
      <button type="button" role="radio" aria-checked={mode === 'terminal'} onClick={() => onMode('terminal')}>
        {vendor === 'mikrotik' ? 'Terminal RouterOS' : HOST_TYPES.has(vendor) ? 'Invite de commandes' : 'Terminal IOS'}
      </button>
    </div>
  );
}

export function DeviceInspector({ node, edges, labels, update, onDelete, mode, onMode, terminal, importer, routing, issues, live }) {
  const Form = HOST_TYPES.has(node.type) ? HostForm : node.type === 'router' ? RouterForm : node.type === 'switch' ? SwitchForm : null;
  const vendor = HOST_TYPES.has(node.type) ? node.type : MODELS[modelId({ type: node.type, model: node.data.model })].vendor;
  if (terminal && mode === 'terminal') {
    return (
      <>
        <h2>{node.data.label} <span className="muted">· {MODELS[modelId({ type: node.type, model: node.data.model })].label}</span></h2>
        <ModeSwitch mode={mode} onMode={onMode} vendor={vendor} />
        {terminal}
        {importer}
        <p className="hint">Les commandes modifient la même configuration que le formulaire. « ? » pour l'aide, Tab pour compléter, ↑ ↓ pour l'historique.</p>
      </>
    );
  }
  return (
    <>
      <h2>{TYPES[node.type].label}</h2>
      {terminal && <ModeSwitch mode={mode} onMode={onMode} vendor={vendor} />}
      {importer}
      <Field label="Nom" value={node.data.label} onChange={(e) => update((d) => ({ ...d, label: e.target.value }))} />
      <Hardware node={node} edges={edges} update={update} />
      {Form ? <Form node={node} edges={edges} labels={labels} update={update} routing={routing} issues={issues} live={live} /> : <p className="hint">Un hub répète chaque trame sur tous ses ports : rien à configurer.</p>}
      <button type="button" className="danger" onClick={onDelete}>Supprimer l'équipement</button>
    </>
  );
}

// Câble sélectionné : type, ports à chaque bout, côté DCE, état
export function CableInspector({ edge, nodes, edges, updateEdge, updateNode, onDelete }) {
  const status = useLinkStatus(edge.id);
  const cable = edge.data?.cable ?? 'straight';
  const ends = [
    { key: 'sourceIface', node: nodes.find((n) => n.id === edge.source) },
    { key: 'targetIface', node: nodes.find((n) => n.id === edge.target) },
  ];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const dceNode = nodesById.get(dceOf(edge));
  const dcePort = edge.data?.[dceOf(edge) === edge.source ? 'sourceIface' : 'targetIface'];
  const clockRate = dceNode?.data.ifaces?.[dcePort]?.clockRate;

  return (
    <>
      <h2>Câble</h2>
      <p className={`cable-status ${status?.up ? 'up' : 'down'}`} role="status">
        {status?.up ? (cable === 'console' ? 'Liaison console prête.' : 'Lien actif.') : status?.reason}
      </p>
      <div className="field">
        <label htmlFor="cable-type">Type de câble</label>
        <select id="cable-type" value={cable} onChange={(e) => updateEdge((d) => ({ ...d, cable: e.target.value }))}>
          {Object.entries(CABLES).map(([id, c]) => <option key={id} value={id}>{c.label}</option>)}
        </select>
        <p className="field-hint">{CABLES[cable].help}</p>
      </div>
      {ends.map(({ key, node }) => node && (
        <div className="field" key={key}>
          <label htmlFor={`port-${key}`}>Port de {node.data.label}</label>
          <select id={`port-${key}`} value={edge.data?.[key] ?? ''} onChange={(e) => updateEdge((d) => ({ ...d, [key]: e.target.value }))}>
            {freePorts(node, edges, edge.id).map((p) => (
              <option key={p.name} value={p.name}>{p.name} ({MEDIA_LABEL[p.media]})</option>
            ))}
          </select>
        </div>
      ))}
      {cable === 'serial' && (
        <>
          <div className="field">
            <label htmlFor="dce">Côté DCE (fournit l'horloge)</label>
            <select id="dce" value={edge.data?.dce === 'target' ? 'target' : 'source'} onChange={(e) => updateEdge((d) => ({ ...d, dce: e.target.value }))}>
              <option value="source">{ends[0].node?.data.label}</option>
              <option value="target">{ends[1].node?.data.label}</option>
            </select>
          </div>
          {dceNode?.type === 'router' && (
            <ClockRate link={edge.id} value={clockRate}
              onChange={(v) => updateNode(dceNode.id)((d) => ({ ...d, ifaces: { ...d.ifaces, [dcePort]: { ...d.ifaces?.[dcePort], clockRate: v } } }))} />
          )}
        </>
      )}
      <button type="button" className="danger" onClick={onDelete}>Supprimer le câble</button>
    </>
  );
}

// Plusieurs équipements sélectionnés : alignement, duplication, suppression
export function MultiInspector({ nodes, onArrange, onDuplicate, onDelete }) {
  return (
    <>
      <h2>{nodes.length} équipements sélectionnés</h2>
      <p className="hint">{nodes.map((n) => n.data.label).join(', ')}</p>
      <h3>Disposition</h3>
      <div className="row">
        <button type="button" className="ghost" onClick={() => onArrange('row')}>Aligner en ligne</button>
        <button type="button" className="ghost" onClick={() => onArrange('column')}>Aligner en colonne</button>
      </div>
      {nodes.length > 2 && (
        <div className="row">
          <button type="button" className="ghost" onClick={() => onArrange('spread-x')}>Répartir horizontalement</button>
          <button type="button" className="ghost" onClick={() => onArrange('spread-y')}>Répartir verticalement</button>
        </div>
      )}
      <button type="button" className="ghost" onClick={onDuplicate}>Dupliquer (Ctrl+D)</button>
      <button type="button" className="danger" onClick={onDelete}>Supprimer les {nodes.length} équipements</button>
    </>
  );
}

export function Overview({ nodes, edges, issues, onSelect }) {
  const errors = issues.filter((i) => i.level === 'error').length;
  return (
    <>
      <h2>Vue d'ensemble</h2>
      <dl className="stats">
        <dt>Équipements</dt><dd>{nodes.length}</dd>
        <dt>Liaisons</dt><dd>{edges.length}</dd>
      </dl>
      <h3>Contrôles</h3>
      {issues.length === 0 ? (
        <p className="ok-text">Aucune incohérence détectée dans l'adressage.</p>
      ) : (
        <>
          <p className="hint">{errors} erreur(s), {issues.length - errors} avertissement(s). Clique pour aller à l'équipement.</p>
          <ul className="issues">
            {issues.map((i, k) => (
              <li key={k}>
                <button type="button" className={`issue issue-${i.level}`} onClick={() => onSelect(i.device)}>
                  <span className="issue-level">{i.level === 'error' ? 'Erreur' : 'Attention'}</span>
                  {i.text}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="hint">Sélectionne un équipement pour modifier son nom et son adressage.</p>
    </>
  );
}
