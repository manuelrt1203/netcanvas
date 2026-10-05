// Collaboration en temps réel sur un schéma partagé (Supabase Realtime, canaux « broadcast » et présence).
// - Éditeurs : canal secret « nc-edit-<clé> » (clé donnée par collab_key aux seuls éditeurs) : modifications et présence.
// - Lecteurs : canal « nc-view-<id> » : ils reçoivent les modifications, ne peuvent rien publier qui soit appliqué
//   par un éditeur (les éditeurs n'écoutent que le canal secret).
// Les modifications circulent équipement par équipement et câble par câble : deux personnes qui modifient des
// équipements différents ne s'écrasent pas ; sur un même équipement, la dernière modification gagne.
const API = import.meta.env?.VITE_SUPABASE_URL;
const KEY = import.meta.env?.VITE_SUPABASE_KEY;
// Client Supabase chargé seulement quand un schéma partagé est ouvert (il pèse lourd)
let client = null;
const supabase = async () => {
  if (!API || !KEY) return null;
  if (!client) {
    const { createClient } = await import('@supabase/supabase-js');
    client = createClient(API, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
};
export const collabEnabled = Boolean(API && KEY);

const byId = (list) => new Map((list ?? []).map((x) => [x.id, x]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Différence entre deux documents : { devices: { id: équipement | null }, links: { id: câble | null }, name?, exercise? } ou null
export function diffDocs(prev, next) {
  const patch = { devices: {}, links: {} };
  let empty = true;
  for (const key of ['devices', 'links']) {
    const a = byId(prev?.[key]);
    const b = byId(next?.[key]);
    for (const [id, x] of b) if (!same(a.get(id), x)) { patch[key][id] = x; empty = false; }
    for (const id of a.keys()) if (!b.has(id)) { patch[key][id] = null; empty = false; }
  }
  for (const key of ['name', 'exercise']) {
    if (!same(prev?.[key] ?? null, next?.[key] ?? null)) { patch[key] = next?.[key] ?? null; empty = false; }
  }
  return empty ? null : patch;
}

// Applique une différence : remplacement à sa place, ajout à la fin, suppression
export function applyPatch(doc, patch) {
  const out = { ...doc };
  for (const key of ['devices', 'links']) {
    const changes = patch[key] ?? {};
    const list = (doc[key] ?? []).filter((x) => changes[x.id] !== null).map((x) => (changes[x.id] ? changes[x.id] : x));
    for (const [id, x] of Object.entries(changes)) if (x && !list.some((y) => y.id === id)) list.push(x);
    out[key] = list;
  }
  if ('name' in patch) out.name = patch.name ?? doc.name;
  if ('exercise' in patch) out.exercise = patch.exercise;
  return out;
}

// Pseudo et couleur de cette personne (compte : début de l'e-mail ; sinon « Invité N » gardé dans le navigateur)
const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
export function myIdentity(user) {
  let id;
  let guest;
  try {
    id = localStorage.getItem('netcanvas:collab-id') ?? crypto.randomUUID();
    localStorage.setItem('netcanvas:collab-id', id);
    guest = localStorage.getItem('netcanvas:pseudo');
  } catch {
    id = crypto.randomUUID();
  }
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { id, name: user?.email?.split('@')[0] || guest || `Invité ${(h % 90) + 10}`, color: COLORS[h % COLORS.length] };
}

// Rejoint la collaboration. editKey : clé secrète (éditeur) ou null (lecteur).
// onPatch(patch, from) ; onPeople([{ id, name, color, selected }]). Renvoie { send(patch), select(ids), leave() }.
export function joinCollab(options) {
  let handle = null;
  let left = false;
  let pending = null; // sélection demandée avant la connexion
  supabase().then((sb) => {
    if (!sb || left) return;
    handle = connect(sb, options);
    if (pending) handle.select(pending);
  });
  return {
    send: (patch) => handle?.send(patch),
    select: (ids) => (handle ? handle.select(ids) : (pending = ids)),
    leave: () => { left = true; handle?.leave(); },
  };
}

function connect(sb, { id, editKey, me, onPatch, onPeople, onStatus }) {
  const view = sb.channel(`nc-view-${id}`, { config: { broadcast: { self: false } } });
  let edit = null;
  let selected = [];
  if (editKey) {
    edit = sb.channel(`nc-edit-${editKey}`, { config: { broadcast: { self: false }, presence: { key: me.id } } });
    edit.on('broadcast', { event: 'patch' }, ({ payload }) => onPatch(payload.patch, payload.from));
    edit.on('presence', { event: 'sync' }, () => {
      const state = edit.presenceState();
      onPeople(Object.values(state).map((metas) => metas.at(-1)).filter(Boolean));
    });
    edit.subscribe((status) => {
      onStatus?.(status);
      if (status === 'SUBSCRIBED') edit.track({ ...me, selected });
    });
    view.subscribe();
  } else {
    view.on('broadcast', { event: 'patch' }, ({ payload }) => onPatch(payload.patch, payload.from));
    view.subscribe((status) => onStatus?.(status));
  }
  return {
    // Éditeur : vers les autres éditeurs, et vers les lecteurs
    send(patch) {
      if (!edit) return;
      const payload = { patch, from: me.id };
      edit.send({ type: 'broadcast', event: 'patch', payload });
      view.send({ type: 'broadcast', event: 'patch', payload });
    },
    select(ids) {
      selected = ids;
      if (edit) edit.track({ ...me, selected });
    },
    leave() {
      if (edit) sb.removeChannel(edit);
      sb.removeChannel(view);
    },
  };
}
