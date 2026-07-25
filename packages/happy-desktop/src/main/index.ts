import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncEngine } from '../sync';
import type { Credentials, DesktopState } from '../sync';

const SERVER_URL = process.env.HAPPY_SERVER_URL || 'http://192.168.0.252:30003';

const mainDir = fileURLToPath(new URL('.', import.meta.url));

let mainWindow: BrowserWindow | null = null;
let engine: SyncEngine | null = null;
let engineError: string | null = null;
let quitting = false;

function resolveHomeDir(): string {
  return process.env.HAPPY_HOME_DIR || join(homedir(), '.happy');
}

async function loadCredentials(homeDir: string): Promise<Credentials | null> {
  try {
    const raw = await readFile(join(homeDir, 'access.key'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'token' in parsed &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
    ) {
      return { token: parsed.token, homeDir };
    }
    return null;
  } catch {
    return null;
  }
}

async function readDaemonPort(homeDir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(homeDir, 'daemon.state.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'httpPort' in parsed &&
      typeof parsed.httpPort === 'number' &&
      Number.isInteger(parsed.httpPort) &&
      parsed.httpPort > 0
    ) {
      return parsed.httpPort;
    }
    return null;
  } catch {
    return null;
  }
}

function fallbackState(error: string): DesktopState {
  return { status: 'offline', sessions: [], messages: {}, error };
}

function pushState(state: DesktopState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hd:state', state);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function bootEngine(): Promise<void> {
  const homeDir = resolveHomeDir();
  const credentials = await loadCredentials(homeDir);
  if (!credentials) {
    engineError = `No Happy credentials found at ${join(homeDir, 'access.key')}`;
    console.warn('[happy-desktop]', engineError);
    pushState(fallbackState(engineError));
    return;
  }
  // Tolerate a missing/stale daemon.state.json: keys then come from
  // sessions.json fallback inside the sync core.
  const port = await readDaemonPort(homeDir);
  engine = new SyncEngine({
    serverUrl: SERVER_URL,
    credentials,
    ...(port !== null ? { daemon: { port } } : {}),
  });
  engine.on('state', (state: DesktopState) => pushState(state));
  try {
    await engine.start();
  } catch (err) {
    engineError = errorMessage(err);
    console.error('[happy-desktop] engine start failed:', err);
    pushState(fallbackState(engineError));
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: join(mainDir, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // Belt-and-suspenders: the renderer also pulls via hd:getState on mount.
  mainWindow.webContents.on('did-finish-load', () => {
    if (engine) {
      pushState(engine.getState());
    } else if (engineError) {
      pushState(fallbackState(engineError));
    }
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(mainDir, '../renderer/index.html'));
  }
}

function requireEngine(): SyncEngine {
  if (!engine) {
    throw new Error(engineError ?? 'Sync engine not started');
  }
  return engine;
}

function registerIpc(): void {
  ipcMain.handle('hd:getState', (): DesktopState => {
    return engine?.getState() ?? fallbackState(engineError ?? 'Sync engine not started');
  });
  ipcMain.handle('hd:send', (_event, sessionId: unknown, text: unknown): Promise<void> => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') {
      throw new Error('hd:send expects (sessionId: string, text: string)');
    }
    return requireEngine().sendMessage(sessionId, text);
  });
  ipcMain.handle('hd:open', (_event, sessionId: unknown): Promise<void> => {
    if (typeof sessionId !== 'string') {
      throw new Error('hd:open expects (sessionId: string)');
    }
    return requireEngine().openSession(sessionId);
  });
}

void app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  await bootEngine();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (!quitting && engine) {
    event.preventDefault();
    quitting = true;
    void engine
      .stop()
      .catch(() => undefined)
      .finally(() => app.quit());
  }
});
