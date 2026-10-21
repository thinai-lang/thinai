import { AstUtils, type AstNode } from 'langium';

interface ParserErrorWithPreviousToken {
    token?: { startOffset: number };
    previousToken?: { startOffset: number; endOffset: number };
}

export function isSyntacticallyComplete(node: AstNode): boolean {
    const cstNode = node.$cstNode;
    if (!cstNode) {
        return false;
    }
    const document = AstUtils.getDocument(node);
    const endOfInput = document.textDocument.getText().trimEnd().length;
    const parserErrors = document.parseResult.parserErrors as ParserErrorWithPreviousToken[];
    const lexerErrors = document.parseResult.lexerErrors as Array<{ offset: number }>;
    const hasParserError = parserErrors.some(error => {
        const offset = error.token?.startOffset;
        if (offset === undefined || offset < 0) {
            return cstNode.end >= endOfInput;
        }
        if (offset >= cstNode.offset && offset <= cstNode.end) {
            return true;
        }
        // A missing token discovered at the token following the node still
        // belongs to the incomplete construct (for example an unfinished
        // transition whose recovery stops at the parent's closing brace).
        const previousToken = error.previousToken;
        return previousToken !== undefined &&
            previousToken.startOffset >= cstNode.offset &&
            previousToken.endOffset <= cstNode.end &&
            offset >= cstNode.end;
    });
    const hasLexerError = lexerErrors.some(error => error.offset >= cstNode.offset && error.offset <= cstNode.end);
    return !hasParserError && !hasLexerError;
}

export function hasReferenceText(reference: unknown): boolean {
    return typeof reference === 'object' && reference !== null &&
        '$refText' in reference && typeof reference.$refText === 'string' && reference.$refText.length > 0;
}
