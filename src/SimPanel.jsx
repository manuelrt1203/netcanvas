import { useMemo } from 'react';
import { buildTopology, isHost } from './net/topology.js';

const CUSTOM = '__custom__';

// form/setForm viennent d'App : le choix source/destination survit au changement d'onglet
export default function SimPanel({ doc, form, setForm, result, playing, onRun, onReplay, onReset }) {
  const { sources, targets } = useMemo(() => {
    const topo = buildTopology(doc);
    const sources = doc.devices.filter((d) => isHost(d) || d.type === 'router');
    const targets = doc.devices.flatMap((d) =>
      topo.l3Ifaces(d.id).map((i) => ({ device: d.id, ip: i.ip, text: `${d.label}${d.type === 'router' ? ` ${i.name}` : ''} · ${i.ip}` })),
    );
    return { sources, targets };
  }, [doc]);

  const { source, target, custom } = form;
  const setSource = (v) => setForm((f) => ({ ...f, source: v }));
  const setTarget = (v) => setForm((f) => ({ ...f, target: v }));
  const setCustom = (v) => setForm((f) => ({ ...f, custom: v }));

  const src = sources.some((s) => s.id === source) ? source : sources[0]?.id ?? '';
  const tgt = target === CUSTOM || targets.some((t) => t.ip === target) ? target : targets.find((t) => t.device !== src)?.ip ?? CUSTOM;
  const dstIp = tgt === CUSTOM ? custom.trim() : tgt;

  const phases = [
    ['request', 'Echo request'],
    ['reply', 'Echo reply'],
  ];

  return (
    <>
      <h2>Simuler un ping</h2>
      <p className="hint">Le paquet ICMP suit les masques, passerelles, VLAN et routes que tu as configurés.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onRun(src, dstIp);
        }}
      >
        <div className="field">
          <label htmlFor="sim-src">Depuis</label>
          <select id="sim-src" value={src} onChange={(e) => setSource(e.target.value)}>
            {!sources.length && <option value="">Aucun PC, serveur ou routeur</option>}
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sim-dst">Vers</label>
          <select id="sim-dst" value={tgt} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={`${t.ip}-${t.text}`} value={t.ip}>{t.text}</option>
            ))}
            <option value={CUSTOM}>Autre adresse…</option>
          </select>
        </div>
        {tgt === CUSTOM && (
          <div className="field">
            <label htmlFor="sim-ip">Adresse IP de destination</label>
            <input id="sim-ip" placeholder="8.8.8.8" inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value)} />
          </div>
        )}
        <div className="row">
          <button type="submit" disabled={!src || !dstIp || playing}>{playing ? 'Simulation…' : 'Lancer le ping'}</button>
          <button type="button" className="ghost" disabled={!src || !dstIp || playing} onClick={() => onRun(src, dstIp, 'trace')}>Traceroute</button>
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
            {result.ok ? 'Ping réussi' : 'Échec du ping'}
          </p>
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
          {phases.map(([phase, title]) => {
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
