import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncEngine, defaultHappyHomeDir } from '../sync';
import type { Credentials, DesktopState, SpawnSessionResult } from '../sync';

type ServerConfiguration =
  | { url: string; error: null }
  | { url: null; error: string };

function readServerConfiguration(): ServerConfiguration {
  const value = process.env.HAPPY_SERVER_URL?.trim();
  if (!value) {
    return {
      url: null,
      error: 'HAPPY_SERVER_URL is required. Set it to the HTTP(S) origin of your Happy server before starting Electron.',
    };
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('expected an HTTP(S) origin with no credentials, path, query, or fragment');
    }
    return { url: parsed.origin, error: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid URL';
    return { url: null, error: `Invalid HAPPY_SERVER_URL: ${detail}` };
  }
}

const SERVER_CONFIGURATION = readServerConfiguration();

const mainDir = fileURLToPath(new URL('.', import.meta.url));

let mainWindow: BrowserWindow | null = null;
let engine: SyncEngine | null = null;
let engineError: string | null = null;
let quitting = false;

type SpawnSessionAgent = 'omp' | 'claude' | 'codex' | 'gemini' | 'openclaw';

const SUPPORTED_SPAWN_AGENTS: Record<SpawnSessionAgent, true> = {
  omp: true,
  claude: true,
  codex: true,
  gemini: true,
  openclaw: true,
};

function isSpawnSessionAgent(value: string): value is SpawnSessionAgent {
  return Object.hasOwn(SUPPORTED_SPAWN_AGENTS, value);
}

interface SpawnSessionInput {
  machineId: string;
  directory: string;
  agent: SpawnSessionAgent;
}

function parseSpawnSessionInput(value: unknown): SpawnSessionInput {
  if (typeof value !== 'object' || value === null) {
    throw new Error('New session details are required');
  }
  const input = value as Record<string, unknown>;
  const machineId = typeof input.machineId === 'string' ? input.machineId.trim() : '';
  const directory = typeof input.directory === 'string' ? input.directory.trim() : '';
  const agent = typeof input.agent === 'string' ? input.agent.trim() : '';
  if (!machineId) {
    throw new Error('Choose a machine before starting a session');
  }
  if (!directory) {
    throw new Error('Enter a directory before starting a session');
  }
  if (!isSpawnSessionAgent(agent)) {
    throw new Error('Choose a supported agent before starting a session');
  }
  return { machineId, directory, agent };
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
  if (SERVER_CONFIGURATION.url === null) {
    const configurationError = SERVER_CONFIGURATION.error;
    engineError = configurationError;
    console.error('[happy-desktop]', configurationError);
    pushState(fallbackState(configurationError));
    return;
  }
  const homeDir = defaultHappyHomeDir();
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
    serverUrl: SERVER_CONFIGURATION.url,
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
  ipcMain.handle('hd:spawn', (_event, input: unknown): Promise<SpawnSessionResult> => {
    const request = parseSpawnSessionInput(input);
    const syncEngine = requireEngine();
    if (!syncEngine.getState().sessions.some((session) => session.machineId === request.machineId)) {
      throw new Error('The selected machine is no longer available in synced session metadata');
    }
    return syncEngine.spawnSession(request.machineId, request.directory, request.agent);
  });
  ipcMain.handle(
    'hd:stopSession',
    (_event, sessionId: unknown): Promise<{ success: boolean; message: string }> => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new Error('Choose an active session before stopping it');
      }
      return requireEngine().killSession(sessionId.trim());
    },
  );
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
