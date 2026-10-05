// Partage par lien, sans compte (Supabase) :
//   lecture : https://…/?d=<id>          édition : https://…/?d=<id>#edit=<jeton>
// Le jeton d'édition reste dans le fragment (#) : il n'est jamais envoyé au serveur web ni journalisé.
// La base ne stocke que son empreinte SHA-256 ; la table n'est accessible que par trois fonctions (RPC).
const API = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_KEY;
const MINE_KEY = 'netcanvas:shares';

export const shareEnabled = Boolean(API && KEY);

async function rpc(fn, body) {
  const res = await fetch(`${API}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? `Erreur ${res.status}`);
  return data;
}

export async function createShared(doc) {
  const [row] = await rpc('create_diagram', { p_doc: doc, p_name: doc.name });
  return { id: row.diagram_id, token: row.edit_token };
}

export async function loadShared(id) {
  const [row] = await rpc('get_diagram', { p_id: id });
  return row ? { name: row.name, doc: row.doc, updatedAt: row.updated_at } : null;
}

export const saveShared = (id, token, doc) => rpc('update_diagram', { p_id: id, p_token: token, p_doc: doc, p_name: doc.name });

// Lien de lecture et lien d'édition
// Application de bureau (file://) : les liens pointent vers le site public
export const PUBLIC_SITE = 'https://netcanvas.vercel.app';
const siteOrigin = () => (window.location.protocol === 'file:' ? PUBLIC_SITE : window.location.origin);

export function shareLinks(id, token, origin = siteOrigin()) {
  const view = `${origin}/?d=${id}`;
  return { view, edit: token ? `${view}#edit=${token}` : null, embed: `${view}&embed=1` };
}

// ?d=<id>[&embed=1]#edit=<jeton>
export function parseShareLocation(loc = window.location) {
  const q = new URLSearchParams(loc.search);
  const id = q.get('d');
  if (!id || !/^[a-z0-9]{6,20}$/.test(id)) return null;
  const token = new URLSearchParams(loc.hash.slice(1)).get('edit');
  return { id, token: token || null, embed: q.get('embed') === '1' };
}

// « Mes partages » : liens d'édition gardés dans ce navigateur (le jeton n'est pas récupérable ailleurs)
export function myShares() {
  try {
    return JSON.parse(localStorage.getItem(MINE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function rememberShare(entry) {
  try {
    const list = [entry, ...myShares().filter((s) => s.id !== entry.id)].slice(0, 50);
    localStorage.setItem(MINE_KEY, JSON.stringify(list));
  } catch {
    /* stockage indisponible : le lien reste dans la barre d'adresse */
  }
}
