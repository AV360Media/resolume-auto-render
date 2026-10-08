import { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, type RunningApp } from '../src/app.js';

/**
 * Tray/menu-bar shell around the companion service.
 * The service runs in this process; the window is just the control panel at http://127.0.0.1:<port>/.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '..', '..', 'build');

let running: RunningApp | null = null;
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot).catch((e) => {
    dialog.showErrorBox('Resolume Auto Render failed to start', String(e?.stack || e));
    app.exit(1);
  });
}

async function boot() {
  if (process.platform === 'darwin') app.dock?.hide();
  running = await startApp({ dataDir: app.getPath('userData') });
  createTray();
  running.service.on('status', updateTrayMenu);
  running.service.on('job', throttle(updateTrayMenu, 1000));
  running.service.on('update', (u) => {
    updateTrayMenu();
    if (u.available) tray?.displayBalloon?.({ title: 'Update available', content: `Version ${u.latest} is available.` });
  });
  // First launch, or launched by the user (not at login): show the panel.
  const atLogin = app.getLoginItemSettings().wasOpenedAtLogin || process.argv.includes('--hidden');
  if (!atLogin) showWindow();
}

function trayImage() {
  // macOS uses a template image so it adapts to light and dark menu bars.
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(assets, file));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Resolume Auto Render');
  tray.on('click', () => showWindow());
  updateTrayMenu();
}

function statusLine(): string {
  if (!running) return 'Starting…';
  const s = running.service.arena.getStatus();
  const jobs = running.service.queue.list();
  const working = jobs.filter((j) => ['waiting', 'probing', 'encoding', 'validating', 'swapping'].includes(j.state)).length;
  const queued = jobs.filter((j) => j.state === 'queued').length;
  const arena = s.state === 'connected' ? 'Arena connected' : s.state === 'connecting' ? 'Connecting to Arena' : 'Arena not reachable';
  return `${arena} · ${working} working, ${queued} waiting`;
}

function updateTrayMenu() {
  if (!tray || !running) return;
  const update = running.service.update();
  const login = app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
  const menu = Menu.buildFromTemplate([
    { label: statusLine(), enabled: false },
    { type: 'separator' },
    { label: 'Open Control Panel', click: () => showWindow() },
    { label: 'Open in Browser', click: () => shell.openExternal(running!.url) },
    { type: 'separator' },
    { label: 'Start at Login', type: 'checkbox', checked: login, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }) },
    update.available
      ? { label: `Download version ${update.latest}…`, click: () => shell.openExternal(update.url || 'https://github.com/AV360Media/resolume-auto-render/releases') }
      : { label: 'Check for Updates', click: () => void checkUpdatesInteractive() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

async function checkUpdatesInteractive() {
  if (!running) return;
  const u = await running.service.checkUpdates();
  if (u.available) {
    const r = await dialog.showMessageBox({ message: `Version ${u.latest} is available. You have ${u.current}.`, buttons: ['Download', 'Later'], defaultId: 0 });
    if (r.response === 0) void shell.openExternal(u.url || 'https://github.com/AV360Media/resolume-auto-render/releases');
  } else {
    await dialog.showMessageBox({ message: u.error ? `Could not check for updates: ${u.error}` : `You have the latest version (${u.current}).` });
  }
}

function showWindow() {
  if (!running) return;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0d0f12',
    title: 'Resolume Auto Render',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void win.loadURL(running.url);
  // External links (release page) open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
}

app.on('window-all-closed', () => {
  // Keep running in the tray.
});

app.on('before-quit', (e) => {
  if (!running) return;
  quitting = true;
  e.preventDefault();
  const r = running;
  running = null;
  r.stop().finally(() => app.exit(0));
});

function throttle(fn: () => void, ms: number) {
  let t: NodeJS.Timeout | null = null;
  return () => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
}
