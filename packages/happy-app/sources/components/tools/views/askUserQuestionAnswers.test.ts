import { describe, expect, it } from 'vitest';
import {
    AskQuestion,
    buildAskAnswers,
    isQuestionAnswered,
    OTHER_OPTION_INDEX,
} from './askUserQuestionAnswers';

const questions: AskQuestion[] = [
    {
        id: 'phone',
        question: 'Which phone?',
        header: 'Phone',
        options: [{ label: 'Pixel' }, { label: 'Samsung' }],
    },
    {
        id: 'features',
        question: 'Which features?',
        header: 'Features',
        options: [{ label: 'Models' }, { label: 'Thinking' }],
        multiSelect: true,
    },
];

describe('AskUserQuestion answers', () => {
    it('returns predefined single-select answers as strings', () => {
        expect(buildAskAnswers(
            questions,
            new Map([[0, new Set([1])]]),
            new Map(),
        )).toEqual({ phone: 'Samsung' });
    });

    it('requires non-empty custom text when Other is selected', () => {
        const selections = new Map([[0, new Set([OTHER_OPTION_INDEX])]]);
        expect(isQuestionAnswered(0, selections, new Map([[0, '   ']]))).toBe(false);
        expect(isQuestionAnswered(0, selections, new Map([[0, 'Fairphone']]))).toBe(true);
        expect(buildAskAnswers(questions, selections, new Map([[0, '  Fairphone  ']]))).toEqual({
            phone: 'Fairphone',
        });
    });

    it('preserves predefined and custom values in multi-select answers', () => {
        expect(buildAskAnswers(
            questions,
            new Map([[1, new Set([0, OTHER_OPTION_INDEX])]]),
            new Map([[1, 'Custom themes']]),
        )).toEqual({ features: ['Models', 'Custom themes'] });
    });
});
