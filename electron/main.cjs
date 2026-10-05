// Application de bureau NetCanvas : la même interface que le site (dist/), avec de vrais fichiers .netcanvas,
// des menus natifs, l'ouverture par double-clic et une confirmation avant de fermer un schéma modifié.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setupUpdates } = require('./updater.cjs');

const SITE = 'https://netcanvas.vercel.app';
const EXT = 'netcanvas';
const FILTERS = [{ name: 'Schéma NetCanvas', extensions: [EXT, 'json'] }];
const RECENT_MAX = 8;

let win = null;
let updates = null;
let dirty = false;
let closing = false;
let rendererReady = false;
const pending = []; // fichiers à ouvrir avant que l'interface soit prête

// Fichier passé en argument (double-clic sous Windows / Linux, « Ouvrir avec »)
const fileArg = (argv) => argv.slice(app.isPackaged ? 1 : 2).find((a) => a.toLowerCase().endsWith(`.${EXT}`) && !a.startsWith('-'));

function sendOpen(file) {
  if (!file) return;
  if (rendererReady && win) win.webContents.send('open-path', path.resolve(file));
  else pending.push(path.resolve(file));
}

// --- Fichiers récents (dans le dossier de l'utilisateur) ----------------------------------------
const recentPath = () => path.join(app.getPath('userData'), 'recent.json');
async function readRecent() {
  try {
    const list = JSON.parse(await fs.readFile(recentPath(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
async function addRecent(file) {
  const list = [file, ...(await readRecent()).filter((f) => f !== file)].slice(0, RECENT_MAX);
  await fs.writeFile(recentPath(), JSON.stringify(list));
  app.addRecentDocument(file);
  buildMenu(list);
  return describe(list);
}
const describe = (list) => list.map((p) => ({ path: p, name: path.basename(p) }));

// --- Menus -----------------------------------------------------------------------------------------
const send = (cmd) => () => win?.webContents.send('menu', cmd);

function buildMenu(recent = []) {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Fichier',
      submenu: [
        { label: 'Nouveau', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Ouvrir…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        {
          label: 'Ouvrir un fichier récent',
          submenu: recent.length
            ? recent.map((p) => ({ label: path.basename(p), sublabel: p, click: () => sendOpen(p) }))
            : [{ label: 'Aucun', enabled: false }],
        },
        { type: 'separator' },
        { label: 'Enregistrer', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Enregistrer sous…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { type: 'separator' },
        { label: 'Accueil et exemples', click: send('welcome') },
        { type: 'separator' },
        mac ? { role: 'close', label: 'Fermer la fenêtre' } : { role: 'quit', label: 'Quitter' },
      ],
    },
    {
      // Couper / copier / coller pour les champs texte ; annuler / rétablir du schéma : raccourcis de l'interface
      label: 'Édition',
      submenu: [
        { role: 'cut', label: 'Couper' }, { role: 'copy', label: 'Copier' }, { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'resetZoom', label: 'Taille réelle' }, { role: 'zoomIn', label: 'Zoom avant' }, { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: 'Outils de développement' }]),
      ],
    },
    {
      label: 'Aide',
      submenu: [
        { label: 'Rechercher des mises à jour…', click: () => updates?.check() },
        { label: 'Site de NetCanvas', click: () => shell.openExternal(SITE) },
        { label: `À propos de NetCanvas ${app.getVersion()}`, click: () => dialog.showMessageBox(win, {
          type: 'info', title: 'À propos', message: `NetCanvas ${app.getVersion()}`,
          detail: 'Schémas réseau, configuration Cisco et MikroTik, simulation expliquée.\nVersion web : ' + SITE,
        }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Fenêtre ---------------------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'NetCanvas',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Liens externes (partage, aide) : navigateur par défaut, jamais dans la fenêtre de l'application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Fermeture avec des modifications non enregistrées : on demande, comme un éditeur classique
  win.on('close', (e) => {
    if (!dirty || closing) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Enregistrer', 'Ne pas enregistrer', 'Annuler'], defaultId: 0, cancelId: 2,
      title: 'NetCanvas', message: 'Enregistrer les modifications du schéma avant de fermer ?',
    });
    if (choice === 0) win.webContents.send('menu', 'save-and-close');
    else if (choice === 1) {
      closing = true;
      win.close();
    }
  });
  win.on('closed', () => {
    win = null;
    rendererReady = false;
  });
}

// --- Échanges avec l'interface (preload.cjs) --------------------------------------------------------
ipcMain.handle('open-file', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Ouvrir un schéma', filters: FILTERS, properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  return { path: file, name: path.basename(file), content: await fs.readFile(file, 'utf8') };
});
ipcMain.handle('read-file', async (_e, file) => ({ path: file, name: path.basename(file), content: await fs.readFile(file, 'utf8') }));
ipcMain.handle('write-file', async (_e, file, content) => {
  await fs.writeFile(file, content, 'utf8');
  return true;
});
ipcMain.handle('save-file-as', async (_e, suggested, content) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Enregistrer le schéma', defaultPath: path.join(app.getPath('documents'), suggested), filters: FILTERS,
  });
  if (r.canceled || !r.filePath) return null;
  const file = r.filePath.toLowerCase().endsWith(`.${EXT}`) || r.filePath.toLowerCase().endsWith('.json') ? r.filePath : `${r.filePath}.${EXT}`;
  await fs.writeFile(file, content, 'utf8');
  return { path: file, name: path.basename(file) };
});
ipcMain.handle('recent-files', async () => describe(await readRecent()));
ipcMain.handle('add-recent', (_e, file) => addRecent(file));
ipcMain.on('set-dirty', (_e, value) => { dirty = Boolean(value); });
ipcMain.on('close-now', () => {
  closing = true;
  win?.close();
});
ipcMain.on('install-update', () => updates?.install());
ipcMain.on('ready', () => {
  rendererReady = true;
  while (pending.length) win.webContents.send('open-path', pending.shift());
});

// Profil isolé (tests automatiques) : fichiers récents et brouillon hors du vrai profil
if (process.env.NETCANVAS_USER_DATA) app.setPath('userData', process.env.NETCANVAS_USER_DATA);

// --- Cycle de vie ------------------------------------------------------------------------------------
// Une seule instance : un double-clic sur un autre fichier l'ouvre dans la fenêtre existante
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    sendOpen(fileArg(argv));
  });
  // macOS : fichier ouvert depuis le Finder
  app.on('open-file', (e, file) => {
    e.preventDefault();
    sendOpen(file);
  });
  app.whenReady().then(async () => {
    buildMenu(await readRecent());
    createWindow();
    updates = setupUpdates(() => win);
    sendOpen(fileArg(process.argv));
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
