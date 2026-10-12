import { AstUtils, type AstNode } from 'langium';

export function isSyntacticallyComplete(node: AstNode): boolean {
    const cstNode = node.$cstNode;
    if (!cstNode) {
        return false;
    }
    const document = AstUtils.getDocument(node);
    const endOfInput = document.textDocument.getText().trimEnd().length;
    const parserErrors = document.parseResult.parserErrors as Array<{ token?: { startOffset: number } }>;
    const lexerErrors = document.parseResult.lexerErrors as Array<{ offset: number }>;
    const hasParserError = parserErrors.some(error => {
        const offset = error.token?.startOffset;
        if (offset === undefined || offset < 0) {
            return cstNode.end >= endOfInput;
        }
        return offset >= cstNode.offset && offset <= cstNode.end;
    });
    const hasLexerError = lexerErrors.some(error => error.offset >= cstNode.offset && error.offset <= cstNode.end);
    return !hasParserError && !hasLexerError;
}
