/**
 * Tests for capped child-process output collection
 */

import { spawn } from 'node:child_process'
import { describe, it, expect } from 'vitest'
import { collectOutput } from './boundedOutput'

const nodeCmd = (script: string) => spawn('node', ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })

describe('collectOutput', () => {
    it('caps a flooding child instead of growing a string without bound', async () => {
        const cap = 16 * 1024
        const line = `${'a'.repeat(63)}\n`
        const child = nodeCmd(`const line = ${JSON.stringify(line)}; for (let i = 0; i < 64; i++) process.stdout.write(line.repeat(256))`)

        const result = await collectOutput(child, cap)

        expect(result.truncated).toBe(true)
        expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(cap)
        expect(result.stdout.endsWith('\n')).toBe(true)
        expect(result.stderr).toContain('output truncated')
    })

    it('returns complete output when the child stays under the cap', async () => {
        const child = nodeCmd("process.stdout.write('one\\ntwo\\n')")

        const result = await collectOutput(child, 1024)

        expect(result).toEqual({ exitCode: 0, stdout: 'one\ntwo\n', stderr: '', truncated: false })
    })

    it('reports the child exit code', async () => {
        const child = nodeCmd('process.exit(3)')

        const result = await collectOutput(child, 1024)

        expect(result.exitCode).toBe(3)
        expect(result.truncated).toBe(false)
    })
})
