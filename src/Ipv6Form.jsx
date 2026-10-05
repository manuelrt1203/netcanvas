// Formulaires IPv6 : adresse d'une interface (globale, EUI-64, link-local), hôte (statique ou SLAAC),
// routage IPv6 d'un routeur (ipv6 unicast-routing, routes statiques). Même config que les terminaux.
import { useId } from 'react';
import { isLinkLocal6, isValidIp6, splitPrefix6 } from './net/ip6.js';
import { isMikrotik } from './net/catalog.js';
import { v6Forwarding } from './net/topology.js';

const toPrefix = (v) => (v === '' ? undefined : Math.max(0, Math.min(128, Math.trunc(Number(v)))));
const v6Error = (v) => (v && !isValidIp6(v) ? 'Format attendu : 2001:db8:1::1' : null);

function Input({ label, error, hint, ...props }) {
  const id = useId();
  const msg = error || hint;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={Boolean(error) || undefined} aria-describedby={msg ? `${id}-msg` : undefined} spellCheck="false" autoCapitalize="none" {...props} />
      {msg && <p id={`${id}-msg`} className={error ? 'field-error' : 'field-hint'}>{msg}</p>}
    </div>
  );
}

// Adresse + préfixe ; « 2001:db8:1::1/64 » collé dans l'adresse remplit le préfixe
function AddressPrefix({ label = 'Adresse IPv6', ip, prefix, onChange, eui64 }) {
  return (
    <div className="field-row">
      <Input label={eui64 ? 'Préfixe IPv6 (EUI-64)' : label} placeholder={eui64 ? '2001:db8:1::' : '2001:db8:1::1'} value={ip ?? ''} error={v6Error(ip)}
        onChange={(e) => {
          const split = splitPrefix6(e.target.value);
          onChange(split ? { ip: split.ip, prefix: split.prefix } : { ip: e.target.value.trim() || undefined });
        }} />
      <Input label="Préfixe" type="number" min="0" max="128" placeholder="/64" className="cidr" value={prefix ?? ''}
        onChange={(e) => onChange({ prefix: toPrefix(e.target.value) })} />
    </div>
  );
}

// Interface de routeur, sous-interface, SVI ou loopback
export function Ipv6IfaceFields({ entry = {}, patch, loopback = false, v6, pools = [] }) {
  const set = (p) => patch({
    ...('ip' in p ? { ipv6: p.ip } : {}),
    ...('prefix' in p ? { prefix6: p.prefix } : {}),
  });
  const on = Boolean(entry.ipv6 || entry.ipv6Enable || entry.linkLocal);
  return (
    <details className="v6" open={on}>
      <summary>IPv6{entry.ipv6 ? <span className="muted"> · {entry.ipv6}{entry.prefix6 != null ? `/${entry.prefix6}` : ''}</span> : null}</summary>
      <AddressPrefix ip={entry.ipv6} prefix={entry.prefix6} onChange={set} eui64={entry.eui64} />
      {v6?.ip && entry.eui64 && <p className="hint">Adresse obtenue : {v6.ip}</p>}
      {!loopback && (
        <>
          {v6?.linkLocal && !entry.linkLocal && <p className="hint">Link-local automatique : {v6.linkLocal}</p>}
          <label className="check">
            <input type="checkbox" checked={Boolean(entry.eui64)} onChange={(e) => patch({ eui64: e.target.checked || undefined })} /> Fin d'adresse en EUI-64 (d'après la MAC)
          </label>
          <Input label="Link-local (vide = automatique fe80:: + EUI-64)" placeholder="fe80::1" value={entry.linkLocal ?? ''}
            error={entry.linkLocal && (!isValidIp6(entry.linkLocal) || !isLinkLocal6(entry.linkLocal)) ? 'Adresse fe80::/10 attendue' : null}
            onChange={(e) => patch({ linkLocal: e.target.value.trim() || undefined })} />
          {entry.ipv6 && (
            <div className="checks">
              <label className="check">
                <input type="checkbox" checked={Boolean(entry.ndManaged)} onChange={(e) => patch({ ndManaged: e.target.checked || undefined })} /> M : adresse par DHCPv6 (managed-config-flag)
              </label>
              <label className="check">
                <input type="checkbox" checked={Boolean(entry.ndOther)} onChange={(e) => patch({ ndOther: e.target.checked || undefined })} /> O : DNS par DHCPv6 (other-config-flag)
              </label>
            </div>
          )}
          {entry.ipv6 && pools.length > 0 && <PoolSelect value={entry.dhcp6Server} pools={pools} onChange={(dhcp6Server) => patch({ dhcp6Server })} />}
          {entry.ipv6 && !entry.dhcp6Server && (entry.ndManaged || entry.ndOther || entry.dhcp6Relay) && (
            <Input label="Relais DHCPv6 vers (ipv6 dhcp relay destination)" placeholder="2001:db8:acad:12::2" value={entry.dhcp6Relay ?? ''}
              error={entry.dhcp6Relay && !isValidIp6(entry.dhcp6Relay) ? 'Adresse IPv6 du serveur DHCPv6 attendue' : null}
              onChange={(e) => patch({ dhcp6Relay: e.target.value.trim() || undefined })} />
          )}
          {!entry.ipv6 && !entry.linkLocal && (
            <label className="check">
              <input type="checkbox" checked={Boolean(entry.ipv6Enable)} onChange={(e) => patch({ ipv6Enable: e.target.checked || undefined })} /> IPv6 actif sans adresse globale (ipv6 enable)
            </label>
          )}
        </>
      )}
    </details>
  );
}

