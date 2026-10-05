// Compte NetCanvas : connexion, création, mot de passe oublié ; connecté : « Mes schémas » (ouvrir, renommer,
// supprimer), rattachement des schémas partagés depuis ce navigateur, déconnexion.
import { useEffect, useId, useState } from 'react';
import { changePassword, resetPassword, signIn, signOut, signUp } from './account.js';
import { claimShared, deleteShared, myDiagrams, myShares, renameShared } from './share.js';

function Field({ label, ...props }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...props} />
    </div>
  );
}

function SignIn({ initialMode = 'login', onDone }) {
  const [mode, setMode] = useState(initialMode); // login | signup | forgot | new-password
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (mode === 'login') {
        await signIn(email.trim(), password);
        onDone?.();
      } else if (mode === 'signup') {
        const r = await signUp(email.trim(), password);
        if (r.needsConfirmation) setMsg({ ok: true, text: `Compte créé. Un e-mail de confirmation a été envoyé à ${email.trim()} : clique sur le lien, puis connecte-toi.` });
        else onDone?.();
      } else if (mode === 'forgot') {
        await resetPassword(email.trim());
        setMsg({ ok: true, text: 'Si un compte existe pour cette adresse, un e-mail permet de choisir un nouveau mot de passe.' });
      } else {
        await changePassword(password);
        setMsg({ ok: true, text: 'Mot de passe changé.' });
        setMode('done');
      }
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };
  const titles = { login: 'Se connecter', signup: 'Créer un compte', forgot: 'Mot de passe oublié', 'new-password': 'Nouveau mot de passe', done: 'Mot de passe changé' };
  return (
    <form onSubmit={submit} className="account-form">
      <h3>{titles[mode]}</h3>
      {mode !== 'new-password' && mode !== 'done' && (
        <Field label="Adresse e-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      )}
      {(mode === 'login' || mode === 'signup' || mode === 'new-password') && (
        <Field label={mode === 'login' ? 'Mot de passe' : 'Mot de passe (6 caractères minimum)'} type="password" required minLength={6}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
      )}
      {msg && <p className={msg.ok ? 'ok-text' : 'field-error'} role="status">{msg.text}</p>}
      {mode !== 'done' && <button type="submit" disabled={busy}>{busy ? '…' : titles[mode]}</button>}
      <p className="account-switch">
        {mode === 'login' && (<>
          <button type="button" className="link" onClick={() => setMode('signup')}>Créer un compte</button> ·{' '}
          <button type="button" className="link" onClick={() => setMode('forgot')}>Mot de passe oublié ?</button>
        </>)}
        {(mode === 'signup' || mode === 'forgot') && <button type="button" className="link" onClick={() => setMode('login')}>J'ai déjà un compte</button>}
      </p>
      <p className="hint">Un compte garde tes schémas partagés dans « Mes schémas », sur tous tes appareils. Sans compte, le partage par lien fonctionne aussi.</p>
    </form>
  );
}

function MyDiagrams({ onOpen, current, onRenameCurrent }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const refresh = () => myDiagrams().then(setList).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);
  // Partages faits sans compte dans ce navigateur (lien d'édition gardé) : on peut les rattacher
  const claimable = myShares().filter((s) => !(list ?? []).some((d) => d.diagram_id === s.id));
  const claimAll = async () => {
    let n = 0;
    for (const s of claimable) {
      try {
        await claimShared(s.id, s.token);
        n++;
      } catch {
        /* déjà rattaché à un compte, ou supprimé */
      }
    }
    setInfo(`${n} schéma${n > 1 ? 's' : ''} rattaché${n > 1 ? 's' : ''} à ton compte.`);
    refresh();
  };
  if (error) return <p className="field-error">Mes schémas : {error}</p>;
  if (!list) return <p className="hint">Chargement…</p>;
  return (
    <section>
      <h3>Mes schémas en ligne</h3>
      {!list.length && <p className="hint">Aucun pour l'instant : « Partager » enregistre le schéma ouvert dans ton compte.</p>}
      <ul className="my-diagrams">
        {list.map((d) => (
          <li key={d.diagram_id}>
            <div>
              <strong>{d.name}</strong>{d.diagram_id === current ? <span className="badge-on">ouvert</span> : null}
              <span className="muted"> · {d.devices} équipement{d.devices > 1 ? 's' : ''} · modifié le {new Date(d.updated_at).toLocaleString('fr-FR')}</span>
              {d.expires_at && (new Date(d.expires_at) <= new Date()
                ? <span className="field-error"> · lien de lecture expiré</span>
                : <span className="muted"> · lien de lecture jusqu'au {new Date(d.expires_at).toLocaleDateString('fr-FR')}</span>)}
            </div>
            <div className="row">
              <button type="button" className="small-btn" onClick={() => onOpen(d.diagram_id)}>Ouvrir</button>
              <button type="button" className="ghost small-btn" onClick={async () => {
                const name = prompt('Nouveau nom du schéma', d.name);
                if (name && name.trim() !== d.name) {
                  // Schéma ouvert dans l'éditeur : son nom change aussi là (sinon l'enregistrement automatique le remettrait)
                  if (d.diagram_id === current) onRenameCurrent?.(name.trim());
                  await renameShared(d.diagram_id, null, name.trim()).catch((e) => setError(e.message));
                }
                refresh();
              }}>Renommer</button>
              <button type="button" className="ghost small-btn danger-text" onClick={async () => {
                if (!confirm(`Supprimer « ${d.name} » ? Ses liens de partage ne marcheront plus.`)) return;
                await deleteShared(d.diagram_id).catch((e) => setError(e.message));
                refresh();
              }}>Supprimer</button>
            </div>
          </li>
        ))}
      </ul>
      {claimable.length > 0 && (
        <p className="hint">
          {claimable.length} schéma{claimable.length > 1 ? 's' : ''} partagé{claimable.length > 1 ? 's' : ''} depuis ce navigateur sans compte.{' '}
          <button type="button" className="link" onClick={claimAll}>Les rattacher à mon compte</button>
        </p>
      )}
      {info && <p className="ok-text">{info}</p>}
    </section>
  );
}

export default function AccountDialog({ user, mode, onOpen, current, onRenameCurrent, onClose }) {
  return (
    <div className="account">
      {user && mode !== 'new-password' ? (
        <>
          <p>Connecté en tant que <strong>{user.email}</strong>.</p>
          <MyDiagrams onOpen={(id) => { onOpen(id); onClose(); }} current={current} onRenameCurrent={onRenameCurrent} />
          <div className="row">
            <button type="button" className="ghost" onClick={() => signOut()}>Se déconnecter</button>
          </div>
        </>
      ) : (
        <SignIn key={mode} initialMode={mode ?? 'login'} onDone={mode === 'new-password' ? null : undefined} />
      )}
    </div>
  );
}
