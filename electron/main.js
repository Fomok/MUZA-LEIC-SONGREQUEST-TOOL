import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconPath = path.join(here, '..', 'build', 'icon.png');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Data (config, queue, cache, log) goes to the per-user app-data folder.
  process.env.SONGBOT_DATA = app.getPath('userData');
  process.env.SONGBOT_EMBEDDED = '1';

  let win = null;
  let tray = null;
  let quitting = false;

  function createWindow(port) {
    win = new BrowserWindow({
      width: 1220,
      height: 860,
      autoHideMenuBar: true,
      icon: iconPath,
      title: 'Song Bot',
      backgroundColor: '#0f1115',
    });
    win.loadURL(`http://localhost:${port}`);
    // Closing the window hides to tray; the bot keeps playing.
    win.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        win.hide();
      }
    });
  }

  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.whenReady().then(async () => {
    const { appReady } = await import('../src/index.js');
    const { port } = await appReady;
    createWindow(port);

    const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(trayIcon);
    tray.setToolTip('Song Bot');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Song Bot', click: () => { win.show(); win.focus(); } },
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit(); } },
      ])
    );
    tray.on('double-click', () => {
      win.show();
      win.focus();
    });
  });
}
