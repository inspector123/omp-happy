/**
 * LIVE end-to-end test against the real self-hosted server.
 *
 * Gated on HD_LIVE=1 and explicit endpoint/credential paths so a test can
 * never contact a developer's server by accident.
 * Run with:
 *   HD_LIVE=1 HAPPY_SERVER_URL=https://happy.example \
 *   HAPPY_HOME_DIR="$HOME/.happy-self-host" \
 *   pnpm --filter happy-desktop exec vitest run tests/live.e2e.test.ts
 *
 * Flow: connect with the selected credentials, spawn an `omp` session through
 * the selected daemon, then verify a streamed agent reply.
 */

import { describe, it, expect } from 'vitest';
import { SyncEngine } from '../src/sync/syncEngine';
import { loadCredentials, readMachineId } from '../src/sync/credentials';
import { readDaemonPort, stopDaemonSession } from '../src/sync/daemonClient';
import type { DesktopState } from '../src/sync/types';

const LIVE = process.env.HD_LIVE === '1';

function requiredLiveEnv(name: 'HAPPY_SERVER_URL' | 'HAPPY_HOME_DIR'): string {
  const value = process.env[name]?.trim();
  if (LIVE && !value) {
    throw new Error(`${name} is required when HD_LIVE=1`);
  }
  return value ?? '';
}

const SERVER_URL = requiredLiveEnv('HAPPY_SERVER_URL');
const HOME_DIR = requiredLiveEnv('HAPPY_HOME_DIR');
const SPAWN_DIRECTORY = process.env.HAPPY_E2E_DIRECTORY ?? process.cwd();
const E2E_TEXT = 'Reply with exactly: DESKTOP-E2E-OK';
const E2E_TOKEN = 'DESKTOP-E2E-OK';

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    // Live integration: polling real network/daemon state — fake timers cannot
    // drive the server, daemon, or socket, so a real interval is required here.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for: ${description}`
    + (lastError instanceof Error ? ` (last error: ${lastError.message})` : ''),
  );
}

describe.skipIf(!LIVE)('live e2e (HD_LIVE=1)', () => {
  it(
    'syncs sessions, spawns via machineRPC, streams a decrypted agent reply',
    { timeout: 300_000 },
    async () => {
      const credentials = await loadCredentials(HOME_DIR);
      const daemonPort = await readDaemonPort(HOME_DIR);
      expect(daemonPort, 'daemon.state.json httpPort — is the daemon running?').not.toBeNull();

      const engine = new SyncEngine({
        serverUrl: SERVER_URL,
        credentials: { token: credentials.token, homeDir: HOME_DIR },
        daemon: { port: daemonPort! },
      });

      const states: DesktopState[] = [];
      engine.on('state', (s: DesktopState) => states.push(s));
      let spawnedId = '';

      try {
        await engine.start();

        // 1. Sessions listed, at least one with an available key.
        await waitFor(
          'session list with at least one keyAvailable session',
          () => engine.getState().sessions.some((s) => s.keyAvailable),
          30_000,
        );
        const withKey = engine.getState().sessions.find((s) => s.keyAvailable)!;

        // 2. openSession -> decrypted messages non-empty.
        await engine.openSession(withKey.id);
        await waitFor(
          `decrypted messages for existing session ${withKey.id}`,
          () => (engine.getState().messages[withKey.id] ?? []).length > 0,
          30_000,
        );
        const existing = engine.getState().messages[withKey.id];
        expect(existing.some((m) => m.text.length > 0)).toBe(true);

        // 3. machineRPC spawn -> new session appears in engine state.
        const machineId = withKey.machineId ?? await readMachineId(HOME_DIR);
        expect(machineId, 'machineId from session metadata or settings.json').toBeTruthy();
        const spawn = await engine.spawnSession(machineId!, SPAWN_DIRECTORY, 'omp');
        expect(spawn.type).toBe('success');
        spawnedId = spawn.type === 'success' ? spawn.sessionId : '';
        expect(spawnedId).not.toBe('');

        await waitFor(
          `spawned session ${spawnedId} to appear with a key`,
          () => engine.getState().sessions.some((s) => s.id === spawnedId && s.keyAvailable),
          90_000,
        );

        // 4. openSession on the spawned session, then send the e2e prompt.
        await engine.openSession(spawnedId);
        await engine.sendMessage(spawnedId, E2E_TEXT);

        // 5. A streamed agent reply containing DESKTOP-E2E-OK arrives within 120s.
        await waitFor(
          'agent reply containing DESKTOP-E2E-OK',
          () => (engine.getState().messages[spawnedId] ?? []).some(
            (m) => m.role === 'agent' && m.kind === 'text' && m.text.includes(E2E_TOKEN),
          ),
          120_000,
        );
      } finally {
        const stopped = spawnedId ? await stopDaemonSession(daemonPort!, spawnedId) : true;
        await engine.stop();
        if (!stopped) {
          throw new Error(`Failed to stop e2e session ${spawnedId}`);
        }
      }
    },
  );
});
