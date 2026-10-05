// Mises à jour depuis les Releases GitHub (electron-updater, fichiers latest*.yml publiés avec les installeurs).
// Windows (NSIS), Linux (AppImage, .deb) : téléchargement en arrière-plan, puis « Redémarrer pour mettre à jour »
// (sinon installation à la fermeture). macOS : une app non signée ne peut pas se remplacer elle-même,
// on annonce la version avec un lien de téléchargement.
const { app, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES = 'https://github.com/manuelrt1203/netcanvas/releases/latest';
const EVERY = 6 * 3600 * 1000;
const manual = process.platform === 'darwin';

function setupUpdates(getWindow) {
  let interactive = false; // vérification demandée depuis le menu : on répond même s'il n'y a rien
  const send = (state) => getWindow()?.webContents.send('update', state);
  autoUpdater.autoDownload = !manual;
  autoUpdater.autoInstallOnAppQuit = !manual;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => send({ state: manual ? 'manual' : 'downloading', version: info.version, percent: 0, url: RELEASES }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }));
  autoUpdater.on('update-not-available', () => {
    if (interactive) dialog.showMessageBox(getWindow(), { type: 'info', title: 'Mises à jour', message: `NetCanvas ${app.getVersion()} est à jour.` });
    interactive = false;
  });
  autoUpdater.on('error', (err) => {
    // Hors ligne au démarrage : silence ; demandé par l'utilisateur : on explique
    if (interactive) {
      dialog.showMessageBox(getWindow(), {
        type: 'warning', title: 'Mises à jour', message: 'Impossible de vérifier les mises à jour.',
        detail: `${err?.message ?? err}\nLes versions sont aussi sur ${RELEASES}`,
      });
    }
    interactive = false;
    send({ state: 'error' });
  });

  const check = (asked = false) => {
    interactive = asked;
    return autoUpdater.checkForUpdates().catch(() => {});
  };
  // Pas de vérification depuis les sources (npm run desktop), sauf pour la tester
  const enabled = app.isPackaged || process.env.NETCANVAS_UPDATE_TEST;
  if (enabled) {
    if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;
    setTimeout(() => check(false), 5000);
    setInterval(() => check(false), EVERY);
  }
  return {
    check: () => (enabled ? check(true) : dialog.showMessageBox(getWindow(), {
      type: 'info', title: 'Mises à jour', message: 'Version de développement : les mises à jour se vérifient dans l\'application installée.',
    })),
    install: () => (manual ? shell.openExternal(RELEASES) : autoUpdater.quitAndInstall()),
  };
}

module.exports = { setupUpdates };
