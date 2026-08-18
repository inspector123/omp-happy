/**
 * Herdr utilities
 *
 * Herdr (herdr.dev) is a terminal multiplexer for AI coding agents. The
 * daemon uses it to host OMP sessions in persistent panes so the desktop
 * can attach to the exact live terminal (replacing the previous tmux path
 * for phone-started OMP sessions).
 *
 * Protocol: newline-delimited JSON over a unix socket (default
 * ~/.config/herdr/herdr.sock):
 *
 *   request:  {"id": string, "method": string, "params": object}
 *   response: {"id": string, "result": object}
 *           | {"id": string, "error": {"code": string, "message": string}}
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { logger } from '@/ui/logger';

const HERDR_BIN = 'herdr';

const REQUEST_TIMEOUT_MS = 10_000;
const PING_TIMEOUT_MS = 2_000;
const SERVER_START_TIMEOUT_MS = 15_000;
const SPAWN_PID_POLL_INTERVAL_MS = 200;
const SPAWN_PID_TIMEOUT_MS = 15_000;

export interface HerdrSpawnOptions {
    /** Full command line to run in a fresh pane's shell */
    command: string;
    cwd: string;
    /** Environment for the launched process (merged over the server's) */
    env: Record<string, string>;
    /** Workspace label shown in the herdr UI */
    label: string;
}

export interface HerdrSpawnResult {
    success: boolean;
    /** herdr pane id (e.g. "w2:p1") - the attach target */
    paneId?: string;
    /** PID of the launched process (foreground process group) */
    pid?: number;
    error?: string;
}

interface HerdrErrorBody {
    code: string;
    message: string;
}

interface HerdrResponse {
    id?: string;
    result?: Record<string, unknown>;
    error?: HerdrErrorBody;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Directory holding herdr's config and sockets. Honors HERDR_CONFIG_PATH
 * (a config file path) the same way the herdr CLI does.
 */
export function getHerdrConfigDir(): string {
    const configPath = process.env.HERDR_CONFIG_PATH;
    if (configPath) {
        return path.dirname(configPath);
    }
    return path.join(os.homedir(), '.config', 'herdr');
}

export function getHerdrSocketPath(): string {
    return path.join(getHerdrConfigDir(), 'herdr.sock');
}

/** True when the herdr binary is on PATH. */
export function isHerdrAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(HERDR_BIN, ['--version'], (error) => resolve(!error));
    });
}

/**
 * One request/response round trip against the herdr server socket.
 * Resolves with the `result` object; rejects on socket or API errors.
 */
export function herdrRequest(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(getHerdrSocketPath());
        const id = `happy:${method}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        let settled = false;
        let buffer = '';

        const finish = (error: Error | null, value?: Record<string, unknown>): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (error) {
                reject(error);
            } else {
                resolve(value ?? {});
            }
        };

        const timer = setTimeout(() => {
            finish(new Error(`herdr request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        socket.on('error', (error) => finish(error));
        socket.on('connect', () => {
            socket.write(`${JSON.stringify({ id, method, params })}\n`);
        });
        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex === -1) return;
            const line = buffer.slice(0, newlineIndex);
            if (!line) return;
            try {
                const parsed = JSON.parse(line) as HerdrResponse;
                if (parsed.error) {
                    finish(new Error(`herdr ${method} failed: ${parsed.error.code}: ${parsed.error.message}`));
                } else {
                    finish(null, parsed.result);
                }
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });
}

async function pingHerdr(): Promise<boolean> {
    try {
        await herdrRequest('ping', {}, PING_TIMEOUT_MS);
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensure the herdr server is running. Control commands do NOT auto-start
 * the server, so when the socket is not accepting we launch a headless
 * server detached from the daemon and wait for it to come up.
 */
export async function ensureHerdrServerRunning(): Promise<void> {
    if (await pingHerdr()) {
        return;
    }

    logger.debug('[HERDR] Server not running, starting headless server');
    const child = spawn(HERDR_BIN, ['server'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
    });
    child.unref();

    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await pingHerdr()) {
            logger.debug('[HERDR] Server is up');
            return;
        }
        await sleep(250);
    }
    throw new Error(`herdr server did not start within ${SERVER_START_TIMEOUT_MS}ms`);
}

/**
 * Herdr detects the omp agent by the pane's foreground process name. The
 * daemon's wrapper is a node script, so it is exec'd through a symlink
 * named "omp" (pointing at the node binary) to make the process name
 * match. The symlink lives outside PATH, so the wrapper's own omp binary
 * resolution can never pick it up.
 *
 * Returns the shim path.
 */
