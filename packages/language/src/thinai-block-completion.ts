import { AstUtils, CstUtils, type AstNode, type LangiumDocument } from 'langium';
import {
    CompletionItemKind,
    InsertTextMode,
    type CompletionItem,
    type CompletionList,
    type Position
} from 'vscode-languageserver';
import { isModel } from './generated/ast.js';
import { ThinaiKeywordContinuations } from './thinai-keyword-continuations.js';
import {
    getBlockNestingDepth,
    getSiblingCompletionKeywords,
    getSiblingStatementPolicy,
    isLineSeparatedSibling
} from './thinai-layout.js';
import { getLineStartOffset, getNewline } from './thinai-text-utils.js';
import { scanThinaiSource } from './thinai-source-scanner.js';

interface BlockCompletionCallbacks {
    createKeywordCompletionItem(
        document: LangiumDocument,
        position: Position,
        label: string,
        detail: string,
        fallbackStart?: number,
        insertText?: string,
        useLangiumTokenEdit?: boolean
    ): CompletionItem;
    getSameLineSiblingAt(document: LangiumDocument, position: Position): AstNode | null | undefined;
    isStandalonePartialKeywordPrefix(document: LangiumDocument, position: Position): boolean;
    isTypeKeywordCompletionPosition(document: LangiumDocument, position: Position): boolean;
}

/** Structural keyword completions for model gaps and block statement positions. */
export class ThinaiBlockCompletion {
    constructor(
        private readonly keywordContinuations: ThinaiKeywordContinuations,
        private readonly callbacks: BlockCompletionCallbacks
    ) {}

