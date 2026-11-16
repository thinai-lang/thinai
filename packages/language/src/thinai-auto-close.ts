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
