import { useMemo } from 'react';
import { buildTopology, isHost } from './net/topology.js';

const CUSTOM = '__custom__';
const KINDS = {
  ping: { label: 'Ping (ICMP)', run: 'Lancer le ping', ok: () => 'Ping réussi', fail: 'Échec du ping' },
  dns: { label: 'Requête DNS (nslookup)', run: 'Résoudre le nom', ok: (s) => `${s.name} = ${s.ip}`, fail: 'Nom non résolu' },
  web: { label: 'Page web (HTTP)', run: 'Ouvrir la page', ok: (s) => `Page reçue de ${s.ip}`, fail: 'Page inaccessible' },
};
const KIND = { 'arp-request': 'ARP', 'arp-reply': 'ARP', 'nd-ns': 'NDP', 'nd-na': 'NDP', icmp: 'ICMP', udp: 'UDP', tcp: 'TCP', done: 'Fin', drop: 'Perdu' };

// Simulation pas à pas : liste des trames, en-têtes de la trame choisie, décisions de l'équipement
function Stepper({ frames, step, onStep, labels }) {
  const frame = frames[step];
  const label = (id) => labels.get(id) ?? id;
  const route = (f) => (f.hops.length ? `${label(f.hops[0].from)} → ${f.hops.length > 1 && f.kind === 'arp-request' ? 'diffusion' : f.hops.length > 1 && f.kind === 'nd-ns' ? 'multicast' : label(f.at)}` : label(f.at));
  return (
    <section className="stepper" aria-label="Simulation pas à pas (flèches gauche et droite)"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' && step < frames.length - 1) onStep(step + 1);
        else if (e.key === 'ArrowLeft' && step > 0) onStep(step - 1);
        else return;
        e.preventDefault();
      }}>
      <div className="stepper-bar">
        <button type="button" className="ghost small-btn" disabled={step === 0} onClick={() => onStep(step - 1)} aria-label="Trame précédente">◀</button>
        <span className="stepper-count">Trame {step + 1} / {frames.length}</span>
        <button type="button" className="ghost small-btn" disabled={step === frames.length - 1} onClick={() => onStep(step + 1)} aria-label="Trame suivante">▶</button>
      </div>
      <div className="frame-detail">
        <p className={`frame-summary kind-${frame.kind}`}><strong>{frame.summary}</strong>{frame.hops.length > 0 && <span className="muted"> · {route(frame)}</span>}</p>
        {frame.notes.length > 0 && (
          <ul className="frame-notes">
            {frame.notes.map((n, i) => <li key={i} className={`log-${n.level}`}>{n.text}</li>)}
          </ul>
        )}
        {frame.layers.map((l) => (
          <details key={l.name} className="layer" open>
            <summary>{l.name}</summary>
            <dl>
              {l.fields.map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd><code>{v}</code></dd></div>
              ))}
            </dl>
          </details>
        ))}
      </div>
      <ol className="frame-list">
        {frames.map((f, i) => (
          <li key={i}>
            <button type="button" className={`frame-row${i === step ? ' current' : ''}`} aria-current={i === step ? 'step' : undefined} onClick={() => onStep(i)}>
              <span className="frame-n">{i + 1}</span>
              <span className={`frame-kind kind-${f.kind} phase-${f.phase}`}>{KIND[f.kind]}</span>
              <span className="frame-route">{route(f)}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

// form/setForm viennent d'App : le choix source/destination survit au changement d'onglet
export default function SimPanel({ doc, form, setForm, result, playing, onRun, onReplay, onReset, step, onStep, labels }) {
  const { sources, targets } = useMemo(() => {
    const topo = buildTopology(doc);
    const sources = doc.devices.filter((d) => isHost(d) || d.type === 'router' || (d.type === 'switch' && topo.l3Ifaces(d.id).length));
    const text = (d, i, ip) => `${d.label}${d.type === 'router' ? ` ${i.name}` : ''} · ${ip}`;
    const targets = [
      ...doc.devices.flatMap((d) => topo.l3Ifaces(d.id).map((i) => ({ device: d.id, ip: i.ip, text: text(d, i, i.ip) }))),
      ...doc.devices.flatMap((d) => topo.l3Ifaces6(d.id).filter((i) => i.ip).map((i) => ({ device: d.id, ip: i.ip, text: text(d, i, i.ip), v6: true }))),
    ];
    return { sources, targets };
  }, [doc]);

  const { source, target, custom, kind = 'ping', name = '' } = form;
  const setSource = (v) => setForm((f) => ({ ...f, source: v }));
  const setTarget = (v) => setForm((f) => ({ ...f, target: v }));
  const setCustom = (v) => setForm((f) => ({ ...f, custom: v }));
  const setKind = (v) => setForm((f) => ({ ...f, kind: v }));
  const setName = (v) => setForm((f) => ({ ...f, name: v }));

  // Noms connus des serveurs DNS du schéma (suggestions)
  const names = useMemo(() => [...new Set(doc.devices.flatMap((d) => (d.config?.services?.dns?.records ?? []).map((r) => r.name).filter(Boolean)))], [doc]);

  const src = sources.some((s) => s.id === source) ? source : sources[0]?.id ?? '';
  const tgt = target === CUSTOM || targets.some((t) => t.ip === target) ? target : targets.find((t) => t.device !== src)?.ip ?? CUSTOM;
  const service = kind !== 'ping';
  const dstIp = service ? name.trim() : tgt === CUSTOM ? custom.trim() : tgt;
  const what = KINDS[result?.service?.kind ?? 'ping'];

  const phases = [
    ['dns', 'Résolution DNS'],
    ['request', result?.service ? 'Requête' : 'Echo request'],
    ['reply', result?.service ? 'Réponse' : 'Echo reply'],
  ];

  return (
    <>
      <h2>Simuler un échange</h2>
      <p className="hint">Le paquet suit les masques, passerelles, VLAN, routes, ACL et NAT que tu as configurés.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onRun(src, dstIp, service ? kind : 'ping');
        }}
      >
        <div className="field">
          <label htmlFor="sim-kind">Type</label>
          <select id="sim-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sim-src">Depuis</label>
          <select id="sim-src" value={src} onChange={(e) => setSource(e.target.value)}>
            {!sources.length && <option value="">Aucun PC, serveur ou routeur</option>}
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
        {service ? (
          <div className="field">
            <label htmlFor="sim-name">{kind === 'web' ? 'Adresse du site (nom ou IP)' : 'Nom à résoudre'}</label>
            <input id="sim-name" list="sim-names" placeholder="www.exemple.lan" spellCheck="false" autoCapitalize="none" value={name} onChange={(e) => setName(e.target.value)} />
            <datalist id="sim-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
          </div>
        ) : (<>
        <div className="field">
          <label htmlFor="sim-dst">Vers</label>
          <select id="sim-dst" value={tgt} onChange={(e) => setTarget(e.target.value)}>
            {targets.some((t) => t.v6) ? (
              <>
                <optgroup label="IPv4">{targets.filter((t) => !t.v6).map((t) => <option key={`${t.ip}-${t.text}`} value={t.ip}>{t.text}</option>)}</optgroup>
                <optgroup label="IPv6">{targets.filter((t) => t.v6).map((t) => <option key={`${t.ip}-${t.text}`} value={t.ip}>{t.text}</option>)}</optgroup>
              </>
            ) : targets.map((t) => (
              <option key={`${t.ip}-${t.text}`} value={t.ip}>{t.text}</option>
            ))}
            <option value={CUSTOM}>Autre adresse…</option>
          </select>
        </div>
        {tgt === CUSTOM && (
          <div className="field">
            <label htmlFor="sim-ip">Adresse IPv4 ou IPv6 de destination</label>
            <input id="sim-ip" placeholder="8.8.8.8 ou fe80::1" spellCheck="false" autoCapitalize="none" value={custom} onChange={(e) => setCustom(e.target.value)} />
          </div>
        )}
        </>)}
        <div className="row">
          <button type="submit" disabled={!src || !dstIp || playing}>{playing ? 'Simulation…' : KINDS[kind].run}</button>
          <button type="button" className="ghost" disabled={!src || !dstIp || playing} onClick={() => onRun(src, dstIp, service ? kind : 'ping', true)}>Pas à pas</button>
          {!service && <button type="button" className="ghost" disabled={!src || !dstIp || playing} onClick={() => onRun(src, dstIp, 'trace')}>Traceroute</button>}
          {result && (
            <>
              <button type="button" className="ghost" onClick={onReplay} disabled={playing}>Rejouer</button>
              <button type="button" className="ghost" onClick={onReset}>Effacer</button>
            </>
          )}
        </div>
      </form>

      {result && (
        <div className="sim-result" aria-live="polite">
          <p className={`sim-verdict ${result.ok ? 'ok' : 'fail'}`}>
            {result.ok ? what.ok(result.service) : what.fail}
          </p>
          {result.ok && result.service?.page && (
            <div className="web-page" aria-label="Page reçue">
              <p className="web-title">{result.service.page.title}</p>
              {result.service.page.body && <p>{result.service.page.body}</p>}
            </div>
          )}
          {result.trace && (
            <section>
              <h3>Traceroute</h3>
              <ol className="trace">
                {result.trace.hops.map((h) => (
                  <li key={h.ttl} className={h.ip ? '' : 'trace-lost'}>
                    <span className="trace-ttl">{h.ttl}</span>
                    <code>{h.ip ?? '*  *  *'}</code>
                    {h.device && <span className="muted"> {doc.devices.find((d) => d.id === h.device)?.label}</span>}
                  </li>
                ))}
              </ol>
              {result.trace.reason && <p className="field-error">{result.trace.reason}</p>}
            </section>
          )}
          {step != null && result.frames?.length > 0 && <Stepper frames={result.frames} step={step} onStep={onStep} labels={labels} />}
          {step == null && result.frames?.length > 0 && !playing && (
            <button type="button" className="ghost small-btn" onClick={() => onStep(0)}>Revoir trame par trame</button>
          )}
          {step == null && phases.map(([phase, title]) => {
            const entries = result.log.filter((l) => l.phase === phase);
            if (!entries.length) return null;
            return (
              <section key={phase}>
                <h3 className={`phase phase-${phase}`}>{title}</h3>
                <ol className="sim-log">
                  {entries.map((l, i) => (
                    <li key={i} className={`log-${l.level}`}>{l.text}</li>
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
