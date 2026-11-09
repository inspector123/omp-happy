/**
 * `@` mentions of files in the session's working directory.
 *
 * omp reads each `@path` in a sent message and attaches that file: images as
 * images, text inline, folders as a listing. Its parser takes `@"..."`,
 * `@'...'`, or a bare `@path` that ends at whitespace or another `@`, and
 * strips leading quotes and brackets and trailing punctuation from a bare
 * path. Paths that would be cut or trimmed are therefore quoted.
 */
const NEEDS_QUOTES = /[\s@]|^[`"'([{<]|[)\]}>.,;:!?"'`]$/;

export function formatFileMention(path: string): string {
    if (!NEEDS_QUOTES.test(path)) return `@${path}`;
    if (!path.includes('"')) return `@"${path}"`;
    if (!path.includes("'")) return `@'${path}'`;
    // A path with both quote characters has no form that omp reads intact.
    return `@${path}`;
}

/** Appends mentions of `paths` to message text and leaves a trailing space for typing. */
export function appendFileMentions(text: string, paths: readonly string[]): string {
    if (paths.length === 0) return text;
    const separator = text.length === 0 || /\s$/.test(text) ? '' : ' ';
    return `${text}${separator}${paths.map(formatFileMention).join(' ')} `;
}
