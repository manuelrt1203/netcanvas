// Import d'une configuration texte : « show running-config » Cisco ou FRR, « /export » MikroTik, config d'un PC
// (VPCS, ipconfig, Linux). Une config d'une autre marque est traduite (OSPF, BGP, RIP, routes… sont communs).
// Aperçu de ce qui est repris et de ce qui est ignoré, puis application à l'équipement.
import { useId, useMemo, useRef, useState } from 'react';
import { analyzeInterfaces, importConfig, renameInterfaces } from './cli/import.js';
import { DIALECTS, defaultMapping, detectDialect, dialectOf, readForeign, sourceInterfaces, translateConfig, translatedSummary } from './cli/translate.js';
import { applyHostConfig, parseHostConfig } from './cli/host-import.js';
import { MODELS, devicePorts, isDataMedia, modelId } from './net/catalog.js';
import { HOST_TYPES } from './net/topology.js';

const blankConfig = (dev) => (dev.type === 'switch' ? { ports: [] } : { interfaces: [], routes: [] });
const PLACEHOLDER = {
  ios: 'hostname R1\n!\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\n!\nrouter ospf 1\n network 192.168.1.0 0.0.0.255 area 0',
  frr: 'hostname R1\n!\ninterface eth0\n ip address 192.168.1.1/24\n!\nrouter ospf\n network 192.168.1.0/24 area 0',
  routeros7: '/ip address\nadd address=192.168.1.1/24 interface=ether2\n/routing ospf interface-template\nadd area=backbone-v2 networks=192.168.1.0/24',
  routeros6: '/ip address\nadd address=192.168.1.1/24 interface=ether2\n/routing ospf network\nadd area=backbone network=192.168.1.0/24',
  host: 'VPCS :  ip 192.168.1.10/24 192.168.1.1\nWindows : sortie de ipconfig /all\nLinux : sortie de ip a et ip route',
};

// Liste « interface d'origine -> port de l'équipement »
function Mapping({ names, mapping, ports, onChange }) {
  return (
    <ul className="import-mapping">
      {names.map((n) => (
        <li key={n}>
          <code>{n}</code> →{' '}
          <select value={mapping[n] ?? ''} aria-label={`Port pour ${n}`} onChange={(e) => onChange(n, e.target.value)}>
            <option value="">(ignorer)</option>
            {ports.map((p) => <option key={p.name} value={p.name}>{p.name}{p.cabled ? ' (câblé)' : ''}</option>)}
          </select>
        </li>
      ))}
    </ul>
  );
}

