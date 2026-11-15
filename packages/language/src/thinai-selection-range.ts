import { AstUtils, CstUtils, GrammarUtils, type AstNode, type LangiumDocument, type Reference } from 'langium';
import { Range, SelectionRange, type Position } from 'vscode-languageserver-types';
import { isMethod, isSpecificationText, isSpecificationTextPart } from './generated/ast.js';
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
    const projectClause = method ? findProjectClause(method, offset) : undefined;
    let referenceNode = findReferenceNode(leaf.astNode, offset);
    let pathRanges = referenceNode ? createPathSelectionRanges(document, referenceNode, offset) : [];
    if (pathRanges.length === 0) {
        const specificationPart = AstUtils.getContainerOfType(leaf.astNode, isSpecificationTextPart);
        if (specificationPart) {
            const partRanges = createPathSelectionRanges(document, specificationPart, offset);
            if (partRanges.length > 0) {
                referenceNode = specificationPart;
                pathRanges = partRanges;
            }
        }
    }

    const quotedValue = specification?.$cstNode ?? CstUtils.getDatatypeNode(leaf);
    const base = projectClause ?? referenceNode?.$cstNode ?? quotedValue ?? leaf.astNode.$cstNode ?? leaf;
    const ranges: SelectionRange['range'][] = [];
    const pushRange = (range: SelectionRange['range']): void => {
        const previous = ranges.at(-1);
        if (!previous || previous.start.line !== range.start.line ||
            previous.start.character !== range.start.character ||
            previous.end.line !== range.end.line ||
            previous.end.character !== range.end.character) {
            ranges.push(range);
        }
    };
    for (const range of pathRanges) {
        pushRange(range);
    }
    if (base) {
        pushRange(base.range);
        let current = base.container;
        while (current) {
            pushRange(current.range);
            current = current.container;
        }
    }

    return ranges.reduceRight<SelectionRange | undefined>(
        (parent, range) => SelectionRange.create(range, parent),
        undefined
    );
}

function findReferenceNode(node: AstNode, offset: number): AstNode | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        const references = AstUtils.streamReferences(current).toArray();
        if (references.some(info => containsOffset(info.reference.$refNode, offset))) {
            return current;
        }
        current = current.$container;
    }
    return undefined;
}

function createPathSelectionRanges(
    document: LangiumDocument,
    node: AstNode,
    offset: number
): Range[] {
    const text = document.textDocument.getText();
    const references = AstUtils.streamReferences(node)
        .map(info => info.reference)
        .toArray()
        .filter((reference): reference is Reference => reference.$refNode !== undefined)
        .sort((left, right) => left.$refNode!.offset - right.$refNode!.offset);
    const currentIndex = references.findIndex(reference => containsOffset(reference.$refNode, offset));
    if (currentIndex < 0) {
        return [];
    }
    let start = currentIndex;
    let end = currentIndex;
    while (start > 0 && isDotGap(text, references[start - 1]!, references[start]!)) {
        start--;
    }
    while (end < references.length - 1 && isDotGap(text, references[end]!, references[end + 1]!)) {
        end++;
    }
    const current = references[currentIndex]!;
    const pathStart = references[start]!.$refNode!.range.start;
    const ranges: Range[] = [current.$refNode!.range];
    for (let index = currentIndex; index <= end; index++) {
        ranges.push(Range.create(pathStart, references[index]!.$refNode!.range.end));
    }
    return ranges;
}

function isDotGap(text: string, left: Reference, right: Reference): boolean {
    const leftNode = left.$refNode;
    const rightNode = right.$refNode;
    return leftNode !== undefined && rightNode !== undefined &&
        /^[\t \r\n]*\.[\t \r\n]*$/u.test(text.slice(leftNode.end, rightNode.offset));
}

function containsOffset(
    referenceNode: { offset: number; end: number } | undefined,
    offset: number
): boolean {
    return referenceNode !== undefined &&
        referenceNode.offset <= offset && offset <= referenceNode.end;
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
