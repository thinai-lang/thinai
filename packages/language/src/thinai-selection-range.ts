import { AstUtils, CstUtils, GrammarUtils, type LangiumDocument } from 'langium';
import { Range, SelectionRange, type Position } from 'vscode-languageserver-types';
import { isMethod, isSpecificationText } from './generated/ast.js';
import { scanThinaiSource } from './thinai-source-scanner.js';

/**
 * Creates a selection hierarchy from the smallest relevant Thinai syntax node
 * through its enclosing constructs. Quoted values start at the complete string.
 */
export function createThinaiSelectionRange(
    document: LangiumDocument,
    position: Position
): SelectionRange | undefined {
    const offset = document.textDocument.offsetAt(position);
    if (scanThinaiSource(document.textDocument.getText().slice(0, offset)).inComment) {
        return createLineSelectionRange(document, position);
    }

    const root = document.parseResult.value.$cstNode;
    if (!root) {
        return createLineSelectionRange(document, position);
    }

    const leaf = CstUtils.findLeafNodeAtOffset(root, offset);
    if (!leaf) {
        return createLineSelectionRange(document, position);
    }

    const specification = AstUtils.getContainerOfType(leaf.astNode, isSpecificationText);
    const method = AstUtils.getContainerOfType(leaf.astNode, isMethod);
    const quotedValue = specification?.$cstNode ?? CstUtils.getDatatypeNode(leaf);
    const projectClause = method ? findProjectClause(method, offset) : undefined;
    const selectionNode = quotedValue ?? projectClause ?? leaf.astNode.$cstNode ?? leaf;

    const ranges: SelectionRange['range'][] = [];
    let current: typeof selectionNode | undefined = selectionNode;
    while (current) {
        const range = current.range;
        const previous = ranges.at(-1);
        if (!previous || previous.start.line !== range.start.line || previous.start.character !== range.start.character
            || previous.end.line !== range.end.line || previous.end.character !== range.end.character) {
            ranges.push(range);
        }
        current = current.container;
    }

    return ranges.reduceRight<SelectionRange | undefined>(
        (parent, range) => SelectionRange.create(range, parent),
        undefined
    );
}

/**
 * Whitespace-only positions have no CST leaf. Returning the enclosing line
 * keeps selection ranges available instead of failing the whole request.
 */
function createLineSelectionRange(document: LangiumDocument, position: Position): SelectionRange {
    return SelectionRange.create(document.textDocument.getLineRange(position.line));
}

function findProjectClause(method: ReturnType<typeof getMethod>, offset: number) {
    const cst = method?.$cstNode;
    if (!cst) {
        return undefined;
    }

    const keywords = GrammarUtils.findNodesForKeyword(cst, 'projects');
    const references = GrammarUtils.findNodesForProperty(cst, 'projects');
    for (let index = 0; index < keywords.length; index++) {
        const keyword = keywords[index]!;
        const nextKeywordOffset = keywords[index + 1]?.offset ?? cst.end;
        const clauseReferences = references.filter(reference =>
            reference.offset >= keyword.end && reference.end <= nextKeywordOffset
        );
        const lastReference = clauseReferences.at(-1);
        if (lastReference && offset >= keyword.offset && offset <= lastReference.end) {
            return {
                ...keyword,
                range: Range.create(keyword.range.start, lastReference.range.end),
                container: keyword.container
            };
        }
    }
    return undefined;
}

function getMethod(node: import('langium').AstNode) {
    return isMethod(node) ? node : AstUtils.getContainerOfType(node, isMethod);
}