export default function ConfigImport({ device, doc, onApply }) {
  const dialog = useRef(null);
  const textId = useId();
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(true);
  // Interfaces d'un autre modèle (ex. c3640 de GNS3 en FastEthernet) : changer de modèle, renommer, ou tel quel
  const [ports, setPorts] = useState({ choice: null, model: null, mapping: {} });
  const host = HOST_TYPES.has(device.type);
  const own = host ? 'host' : dialectOf(device);

  // Marque de la config collée : différente de celle de l'équipement -> traduction (routeurs)
  const dialect = useMemo(() => (host || !text.trim() ? null : detectDialect(text)), [text, host]);
  const foreign = Boolean(dialect && dialect !== own);
  const source = useMemo(() => {
    if (!foreign || device.type !== 'router') return null;
    try {
      return readForeign(text, dialect);
    } catch (err) {
      return { error: err.message };
    }
  }, [foreign, text, dialect, device.type]);

  const cabled = useMemo(() => doc.links.flatMap((l) => [
    ...(l.source === device.id ? [l.sourceIface] : []), ...(l.target === device.id ? [l.targetIface] : []),
  ]).filter(Boolean), [doc.links, device.id]);
  const ownPorts = devicePorts(modelId(device), device.modules).filter((p) => isDataMedia(p.media)).map((p) => ({ ...p, cabled: cabled.includes(p.name) }));

  // Même marque, autre modèle : ports absents
  const analysis = useMemo(() => (text.trim() && !foreign && !host ? analyzeInterfaces(device, text) : null), [text, device, foreign, host]);
  const models = (analysis?.models ?? []).map((m) => {
    const have = new Set(devicePorts(m.id, m.modules).filter((p) => isDataMedia(p.media)).map((p) => p.name));
    return { ...m, lost: cabled.filter((n) => !have.has(n)) };
  });
  const usable = models.filter((m) => !m.lost.length);
  // Par défaut : le modèle compatible s'il y en a un, sinon tel quel (pas de renommage silencieux)
  const choice = !analysis?.missing.length ? 'keep' : ports.choice ?? (usable.length ? 'model' : 'keep');
  const target = usable.find((m) => m.id === ports.model) ?? usable[0];
  const autoMapping = useMemo(() => (source?.device ? defaultMapping(source.device, device, doc) : analysis?.mapping ?? {}), [source, device, doc, analysis]);
  const mapping = { ...autoMapping, ...ports.mapping };
  const setMapping = (n, v) => setPorts((p) => ({ ...p, mapping: { ...p.mapping, [n]: v } }));

  const preview = useMemo(() => {
    if (!text.trim()) return null;
    if (host) {
      const parsed = parseHostConfig(text);
      if (!parsed.format) return { error: 'Format non reconnu : colle des commandes VPCS (ip …), la sortie de ipconfig (Windows) ou de ip a / ip route (Linux).' };
      return { kind: 'host', parsed, device: applyHostConfig(device, parsed, { replace }), applied: parsed.used.length };
    }
    if (foreign) {
      if (device.type !== 'router') return { error: `Config ${DIALECTS[dialect]} : elle s'importe dans un routeur, pas dans un switch.` };
      if (source?.error) return { error: source.error };
      const t = translateConfig(source.device, device, doc, mapping, { replace });
      const summary = translatedSummary(t.device.config);
      return { kind: 'translate', ...t, summary, ignored: source.ignored, applied: summary.length };
    }
    let base = replace ? { ...device, config: blankConfig(device) } : device;
    let src = text;
    if (choice === 'model' && target) base = { ...base, model: target.id, modules: target.modules };
    if (choice === 'rename') src = renameInterfaces(text, mapping);
    const baseDoc = { ...doc, devices: doc.devices.map((d) => (d.id === device.id ? base : d)) };
    try {
      return { kind: 'lines', ...importConfig(base, baseDoc, src) };
    } catch (err) {
      return { error: err.message };
    }
  }, [text, replace, device, doc, choice, target?.id, JSON.stringify(mapping), host, foreign, source, dialect]);

  const loadFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) setText(await file.text());
  };
  const reset = () => { setText(''); setPorts({ choice: null, model: null, mapping: {} }); };

  return (
    <>
      <button type="button" className="ghost small" onClick={() => dialog.current?.showModal()}>Importer une config…</button>
      <dialog ref={dialog} className="help-dialog import-dialog" aria-labelledby={`${textId}-title`}>
        <h2 id={`${textId}-title`}>Importer une configuration dans {device.label}</h2>
        <p className="hint">
          {host
            ? 'Colle la config du PC : commandes VPCS de GNS3 ou « show ip », sortie de « ipconfig /all » (Windows), ou de « ip a » et « ip route » (Linux, ainsi que /etc/network/interfaces ou netplan).'
            : <>Colle un « show running-config » (Cisco, FRR) ou un « /export » (MikroTik), ou choisis un fichier. Une config d'une autre marque est traduite pour ce {MODELS[modelId(device)].label} : routes, OSPF, RIP, BGP (eBGP, iBGP), IPv6.</>}
        </p>
        <div className="field">
          <label htmlFor={textId}>Configuration</label>
          <textarea id={textId} className="rules import-text" rows={12} spellCheck="false" value={text}
            placeholder={PLACEHOLDER[own]} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="row">
          <label className="file-btn ghost small">
            Choisir un fichier
            <input type="file" accept=".txt,.cfg,.conf,.rsc,.ios,.vpc,.yaml,.yml,text/plain" onChange={loadFile} />
          </label>
          <label className="check">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Remplacer la config actuelle (sinon, ajouter à celle-ci)
          </label>
        </div>

        {foreign && source?.device && device.type === 'router' && (
          <fieldset className="import-ports">
            <legend>Config {DIALECTS[dialect]} traduite pour {DIALECTS[own]}</legend>
            <p className="hint">Port de {device.label} pour chaque interface de la config d'origine :</p>
            <Mapping names={sourceInterfaces(source.device).map((i) => i.name)} mapping={mapping} ports={ownPorts} onChange={setMapping} />
          </fieldset>
        )}

        {analysis?.missing.length > 0 && (
          <fieldset className="import-ports">
            <legend>
              Interfaces absentes du {MODELS[modelId(device)].label} : {analysis.missing.join(', ')}
            </legend>
            <label className="check">
              <input type="radio" name={`${textId}-ports`} checked={choice === 'model'} disabled={!usable.length}
                onChange={() => setPorts((p) => ({ ...p, choice: 'model' }))} />
              Passer l'équipement en
              <select value={target?.id ?? ''} disabled={!usable.length} aria-label="Modèle compatible"
                onChange={(e) => setPorts((p) => ({ ...p, choice: 'model', model: e.target.value }))}>
                {usable.length ? usable.map((m) => <option key={m.id} value={m.id}>{m.label}{Object.keys(m.modules).length ? ` (${Object.values(m.modules).join(', ')})` : ''}</option>)
                  : <option value="">aucun modèle compatible</option>}
              </select>
            </label>
            {models.length > usable.length && (
              <p className="hint">
                {models.filter((m) => m.lost.length).map((m) => `${m.label} : ${m.lost.join(', ')} câblé${m.lost.length > 1 ? 's' : ''} n'existerai${m.lost.length > 1 ? 'ent' : 't'} plus`).join(' ; ')}.
              </p>
            )}
            <label className="check">
              <input type="radio" name={`${textId}-ports`} checked={choice === 'rename'}
                onChange={() => setPorts((p) => ({ ...p, choice: 'rename' }))} />
              Garder le {MODELS[modelId(device)].short} et renommer les interfaces
            </label>
            {choice === 'rename' && <Mapping names={analysis.missing} mapping={mapping} ports={ownPorts} onChange={setMapping} />}
            <label className="check">
              <input type="radio" name={`${textId}-ports`} checked={choice === 'keep'}
                onChange={() => setPorts((p) => ({ ...p, choice: 'keep' }))} />
              Importer tel quel (ces interfaces seront ignorées)
            </label>
          </fieldset>
        )}

        {preview?.error && <p className="field-error">{preview.error}</p>}
        {preview?.kind === 'lines' && (
          <div className="import-report" aria-live="polite">
            <p className={preview.ignored.length ? 'hint' : 'ok-text'}>
              {preview.applied} ligne{preview.applied > 1 ? 's' : ''} appliquée{preview.applied > 1 ? 's' : ''}
              {preview.ignored.length ? `, ${preview.ignored.length} ignorée${preview.ignored.length > 1 ? 's' : ''} :` : ', aucune ignorée.'}
            </p>
            {preview.ignored.length > 0 && (
              <ul className="import-ignored">
                {preview.ignored.map((x) => (
                  <li key={x.n}><span className="muted">ligne {x.n}</span> <code>{x.text}</code> <span className="field-error">{x.reason}</span></li>
                ))}
              </ul>
            )}
          </div>
        )}
        {preview?.kind === 'translate' && (
          <div className="import-report" aria-live="polite">
            <p className={preview.summary.length ? 'ok-text' : 'hint'}>
              {preview.summary.length ? `Repris : ${preview.summary.join(', ')}.` : 'Rien à reprendre pour l\'instant.'}
            </p>
            {(preview.warnings.length > 0 || preview.ignored.length > 0) && (
              <ul className="import-ignored">
                {preview.warnings.map((w) => <li key={w}><span className="field-error">{w}</span></li>)}
                {preview.ignored.map((x) => (
                  <li key={`l${x.n}`}><span className="muted">ligne {x.n}</span> <code>{x.text}</code> <span className="field-error">{x.reason}</span></li>
                ))}
              </ul>
            )}
          </div>
        )}
        {preview?.kind === 'host' && (
          <div className="import-report" aria-live="polite">
            <p className={preview.applied ? 'ok-text' : 'hint'}>
              {preview.parsed.formatLabel} : {preview.applied ? preview.parsed.used.map((u) => u.what).join(', ') : 'aucune adresse trouvée'}.
            </p>
            {(preview.parsed.warnings.length > 0 || preview.parsed.ignored.length > 0) && (
              <ul className="import-ignored">
                {preview.parsed.warnings.map((w) => <li key={w}><span className="field-error">{w}</span></li>)}
                {preview.parsed.ignored.map((x) => (
                  <li key={x.n}><span className="muted">ligne {x.n}</span> <code>{x.text}</code> <span className="field-error">{x.reason}</span></li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="row">
          <button type="button" disabled={!preview || preview.error || !preview.applied}
            onClick={() => { onApply(preview.device); reset(); dialog.current?.close(); }}>
            Appliquer
          </button>
          <button type="button" className="ghost" onClick={() => dialog.current?.close()}>Annuler</button>
        </div>
      </dialog>
    </>
  );
}
