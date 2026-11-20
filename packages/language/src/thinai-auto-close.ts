/**
 * VS Code removes single-character auto-closing pairs when the opener is
 * deleted, but not multi-character pairs such as `[[`/`]]`. This returns the
 * closer range to remove after a deletion immediately before one or two `]`.
 */
export function getSpecificationLinkAutoDeleteRange(
    previousText: string,
    currentText: string,
    rangeOffset: number,
    rangeLength: number,
    insertedText: string
): { start: number; end: number } | undefined {
    if (insertedText.length > 0 || rangeLength === 0 || rangeOffset < 0) {
        return undefined;
    }
    const doubleCloser = currentText.slice(rangeOffset, rangeOffset + 2) === ']]';
    if (!doubleCloser && currentText[rangeOffset] !== ']') {
        return undefined;
    }
    const deleted = previousText.slice(rangeOffset, rangeOffset + rangeLength);
    if (deleted.endsWith('[[')) {
        return { start: rangeOffset, end: rangeOffset + (doubleCloser ? 2 : 1) };
    }
    if (deleted === '[') {
        return { start: rangeOffset, end: rangeOffset + 1 };
    }
    return undefined;
}

/**
 * VS Code removes single-character auto-closing pairs when the opener is
 * deleted, but not multi-character pairs such as `"""`/`"""`. This returns the
 * closing delimiter range to remove after a deletion inside an opening triple
 * quote.
 */
export function getTripleQuoteAutoDeleteRange(
    previousText: string,
    currentText: string,
    rangeOffset: number,
    rangeLength: number,
    insertedText: string
): { start: number; end: number } | undefined {
    if (insertedText.length > 0 || rangeLength === 0 || rangeOffset < 0) {
        return undefined;
    }
    const deleted = previousText.slice(rangeOffset, rangeOffset + rangeLength);
    if (!/^"+$/u.test(deleted)) {
        return undefined;
    }

    let runStart = rangeOffset;
    while (runStart > 0 && previousText[runStart - 1] === '"') {
        runStart--;
    }
    let runEnd = rangeOffset + rangeLength;
    while (runEnd < previousText.length && previousText[runEnd] === '"') {
        runEnd++;
    }
    if (runEnd - runStart < 3 || rangeOffset > runStart + 2) {
        return undefined;
    }

    // Only an opening delimiter is preceded by a specification keyword or
    // `import`; a closing delimiter is preceded by string content.
    const prefix = previousText.slice(0, runStart).trimEnd();
    if (!/\b(?:behavior|invariant|precondition|postcondition|when|with|import)$/u.test(prefix)) {
        return undefined;
    }

    const runLength = runEnd - runStart;
    if (runLength >= 6) {
        // An empty auto-closed string is one contiguous run of six quotes.
        // VS Code may delete quotes from both ends of that run, so keep the
        // number of opening quotes the user still has and drop the rest.
        const openingDeleted = Math.max(0, Math.min(rangeOffset + rangeLength, runStart + 3) - rangeOffset);
        const remainingOpening = Math.max(0, 3 - openingDeleted);
        let currentRunEnd = runStart + remainingOpening;
        while (currentText[currentRunEnd] === '"') {
            currentRunEnd++;
        }
        const closerStart = runStart + remainingOpening;
        return currentRunEnd > closerStart
            ? { start: closerStart, end: currentRunEnd }
            : undefined;
    }

    let searchFrom = rangeOffset;
    while (currentText[searchFrom] === '"') {
        searchFrom++;
    }
    const closerStart = findClosingTriple(currentText, searchFrom);
    return closerStart === undefined
        ? undefined
        : { start: closerStart, end: closerStart + 3 };
}

function findClosingTriple(text: string, from: number): number | undefined {
    for (let index = from; index + 3 <= text.length; index++) {
        if (text.startsWith('"""', index) && !isEscaped(text, index)) {
            return index;
        }
    }
    return undefined;
}

function isEscaped(text: string, index: number): boolean {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}
