// Séance de TP en direct : lancement (prof, depuis un TP), entrée et bandeau (étudiant), suivi en direct (prof).
// Seule la progression des objectifs voyage : le prof ne voit jamais le schéma de l'étudiant.
import { useEffect, useId, useState } from 'react';
import { deleteLive, forgetLive, liveLinks, liveState, setLiveClosed } from './share.js';

function CopyRow({ label, value }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="copy-row">
        <input id={id} readOnly value={value} onFocus={(e) => e.target.select()} />
        <button type="button" className="ghost small-btn" onClick={() => navigator.clipboard?.writeText(value)}>Copier</button>
      </div>
    </div>
  );
}

// Prof : lance la séance à partir du TP ouvert (sujet figé)
export function LiveCreateForm({ defaultTitle, onCreate, onOpenDashboard }) {
  const [title, setTitle] = useState(defaultTitle || 'Séance de TP');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState(null);
  const id = useId();
  if (created) {
    const links = liveLinks(created.id, created.token);
    return (
      <div className="exam-created">
        <p className="ok-text">Séance lancée pour 24 h. Le sujet est figé : modifier le schéma maintenant ne change plus la séance.</p>
        <CopyRow label="Lien pour les étudiants" value={links.student} />
        <CopyRow label="Lien de suivi (garde-le pour toi)" value={liveLinks(created.id, created.token).admin} />
        <button type="button" onClick={() => onOpenDashboard(created.id, created.token)}>Ouvrir le suivi en direct</button>
      </div>
    );
  }
  return (
    <form className="exam-create" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        setCreated(await onCreate({ title: title.trim() || 'Séance de TP' }));
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    }}>
      <h3>Lancer une séance en direct</h3>
      <p className="hint">Les étudiants ouvrent le lien, saisissent leur nom et travaillent sur ce TP : tu vois leur progression objectif par objectif, sans leur schéma. Sans note ni chrono.</p>
      <div className="field">
        <label htmlFor={id}>Titre de la séance</label>
        <input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {error && <p className="field-error">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Lancement…' : 'Lancer la séance'}</button>
    </form>
  );
}

// Étudiant : saisie du nom avant de rejoindre
export function LiveStart({ live, onStart, error }) {
  const [name, setName] = useState('');
  const id = useId();
  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="live-start-title">
      <form className="welcome-card exam-start" onSubmit={(e) => { e.preventDefault(); onStart(name.trim()); }}>
        <h1 id="live-start-title">{live.title}</h1>
        {live.closed ? <p className="field-error">Cette séance est close.</p> : (
          <>
            <p>Séance de TP en direct : ton enseignant voit quels objectifs tu as atteints (pas ton schéma). Aucune note, aucun chrono.</p>
            <div className="field">
              <label htmlFor={id}>Ton nom et prénom</label>
              <input id={id} required minLength={2} maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {error && <p className="field-error">{error}</p>}
            <button type="submit" disabled={name.trim().length < 2}>Rejoindre la séance</button>
          </>
        )}
      </form>
    </div>
  );
}

// Étudiant : bandeau pendant la séance
export function LiveBanner({ live, score, total, state }) {
  return (
    <div className="exam-banner" role="status">
      <strong>{live.title}</strong>
      <span className="muted">{live.student}</span>
      <span>{total ? `${score}/${total} objectifs` : 'Séance en direct'}</span>
      {state === 'error' && <span className="field-error">Connexion perdue : ta progression sera renvoyée dès que possible.</span>}
    </div>
  );
}

const ago = (iso, now) => {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 10) return 'à l\'instant';
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  return `il y a ${Math.round(s / 3600)} h`;
};