function PoolSelect({ value, pools, onChange }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>Serveur DHCPv6 sur cette interface (ipv6 dhcp server)</label>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Aucun</option>
        {pools.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
    </div>
  );
}

// Pools DHCPv6 du routeur : préfixe d'adresses (stateful) et serveur DNS
function Dhcp6Pools({ node, update }) {
  const pools = node.data.dhcp6Pools ?? {};
  const set = (fn) => update((x) => {
    const next = fn({ ...(x.dhcp6Pools ?? {}) });
    const { dhcp6Pools, ...rest } = x;
    return Object.keys(next).length ? { ...rest, dhcp6Pools: next } : rest;
  });
  const patch = (n, p) => set((all) => ({ ...all, [n]: { ...all[n], ...p } }));
  return (
    <fieldset className="iface">
      <legend>Pools DHCPv6</legend>
      {Object.entries(pools).map(([n, p]) => (
        <div key={n}>
          <p className="label">{n}</p>
          <AddressPrefix label="Préfixe d'adresses (address prefix, M=1)" ip={p.prefix} prefix={p.len}
            onChange={(v) => patch(n, { ...('ip' in v ? { prefix: v.ip } : {}), ...('prefix' in v ? { len: v.prefix } : {}) })} />
          <Input label="Serveur DNS (dns-server)" placeholder="2001:db8:acad:30::10" value={p.dns ?? ''} error={v6Error(p.dns)}
            onChange={(e) => patch(n, { dns: e.target.value.trim() || undefined })} />
          <button type="button" className="ghost small" onClick={() => set((all) => { delete all[n]; return all; })}>Retirer le pool {n}</button>
        </div>
      ))}
      <button type="button" className="ghost small" onClick={() => set((all) => ({ ...all, [`POOL6-${Object.keys(all).length + 1}`]: { len: 64 } }))}>Ajouter un pool DHCPv6</button>
      <p className="hint">Puis, sur l'interface : choisis le pool et coche M (adresse) ou O (DNS seulement).</p>
    </fieldset>
  );
}

