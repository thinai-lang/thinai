import { AstUtils, type LangiumDocument } from 'langium';
import { isModel, isSpecificationText, isSpecificationTextPart } from './generated/ast.js';

export type SpecificationCompletionContext = 'text' | 'reference' | undefined;

/** Distinguishes prose from a linked reference while a specification string is incomplete. */
export function getSpecificationCompletionContext(
    document: LangiumDocument,
    offset: number
): SpecificationCompletionContext {
    const model = document.parseResult.value;
    if (!isModel(model)) {
        return undefined;
    }
    const specification = AstUtils.streamAst(model)
        .filter(isSpecificationText)
        .filter(node => {
            const cstNode = node.$cstNode;
            if (!cstNode || offset <= cstNode.offset) {
                return false;
            }
            if (offset < cstNode.end) {
                return true;
            }
            return offset === cstNode.end && !hasClosingDelimiter(cstNode.text);
        })
        .toArray()
        .sort((left, right) =>
            (left.$cstNode!.end - left.$cstNode!.offset) - (right.$cstNode!.end - right.$cstNode!.offset)
        )[0];
    if (!specification) {
        return undefined;
    }
    const inReference = specification.parts.some(part => {
        if (!isSpecificationTextPart(part) || !part.$cstNode) {
            return false;
        }
        const isReferencePart = part.target !== undefined || part.$cstNode.text.startsWith('[[');
        return isReferencePart && part.$cstNode.offset <= offset && offset <= part.$cstNode.end;
    });
    return inReference ? 'reference' : 'text';
}

function hasClosingDelimiter(text: string): boolean {
    const delimiter = text.startsWith('"""') ? '"""' : text[0];
    if (delimiter !== '"""' && delimiter !== '"' && delimiter !== "'") {
        return false;
    }
    if (!text.endsWith(delimiter)) {
        return false;
    }
    let precedingBackslashes = 0;
    for (let index = text.length - delimiter.length - 1; index >= 0 && text[index] === '\\'; index--) {
        precedingBackslashes++;
    }
    return precedingBackslashes % 2 === 0;
}