// Prof : suivi en direct (actualisé toutes les 5 s)
export function LiveDashboard({ id, token, onClose }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0); // écart entre l'horloge du poste et celle du serveur
  const refresh = () => liveState(id, token)
    .then((s) => {
      if (!s) throw new Error('séance introuvable');
      setOffset(new Date(s.serverNow).getTime() - Date.now());
      setState(s);
      setError(null);
    })
    .catch((err) => setError(err.message));
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [id, token]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  if (error && !state) return <div className="welcome"><div className="welcome-card"><p className="field-error">Suivi de la séance : {error}</p></div></div>;
  if (!state) return <div className="welcome"><div className="welcome-card"><p className="hint">Chargement du suivi…</p></div></div>;
  const now = Date.now() + offset;
  const students = state.students;
  const finished = students.filter((s) => s.total > 0 && s.score === s.total).length;
  const labels = students.find((s) => s.progress.length)?.progress.map((p) => p.text) ?? [];
  // Objectif le moins réussi : à reprendre au tableau
  const hardest = labels
    .map((text, i) => ({ text, ok: students.filter((s) => s.progress[i]?.ok).length }))
    .sort((a, b) => a.ok - b.ok)[0];
  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="live-dash-title">
      <div className="welcome-card exam-dashboard">
        <div className="welcome-head">
          <div>
            <h1 id="live-dash-title">{state.title}</h1>
            <p className="muted">
              {state.closed ? <strong>séance close</strong> : 'séance ouverte'} · {students.length} étudiant{students.length > 1 ? 's' : ''} connecté{students.length > 1 ? 's' : ''}
              {students.length ? ` · ${finished} ont tout réussi` : ''} · expire le {new Date(state.expiresAt).toLocaleString('fr-FR')}
            </p>
          </div>
          {onClose && <button type="button" className="ghost icon welcome-close" onClick={() => onClose(false)} aria-label="Fermer le suivi">✕</button>}
        </div>
        <CopyRow label="Lien pour les étudiants" value={liveLinks(id, null).student} />
        <div className="row">
          <button type="button" className="ghost small-btn" onClick={refresh}>Actualiser</button>
          <button type="button" className="ghost small-btn" onClick={async () => {
            if (!state.closed && !confirm('Clore la séance ? Plus personne ne pourra la rejoindre et la progression ne sera plus transmise.')) return;
            await setLiveClosed(id, token, !state.closed).catch((e) => setError(e.message));
            refresh();
          }}>{state.closed ? 'Rouvrir la séance' : 'Clore la séance'}</button>
          <button type="button" className="ghost small-btn danger-text" onClick={async () => {
            if (!confirm('Supprimer la séance et la progression des étudiants ? C\'est irréversible.')) return;
            try {
              await deleteLive(id, token);
              forgetLive(id);
              onClose?.(true);
            } catch (e) { setError(e.message); }
          }}>Supprimer la séance</button>
        </div>
        {error && <p className="field-error">{error}</p>}
        {!students.length ? <p className="hint">Personne n'a encore rejoint la séance. Envoie le lien aux étudiants.</p> : (
          <>
            {hardest && students.length > 1 && hardest.ok < students.length && (
              <p className="hint">Objectif le moins réussi : « {hardest.text} » ({hardest.ok}/{students.length}).</p>
            )}
            <table className="exam-table live-table">
              <thead>
                <tr>
                  <th>Étudiant</th><th>Avancement</th>
                  {labels.map((text, i) => <th key={i} title={text} className="live-obj">O{i + 1}</th>)}
                  <th>Activité</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => {
                  const idle = now - new Date(s.updatedAt).getTime() > 120000;
                  return (
                    <tr key={s.student + s.joinedAt} className={idle ? 'late' : ''}>
                      <td>{s.student}</td>
                      <td>
                        <progress max={s.total || 1} value={s.score} aria-label={`${s.student} : ${s.score} objectifs sur ${s.total}`} />{' '}
                        {s.total ? `${s.score}/${s.total}` : '–'}
                      </td>
                      {labels.map((text, i) => (
                        <td key={i} title={text} aria-label={`${text} : ${s.progress[i]?.ok ? 'atteint' : 'pas atteint'}`}>
                          {s.progress[i] ? (s.progress[i].ok ? '✓' : '✗') : '–'}
                        </td>
                      ))}
                      <td title={new Date(s.updatedAt).toLocaleString('fr-FR')}>{ago(s.updatedAt, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
        <p className="hint">Actualisation automatique toutes les 5 secondes. En orange : sans activité depuis plus de 2 minutes. Survole « O1, O2… » pour lire l'objectif.</p>
      </div>
    </div>
  );
}
