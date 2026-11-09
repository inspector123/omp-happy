import { describe, expect, it } from 'vitest';
import { buildOmpSessionArgs } from './ompSessionArgs';

describe('buildOmpSessionArgs', () => {
    it('forks instead of resuming, so the source session is never continued in place', () => {
        expect(buildOmpSessionArgs({
            resumeOmpSessionId: 'omp-source',
            forkOmpSessionId: 'omp-source',
            ompModel: 'zlocal/glm-5.3-flash',
        })).toEqual(['--fork', 'omp-source', '--model', 'zlocal/glm-5.3-flash']);
    });

    it('resumes, or starts fresh, with an optional model', () => {
        expect(buildOmpSessionArgs({ resumeOmpSessionId: 'omp-existing' })).toEqual(['--resume', 'omp-existing']);
        expect(buildOmpSessionArgs({ ompModel: 'anthropic/claude-opus-5-5' })).toEqual(['--model', 'anthropic/claude-opus-5-5']);
        expect(buildOmpSessionArgs({})).toEqual([]);
    });
});
