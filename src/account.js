// Comptes NetCanvas (Supabase Auth, API REST) : e-mail + mot de passe. La session est gardée dans ce navigateur
// (ou dans l'application de bureau) et renouvelée avant expiration. Sans compte, le partage par lien marche toujours.
const API = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_KEY;
const SESSION_KEY = 'netcanvas:session';
const SITE = 'https://netcanvas.vercel.app';

export const accountsEnabled = Boolean(API && KEY);
const listeners = new Set();
let session = read();

function read() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function store(next) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* stockage indisponible : session pour cet onglet seulement */
  }
  for (const fn of listeners) fn(currentUser());
}

const fromAuth = (r) => ({
  access_token: r.access_token, refresh_token: r.refresh_token,
  expires_at: r.expires_at ?? Math.floor(Date.now() / 1000) + (r.expires_in ?? 3600),
  user: { id: r.user?.id, email: r.user?.email },
});

// Messages de Supabase Auth en français
const MESSAGES = [
  [/invalid login credentials/i, 'e-mail ou mot de passe incorrect'],
  [/email not confirmed/i, 'adresse e-mail pas encore confirmée : clique sur le lien reçu par e-mail'],
  [/user already registered|already been registered/i, 'un compte existe déjà avec cette adresse'],
  [/password should be at least (\d+)/i, (m) => `mot de passe trop court (${m[1]} caractères minimum)`],
  [/rate limit|too many/i, 'trop de tentatives, réessaie dans quelques minutes'],
  [/unable to validate email|invalid format/i, 'adresse e-mail invalide'],
];
function french(text) {
  for (const [re, fr] of MESSAGES) {
    const m = re.exec(text ?? '');
    if (m) return typeof fr === 'function' ? fr(m) : fr;
  }
  return text || 'erreur inconnue';
}

async function auth(path, body, token = null, method = 'POST') {
  const res = await fetch(`${API}/auth/v1/${path}`, {
    method,
    headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(french(data?.msg ?? data?.error_description ?? data?.message ?? `Erreur ${res.status}`));
  return data;
}

export const currentUser = () => session?.user ?? null;
export function onUserChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Jeton d'accès valide (renouvelé s'il expire dans moins d'une minute) ; null sans compte
export async function accessToken() {
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  try {
    store(fromAuth(await auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token })));
    return session.access_token;
  } catch {
    store(null); // session expirée ou révoquée : retour au mode sans compte
    return null;
  }
}

// Inscription : { user, needsConfirmation } (confirmation par e-mail si le projet l'exige)
export async function signUp(email, password) {
  const r = await auth(`signup?redirect_to=${encodeURIComponent(SITE)}`, { email, password });
  if (r.access_token) {
    store(fromAuth(r));
    return { user: currentUser(), needsConfirmation: false };
  }
  return { user: null, needsConfirmation: true };
}

export async function signIn(email, password) {
  store(fromAuth(await auth('token?grant_type=password', { email, password })));
  return currentUser();
}

export async function signOut() {
  const token = session?.access_token;
  store(null);
  if (token) await auth('logout', null, token).catch(() => {});
}

export const resetPassword = (email) => auth(`recover?redirect_to=${encodeURIComponent(SITE)}`, { email });

export async function changePassword(password) {
  const token = await accessToken();
  if (!token) throw new Error('connexion requise');
  await auth('user', { password }, token, 'PUT');
}

// Retour d'un lien reçu par e-mail (confirmation, mot de passe oublié) : #access_token=…&type=signup|recovery
// Renvoie le type, ou null ; nettoie l'adresse.
export async function handleAuthRedirect(loc = window.location) {
  const p = new URLSearchParams(loc.hash.slice(1));
  if (!p.get('access_token')) return null;
  const type = p.get('type');
  window.history.replaceState(null, '', loc.pathname + loc.search);
  try {
    const user = await auth('user', null, p.get('access_token'), 'GET');
    store(fromAuth({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_at: Number(p.get('expires_at')) || undefined, user }));
    return type ?? 'signup';
  } catch {
    return null;
  }
}
