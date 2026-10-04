// Onglet « TP » : consigne, objectifs vérifiés en direct, indices progressifs (élève) ;
// création et modification des objectifs (enseignant).
import { useId, useState } from 'react';
import { OBJECTIVES, hintFor } from './net/exercise.js';
import { isValidIp } from './net/ip.js';

const newObjectiveId = () => `o${crypto.randomUUID().slice(0, 6)}`;
const EMPTY_EXERCISE = { title: 'Nouveau TP', instructions: '', objectives: [] };

function Field({ label, children }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

// Paramètre d'un objectif : équipement, routeur ou adresse IP (avec préfixe facultatif)
function Param({ kind, name, value, devices, onChange }) {
  const labels = { from: 'Depuis', to: 'Vers', host: 'Hôte', a: 'Routeur A', b: 'Routeur B', router: 'Routeur', neighbor: 'Voisin (IP)' };
  if (kind === 'ip') {
    const ip = (value ?? '').split('/')[0];
    return (
      <Field label={labels[name] ?? name}>
        {(id) => <input id={id} value={value ?? ''} placeholder="192.168.1.10" aria-invalid={value && !isValidIp(ip) ? true : undefined}
          onChange={(e) => onChange(e.target.value.trim())} />}
      </Field>
    );
  }
  const list = devices.filter((d) => (kind === 'router' ? d.type === 'router' || d.type === 'switch' : d.type !== 'hub' && d.type !== 'switch'));
  return (
    <Field label={labels[name] ?? name}>
      {(id) => (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">—</option>
          {list.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      )}
    </Field>
  );
}

function ObjectiveEditor({ objective, devices, onChange, onRemove }) {
  const def = OBJECTIVES[objective.type];
  return (
    <fieldset className="iface">
      <legend>{def?.label ?? objective.type}</legend>
      <Field label="Type">
        {(id) => (
          <select id={id} value={objective.type} onChange={(e) => onChange({ id: objective.id, type: e.target.value })}>
            {Object.entries(OBJECTIVES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        )}
      </Field>
      {def?.params.length > 0 && (
        <div className="field-row">
          {def.params.map(([name, kind]) => (
            <Param key={name} kind={kind} name={name} value={objective[name]} devices={devices}
              onChange={(v) => onChange({ ...objective, [name]: v })} />
          ))}
        </div>
      )}
      <Field label="Libellé affiché (facultatif)">
        {(id) => <input id={id} value={objective.label ?? ''} placeholder="Généré automatiquement"
          onChange={(e) => onChange({ ...objective, label: e.target.value || undefined })} />}
      </Field>
      <button type="button" className="ghost small" onClick={onRemove}>Retirer l'objectif</button>
    </fieldset>
  );
}

export default function ExercisePanel({ exercise, results, devices, readOnly, doc, onChange, onLocate }) {
  const [editing, setEditing] = useState(false);
  const [hints, setHints] = useState({}); // id de l'objectif -> niveau d'indice affiché

  if (!exercise) {
    return (
      <>
        <h2>TP</h2>
        <p className="hint">Transforme ce schéma en exercice : écris une consigne, ajoute des objectifs (pings, adjacences OSPF, sessions BGP, baux DHCP, routes…), puis casse le réseau.</p>
        <p className="hint">L'élève voit les objectifs se valider en direct pendant qu'il répare, avec des indices s'il bloque. Partage le lien de lecture : il le duplique pour travailler.</p>
        <p className="hint">Exemples tout prêts dans le menu Démos (« TP : … »).</p>
        {!readOnly && <button type="button" onClick={() => { onChange(EMPTY_EXERCISE); setEditing(true); }}>Créer un TP</button>}
      </>
    );
  }

  const done = results.filter((r) => r.ok).length;
  const total = results.length;
  const set = (patch) => onChange({ ...exercise, ...patch });
  const objectives = exercise.objectives ?? [];

  if (editing && !readOnly) {
    return (
      <>
        <div className="table-title">
          <h2>Modifier le TP</h2>
          <button type="button" className="ghost small-btn" onClick={() => setEditing(false)}>Vue élève</button>
        </div>
        <Field label="Titre">{(id) => <input id={id} value={exercise.title ?? ''} onChange={(e) => set({ title: e.target.value })} />}</Field>
        <Field label="Consigne">
          {(id) => <textarea id={id} className="rules" rows={4} value={exercise.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value })} />}
        </Field>
        <h3>Objectifs</h3>
        {objectives.map((o, i) => (
          <ObjectiveEditor key={o.id} objective={o} devices={devices}
            onChange={(next) => set({ objectives: objectives.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => set({ objectives: objectives.filter((_, j) => j !== i) })} />
        ))}
        <button type="button" className="ghost small" onClick={() => set({ objectives: [...objectives, { id: newObjectiveId(), type: 'ping' }] })}>
          Ajouter un objectif
        </button>
        <p className="hint">Conseil : règle d'abord le réseau qui marche, ajoute les objectifs (tous verts), puis introduis les pannes.</p>
        <button type="button" className="ghost small danger" onClick={() => { if (confirm('Supprimer le TP (le schéma est gardé) ?')) { onChange(null); setEditing(false); } }}>
          Supprimer le TP
        </button>
      </>
    );
  }

  return (
    <>
      <div className="table-title">
        <h2>{exercise.title || 'TP'}</h2>
        {!readOnly && <button type="button" className="ghost small-btn" onClick={() => setEditing(true)}>Modifier</button>}
      </div>
      {exercise.instructions && <div className="tp-instructions">{exercise.instructions.split('\n').map((l, i) => <p key={i}>{l}</p>)}</div>}
      {total > 0 && (
        <div className="tp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Objectifs atteints">
          <span style={{ width: `${(100 * done) / total}%` }} />
        </div>
      )}
      <p className={done === total && total ? 'ok-text' : 'hint'}>
        {total === 0 ? 'Aucun objectif pour l\'instant.' : done === total ? `Bravo, les ${total} objectifs sont atteints !` : `${done} objectif${done > 1 ? 's' : ''} atteint${done > 1 ? 's' : ''} sur ${total}, vérifiés en direct.`}
      </p>
      <ol className="tp-objectives">
        {results.map((r) => {
          const level = hints[r.objective.id] ?? 0;
          return (
            <li key={r.objective.id} className={r.ok ? 'ok' : 'todo'}>
              <span className="tp-mark" aria-label={r.ok ? 'atteint' : 'pas encore atteint'}>{r.ok ? '✓' : '○'}</span>
              <div>
                <span>{r.text}</span>
                {!r.ok && level > 0 && (
                  <p className="tp-hint">
                    {hintFor(r, level, doc)}
                    {level >= 2 && r.where && <> <button type="button" className="linklike" onClick={() => onLocate(r.where)}>Voir</button></>}
                  </p>
                )}
                {!r.ok && level < 3 && (
                  <button type="button" className="ghost small-btn" onClick={() => setHints((h) => ({ ...h, [r.objective.id]: level + 1 }))}>
                    {level === 0 ? 'Indice' : 'Indice suivant'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
