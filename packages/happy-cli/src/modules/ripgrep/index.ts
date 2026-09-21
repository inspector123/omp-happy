/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { spawn as crossSpawn } from 'cross-spawn';
import { projectPath } from '@/projectPath';
import { join, resolve } from 'path';
import { collectOutput } from '@/utils/boundedOutput';

export interface RipgrepResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface RipgrepOptions {
    cwd?: string
}

/**
 * Run ripgrep with the given arguments
 * @param args - Array of command line arguments to pass to ripgrep
 * @param options - Options for ripgrep execution
 * @returns Promise with exit code, stdout and stderr
 */
export function run(args: string[], options?: RipgrepOptions): Promise<RipgrepResult> {
    const RUNNER_PATH = resolve(join(projectPath(), 'scripts', 'ripgrep_launcher.cjs'));
    // Use cross-spawn so `node` resolves to `node.exe` on Windows (issue #1082).
    const child = crossSpawn('node', [RUNNER_PATH, JSON.stringify(args)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: options?.cwd,
        windowsHide: true,
    });

    return collectOutput(child);
}