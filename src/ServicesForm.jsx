// Services d'un serveur (DNS, web) : même config que celle lue par le simulateur (config.services).
import { useId } from 'react';
import { isValidIp } from './net/ip.js';
import { isHostname } from './net/services.js';
import { isMikrotik } from './net/catalog.js';
import { isValidIp6 } from './net/ip6.js';

function Input({ label, invalid, ...props }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={invalid || undefined} {...props} />
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

export function ServicesForm({ node, update }) {
  const s = node.data.services ?? {};
  const dns = s.dns ?? { enabled: false, records: [] };
  const http = s.http ?? { enabled: false, title: '', body: '' };
  // Un service vidé et arrêté disparaît du document
  const set = (key, value) => update((d) => {
    const services = { ...d.services, [key]: value };
    const empty = (v) => !v.enabled && !(v.records?.length) && !v.title && !v.body;
    for (const k of Object.keys(services)) if (empty(services[k])) delete services[k];
    const { services: _, ...rest } = d;
    return Object.keys(services).length ? { ...rest, services } : rest;
  });
  const records = dns.records ?? [];
  const patchRecord = (i, patch) => set('dns', { ...dns, records: records.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const count = [dns.enabled && 'DNS', http.enabled && 'web'].filter(Boolean);

  return (
    <details className="proto" open={count.length > 0}>
      <summary>Services {count.length > 0 && <span className="badge-on">{count.join(' + ')}</span>}</summary>

      <Toggle label="Serveur DNS (UDP 53)" checked={Boolean(dns.enabled)} onChange={(enabled) => set('dns', { ...dns, enabled })} />
      {dns.enabled && (
        <>
          {records.map((r, i) => (
            <div key={i} className="field-row">
              <Input label={`Nom ${i + 1}`} placeholder="www.exemple.lan" value={r.name ?? ''} invalid={r.name && !isHostname(r.name)}
                onChange={(e) => patchRecord(i, { name: e.target.value.trim() })} />
              <Input label="Adresse (A ou AAAA)" placeholder="192.168.1.10 ou 2001:db8::10" value={r.ip ?? ''} invalid={r.ip && !isValidIp(r.ip) && !isValidIp6(r.ip)}
                onChange={(e) => patchRecord(i, { ip: e.target.value.trim() })} />
              <button type="button" className="ghost small" aria-label={`Retirer ${r.name || `l'enregistrement ${i + 1}`}`}
                onClick={() => set('dns', { ...dns, records: records.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button type="button" className="ghost small" onClick={() => set('dns', { ...dns, records: [...records, { name: '', ip: '' }] })}>
            Ajouter un enregistrement
          </button>
        </>
      )}

      <Toggle label="Serveur web (TCP 80)" checked={Boolean(http.enabled)} onChange={(enabled) => set('http', { ...http, enabled })} />
      {http.enabled && (
        <>
          <Input label="Titre de la page" placeholder="Intranet" value={http.title ?? ''} onChange={(e) => set('http', { ...http, title: e.target.value })} />
          <Input label="Contenu" placeholder="Bienvenue sur le serveur web." value={http.body ?? ''} onChange={(e) => set('http', { ...http, body: e.target.value })} />
        </>
      )}
      <p className="hint">Teste depuis un PC : nslookup &lt;nom&gt;, curl http://&lt;nom&gt; ou ping &lt;nom&gt;.</p>
    </details>
  );
}

// DNS d'un routeur ou d'un switch niveau 3 : ip name-server, ip dns server, ip host (Cisco) ;
// /ip dns set servers= allow-remote-requests=, /ip dns static (MikroTik)
export function RouterDnsForm({ node, update }) {
  const d = node.data;
  const mk = isMikrotik({ type: node.type, model: d.model });
  const hosts = d.hosts ?? [];
  const set = (key, value) => update((x) => {
    const { [key]: _, ...rest } = x;
    return value === undefined || value === '' || value === false || (Array.isArray(value) && !value.length) ? rest : { ...rest, [key]: value };
  });
  const patchHost = (i, patch) => set('hosts', hosts.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const on = Boolean(d.nameServer || d.dnsServer || hosts.length);
  return (
    <details className="proto" open={on}>
      <summary>DNS {d.dnsServer && <span className="badge-on">serveur</span>}</summary>
      <Input label={mk ? 'Serveur DNS (servers=)' : 'Serveur DNS (ip name-server)'} placeholder="8.8.8.8" inputMode="decimal"
        value={d.nameServer ?? ''} invalid={d.nameServer && !isValidIp(d.nameServer)} onChange={(e) => set('nameServer', e.target.value.trim())} />
      <Toggle label={mk ? 'Répondre aux PC (allow-remote-requests=yes)' : 'Répondre aux PC (ip dns server)'} checked={Boolean(d.dnsServer)}
        onChange={(v) => set('dnsServer', v)} />
      {hosts.map((h, i) => (
        <div key={i} className="field-row">
          <Input label={`Nom ${i + 1}`} placeholder="imprimante.lan" value={h.name ?? ''} invalid={h.name && !isHostname(h.name)}
            onChange={(e) => patchHost(i, { name: e.target.value.trim() })} />
          <Input label="Adresse" placeholder="192.168.1.50" inputMode="decimal" value={h.ip ?? ''} invalid={h.ip && !isValidIp(h.ip)}
            onChange={(e) => patchHost(i, { ip: e.target.value.trim() })} />
          <button type="button" className="ghost small" aria-label={`Retirer ${h.name || `l'entrée ${i + 1}`}`}
            onClick={() => set('hosts', hosts.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="ghost small" onClick={() => set('hosts', [...hosts, { name: '', ip: '' }])}>
        {mk ? 'Ajouter une entrée statique' : 'Ajouter une entrée ip host'}
      </button>
      <p className="hint">Le routeur répond avec ses entrées, et relaie les autres noms à son serveur DNS.</p>
    </details>
  );
}
