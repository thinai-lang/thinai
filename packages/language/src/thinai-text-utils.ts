import type { LangiumDocument } from 'langium';

/** Returns the document offset for the start of the line containing `offset`. */
export function getLineStartOffset(document: LangiumDocument, offset: number): number {
    const line = document.textDocument.positionAt(offset).line;
    return document.textDocument.offsetAt({ line, character: 0 });
}

/** Returns the document's first observed line delimiter, defaulting to LF. */
export function getNewline(text: string): string {
    return text.match(/\r\n|\r|\n/u)?.[0] ?? '\n';
}

export function getNewlineLengthAt(text: string, offset: number): number {
    if (text.startsWith('\r\n', offset)) {
        return 2;
    }
    return text[offset] === '\r' || text[offset] === '\n' ? 1 : 0;
}

export function normalizeNewlines(text: string): string {
    return text.replace(/\r\n|\r|\n/gu, '\n');
}
