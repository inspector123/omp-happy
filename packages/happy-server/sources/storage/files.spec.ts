import { describe, expect, it } from 'vitest';
import { isPublicFilePath } from './files';

describe('isPublicFilePath', () => {
    it('allows generated public profile images', () => {
        expect(isPublicFilePath('public/users/u1/avatar/image.jpg')).toBe(true);
    });

    it('blocks private session attachments', () => {
        expect(isPublicFilePath('sessions/s1/attachments/private.enc')).toBe(false);
    });

    it('blocks traversal and absolute paths', () => {
        expect(isPublicFilePath('public/../sessions/s1/private.enc')).toBe(false);
        expect(isPublicFilePath('/public/users/u1/avatar.jpg')).toBe(false);
    });
});
