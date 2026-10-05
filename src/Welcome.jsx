// Écran d'accueil : nouveau projet, ouvrir un fichier, reprendre le brouillon ou un fichier récent, exemples.
import { DEMOS } from './examples.js';

export default function Welcome({ version, draft, recents = [], onNew, onOpen, onResume, onRecent, onExample, onClose, notice = null, user, onAccount }) {
  const groups = [['Exemples', DEMOS.filter((d) => d.kind !== 'tp')], ['TP (exercices corrigés en direct)', DEMOS.filter((d) => d.kind === 'tp')]];
  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="welcome-card">
        <header className="welcome-head">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" />
            <path d="M7.5 6h9M6.3 8.2l4.4 7.6M17.7 8.2l-4.4 7.6" />
          </svg>
          <div>
            <h1 id="welcome-title">NetCanvas</h1>
            <p className="muted">Schémas réseau, configuration Cisco et MikroTik, simulation expliquée. {version && <span>Version {version}</span>}</p>
          </div>
          {onClose && <button type="button" className="ghost icon welcome-close" onClick={onClose} aria-label="Fermer l'accueil">✕</button>}
        </header>
        {notice}

        <div className="welcome-actions">
          <button type="button" onClick={onNew}>Nouveau projet</button>
          <button type="button" className="ghost" onClick={onOpen}>Ouvrir un fichier…</button>
          {user !== undefined && (
            <button type="button" className="ghost" onClick={onAccount}>{user ? 'Mes schémas en ligne' : 'Se connecter'}</button>
          )}
          {draft && (
            <button type="button" className="ghost" onClick={onResume}>
              {draft.recover ? 'Récupérer le brouillon non enregistré' : 'Reprendre'} « {draft.name} » ({draft.count} équipement{draft.count > 1 ? 's' : ''})
            </button>
          )}
        </div>

        {recents.length > 0 && (
          <section>
            <h2>Récents</h2>
            <ul className="welcome-recents">
              {recents.map((r) => (
                <li key={r.path}>
                  <button type="button" className="link" onClick={() => onRecent(r)} title={r.path}>{r.name}</button>
                  <span className="muted"> {r.path.replace(/[\\/][^\\/]*$/, '')}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {groups.map(([title, list]) => (
          <section key={title}>
            <h2>{title}</h2>
            <div className="welcome-examples">
              {list.map((d) => (
                <button key={d.id} type="button" className="example" onClick={() => onExample(d)}>
                  <strong>{d.label.replace(/^TP : /, '')}</strong>
                  <span>{d.about}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
