// Import d'une configuration texte (« show running-config » Cisco, « /export » MikroTik) :
// aperçu des lignes appliquées et ignorées, puis application à l'équipement.
import { useId, useMemo, useRef, useState } from 'react';
import { analyzeInterfaces, importConfig, renameInterfaces } from './cli/import.js';
import { MODELS, devicePorts, isDataMedia, isMikrotik, modelId } from './net/catalog.js';

const blankConfig = (dev) => (dev.type === 'switch' ? { ports: [] } : { interfaces: [], routes: [] });

export default function ConfigImport({ device, doc, onApply }) {
  const dialog = useRef(null);
  const textId = useId();
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(true);
  // Interfaces d'un autre modèle (ex. c3640 de GNS3 en FastEthernet) : changer de modèle, renommer, ou tel quel
  const [ports, setPorts] = useState({ choice: null, model: null, mapping: {} });
  const mk = isMikrotik(device);
  const analysis = useMemo(() => (text.trim() && !mk ? analyzeInterfaces(device, text) : null), [text, device, mk]);
  // Ports câblés de l'équipement : un modèle qui ne les a pas ne convient pas
  const cabled = useMemo(() => doc.links.flatMap((l) => [
    ...(l.source === device.id ? [l.sourceIface] : []), ...(l.target === device.id ? [l.targetIface] : []),
  ]).filter(Boolean), [doc.links, device.id]);
  const models = (analysis?.models ?? []).map((m) => {
    const have = new Set(devicePorts(m.id, m.modules).filter((p) => isDataMedia(p.media)).map((p) => p.name));
    return { ...m, lost: cabled.filter((n) => !have.has(n)) };
  });
  const usable = models.filter((m) => !m.lost.length);
  const choice = !analysis?.missing.length ? 'keep' : ports.choice ?? (usable.length ? 'model' : 'rename');
  const target = usable.find((m) => m.id === ports.model) ?? usable[0];
  const mapping = { ...analysis?.mapping, ...ports.mapping };
  const ownPorts = devicePorts(modelId(device), device.modules).filter((p) => isDataMedia(p.media));

  const preview = useMemo(() => {
    if (!text.trim()) return null;
    let base = replace ? { ...device, config: blankConfig(device) } : device;
    let source = text;
    if (choice === 'model' && target) base = { ...base, model: target.id, modules: target.modules };
    if (choice === 'rename') source = renameInterfaces(text, mapping);
    const baseDoc = { ...doc, devices: doc.devices.map((d) => (d.id === device.id ? base : d)) };
    try {
      return importConfig(base, baseDoc, source);
    } catch (err) {
      return { error: err.message };
    }
  }, [text, replace, device, doc, choice, target?.id, JSON.stringify(mapping)]);

  const loadFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) setText(await file.text());
  };

  return (
    <>
      <button type="button" className="ghost small" onClick={() => dialog.current?.showModal()}>Importer une config…</button>
      <dialog ref={dialog} className="help-dialog import-dialog" aria-labelledby={`${textId}-title`}>
        <h2 id={`${textId}-title`}>Importer une configuration dans {device.label}</h2>
        <p className="hint">
          Colle {mk ? 'la sortie de « /export » d\'un routeur MikroTik' : 'la sortie de « show running-config » d\'un routeur ou switch Cisco'}, ou choisis un fichier.
          Chaque ligne passe par le terminal simulé, avec les mêmes contrôles que si tu la tapais.
        </p>
        <div className="field">
          <label htmlFor={textId}>Configuration</label>
          <textarea id={textId} className="rules import-text" rows={12} spellCheck="false" value={text}
            placeholder={mk ? '/ip address\nadd address=192.168.1.1/24 interface=ether2' : 'hostname R1\n!\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown'}
            onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="row">
          <label className="file-btn ghost small">
            Choisir un fichier
            <input type="file" accept=".txt,.cfg,.conf,.rsc,.ios,text/plain" onChange={loadFile} />
          </label>
          <label className="check">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Remplacer la config actuelle (sinon, ajouter à celle-ci)
          </label>
        </div>
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
            {choice === 'rename' && (
              <ul className="import-mapping">
                {analysis.missing.map((n) => (
                  <li key={n}>
                    <code>{n}</code> →{' '}
                    <select value={mapping[n] ?? ''} aria-label={`Nouveau nom de ${n}`}
                      onChange={(e) => setPorts((p) => ({ ...p, mapping: { ...p.mapping, [n]: e.target.value } }))}>
                      <option value="">(ignorer)</option>
                      {ownPorts.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </select>
                  </li>
                ))}
              </ul>
            )}
            <label className="check">
              <input type="radio" name={`${textId}-ports`} checked={choice === 'keep'}
                onChange={() => setPorts((p) => ({ ...p, choice: 'keep' }))} />
              Importer tel quel (ces interfaces seront ignorées)
            </label>
          </fieldset>
        )}
        {preview?.error && <p className="field-error">{preview.error}</p>}
        {preview && !preview.error && (
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
        <div className="row">
          <button type="button" disabled={!preview || preview.error || !preview.applied}
            onClick={() => { onApply(preview.device); setText(''); setPorts({ choice: null, model: null, mapping: {} }); dialog.current?.close(); }}>
            Appliquer
          </button>
          <button type="button" className="ghost" onClick={() => dialog.current?.close()}>Annuler</button>
        </div>
      </dialog>
    </>
  );
}
