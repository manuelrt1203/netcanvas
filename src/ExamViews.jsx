// Mode examen : création (prof, depuis un TP), début de l'épreuve et chrono (étudiant), suivi des copies (prof).
import { useEffect, useId, useState } from 'react';
import { examAdmin, examLinks, listSubmissions, setExamClosed } from './share.js';
import { formatClock, gradeSubmission, gradesCsv } from './exam.js';

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

// Prof : réglages de l'examen, puis liens
export function ExamCreateForm({ defaultTitle, onCreate }) {
  const [title, setTitle] = useState(defaultTitle || 'Examen');
  const [duration, setDuration] = useState(60);
  const [hints, setHints] = useState(false);
  const [progress, setProgress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState(null);
  const ids = { title: useId(), duration: useId() };
  if (created) {
    const links = examLinks(created.id, created.token);
    return (
      <div className="exam-created">
        <p className="ok-text">Examen créé. Le sujet est figé : modifier le schéma maintenant ne change plus l'examen.</p>
        <CopyRow label="Lien pour les étudiants" value={links.student} />
        <CopyRow label="Lien de suivi (garde-le pour toi : il donne les copies)" value={links.admin} />
        <p className="hint">Le suivi est aussi gardé dans ce navigateur, et dans « Mon compte » si tu es connecté.</p>
      </div>
    );
  }
  return (
    <form className="exam-create" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        setCreated(await onCreate({ title, duration: Number(duration), hints, progress: progress || hints }));
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    }}>
      <h3>Créer un examen à partir de ce TP</h3>
      <div className="field-row">
        <div className="field">
          <label htmlFor={ids.title}>Titre</label>
          <input id={ids.title} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.duration}>Durée (minutes)</label>
          <input id={ids.duration} type="number" min="1" max="600" className="cidr" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </div>
      </div>
      <label className="check"><input type="checkbox" checked={progress || hints} disabled={hints} onChange={(e) => setProgress(e.target.checked)} /> L'étudiant voit quels objectifs sont atteints</label>
      <label className="check"><input type="checkbox" checked={hints} onChange={(e) => setHints(e.target.checked)} /> Indices autorisés (la progression est alors visible)</label>
      {error && <p className="field-error">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Création…' : 'Créer l\'examen'}</button>
      <p className="hint">Le schéma actuel (avec ses pannes) devient le sujet. Les notes sont calculées à partir des copies rendues.</p>
    </form>
  );
}

// Étudiant : nom avant de commencer
export function ExamStart({ exam, onStart, error }) {
  const [name, setName] = useState('');
  const id = useId();
  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="exam-start-title">
      <form className="welcome-card exam-start" onSubmit={(e) => { e.preventDefault(); onStart(name.trim()); }}>
        <h1 id="exam-start-title">{exam.title}</h1>
        {exam.closed ? <p className="field-error">Cet examen est clos : il n'accepte plus de copies.</p> : (
          <>
            <p>Durée : <strong>{exam.settings.duration} minutes</strong>, à partir du moment où tu commences.
              {exam.settings.hints ? ' Indices autorisés.' : ' Sans indices.'} Ta copie est rendue automatiquement à la fin du temps.</p>
            <div className="field">
              <label htmlFor={id}>Ton nom et prénom</label>
              <input id={id} required minLength={2} maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {error && <p className="field-error">{error}</p>}
            <button type="submit" disabled={name.trim().length < 2}>Commencer l'épreuve</button>
          </>
        )}
      </form>
    </div>
  );
}