export async function ensureHerdrOmpShim(): Promise<string> {
    const shimDir = path.join(os.homedir(), '.local', 'share', 'happy', 'herdr-bin');
    const shimPath = path.join(shimDir, 'omp');
    const nodeBinary = process.execPath;

    await fs.promises.mkdir(shimDir, { recursive: true });

    try {
        const existing = await fs.promises.lstat(shimPath);
        if (existing.isSymbolicLink()) {
            const target = await fs.promises.readlink(shimPath);
            if (target === nodeBinary) {
                return shimPath;
            }
            await fs.promises.rm(shimPath);
        } else {
            // A real file occupies the shim path - never clobber it.
            throw new Error(`refusing to replace existing file at ${shimPath}`);
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('refusing')) {
            throw error;
        }
        // ENOENT - nothing to inspect, fall through and create the link.
    }

    await fs.promises.symlink(nodeBinary, shimPath);
    return shimPath;
}

/**
 * Build the environment for a herdr pane: the daemon's full environment
 * plus the session's extra variables, minus variables that would confuse
 * the pane (stale tmux state, stale herdr caller context - herdr injects
 * its own HERDR_* variables into every pane it manages).
 */
export function buildHerdrPaneEnv(extraEnv: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (key === 'TMUX' || key === 'TMUX_PANE' || key === 'TMUX_SOCKET') continue;
        if (key.startsWith('HERDR_')) continue;
        env[key] = value;
    }
    Object.assign(env, extraEnv);

    // Pin the real omp binary (same precedence the wrapper uses) so the
    // wrapper's resolution can never land on the herdr shim.
    const realOmp = [
        process.env.OMP_HAPPY_REAL_BIN,
        path.join(os.homedir(), '.bun', 'bin', 'omp'),
        path.join(os.homedir(), '.local', 'bin', 'omp'),
    ].find((candidate): candidate is string => typeof candidate === 'string' && fs.existsSync(candidate));
    if (realOmp) {
        env.OMP_HAPPY_REAL_BIN = realOmp;
    }

    return env;
}

/**
 * Spawn a command in a fresh herdr pane and wait for it to become the
 * pane's foreground process.
 *
 * The pane starts at a shell prompt; we send the command line and Enter,
 * then poll pane.process_info until the foreground process group is no
 * longer the shell itself. That PID is the launched process - the same
 * information tmux's -P flag provided on the old path.
 */
export async function spawnInHerdr(options: HerdrSpawnOptions): Promise<HerdrSpawnResult> {
    let paneId: string | undefined;
    try {
        const created = (await herdrRequest('workspace.create', {
            cwd: options.cwd,
            env: options.env,
            label: options.label,
            focus: false,
        })) as { root_pane?: { pane_id?: string } };
        paneId = created.root_pane?.pane_id;
        if (!paneId) {
            return { success: false, error: 'herdr workspace.create did not return a pane id' };
        }

        await herdrRequest('pane.send_text', { pane_id: paneId, text: options.command });
        await herdrRequest('pane.send_keys', { pane_id: paneId, keys: ['Enter'] });

        const deadline = Date.now() + SPAWN_PID_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const info = (await herdrRequest('pane.process_info', { pane_id: paneId })) as {
                process_info?: {
                    shell_pid?: number;
                    foreground_process_group_id?: number;
                    foreground_processes?: Array<{ pid?: number }>;
                };
            };
            const processInfo = info.process_info;
            const foregroundPid = processInfo?.foreground_processes?.[0]?.pid;
            if (
                processInfo?.shell_pid !== undefined
                && processInfo.foreground_process_group_id !== undefined
                && processInfo.foreground_process_group_id !== processInfo.shell_pid
                && foregroundPid
            ) {
                return { success: true, paneId, pid: foregroundPid };
            }
            await sleep(SPAWN_PID_POLL_INTERVAL_MS);
        }

        return {
            success: false,
            paneId,
            error: `herdr pane ${paneId} did not start a foreground process within ${SPAWN_PID_TIMEOUT_MS}ms`,
        };
    } catch (error) {
        return {
            success: false,
            paneId,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Attach the current terminal to a herdr pane. Requires a TTY, the same
 * requirement as tmux attach.
 */
export function attachHerdrPane(paneId: string): void {
    execFileSync(HERDR_BIN, ['agent', 'attach', paneId], { stdio: 'inherit' });
}

/**
 * Rename the herdr workspace hosting a pane so the herdr TUI shows the
 * session's own title instead of the spawn-time label. The pane id is
 * "workspace:pane" (e.g. "w2:p1"); the workspace id is the part before
 * the colon.
 */
export async function renameHerdrWorkspaceForPane(paneId: string, label: string): Promise<void> {
    const workspaceId = paneId.split(':')[0];
    if (!workspaceId) return;
    const cleanLabel = label.replace(/\s+/g, ' ').trim();
    if (!cleanLabel) return;
    await herdrRequest('workspace.rename', {
        workspace_id: workspaceId,
        label: cleanLabel,
    });
}
