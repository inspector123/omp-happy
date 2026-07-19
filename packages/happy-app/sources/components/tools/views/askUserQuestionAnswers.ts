export interface AskQuestionOption {
    label: string;
    description?: string;
}

export interface AskQuestion {
    id?: string;
    question: string;
    header: string;
    options: AskQuestionOption[];
    multiSelect?: boolean;
}

export type AskAnswer = string | string[];
export const OTHER_OPTION_INDEX = -1;

export function getAnswerValues(
    question: AskQuestion,
    questionIndex: number,
    selections: Map<number, Set<number>>,
    customAnswers: Map<number, string>,
): string[] {
    const selected = selections.get(questionIndex);
    if (!selected?.size) return [];
    return Array.from(selected)
        .map(optionIndex => optionIndex === OTHER_OPTION_INDEX
            ? customAnswers.get(questionIndex)?.trim()
            : question.options[optionIndex]?.label)
        .filter((value): value is string => Boolean(value));
}

export function buildAskAnswers(
    questions: AskQuestion[],
    selections: Map<number, Set<number>>,
    customAnswers: Map<number, string>,
): Record<string, AskAnswer> {
    const answers: Record<string, AskAnswer> = {};
    questions.forEach((question, questionIndex) => {
        const values = getAnswerValues(question, questionIndex, selections, customAnswers);
        if (values.length > 0) {
            answers[question.id ?? question.question] = question.multiSelect === true ? values : values[0];
        }
    });
    return answers;
}

export function isQuestionAnswered(
    questionIndex: number,
    selections: Map<number, Set<number>>,
    customAnswers: Map<number, string>,
): boolean {
    const selected = selections.get(questionIndex);
    if (!selected?.size) return false;
    return !selected.has(OTHER_OPTION_INDEX) || Boolean(customAnswers.get(questionIndex)?.trim());
}