// Hôte : désactivé, statique, ou automatique par les annonces du routeur (SLAAC)
export function HostIpv6Form({ node, update, v6 }) {
  const d = node.data;
  const mode = d.slaac ? 'slaac' : d.ipv6 || d.gateway6 ? 'static' : 'off';
  const setMode = (m) => update((x) => {
    const { ipv6, prefix6, gateway6, slaac, ...rest } = x;
    if (m === 'slaac') return { ...rest, slaac: true };
    if (m === 'static') return { ...rest, ipv6: ipv6 ?? '', prefix6: prefix6 ?? 64 };
    return rest;
  });
  const id = useId();
  return (
    <details className="proto" open={mode !== 'off'}>
      <summary>IPv6 {mode !== 'off' && <span className="badge-on">{mode === 'slaac' ? 'SLAAC' : 'statique'}</span>}</summary>
      <div className="field">
        <label htmlFor={id}>Configuration IPv6</label>
        <select id={id} value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="off">Link-local seulement</option>
          <option value="static">Statique</option>
          <option value="slaac">Automatique (SLAAC / DHCPv6)</option>
        </select>
      </div>
      {mode === 'static' && (
        <>
          <AddressPrefix ip={d.ipv6} prefix={d.prefix6} onChange={(p) => update((x) => ({ ...x, ...('ip' in p ? { ipv6: p.ip ?? '' } : {}), ...('prefix' in p ? { prefix6: p.prefix } : {}) }))} />
          <Input label="Passerelle IPv6" placeholder="fe80::1 ou 2001:db8:1::1" value={d.gateway6 ?? ''} error={v6Error(d.gateway6)}
            onChange={(e) => update((x) => ({ ...x, gateway6: e.target.value.trim() || undefined }))} />
        </>
      )}
      {mode === 'slaac' && v6?.dnsError && <p className="field-hint">DNS non reçu : {v6.dnsError}.</p>}
      {mode === 'slaac' && v6 && (
        v6.slaacError
          ? <p className="field-error">Pas d'adresse automatique : {v6.slaacError}.</p>
          : v6.ip && (
            <p className="ok-text">
              {v6.how === 'dhcp6' ? `Adresse DHCPv6 (M=1) : ${v6.ip}` : `Annonce reçue (SLAAC) : ${v6.ip}/${v6.prefix}`}, passerelle {v6.gateway}{v6.dns ? `, DNS ${v6.dns} (DHCPv6)` : ''}.
            </p>
          )
      )}
      {v6?.linkLocal && <p className="hint">Link-local : {v6.linkLocal}</p>}
    </details>
  );
}

// Routeur (ou switch niveau 3) : ipv6 unicast-routing et routes statiques IPv6
export function Ipv6RoutingForm({ node, update }) {
  const d = node.data;
  const mk = isMikrotik({ type: node.type, model: d.model });
  const forwarding = v6Forwarding({ type: node.type, model: d.model, config: d });
  const routes = d.routes6 ?? [];
  const setRoutes = (list) => update((x) => {
    const { routes6, ...rest } = x;
    return list.length ? { ...rest, routes6: list } : rest;
  });
  const patchRoute = (i, p) => setRoutes(routes.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <details className="proto" open={Boolean((!mk && forwarding) || routes.length || d.ospf6)}>
      <summary>Routage IPv6 {forwarding && <span className="badge-on">actif</span>}</summary>
      <label className="check">
        <input type="checkbox" checked={forwarding} onChange={(e) => update((x) => {
          const { ipv6Routing, ipv6NoForward, ...rest } = x;
          if (mk) return e.target.checked ? rest : { ...rest, ipv6NoForward: true };
          return e.target.checked ? { ...rest, ipv6Routing: true } : rest;
        })} /> {mk ? 'Router les paquets IPv6 et envoyer les annonces RA (/ipv6 settings forward=yes)' : 'Router les paquets IPv6 et envoyer les annonces RA (ipv6 unicast-routing)'}
      </label>
      {routes.map((r, i) => (
        <fieldset key={i} className="iface">
          <legend>Route IPv6 {i + 1}</legend>
          <AddressPrefix label="Réseau" ip={r.network} prefix={r.prefix}
            onChange={(p) => patchRoute(i, { ...('ip' in p ? { network: p.ip } : {}), ...('prefix' in p ? { prefix: p.prefix } : {}) })} />
          <div className="field-row">
            <Input label="Saut suivant" placeholder="2001:db8:12::2 ou fe80::2" value={r.nextHop ?? ''} error={v6Error(r.nextHop)}
              onChange={(e) => patchRoute(i, { nextHop: e.target.value.trim() || undefined })} />
            <Input label="Interface (si link-local)" placeholder="G0/1" value={r.iface ?? ''}
              onChange={(e) => patchRoute(i, { iface: e.target.value.trim() || undefined })} />
          </div>
          <button type="button" className="ghost small" onClick={() => setRoutes(routes.filter((_, j) => j !== i))}>Retirer la route</button>
        </fieldset>
      ))}
      <button type="button" className="ghost small" onClick={() => setRoutes([...routes, { network: '', prefix: 64 }])}>Ajouter une route IPv6</button>
      <p className="hint">Route par défaut : ::/0. Un saut suivant link-local (fe80::) exige l'interface de sortie.</p>
      <Ospf6Fields node={node} update={update} />
      <Dhcp6Pools node={node} update={update} />
    </details>
  );
}

