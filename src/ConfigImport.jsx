// Import d'une configuration texte (« show running-config » Cisco, « /export » MikroTik) :
// aperçu des lignes appliquées et ignorées, puis application à l'équipement.
import { useId, useMemo, useRef, useState } from 'react';
import { importConfig } from './cli/import.js';
import { isMikrotik } from './net/catalog.js';

const blankConfig = (dev) => (dev.type === 'switch' ? { ports: [] } : { interfaces: [], routes: [] });

export default function ConfigImport({ device, doc, onApply }) {
  const dialog = useRef(null);
  const textId = useId();
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(true);
  const mk = isMikrotik(device);

  const preview = useMemo(() => {
    if (!text.trim()) return null;
    const base = replace ? { ...device, config: blankConfig(device) } : device;
    const baseDoc = { ...doc, devices: doc.devices.map((d) => (d.id === device.id ? base : d)) };
    try {
      return importConfig(base, baseDoc, text);
    } catch (err) {
      return { error: err.message };
    }
  }, [text, replace, device, doc]);

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
            onClick={() => { onApply(preview.device); setText(''); dialog.current?.close(); }}>
            Appliquer
          </button>
          <button type="button" className="ghost" onClick={() => dialog.current?.close()}>Annuler</button>
        </div>
      </dialog>
    </>
  );
}
