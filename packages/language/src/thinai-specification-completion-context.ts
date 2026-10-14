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
            const delimiter = cstNode.text[0];
            return offset === cstNode.end && (delimiter !== '"' && delimiter !== "'" || !cstNode.text.endsWith(delimiter));
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
