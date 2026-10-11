export function applyConfiguredIndentation(
    text: string,
    depth: number,
    tabSize: number,
    insertSpaces: boolean
): string {
    const lines = text.split(/\r\n|\r|\n/u);
    if (lines.length < 2) {
        return text;
    }
    const safeDepth = Math.max(0, Math.floor(depth));
    const safeTabSize = Number.isFinite(tabSize) && tabSize > 0 ? Math.floor(tabSize) : 2;
    const indentation = insertSpaces ? ' '.repeat(safeDepth * safeTabSize) : '\t'.repeat(safeDepth);
    lines[1] = `${indentation}${lines[1]!.replace(/^[\t ]*/u, '')}`;
    return lines.join(text.match(/\r\n|\r|\n/u)?.[0] ?? '\n');
}

export function applyConfiguredIndentationToCompletions<
    T extends { data?: unknown; textEdit?: { newText: string } }
>(items: T[], tabSize: number, insertSpaces: boolean): T[] {
    return items.map(item => {
        const data = item.data as { thinaiIndentationDepth?: unknown } | undefined;
        const depth = data?.thinaiIndentationDepth;
        if (typeof depth !== 'number' || !item.textEdit) {
            return item;
        }
        return {
            ...item,
            textEdit: {
                ...item.textEdit,
                newText: applyConfiguredIndentation(item.textEdit.newText, depth, tabSize, insertSpaces)
            }
        } as T;
    });
}
