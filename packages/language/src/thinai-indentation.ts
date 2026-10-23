export interface ThinaiIndentationOptions {
    tabSize: number;
    insertSpaces: boolean;
}

/**
 * Infers the document's own indentation style. This is the fallback when the
 * client does not answer a scoped `editor` configuration request.
 */
export function inferIndentationOptions(text: string): ThinaiIndentationOptions {
    const indentation = text.split(/\r\n|\r|\n/u)
        .map(line => /^[ \t]+/u.exec(line)?.[0] ?? '')
        .filter(value => value.length > 0);
    if (indentation.some(value => value.includes('\t'))) {
        return { tabSize: 4, insertSpaces: false };
    }
    const widths = indentation
        .map(value => value.length)
        .filter(width => width > 0);
    if (widths.length === 0) {
        return { tabSize: 2, insertSpaces: true };
    }
    const greatestCommonDivisor = (left: number, right: number): number =>
        right === 0 ? left : greatestCommonDivisor(right, left % right);
    const tabSize = widths.reduce((current, width) => greatestCommonDivisor(current, width), widths[0]!);
    return {
        tabSize: tabSize >= 1 && tabSize <= 8 ? tabSize : 2,
        insertSpaces: true
    };
}

export function applyConfiguredIndentation(
    text: string,
    depth: number,
    tabSize: number,
    insertSpaces: boolean,
    closingDepth?: number,
    additionalIndentationLines: readonly number[] = []
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
    const indentLine = (line: number, lineDepth: number) => {
        if (line > 0 && line < lines.length) {
            lines[line] = `${getIndentation(lineDepth)}${lines[line]!.replace(/^[\t ]*/u, '')}`;
        }
    };
    indentLine(1, safeDepth);
    for (const line of additionalIndentationLines) {
        indentLine(line, safeDepth);
    }
    if (closingDepth !== undefined && lines.length > 2) {
        const lastLine = lines.length - 1;
        indentLine(lastLine, closingDepth);
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
            thinaiIndentationLines?: unknown;
        } | undefined;
        const depth = data?.thinaiIndentationDepth;
        if (typeof depth !== 'number' || !item.textEdit) {
            return item;
        }
        const closingDepth = data?.thinaiClosingIndentationDepth;
        const indentationLines = Array.isArray(data?.thinaiIndentationLines)
            ? data.thinaiIndentationLines.filter((line): line is number => typeof line === 'number')
            : [];
        return {
            ...item,
            textEdit: {
                ...item.textEdit,
                newText: applyConfiguredIndentation(
                    item.textEdit.newText,
                    depth,
                    tabSize,
                    insertSpaces,
                    typeof closingDepth === 'number' ? closingDepth : undefined,
                    indentationLines
                )
            }
        } as T;
    });
}