    getModelGapKeywordCompletions(
        document: LangiumDocument,
        position: Position,
        defaultCompletion: CompletionList | undefined,
        inProgressCompletions: CompletionItem[]
    ): CompletionItem[] {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, offset);
        const rawPrefix = text.slice(lineStart, offset);
        const typedPrefix = rawPrefix.trimStart();
        const labels = getSiblingCompletionKeywords('Model');
        const normalizedPrefix = typedPrefix.toLowerCase().replace(/\s+/g, ' ');
        if (typedPrefix && !/^[\p{L}_][\p{L}_ ]*$/u.test(typedPrefix)) {
            return [];
        }
        const matchingLabels = labels.filter(label =>
            !normalizedPrefix || normalizedPrefix.length < label.length && label.startsWith(normalizedPrefix)
        );
        if (matchingLabels.length === 0 || typedPrefix && inProgressCompletions.length > 0) {
            return [];
        }
        const children = [...model.imports, ...model.declarations]
            .map(node => node.$cstNode)
            .filter((node): node is NonNullable<typeof node> => node !== undefined)
            .sort((left, right) => left.offset - right.offset);
        if (children.some(node => node.offset < lineStart && offset < node.end)) {
            return [];
        }
        const previousEnd = children
            .filter(node => node.end <= lineStart)
            .reduce((end, node) => Math.max(end, node.end), 0);
        const nextStart = children
            .filter(node => node.offset >= offset)
            .reduce((start, node) => Math.min(start, node.offset), text.length);
        const beforeLine = text.slice(previousEnd, lineStart);
        const after = text.slice(offset, nextStart);
        const gap = text.slice(previousEnd, nextStart);
        if (!/^\s*$/.test(beforeLine) || !/^\s*$/.test(after) ||
            !/[\r\n]/.test(gap) && !(previousEnd === 0 && nextStart === text.length)) {
            return [];
        }
        const defaultKeywords = new Set((defaultCompletion?.items ?? [])
            .filter(item => item.kind === CompletionItemKind.Keyword && typeof item.label === 'string')
            .map(item => item.label as string));
        if (matchingLabels.some(label => defaultKeywords.has(label) || defaultKeywords.has(label.split(/\s+/)[0]!))) {
            return [];
        }
        return this.getTopLevelKeywordCompletions(document, position, typedPrefix);
    }

    getEnclosingBlockKeywordCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, offset);
        const openingBrace = scanThinaiSource(text.slice(0, offset)).openBraceOffsets.at(-1) ?? -1;
        const linePrefixStart = (openingBrace: number) => openingBrace >= lineStart ? openingBrace + 1 : lineStart;
        const container = AstUtils.streamAst(root)
            .filter(candidate => this.keywordContinuations.getSiblingKeywordLabels(candidate).length > 0)
            .filter(candidate => {
                const cstNode = candidate.$cstNode;
                return cstNode !== undefined && cstNode.offset <= offset && offset < cstNode.end;
            })
            .toArray()
            .sort((left, right) => (left.$cstNode!.end - left.$cstNode!.offset) - (right.$cstNode!.end - right.$cstNode!.offset))
            .find(candidate => {
                const cstNode = candidate.$cstNode!;
                if (openingBrace < cstNode.offset) {
                    return false;
                }
                const directChildren = AstUtils.streamAst(candidate).toArray().filter(child => child.$container === candidate);
                const directChildAtCursor = directChildren.some(child => {
                    const childCst = child.$cstNode;
                    return childCst !== undefined && childCst.offset <= offset && offset < childCst.end;
                });
                if (!directChildAtCursor) {
                    return true;
                }
                const prefix = text.slice(linePrefixStart(openingBrace), offset).trim();
                return this.matchesKeywordPrefix(this.keywordContinuations.getSiblingKeywordLabels(candidate), prefix);
            });
        if (!container) {
            return [];
        }
        const labels = this.keywordContinuations.getSiblingKeywordLabels(container);
        const prefix = text.slice(linePrefixStart(openingBrace), offset).trim();
        const typedPrefix = /^[\p{L}_][\p{L}_ ]*$/u.test(prefix) ? prefix : '';
        const matchingLabels = typedPrefix ? labels.filter(label => this.matchesKeywordPrefix([label], typedPrefix)) : labels;
        const completions = this.createKeywordCompletions(matchingLabels, document, position, typedPrefix);
        return this.moveEmptyBlockCompletionsToNextLine(completions, document, position, container, openingBrace);
    }

    getBlockChildIndentation(document: LangiumDocument, parent: AstNode | undefined, offset: number): string {
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, offset);
        const depth = getBlockNestingDepth(parent);
        const indentationCandidates = text.slice(0, offset).split(/\r\n|\r|\n/u)
            .map(line => /^[\t ]+/u.exec(line)?.[0] ?? '')
            .filter(indentation => indentation.length > 0);
        const unit = indentationCandidates.some(indentation => indentation.startsWith('\t')) ? '\t' : '  ';
        const lineIndent = /^[\t ]*/u.exec(text.slice(lineStart, offset))?.[0] ?? '';
        return `${lineIndent}${unit.repeat(Math.max(0, depth - Math.floor(lineIndent.length / unit.length)))}`;
    }

    filterSameLineSiblingCompletions(
        document: LangiumDocument,
        position: Position,
        completion: CompletionList | undefined,
        extraAllowedKeywords: string[] = []
    ): CompletionList | undefined {
        const sibling = this.callbacks.getSameLineSiblingAt(document, position);
        const inProgressContinuations = extraAllowedKeywords.filter(keyword =>
            ['-> supplier', '<-> partner', '-x-', 'supplier', 'partner', 'integrationPatterns',
                'participants', 'manages', 'serves', 'reads from', 'from', 'to', 'on', 'realizes', 'kind', 'depends',
                'mirrors', 'returns', 'initial', 'when', 'with',
                'core', 'supporting', 'generic']
                .includes(keyword)
        );
        if (sibling === null) {
            const allowedContinuations = new Set(extraAllowedKeywords);
            const inTypePosition = this.callbacks.isTypeKeywordCompletionPosition(document, position);
            const typeKeywords = new Set(['string', 'number', 'boolean', 'date', 'time', 'instant', 'List', 'Set', 'Map']);
            return {
                isIncomplete: completion?.isIncomplete ?? false,
                items: completion?.items.filter(item =>
                    item.kind !== CompletionItemKind.Keyword || typeof item.label !== 'string' ||
                    allowedContinuations.has(item.label) || allowedContinuations.has(item.label.split(/\s+/)[0]!) ||
                    inTypePosition && typeKeywords.has(item.label)
                ) ?? []
            };
        }
        if (sibling === undefined || this.callbacks.isStandalonePartialKeywordPrefix(document, position)) {
            return completion;
        }
        const continuations = this.keywordContinuations.getSameLineContinuationKeywords(sibling, document, position);
        const siblingCompletions = this.getSameLineNextSiblingCompletions(document, position, sibling);
        const allowed = new Set([...continuations, ...inProgressContinuations]);
        const items = completion?.items.filter(item => {
            if (item.kind !== CompletionItemKind.Keyword || typeof item.label !== 'string') {
                return true;
            }
            const firstWord = item.label.split(/\s+/)[0];
            return allowed.has(item.label) || allowed.has(firstWord);
        }) ?? [];
        const existingLabels = new Set(items.map(item => item.label));
        items.push(...siblingCompletions.filter(item => !existingLabels.has(item.label)));
        return {
            isIncomplete: completion?.isIncomplete ?? false,
            items
        };
    }

    private getSameLineNextSiblingCompletions(
        document: LangiumDocument,
        position: Position,
        sibling: AstNode
    ): CompletionItem[] {
        const parent = sibling.$container;
        if (!parent) {
            return [];
        }
        const labels = this.keywordContinuations.getSiblingKeywordLabels(parent);
        if (labels.length === 0) {
            return [];
        }

        const offset = document.textDocument.offsetAt(position);
        const end = sibling.$cstNode?.end;
        if (end === undefined || end > offset) {
            return [];
        }
        const text = document.textDocument.getText();
        const gap = text.slice(end, offset);
        if (/[\r\n]/.test(gap) || !/^[\t ]*(?:[\p{L}_][\p{L}_ ]*)?$/u.test(gap)) {
            return [];
        }
        const siblingStart = sibling.$cstNode?.offset;
        const siblingSource = text.slice(siblingStart ?? end, end).trimEnd();
        const endsWithIdentifier = /[\p{L}\p{N}_]$/u.test(siblingSource);
        if (gap.length === 0 && getSiblingStatementPolicy(sibling.$type).bareNameBoundary && endsWithIdentifier) {
            return [];
        }
        const typedPrefix = gap.trim();
        const matchingLabels = labels.filter(label => !typedPrefix ||
            typedPrefix.length < label.length && label.toLowerCase().startsWith(typedPrefix.toLowerCase().replace(/\s+/g, ' '))
        );
        if (matchingLabels.length === 0) {
            return [];
        }

        const lineStart = getLineStartOffset(document, siblingStart ?? end);
        const prefixBeforeSibling = text.slice(lineStart, siblingStart ?? end);
        const requiresStructuralIndentation = !/^[\t ]*$/.test(prefixBeforeSibling);
        const indentationDepth = getBlockNestingDepth(sibling.$container);
        const indent = requiresStructuralIndentation
            ? this.getBlockChildIndentation(document, sibling.$container, offset)
            : prefixBeforeSibling;
        const newline = getNewline(text);
        return matchingLabels.map(label => ({
            label,
            kind: CompletionItemKind.Keyword,
            detail: 'Language keyword',
            preselect: true,
            insertTextMode: InsertTextMode.asIs,
            data: {
                thinaiSiblingCompletion: true,
                thinaiIndentationDepth: indentationDepth
            },
            sortText: '1',
            textEdit: {
                range: {
                    start: document.textDocument.positionAt(end),
                    end: position
                },
                newText: `${newline}${indent}${label}`
            }
        }));
    }

    private moveEmptyBlockCompletionsToNextLine(
        completions: CompletionItem[],
        document: LangiumDocument,
        position: Position,
        parent: AstNode,
        openingBrace: number
    ): CompletionItem[] {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const bodyPrefix = openingBrace < 0 ? '' : text.slice(openingBrace + 1, offset);
        if (openingBrace < 0) {
            return completions;
        }
        if (/[\r\n]/.test(bodyPrefix)) {
            return this.normalizeBlockStatementIndentation(completions, document, position, parent);
        }
        if (!/^[\t ]*(?:[\p{L}_][\p{L}_ ]*)?$/u.test(bodyPrefix)) {
            return this.moveCommentOnlyBlockContentsToNextLine(
                completions, document, position, parent, openingBrace, bodyPrefix
            );
        }
        const newline = getNewline(text);
        const childIndent = this.getBlockChildIndentation(document, parent, offset);
        const indentationDepth = getBlockNestingDepth(parent);
        const parentLineStart = getLineStartOffset(document, openingBrace);
        const parentIndent = /^[\t ]*/u.exec(text.slice(parentLineStart, openingBrace))?.[0] ?? '';
        const closeBrace = /^[\t ]*\}/u.exec(text.slice(offset));
        const closeOffset = closeBrace ? offset + closeBrace[0].lastIndexOf('}') : offset;
        const hasClosingBrace = closeBrace !== null;
        return completions.map(item => ({
            ...item,
            detail: 'Language keyword',
            preselect: true,
            insertTextMode: InsertTextMode.asIs,
            data: {
                thinaiSiblingCompletion: true,
                thinaiIndentationDepth: indentationDepth,
                ...(hasClosingBrace ? { thinaiClosingIndentationDepth: Math.max(0, indentationDepth - 1) } : {})
            },
            textEdit: {
                range: {
                    start: document.textDocument.positionAt(openingBrace + 1),
                    end: document.textDocument.positionAt(closeOffset)
                },
                newText: `${newline}${childIndent}${item.label}${hasClosingBrace ? `${newline}${parentIndent}` : ''}`
            }
        }));
    }

    private moveCommentOnlyBlockContentsToNextLine(
        completions: CompletionItem[],
        document: LangiumDocument,
        position: Position,
        parent: AstNode,
        openingBrace: number,
        bodyPrefix: string
    ): CompletionItem[] {
        const cstNode = parent.$cstNode;
        if (!cstNode || openingBrace < 0) {
            return completions;
        }
        const text = document.textDocument.getText();
        const offset = document.textDocument.offsetAt(position);
        const comments = CstUtils.flattenCst(cstNode)
            .filter(node => (node.tokenType.name === 'SL_COMMENT' || node.tokenType.name === 'ML_COMMENT') &&
                node.offset >= openingBrace + 1 && node.end <= offset)
            .toArray()
            .sort((left, right) => left.offset - right.offset);
        if (comments.length === 0) {
            return completions;
        }
        let cursor = openingBrace + 1;
        for (const comment of comments) {
            if (!/^[\t \r\n]*$/u.test(text.slice(cursor, comment.offset))) {
                return completions;
            }
            cursor = comment.end;
        }
        if (!/^[\t \r\n]*$/u.test(text.slice(cursor, offset))) {
            return completions;
        }

        const newline = getNewline(text);
        const childIndent = this.getBlockChildIndentation(document, parent, offset);
        const indentationDepth = getBlockNestingDepth(parent);
        const parentLineStart = getLineStartOffset(document, openingBrace);
        const parentIndent = /^[\t ]*/u.exec(text.slice(parentLineStart, openingBrace))?.[0] ?? '';
        const closeBrace = /^[\t ]*\}/u.exec(text.slice(offset));
        const closeOffset = closeBrace ? offset + closeBrace[0].lastIndexOf('}') : offset;
        const commentText = bodyPrefix.trim();
        return completions.map(item => ({
            ...item,
            detail: 'Language keyword',
            preselect: true,
            insertTextMode: InsertTextMode.asIs,
            data: {
                thinaiSiblingCompletion: true,
                thinaiIndentationDepth: indentationDepth,
                thinaiIndentationLines: [commentText.split(/\r\n|\r|\n/u).length + 1],
                ...(closeBrace ? { thinaiClosingIndentationDepth: Math.max(0, indentationDepth - 1) } : {})
            },
            textEdit: {
                range: {
                    start: document.textDocument.positionAt(openingBrace + 1),
                    end: document.textDocument.positionAt(closeOffset)
                },
                newText: `${newline}${childIndent}${commentText}${newline}${childIndent}${item.label}${closeBrace ? `${newline}${parentIndent}` : ''}`
            }
        }));
    }

    private normalizeBlockStatementIndentation(
        completions: CompletionItem[],
        document: LangiumDocument,
        position: Position,
        parent: AstNode
    ): CompletionItem[] {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, offset);
        const currentPrefix = text.slice(lineStart, offset);
        if (!/^[\t ]*(?:[\p{L}_][\p{L}_ ]*)?$/u.test(currentPrefix)) {
            return completions;
        }
        const expectedIndent = this.getPreviousSiblingIndentation(document, parent, offset);
        if (expectedIndent === undefined) {
            return completions;
        }
        return completions.map(item => ({
            ...item,
            detail: 'Language keyword',
            preselect: true,
            data: { thinaiSiblingCompletion: true },
            textEdit: {
                range: {
                    start: document.textDocument.positionAt(lineStart),
                    end: position
                },
                newText: `${expectedIndent}${item.label}`
            }
        }));
    }

    private getPreviousSiblingIndentation(
        document: LangiumDocument,
        parent: AstNode,
        offset: number
    ): string | undefined {
        const text = document.textDocument.getText();
        const currentLine = document.textDocument.positionAt(offset).line;
        const previousSibling = AstUtils.streamAst(parent)
            .filter(node => node.$container === parent && isLineSeparatedSibling(node) && node.$cstNode !== undefined)
            .filter(node => document.textDocument.positionAt(node.$cstNode!.end).line < currentLine && node.$cstNode!.end <= offset)
            .toArray()
            .sort((left, right) => right.$cstNode!.end - left.$cstNode!.end)[0];
        const cstNode = previousSibling?.$cstNode;
        if (!cstNode) {
            return undefined;
        }
        const lineStart = getLineStartOffset(document, cstNode.offset);
        const prefix = text.slice(lineStart, cstNode.offset);
        return /^[\t ]*$/.test(prefix) ? prefix : undefined;
    }

    private createKeywordCompletions(
        labels: readonly string[],
        document: LangiumDocument,
        position: Position,
        typedPrefix: string
    ): CompletionItem[] {
        const prefixStart = document.textDocument.offsetAt(position) - typedPrefix.length;
        return labels.map(label => this.callbacks.createKeywordCompletionItem(
            document,
            position,
            label,
            'Language keyword',
            prefixStart,
            label,
            !typedPrefix.includes(' ')
        ));
    }

    private matchesKeywordPrefix(labels: readonly string[], prefix: string): boolean {
        const normalizedPrefix = prefix.toLowerCase().replace(/\s+/g, ' ');
        return labels.some(label => normalizedPrefix.length <= label.length &&
            label.toLowerCase().startsWith(normalizedPrefix));
    }

    private getTopLevelKeywordCompletions(
        document: LangiumDocument,
        position: Position,
        typedPrefix = ''
    ): CompletionItem[] {
        const offset = document.textDocument.offsetAt(position);
        const prefixStart = offset - typedPrefix.length;
        return getSiblingCompletionKeywords('Model').filter(label => !typedPrefix ||
            typedPrefix.length < label.length && label.toLowerCase().startsWith(typedPrefix.toLowerCase().replace(/\s+/g, ' ')))
            .map(label => this.callbacks.createKeywordCompletionItem(
                document,
                position,
                label,
                'Top-level declaration',
                prefixStart,
                label,
                !typedPrefix.includes(' ')
            ));
    }
}
