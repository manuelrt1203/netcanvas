// Historique d'un schéma partagé (éditeurs) : versions archivées automatiquement (au plus une toutes les 10 min,
// avant une modification) ou nommées à la main ; restaurer remplace le schéma, l'état actuel est archivé avant.
import { useEffect, useId, useState } from 'react';
import { listVersions, loadVersion, snapshotShared } from './share.js';

export default function VersionsPanel({ id, token, onRestore }) {
  const [list, setList] = useState(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState(null);
  const labelId = useId();
  const refresh = () => listVersions(id, token).then(setList).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, [id, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const snapshot = async (e) => {
    e.preventDefault();
    try {
      await snapshotShared(id, token, label);
      setLabel('');
      refresh();
    } catch (err) {
      setError(err.message);
    }
  };
  const restore = async (v) => {
    if (!confirm(`Revenir à la version du ${new Date(v.created_at).toLocaleString('fr-FR')} ? L'état actuel est gardé dans l'historique.`)) return;
    try {
      await snapshotShared(id, token, 'avant restauration');
      const row = await loadVersion(id, token, v.version_id);
      if (row) onRestore(row.doc);
      refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="versions">
      <h3>Historique des versions</h3>
      <form className="copy-row" onSubmit={snapshot}>
        <label className="visually-hidden" htmlFor={labelId}>Nom de la version</label>
        <input id={labelId} placeholder="Nom de la version (ex. avant le TP 2)" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" className="ghost small-btn">Créer une version</button>
      </form>
      {error && <p className="field-error">{error}</p>}
      {!list ? <p className="hint">Chargement…</p> : !list.length ? (
        <p className="hint">Pas encore de version : elles sont créées automatiquement pendant que tu modifies le schéma (au plus une toutes les 10 minutes).</p>
      ) : (
        <ul className="version-list">
          {list.map((v) => (
            <li key={v.version_id}>
              <span>
                {new Date(v.created_at).toLocaleString('fr-FR')}
                {v.label && <strong> · {v.label}</strong>}
                <span className="muted"> · {v.name}, {v.devices} équipement{v.devices > 1 ? 's' : ''}</span>
              </span>
              <button type="button" className="ghost small-btn" onClick={() => restore(v)}>Restaurer</button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">50 versions gardées au plus.</p>
    </section>
  );
}
