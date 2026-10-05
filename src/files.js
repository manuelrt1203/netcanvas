// Fichiers .netcanvas (JSON) : ouvrir, enregistrer, enregistrer sous.
// - Application de bureau (Electron) : vraies boîtes de dialogue et chemin du fichier (window.netcanvas, preload).
// - Navigateur récent (Chrome, Edge) : File System Access API, on réécrit le même fichier.
// - Sinon : ouverture par <input type=file>, enregistrement par téléchargement.
// Un « fichier » ouvert : { name, path (bureau) | handle (navigateur) | null }.

export const EXTENSION = '.netcanvas';
export const desktop = typeof window !== 'undefined' ? window.netcanvas ?? null : null;
const fsAccess = typeof window !== 'undefined' && 'showOpenFilePicker' in window;
const TYPES = [{ description: 'Schéma NetCanvas', accept: { 'application/json': [EXTENSION, '.json'] } }];

export const fileName = (doc) => `${(doc.name || 'reseau').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'reseau'}${EXTENSION}`;
const text = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

// Choix d'un fichier dans le navigateur sans File System Access
function pickWithInput() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${EXTENSION},.json,application/json`;
    input.onchange = () => resolve(input.files[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// Renvoie { file, content } ou null si annulé
export async function openFile() {
  if (desktop) {
    const r = await desktop.openFile();
    return r && { file: { name: r.name, path: r.path }, content: r.content };
  }
  if (fsAccess) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: TYPES, multiple: false });
      const f = await handle.getFile();
      return { file: { name: f.name, handle }, content: await f.text() };
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }
  const f = await pickWithInput();
  return f && { file: { name: f.name, handle: null }, content: await f.text() };
}

// Enregistre dans le fichier courant ; sans fichier, demande où (Enregistrer sous). Renvoie le fichier, ou null si annulé.
export async function saveFile(doc, file) {
  if (desktop && file?.path) {
    await desktop.writeFile(file.path, text(doc));
    return file;
  }
  if (file?.handle) {
    const w = await file.handle.createWritable();
    await w.write(text(doc));
    await w.close();
    return file;
  }
  return saveFileAs(doc);
}

export async function saveFileAs(doc) {
  if (desktop) {
    const r = await desktop.saveFileAs(fileName(doc), text(doc));
    return r && { name: r.name, path: r.path };
  }
  if (fsAccess) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: fileName(doc), types: TYPES });
      const file = { name: handle.name, handle };
      return saveFile(doc, file);
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }
  // Téléchargement : pas de fichier « courant » à réécrire ensuite
  const url = URL.createObjectURL(new Blob([text(doc)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName(doc) });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { name: fileName(doc), handle: null, downloaded: true };
}
