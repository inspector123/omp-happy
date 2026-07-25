import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncEngine } from '../src/sync/syncEngine';
import { loadCredentials, readMachineId } from '../src/sync/credentials';
import { readDaemonPort, stopDaemonSession } from '../src/sync/daemonClient';

// Live desktop e2e: requires a real server + daemon + credentials.
// Run with: HD_LIVE=1 pnpm --filter happy-desktop build && pnpm --filter happy-desktop test:e2e
const LIVE = process.env.HD_LIVE === '1';
test.skip(!LIVE, 'Live desktop e2e is gated on HD_LIVE=1');

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const SERVER_URL = process.env.HAPPY_SERVER_URL ?? 'http://192.168.0.252:30003';
const HOME_DIR = process.env.HAPPY_HOME_DIR ?? join(homedir(), '.omp-happy');
const SPAWN_DIRECTORY = join(homedir(), 'projects/omp-happy/tmp');

async function waitFor(description: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 500);
    await promise;
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

// electron.launch requires string-only env values; process.env may hold undefined.
const launchEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) {
    launchEnv[key] = value;
  }
}
// The app under test must use the same credentials/server as the test-side engine.
launchEnv.HAPPY_HOME_DIR = HOME_DIR;
launchEnv.HAPPY_SERVER_URL = SERVER_URL;

test.describe.configure({ timeout: 180_000 });

test('session list -> open session -> send message -> streamed reply', async () => {
  // Spawn a dedicated throwaway session via machineRPC (acting as the phone)
  // so the UI flow never touches the user's real sessions.
  const credentials = await loadCredentials(HOME_DIR);
  const daemonPort = await readDaemonPort(HOME_DIR);
  if (daemonPort === null) throw new Error(`daemon.state.json httpPort missing in ${HOME_DIR} — is the daemon running?`);
  const engine = new SyncEngine({
    serverUrl: SERVER_URL,
    credentials: { token: credentials.token, homeDir: HOME_DIR },
    daemon: { port: daemonPort },
  });
  await engine.start();
  let spawnedId = '';
  try {
    await waitFor('engine session list with keys', () => engine.getState().sessions.some((s) => s.keyAvailable), 30_000);
    const machineId = await readMachineId(HOME_DIR);
    if (!machineId) throw new Error(`machineId missing in ${HOME_DIR}/settings.json`);
    const spawn = await engine.spawnSession(machineId, SPAWN_DIRECTORY, 'omp');
    if (spawn.type !== 'success') {
      throw new Error(`spawn failed: ${JSON.stringify(spawn)}`);
    }
    spawnedId = spawn.sessionId;
  } finally {
    await engine.stop();
  }

  try {
    const mainEntry = join(packageRoot, 'out/main/index.js');
    if (!existsSync(mainEntry)) {
      throw new Error(`Build output missing at ${mainEntry} — run "pnpm --filter happy-desktop build" first`);
    }

    const app = await electron.launch({
      args: ['.'],
      cwd: packageRoot,
      env: launchEnv,
      timeout: 60_000,
    });

    try {
      const page = await app.firstWindow();

      const sessionList = page.locator('[data-testid="session-list"]');
      await sessionList.waitFor({ state: 'visible', timeout: 60_000 });

      // The spawned session is identified by id — never an arbitrary user session.
      const spawnedItem = page.locator(`[data-session-id="${spawnedId}"]`);
      await spawnedItem.waitFor({ state: 'visible', timeout: 90_000 });
      await spawnedItem.click();

      const composer = page.locator('[data-testid="composer-input"]');
      await composer.waitFor({ state: 'visible', timeout: 30_000 });
      await composer.fill('Reply with exactly: DESKTOP-E2E-OK');
      await composer.press('Enter');

      await expect(page.locator('[data-testid="message-list"]')).toContainText('DESKTOP-E2E-OK', {
        timeout: 120_000,
      });
    } finally {
      await app.close();
    }
  } finally {
    const stopped = spawnedId ? await stopDaemonSession(daemonPort, spawnedId) : true;
    if (!stopped) {
      throw new Error(`Failed to stop e2e session ${spawnedId}`);
    }
  }
});
