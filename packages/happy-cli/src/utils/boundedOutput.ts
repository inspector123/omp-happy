/**
 * Child-process output collection with a hard byte cap.
 *
 * A child can stream hundreds of megabytes in one call (for example
 * `rg --files --follow` started in a home directory). Appending that to a
 * single string eventually throws `RangeError: Invalid string length` from
 * inside a stream 'data' handler, and that uncaught error kills the whole CLI
 * process. Collection therefore stops at the cap and the child is stopped.
 */

import type { ChildProcess } from 'node:child_process';

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface BoundedOutput {
    exitCode: number
    stdout: string
    stderr: string
    truncated: boolean
}

const TRUNCATION_NOTE = '\n[output truncated: the command produced more than the collection limit and was stopped]\n';

export function collectOutput(child: ChildProcess, maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES): Promise<BoundedOutput> {
    const { promise, resolve, reject } = Promise.withResolvers<BoundedOutput>();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    const keep = (chunks: Buffer[], size: number, data: Buffer): number => {
        if (size >= maxBytes) return size;
        const room = maxBytes - size;
        const chunk = data.length > room ? data.subarray(0, room) : data;
        chunks.push(chunk);
        return size + chunk.length;
    };

    const stopFlood = (): void => {
        if (truncated) return;
        truncated = true;
        child.kill();
    };

    child.stdout?.on('data', (data: Buffer) => {
        stdoutBytes = keep(stdoutChunks, stdoutBytes, data);
        if (stdoutBytes >= maxBytes) stopFlood();
    });

    child.stderr?.on('data', (data: Buffer) => {
        stderrBytes = keep(stderrChunks, stderrBytes, data);
        if (stderrBytes >= maxBytes) stopFlood();
    });

    child.on('error', reject);

    child.on('close', (code) => {
        let stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        if (truncated) {
            // Drop a partial trailing line so callers never see half a path or half a match.
            const lastNewline = stdout.lastIndexOf('\n');
            if (lastNewline !== -1) stdout = stdout.slice(0, lastNewline + 1);
        }
        resolve({
            exitCode: code || 0,
            stdout,
            stderr: truncated ? stderr + TRUNCATION_NOTE : stderr,
            truncated
        });
    });

    return promise;
}
