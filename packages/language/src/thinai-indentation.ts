export function applyConfiguredIndentation(
    text: string,
    depth: number,
    tabSize: number,
    insertSpaces: boolean,
    closingDepth?: number
): string {
    const lines = text.split(/\r\n|\r|\n/u);
    if (lines.length < 2) {
        return text;
    }
    const safeDepth = Math.max(0, Math.floor(depth));
    const safeTabSize = Number.isFinite(tabSize) && tabSize > 0 ? Math.floor(tabSize) : 2;
    const getIndentation = (lineDepth: number): string => {
        const safeLineDepth = Math.max(0, Math.floor(lineDepth));
        return insertSpaces ? ' '.repeat(safeLineDepth * safeTabSize) : '\t'.repeat(safeLineDepth);
    };
    lines[1] = `${getIndentation(safeDepth)}${lines[1]!.replace(/^[\t ]*/u, '')}`;
    if (closingDepth !== undefined && lines.length > 2) {
        const lastLine = lines.length - 1;
        lines[lastLine] = `${getIndentation(closingDepth)}${lines[lastLine]!.replace(/^[\t ]*/u, '')}`;
    }
    return lines.join(text.match(/\r\n|\r|\n/u)?.[0] ?? '\n');
}

export function applyConfiguredIndentationToCompletions<
    T extends { data?: unknown; textEdit?: { newText: string } }
>(items: T[], tabSize: number, insertSpaces: boolean): T[] {
    return items.map(item => {
        const data = item.data as {
            thinaiIndentationDepth?: unknown;
            thinaiClosingIndentationDepth?: unknown;
        } | undefined;
        const depth = data?.thinaiIndentationDepth;
        if (typeof depth !== 'number' || !item.textEdit) {
            return item;
        }
        const closingDepth = data?.thinaiClosingIndentationDepth;
        return {
            ...item,
            textEdit: {
                ...item.textEdit,
                newText: applyConfiguredIndentation(
                    item.textEdit.newText,
                    depth,
                    tabSize,
                    insertSpaces,
                    typeof closingDepth === 'number' ? closingDepth : undefined
                )
            }
        } as T;
    });
}