// OSPFv3 : activé par interface (zone), router-id au format IPv4, interfaces passives, route par défaut
function Ospf6Fields({ node, update }) {
  const d = node.data;
  const o = d.ospf6;
  const names = Object.entries(d.ifaces ?? {}).filter(([, i]) => i.ipv6 || i.ipv6Enable || i.linkLocal).map(([n]) => n)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const set = (fn) => update((x) => ({ ...x, ospf6: fn(x.ospf6 ?? { processId: 1, interfaces: [] }) }));
  const id = useId();
  return (
    <fieldset className="iface">
      <legend>OSPFv3</legend>
      <label className="check">
        <input type="checkbox" checked={Boolean(o)} onChange={(e) => update((x) => {
          const { ospf6, ...rest } = x;
          return e.target.checked ? { ...rest, ospf6: { processId: 1, interfaces: [] } } : rest;
        })} /> Activer OSPFv3
      </label>
      {o && (
        <>
          <Input label="Router-ID (format IPv4, vide = d'après les adresses IPv4)" placeholder="1.1.1.1" value={o.routerId ?? ''}
            onChange={(e) => set((x) => ({ ...x, routerId: e.target.value.trim() || undefined }))} />
          {!names.length && <p className="hint">Active d'abord IPv6 sur une interface (adresse, link-local ou « ipv6 enable »).</p>}
          {names.map((n) => {
            const cur = (o.interfaces ?? []).find((x) => x.name === n);
            return (
              <div key={n} className="field-row">
                <Input label={`${n} : zone (vide = hors OSPFv3)`} type="number" min="0" className="cidr" value={cur?.area ?? ''}
                  onChange={(e) => set((x) => ({
                    ...x,
                    interfaces: [...(x.interfaces ?? []).filter((y) => y.name !== n), ...(e.target.value === '' ? [] : [{ name: n, area: Number(e.target.value) }])],
                  }))} />
                <label className="check">
                  <input type="checkbox" checked={(o.passive ?? []).includes(n)} onChange={(e) => set((x) => ({
                    ...x, passive: e.target.checked ? [...new Set([...(x.passive ?? []), n])] : (x.passive ?? []).filter((y) => y !== n),
                  }))} /> passive
                </label>
              </div>
            );
          })}
          <div className="field">
            <label htmlFor={id}>Route par défaut annoncée (default-information originate)</label>
            <select id={id} value={o.defaultOriginate === 'always' ? 'always' : o.defaultOriginate ? 'yes' : ''}
              onChange={(e) => set((x) => ({ ...x, defaultOriginate: e.target.value === 'always' ? 'always' : e.target.value === 'yes' ? true : undefined }))}>
              <option value="">Non</option>
              <option value="yes">Si le routeur a une route ::/0</option>
              <option value="always">Toujours (always)</option>
            </select>
          </div>
        </>
      )}
    </fieldset>
  );
}
