/** Lexical structure needed by editor features while a document is incomplete. */
export interface ThinaiSourceStructure {
    braces: Array<{ character: '{' | '}'; offset: number }>;
    openBraces: number;
    unterminatedString: boolean;
}

/**
 * Scans Thinai source without treating braces inside quoted text or comments as
 * structural. Langium's CST remains the source of truth for parsed documents;
 * this scanner is for cursor prefixes that may not form a complete CST node.
 */
export function scanThinaiSource(source: string): ThinaiSourceStructure {
    let quote: '"' | "'" | undefined;
    let tripleQuoted = false;
    let escaped = false;
    let blockComment = false;
    let lineComment = false;
    let openBraces = 0;
    const braces: ThinaiSourceStructure['braces'] = [];

    for (let offset = 0; offset < source.length; offset++) {
        const character = source[offset]!;
        const next = source[offset + 1];
        if (lineComment) {
            if (character === '\n' || character === '\r') {
                lineComment = false;
            }
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') {
                blockComment = false;
                offset++;
            }
            continue;
        }
        if (quote && escaped) {
            escaped = false;
        } else if (quote && character === '\\') {
            escaped = true;
        } else if (quote && tripleQuoted) {
            if (character === '"' && source.slice(offset, offset + 3) === '"""') {
                quote = undefined;
                tripleQuoted = false;
                offset += 2;
            }
        } else if (quote && character === quote) {
            quote = undefined;
        } else if (quote) {
            continue;
        } else if (character === '/' && next === '/') {
            lineComment = true;
            offset++;
        } else if (character === '/' && next === '*') {
            blockComment = true;
            offset++;
        } else if (character === '"' && source.slice(offset, offset + 3) === '"""') {
            quote = '"';
            tripleQuoted = true;
            offset += 2;
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '{' || character === '}') {
            braces.push({ character, offset });
            openBraces += character === '{' ? 1 : -1;
        }
    }

    return { braces, openBraces, unterminatedString: quote !== undefined };
}
