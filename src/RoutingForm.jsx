// Formulaires du routage dynamique d'un routeur (OSPF, RIP, BGP) et de ses loopbacks.
// Ils écrivent la même configuration que les terminaux IOS et RouterOS.
import { Fragment, useId } from 'react';
import { Ipv6IfaceFields } from './Ipv6Form.jsx';
import { cidrToWildcard, wildcardToCidr } from './net/routing.js';
import { isValidIp } from './net/ip.js';
import { isMikrotik } from './net/catalog.js';

const num = (v) => (v === '' || v === null || v === undefined ? '' : Number(v));

function Input({ label, ...props }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={props.value && props['data-ip'] && !isValidIp(props.value) ? true : undefined} {...props} />
    </div>
  );
}

function Check({ label, checked, onChange }) {
  return (
    <label className="check">
      <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

// Liste éditable : une ligne par élément, bouton retirer, bouton ajouter
function Rows({ items, render, onAdd, onRemove, addLabel }) {
  return (
    <>
      {items.map((item, i) => (
        <div className="rows-item" key={i}>
          {render(item, i)}
          <button type="button" className="ghost small" aria-label="Retirer" onClick={() => onRemove(i)}>✕</button>
        </div>
      ))}
      <button type="button" className="ghost small" onClick={onAdd}>{addLabel}</button>
    </>
  );
}

// État en direct calculé par NetCanvas : voisins, sessions et explications
function Status({ lines, problems }) {
  if (!lines.length && !problems.length) return null;
  return (
    <div className="routing-status">
      {lines.map((l) => <p key={l} className="ok-text">{l}</p>)}
      {problems.map((p) => <p key={p} className="field-error">{p}</p>)}
    </div>
  );
}

// Sous-interfaces 802.1Q d'un port (router-on-a-stick) : G0/0.10 chez Cisco, vlan10 chez MikroTik
export function SubInterfaces({ node, parent, update }) {
  const mk = isMikrotik({ type: node.type, model: node.data.model });
  const subs = Object.entries(node.data.ifaces ?? {}).filter(([, i]) => i.parent === parent)
    .sort(([, a], [, b]) => Number(a.vlan) - Number(b.vlan));
  const nameFor = (vlan) => (mk ? `vlan${vlan}` : `${parent}.${vlan}`);
  const setSub = (oldName, patch) => update((d) => {
    const ifaces = { ...d.ifaces };
    const cur = { ...ifaces[oldName], ...patch };
    delete ifaces[oldName];
    ifaces[patch.vlan !== undefined ? nameFor(patch.vlan) : oldName] = cur; // le nom suit le VLAN
    return { ...d, ifaces };
  });
  const add = () => {
    const used = new Set(subs.map(([, i]) => Number(i.vlan)));
    let vlan = 10;
    while (used.has(vlan)) vlan += 10;
    update((d) => ({ ...d, ifaces: { ...d.ifaces, [nameFor(vlan)]: { parent, vlan, ip: '', mask: 24 } } }));
  };
  const remove = (name) => update((d) => {
    const ifaces = { ...d.ifaces };
    delete ifaces[name];
    return { ...d, ifaces };
  });
  return (
    <div className="subifs">
      {subs.map(([name, i]) => (
        <Fragment key={name}>
        <div className="rows-item">
          <code className="iface-name">{name}</code>
          <Input label="VLAN" type="number" min="1" max="4094" className="cidr" value={i.vlan}
            onChange={(e) => { const v = Math.max(1, Math.min(4094, Number(e.target.value) || 1)); if (!subs.some(([n, x]) => n !== name && Number(x.vlan) === v)) setSub(name, { vlan: v }); }} />
          <Input label="Adresse" placeholder="192.168.10.1" data-ip value={i.ip ?? ''} onChange={(e) => setSub(name, { ip: e.target.value.trim() })} />
          <Input label="/" type="number" min="0" max="32" className="cidr" value={i.mask ?? ''} onChange={(e) => setSub(name, { mask: num(e.target.value) })} />
          {!mk && (
            <Input label="Relais DHCP (ip helper-address)" placeholder="serveur" data-ip value={i.helperAddress ?? ''}
              onChange={(e) => setSub(name, { helperAddress: e.target.value.trim() || undefined })} />
          )}
          <button type="button" className="ghost small" aria-label={`Retirer ${name}`} onClick={() => remove(name)}>✕</button>
        </div>
        <Ipv6IfaceFields entry={i} patch={(p) => setSub(name, p)} />
        </Fragment>
      ))}
      <button type="button" className="ghost small" onClick={add}>Ajouter une sous-interface 802.1Q</button>
    </div>
  );
}

export function LoopbacksForm({ node, update }) {
  const mk = isMikrotik({ type: node.type, model: node.data.model });
  const names = Object.keys(node.data.ifaces ?? {}).filter((n) => /^(Lo\d+|lo)$/.test(n)).sort();
  const next = mk ? 'lo' : `Lo${names.length ? Math.max(...names.map((n) => Number(n.slice(2)) || 0)) + 1 : 0}`;
  const patch = (name, value) => update((d) => ({ ...d, ifaces: { ...d.ifaces, [name]: { ...d.ifaces?.[name], ...value } } }));
  const remove = (name) => update((d) => {
    const ifaces = { ...d.ifaces };
    delete ifaces[name];
    return { ...d, ifaces };
  });
  return (
    <>
      <h3>Loopbacks</h3>
      {names.map((name) => (
        <Fragment key={name}>
        <div className="rows-item">
          <code className="iface-name">{name}</code>
          <Input label="Adresse" placeholder="1.1.1.1" data-ip value={node.data.ifaces[name].ip ?? ''} onChange={(e) => patch(name, { ip: e.target.value.trim() })} />
          <Input label="Masque" type="number" min="0" max="32" className="cidr" value={node.data.ifaces[name].mask ?? 32} onChange={(e) => patch(name, { mask: num(e.target.value) })} />
          <button type="button" className="ghost small" aria-label={`Retirer ${name}`} onClick={() => remove(name)}>✕</button>
        </div>
        <Ipv6IfaceFields entry={node.data.ifaces[name]} patch={(p) => patch(name, p)} loopback />
        </Fragment>
      ))}
      {!(mk && names.length) && (
        <button type="button" className="ghost small" onClick={() => patch(next, { ip: '', mask: 32 })}>Ajouter {next}</button>
      )}
      <p className="hint">Toujours active : sert de router-id et de source des sessions iBGP.</p>
    </>
  );
}

export function RoutingForm({ node, update, ports, state }) {
  const d = node.data;
  const mk = isMikrotik({ type: node.type, model: d.model });
  const set = (key, fn) => update((x) => ({ ...x, [key]: fn(x[key]) }));
  const toggle = (key, init) => (on) => update((x) => {
    const copy = { ...x };
    if (on) copy[key] = init;
    else delete copy[key];
    return copy;
  });
  const names = [...ports.map((p) => p.name), ...Object.keys(d.ifaces ?? {}).filter((n) => /^(Lo\d+|lo)$/.test(n))];
  const passiveBoxes = (key) => names.map((n) => (
    <Check key={n} label={n} checked={d[key]?.passive?.includes(n)}
      onChange={(on) => set(key, (c) => ({ ...c, passive: on ? [...new Set([...(c.passive ?? []), n])] : (c.passive ?? []).filter((x) => x !== n) }))} />
  ));
  const issues = (re) => (state?.issues ?? []).filter((i) => re.test(i.text)).map((i) => i.text);

  return (
    <>
      <h3>Routage dynamique</h3>

      <details className="proto" open={Boolean(d.ospf)}>
        <summary>OSPF {d.ospf && <span className="badge-on">actif</span>}</summary>
        <Check label="Activer OSPF" checked={d.ospf} onChange={toggle('ospf', { processId: 1, networks: [] })} />
        {d.ospf && (
          <>
            <Status
              lines={(state?.ospf.neighbors ?? []).map((n) => `Voisin ${n.peer.label} (${n.peer.ospf.routerId}) sur ${n.iface.name}, zone ${n.area} : FULL`)}
              problems={issues(/^OSPF|OSPF est activé|default-information/)} />
            <div className="field-row">
              <Input label="Processus" type="number" min="1" className="cidr" value={d.ospf.processId ?? 1} onChange={(e) => set('ospf', (o) => ({ ...o, processId: num(e.target.value) || 1 }))} />
              <Input label="Router-ID" placeholder="auto" data-ip value={d.ospf.routerId ?? ''} onChange={(e) => set('ospf', (o) => ({ ...o, routerId: e.target.value.trim() || undefined }))} />
            </div>
            <p className="label">Réseaux annoncés (network … area …)</p>
            <Rows
              items={d.ospf.networks ?? []}
              addLabel="Ajouter un réseau"
              onAdd={() => set('ospf', (o) => ({ ...o, networks: [...(o.networks ?? []), { network: '', wildcard: '0.0.0.255', area: 0 }] }))}
              onRemove={(i) => set('ospf', (o) => ({ ...o, networks: o.networks.filter((_, j) => j !== i) }))}
              render={(n, i) => {
                const patch = (v) => set('ospf', (o) => ({ ...o, networks: o.networks.map((x, j) => (j === i ? { ...x, ...v } : x)) }));
                return (
                  <>
                    <Input label="Réseau" placeholder="10.0.0.0" data-ip value={n.network} onChange={(e) => patch({ network: e.target.value.trim() })} />
                    <Input label="/" type="number" min="0" max="32" className="cidr" value={wildcardToCidr(n.wildcard) ?? ''} onChange={(e) => patch({ wildcard: cidrToWildcard(Math.max(0, Math.min(32, Number(e.target.value) || 0))) })} />
                    <Input label="Zone" type="number" min="0" className="cidr" value={n.area} onChange={(e) => patch({ area: num(e.target.value) || 0 })} />
                  </>
                );
              }} />
            <p className="label">Interfaces passives</p>
            <div className="checks">{passiveBoxes('ospf')}</div>
            <div className="field">
              <label htmlFor={`dio-${node.id}`}>Annoncer la route par défaut</label>
              <select id={`dio-${node.id}`} value={d.ospf.defaultOriginate === 'always' ? 'always' : d.ospf.defaultOriginate ? 'yes' : ''}
                onChange={(e) => set('ospf', (o) => ({ ...o, defaultOriginate: e.target.value === 'always' ? 'always' : e.target.value ? true : undefined }))}>
                <option value="">Non</option>
                <option value="yes">Si ce routeur en a une (default-information originate)</option>
                <option value="always">Toujours (… always)</option>
              </select>
            </div>
            <div className="checks">
              <Check label="Redistribuer les routes statiques" checked={d.ospf.redistribute?.static} onChange={(v) => set('ospf', (o) => ({ ...o, redistribute: { ...o.redistribute, static: v } }))} />
              <Check label="Redistribuer les réseaux connectés" checked={d.ospf.redistribute?.connected} onChange={(v) => set('ospf', (o) => ({ ...o, redistribute: { ...o.redistribute, connected: v } }))} />
            </div>
          </>
        )}
      </details>

      <details className="proto" open={Boolean(d.rip)}>
        <summary>RIP {d.rip && <span className="badge-on">actif</span>}</summary>
        <Check label="Activer RIP" checked={d.rip} onChange={toggle('rip', { version: 2, networks: [] })} />
        {d.rip && (
          <>
            <Status lines={[]} problems={issues(/RIP/)} />
            <div className="field">
              <label htmlFor={`ripv-${node.id}`}>Version</label>
              <select id={`ripv-${node.id}`} value={d.rip.version ?? ''} onChange={(e) => set('rip', (r) => ({ ...r, version: e.target.value ? Number(e.target.value) : undefined }))}>
                <option value="2">2 (recommandé)</option>
                <option value="1">1</option>
                <option value="">par défaut (envoie v1)</option>
              </select>
            </div>
            <p className="label">Réseaux (par classe, ex. 10.0.0.0)</p>
            <Rows
              items={d.rip.networks ?? []}
              addLabel="Ajouter un réseau"
              onAdd={() => set('rip', (r) => ({ ...r, networks: [...(r.networks ?? []), ''] }))}
              onRemove={(i) => set('rip', (r) => ({ ...r, networks: r.networks.filter((_, j) => j !== i) }))}
              render={(n, i) => <Input label="Réseau" placeholder="10.0.0.0" data-ip value={n} onChange={(e) => set('rip', (r) => ({ ...r, networks: r.networks.map((x, j) => (j === i ? e.target.value.trim() : x)) }))} />} />
            <p className="label">Interfaces passives</p>
            <div className="checks">{passiveBoxes('rip')}</div>
            <Check label="Annoncer la route par défaut" checked={d.rip.defaultOriginate} onChange={(v) => set('rip', (r) => ({ ...r, defaultOriginate: v || undefined }))} />
          </>
        )}
      </details>

      {!mk && (
      <details className="proto" open={Boolean(d.eigrp)}>
        <summary>EIGRP {d.eigrp && <span className="badge-on">AS {d.eigrp.asn}</span>}</summary>
        <Check label="Activer EIGRP" checked={d.eigrp} onChange={toggle('eigrp', { asn: 100, networks: [] })} />
        {d.eigrp && (
          <>
            <Status
              lines={(state?.eigrp?.neighbors ?? []).map((n) => `Voisin ${n.peer.label} (${n.peerIface.ip}) sur ${n.iface.name}`)}
              problems={issues(/EIGRP/)} />
            <div className="field-row">
              <Input label="Numéro d'AS" type="number" min="1" max="65535" className="cidr" value={d.eigrp.asn ?? ''} onChange={(e) => set('eigrp', (x) => ({ ...x, asn: num(e.target.value) }))} />
              <Input label="Router-ID" placeholder="auto" data-ip value={d.eigrp.routerId ?? ''} onChange={(e) => set('eigrp', (x) => ({ ...x, routerId: e.target.value.trim() || undefined }))} />
            </div>
            <p className="label">Réseaux (network ; sans masque : réseau par classe)</p>
            <Rows
              items={d.eigrp.networks ?? []}
              addLabel="Ajouter un réseau"
              onAdd={() => set('eigrp', (x) => ({ ...x, networks: [...(x.networks ?? []), { network: '' }] }))}
              onRemove={(i) => set('eigrp', (x) => ({ ...x, networks: x.networks.filter((_, j) => j !== i) }))}
              render={(n, i) => {
                const patch = (v) => set('eigrp', (x) => ({ ...x, networks: x.networks.map((y, j) => (j === i ? { ...y, ...v } : y)) }));
                return (
                  <>
                    <Input label="Réseau" placeholder="10.0.0.0" data-ip value={n.network} onChange={(e) => patch({ network: e.target.value.trim() })} />
                    <Input label="/" type="number" min="0" max="32" className="cidr" placeholder="classe" value={n.wildcard ? wildcardToCidr(n.wildcard) ?? '' : ''}
                      onChange={(e) => patch({ wildcard: e.target.value === '' ? undefined : cidrToWildcard(Math.max(0, Math.min(32, Number(e.target.value) || 0))) })} />
                  </>
                );
              }} />
            <p className="label">Interfaces passives</p>
            <div className="checks">{passiveBoxes('eigrp')}</div>
            <Check label="Redistribuer les routes statiques (D EX)" checked={d.eigrp.redistribute?.static} onChange={(v) => set('eigrp', (x) => ({ ...x, redistribute: v ? { static: true } : undefined }))} />
            <p className="hint">Métrique : 256 × (10⁷ / bande passante minimale + somme des délais). Bande passante et délai se règlent sur chaque interface.</p>
          </>
        )}
      </details>
      )}

      <details className="proto" open={Boolean(d.bgp)}>
        <summary>BGP {d.bgp && <span className="badge-on">AS {d.bgp.asn}</span>}</summary>
        <Check label="Activer BGP" checked={d.bgp} onChange={toggle('bgp', { asn: 65001, neighbors: [], networks: [] })} />
        {d.bgp && (
          <>
            <Status
              lines={(state?.bgp.sessions ?? []).filter((s) => s.state === 'Established').map((s) => `Session ${s.ebgp ? 'eBGP' : 'iBGP'} avec ${s.peer.label} (${s.neighbor}) : établie`)}
              problems={issues(/^BGP/)} />
            <div className="field-row">
              <Input label="Numéro d'AS" type="number" min="1" value={d.bgp.asn ?? ''} onChange={(e) => set('bgp', (b) => ({ ...b, asn: num(e.target.value) }))} />
              <Input label="Router-ID" placeholder="auto" data-ip value={d.bgp.routerId ?? ''} onChange={(e) => set('bgp', (b) => ({ ...b, routerId: e.target.value.trim() || undefined }))} />
            </div>
            <p className="label">Voisins</p>
            <Rows
              items={d.bgp.neighbors ?? []}
              addLabel="Ajouter un voisin"
              onAdd={() => set('bgp', (b) => ({ ...b, neighbors: [...(b.neighbors ?? []), { ip: '', remoteAs: b.asn }] }))}
              onRemove={(i) => set('bgp', (b) => ({ ...b, neighbors: b.neighbors.filter((_, j) => j !== i) }))}
              render={(n, i) => {
                const patch = (v) => set('bgp', (b) => ({ ...b, neighbors: b.neighbors.map((x, j) => (j === i ? { ...x, ...v } : x)) }));
                return (
                  <div className="neighbor">
                    <div className="field-row">
                      <Input label="Adresse" placeholder="10.0.0.2" data-ip value={n.ip} onChange={(e) => patch({ ip: e.target.value.trim() })} />
                      <Input label="remote-as" type="number" min="1" value={n.remoteAs ?? ''} onChange={(e) => patch({ remoteAs: num(e.target.value) })} />
                    </div>
                    <div className="field">
                      <label htmlFor={`us-${node.id}-${i}`}>update-source</label>
                      <select id={`us-${node.id}-${i}`} value={n.updateSource ?? ''} onChange={(e) => patch({ updateSource: e.target.value || undefined })}>
                        <option value="">Interface de sortie</option>
                        {names.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </div>
                    <div className="checks">
                      <Check label="next-hop-self" checked={n.nextHopSelf} onChange={(v) => patch({ nextHopSelf: v || undefined })} />
                      <Check label="ebgp-multihop" checked={n.ebgpMultihop} onChange={(v) => patch({ ebgpMultihop: v ? 2 : undefined })} />
                    </div>
                  </div>
                );
              }} />
            <p className="label">Réseaux annoncés (network … mask …)</p>
            <Rows
              items={d.bgp.networks ?? []}
              addLabel="Ajouter un réseau"
              onAdd={() => set('bgp', (b) => ({ ...b, networks: [...(b.networks ?? []), { network: '', mask: 24 }] }))}
              onRemove={(i) => set('bgp', (b) => ({ ...b, networks: b.networks.filter((_, j) => j !== i) }))}
              render={(n, i) => {
                const patch = (v) => set('bgp', (b) => ({ ...b, networks: b.networks.map((x, j) => (j === i ? { ...x, ...v } : x)) }));
                return (
                  <>
                    <Input label="Réseau" placeholder="192.168.1.0" data-ip value={n.network} onChange={(e) => patch({ network: e.target.value.trim() })} />
                    <Input label="/" type="number" min="0" max="32" className="cidr" value={n.mask} onChange={(e) => patch({ mask: num(e.target.value) })} />
                  </>
                );
              }} />
            <p className="hint">Comme sur IOS, un réseau n'est annoncé que s'il est exactement dans la table de routage.</p>
          </>
        )}
      </details>
    </>
  );
}
