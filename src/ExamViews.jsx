// Mode examen : création (prof, depuis un TP), début de l'épreuve et chrono (étudiant), suivi des copies (prof).
import { useEffect, useId, useMemo, useState } from 'react';
import { examAdmin, examLinks, listSubmissions, setExamClosed } from './share.js';
import { examSettings, formatClock, gradeSubmission, gradesCsv } from './exam.js';
import { analyzeLog, clock, logSummary } from './examlog.js';
import { variantSupport } from './net/variant.js';

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
export function ExamCreateForm({ defaultTitle, subject, onCreate }) {
  const [title, setTitle] = useState(defaultTitle || 'Examen');
  const [duration, setDuration] = useState(60);
  const [hints, setHints] = useState(false);
  const [progress, setProgress] = useState(false);
  const support = useMemo(() => (subject ? variantSupport(subject) : { ip: false, vlan: false }), [subject]);
  const canVary = support.ip || support.vlan;
  const [variants, setVariants] = useState(canVary);
  const [log, setLog] = useState(true);
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
        setCreated(await onCreate({ title, duration: Number(duration), hints, progress: progress || hints, variants: variants && canVary, log }));
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
      <label className="check"><input type="checkbox" checked={variants && canVary} disabled={!canVary} onChange={(e) => setVariants(e.target.checked)} /> Un sujet personnel par étudiant (adresses et VLAN changés)</label>
      <p className="hint">
        {canVary
          ? `Calculé à partir du sujet, avec le même comportement : même nombre d'objectifs atteints au départ, mêmes pannes. Adresses : ${support.ip ? 'oui' : 'non'} · VLAN : ${support.vlan ? 'oui' : 'non (aucun VLAN à renuméroter)'}. Les copies sont notées avec les objectifs de la variante de chaque étudiant.`
          : 'Ce sujet ne peut pas être décliné automatiquement (pas d\'adresse privée ni de VLAN à changer, ou le comportement ne se conserve pas).'}
      </p>
      <label className="check"><input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} /> Journal d'actions (commandes, modifications, collages, sorties de la fenêtre)</label>
      <p className="hint">Enregistré sur le poste de l'étudiant et remis avec sa copie : un indice pour toi, pas une preuve. L'étudiant en est informé au début de l'épreuve.</p>
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
            {exam.settings.variants && <p className="hint">Ton sujet est personnel : les adresses et les numéros de VLAN te sont propres, ne compare pas avec un voisin.</p>}
            {exam.settings.log && <p className="hint">Un journal de tes actions (commandes tapées, modifications du schéma, collages, sorties de la fenêtre) est enregistré et remis avec ta copie.</p>}
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
  const settings = examSettings(exam);
  const template = { ...exam.template, settings };
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
        <div className="welcome-head">
          <div>
            <h1 id="exam-dash-title">{exam.title}</h1>
            <p className="muted">
              {exam.settings.duration} min · {exam.settings.hints ? 'indices autorisés' : 'sans indices'} · {exam.closed ? <strong>examen clos</strong> : 'ouvert'}
              {' · '}{done.length} copie{done.length > 1 ? 's' : ''} rendue{done.length > 1 ? 's' : ''} sur {graded.length}{avg !== null ? ` · moyenne ${String(avg).replace('.', ',')}/20` : ''}
            </p>
          </div>
          {onClose && <button type="button" className="ghost icon welcome-close" onClick={onClose} aria-label="Fermer le suivi">✕</button>}
        </div>
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
            <thead><tr><th>Étudiant</th><th>Note</th><th>Objectifs</th><th>Statut</th><th>Durée</th><th>Remise</th>{settings.log && <th>Journal</th>}<th /></tr></thead>
            <tbody>
              {graded.map((g) => (
                <tr key={g.id} className={g.status === 'en retard' ? 'late' : ''}>
                  <td>{g.student}</td>
                  <td>{g.note === null ? '–' : `${String(g.note).replace('.', ',')}/20`}</td>
                  <td>{g.score === null ? '–' : `${g.score}/${g.total}`}</td>
                  <td>{g.status}</td>
                  <td>{g.minutes === null ? '–' : `${String(g.minutes).replace('.', ',')} min`}</td>
                  <td>{g.submittedAt ? new Date(g.submittedAt).toLocaleTimeString('fr-FR') : '–'}</td>
                  {settings.log && <LogCell log={g.doc?.examLog} />}
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

// Résumé du journal dans le tableau de suivi : les indices à regarder sont signalés
function LogCell({ log }) {
  const sum = logSummary(log);
  if (!sum) return <td className="muted">–</td>;
  return (
    <td title={sum.flags.join('\n') || 'Rien à signaler'}>
      {sum.text}{sum.flags.length > 0 && <strong className="log-flag" aria-label="À regarder"> ⚠ {sum.flags.length}</strong>}
    </td>
  );
}

const LOG_LABELS = { start: 'Début', cmd: 'Commande', edit: 'Modification', sim: 'Simulation', paste: 'Collage', copy: 'Copie', out: 'Sortie', stop: 'Journal' };

// Prof : journal d'actions d'une copie, avec les indices repérés
export function ExamLogView({ student, log, onClose }) {
  const a = analyzeLog(log);
  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="exam-log-title">
      <div className="welcome-card exam-dashboard">
        <div className="welcome-head">
          <div>
            <h1 id="exam-log-title">Journal de {student}</h1>
            <p className="muted">{a.commands} commandes · {a.edits} modifications · {a.pastes} collage{a.pastes > 1 ? 's' : ''} · {a.outs} sortie{a.outs > 1 ? 's' : ''} de la fenêtre</p>
          </div>
          <button type="button" className="ghost icon welcome-close" onClick={onClose} aria-label="Fermer le journal">✕</button>
        </div>
        {a.flags.length > 0 ? (
          <ul className="log-flags">{a.flags.map((f) => <li key={f}>{f}</li>)}</ul>
        ) : <p className="ok-text">Rien d'inhabituel dans ce journal.</p>}
        <p className="hint">Un indice n'est pas une preuve : le journal vit sur le poste de l'étudiant et ne voit pas un autre appareil. Pour trancher, demande-lui de refaire ou d'expliquer une panne.</p>
        <table className="exam-table log-table">
          <thead><tr><th>Temps</th><th>Type</th><th>Détail</th></tr></thead>
          <tbody>
            {log.map((e, i) => (
              <tr key={i} className={e.k === 'paste' || e.k === 'copy' || e.k === 'out' ? 'late' : ''}>
                <td>{clock(e.t)}</td>
                <td>{LOG_LABELS[e.k] ?? e.k}</td>
                <td>{e.x}{e.n > 1 ? ` (×${e.n})` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