// Étudiant : bandeau avec le temps restant et la remise
export function ExamBanner({ exam, remaining, submitted, submitting, error, onSubmit }) {
  return (
    <div className={`exam-banner${remaining !== null && remaining <= 300 && !submitted ? ' urgent' : ''}`} role="status">
      <strong>{exam.title}</strong>
      {submitted ? (
        <span className="ok-text">Copie rendue à {new Date(submitted).toLocaleTimeString('fr-FR')} : elle ne peut plus être modifiée.</span>
      ) : (
        <>
          <span className="exam-clock" aria-label="Temps restant">⏱ {formatClock(remaining ?? 0)}</span>
          <span className="muted">{exam.student}</span>
          <button type="button" className="small-btn" disabled={submitting} onClick={() => {
            if (confirm('Rendre ta copie maintenant ? Tu ne pourras plus la modifier.')) onSubmit();
          }}>{submitting ? 'Envoi…' : 'Rendre ma copie'}</button>
        </>
      )}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

// Prof : suivi des copies (actualisé toutes les 15 s), ouverture d'une copie, CSV, clôture
export function ExamDashboard({ id, token, onOpenCopy, onClose }) {
  const [exam, setExam] = useState(null);
  const [subs, setSubs] = useState(null);
  const [error, setError] = useState(null);
  const refresh = () => Promise.all([examAdmin(id, token), listSubmissions(id, token)])
    .then(([e, s]) => { setExam(e); setSubs(s); setError(null); })
    .catch((err) => setError(err.message));
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [id, token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !exam) return <div className="welcome"><div className="welcome-card"><p className="field-error">Suivi de l'examen : {error}</p></div></div>;
  if (!exam || !subs) return <div className="welcome"><div className="welcome-card"><p className="hint">Chargement du suivi…</p></div></div>;
  const template = { ...exam.template, settings: exam.settings };
  const graded = subs.map((s) => ({ ...gradeSubmission(s, template), id: s.submission_id, doc: s.doc }));
  const done = graded.filter((g) => g.status !== 'en cours');
  const avg = done.length ? Math.round((10 * done.reduce((a, g) => a + (g.note ?? 0), 0)) / done.length) / 10 : null;
  const csv = () => {
    const url = URL.createObjectURL(new Blob([gradesCsv(exam.title, graded)], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `${exam.title.replace(/[\\/:*?"<>|]+/g, '-')} - notes.csv` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="exam-dash-title">
      <div className="welcome-card exam-dashboard">
        <header className="welcome-head">
          <div>
            <h1 id="exam-dash-title">{exam.title}</h1>
            <p className="muted">
              {exam.settings.duration} min · {exam.settings.hints ? 'indices autorisés' : 'sans indices'} · {exam.closed ? <strong>examen clos</strong> : 'ouvert'}
              {' · '}{done.length} copie{done.length > 1 ? 's' : ''} rendue{done.length > 1 ? 's' : ''} sur {graded.length}{avg !== null ? ` · moyenne ${String(avg).replace('.', ',')}/20` : ''}
            </p>
          </div>
          {onClose && <button type="button" className="ghost icon welcome-close" onClick={onClose} aria-label="Fermer le suivi">✕</button>}
        </header>
        <CopyRow label="Lien pour les étudiants" value={examLinks(id, null).student} />
        <div className="row">
          <button type="button" className="ghost small-btn" onClick={refresh}>Actualiser</button>
          <button type="button" className="ghost small-btn" onClick={csv} disabled={!graded.length}>Exporter les notes (CSV)</button>
          <button type="button" className="ghost small-btn" onClick={async () => {
            if (!exam.closed && !confirm('Clore l\'examen ? Plus aucune copie ne sera acceptée (les épreuves en cours ne pourront plus être rendues).')) return;
            await setExamClosed(id, token, !exam.closed).catch((e) => setError(e.message));
            refresh();
          }}>{exam.closed ? 'Rouvrir l\'examen' : 'Clore l\'examen'}</button>
        </div>
        {error && <p className="field-error">{error}</p>}
        {!graded.length ? <p className="hint">Aucun étudiant n'a encore commencé.</p> : (
          <table className="exam-table">
            <thead><tr><th>Étudiant</th><th>Note</th><th>Objectifs</th><th>Statut</th><th>Durée</th><th>Remise</th><th /></tr></thead>
            <tbody>
              {graded.map((g) => (
                <tr key={g.id} className={g.status === 'en retard' ? 'late' : ''}>
                  <td>{g.student}</td>
                  <td>{g.note === null ? '–' : `${String(g.note).replace('.', ',')}/20`}</td>
                  <td>{g.score === null ? '–' : `${g.score}/${g.total}`}</td>
                  <td>{g.status}</td>
                  <td>{g.minutes === null ? '–' : `${String(g.minutes).replace('.', ',')} min`}</td>
                  <td>{g.submittedAt ? new Date(g.submittedAt).toLocaleTimeString('fr-FR') : '–'}</td>
                  <td>{g.doc && <button type="button" className="ghost small-btn" onClick={() => onOpenCopy(g, template)}>Voir la copie</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">Notes recalculées à partir des schémas rendus et des objectifs du sujet. Actualisation automatique toutes les 15 secondes.</p>
      </div>
    </div>
  );
}
