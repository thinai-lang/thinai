import { AstUtils, type AstNode, type LangiumDocument } from 'langium';
import {
    CompletionItemKind,
    InsertTextMode,
    type CompletionItem,
    type Position
} from 'vscode-languageserver';
import {
    isApplicationService,
    isDomainService,
    isMethod,
    isProjector,
    isQueryRepository,
    isQueryService
} from './generated/ast.js';
import { getBlockNestingDepth } from './thinai-layout.js';
import { scanThinaiSource } from './thinai-source-scanner.js';

interface QueryRepositoryCompletionCallbacks {
    createKeywordCompletionItem(
        document: LangiumDocument,
        position: Position,
        label: string,
        detail: string,
        fallbackStart: number,
        insertText: string,
        useLangiumTokenEdit: boolean
    ): CompletionItem;
    getBlockChildIndentation(document: LangiumDocument, parent: AstNode | undefined, offset: number): string;
}

/** Handles the query-repository-only `reads from` clause and its custom trigger position. */
export class ThinaiQueryRepositoryCompletion {
    constructor(private readonly callbacks: QueryRepositoryCompletionCallbacks) {}

    getQueryRepositoryReadCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const repository = AstUtils.streamAst(root)
            .filter(isQueryRepository)
            .filter(candidate => candidate.$cstNode !== undefined && candidate.$cstNode.offset <= offset &&
                scanThinaiSource(text.slice(candidate.$cstNode.offset, offset)).openBraces > 0)
            .toArray()
            .sort((left, right) => right.$cstNode!.offset - left.$cstNode!.offset)[0];
        const servedReference = repository?.readModel;
        const referenceEnd = servedReference?.$refNode?.end;
        if (!repository || !this.hasReferenceText(servedReference) || referenceEnd === undefined || offset < referenceEnd) {
            return [];
        }
        const betweenServeAndCursor = text.slice(referenceEnd, offset);
        const partialPhrase = this.getReadsFromPrefix(betweenServeAndCursor);
        if (!/^[\t \r\n]*$/u.test(betweenServeAndCursor) && !partialPhrase ||
            repository.sources.length > 0 && !partialPhrase) {
            return [];
        }
        const newline = text.includes('\r\n') ? '\r\n' : '\n';
        const indentation = this.callbacks.getBlockChildIndentation(document, repository, offset);
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const currentLinePrefix = text.slice(lineStart, offset);
        const partialLinePhrase = this.getReadsFromPrefix(currentLinePrefix);
        let editStart: number;
        let newText: string;
        if (/^[\t ]*$/u.test(currentLinePrefix)) {
            editStart = lineStart;
            newText = `${currentLinePrefix}reads from`;
        } else if (partialLinePhrase) {
            editStart = lineStart + partialLinePhrase.start;
            newText = 'reads from';
        } else {
            editStart = referenceEnd;
            newText = `${newline}${indentation}reads from`;
        }
        return [{
            label: 'reads from',
            kind: CompletionItemKind.Keyword,
            detail: 'Language keyword',
            preselect: true,
            insertTextMode: InsertTextMode.asIs,
            data: {
                thinaiSiblingCompletion: true,
                thinaiIndentationDepth: getBlockNestingDepth(repository)
            },
            sortText: '1',
            textEdit: {
                range: {
                    start: document.textDocument.positionAt(editStart),
                    end: position
                },
                newText
            }
        }];
    }

    getMethodReadsFromCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const prefix = text.slice(lineStart, offset);
        const partial = this.getReadsFromPrefix(prefix);
        if (!partial) {
            return [];
        }
        const method = AstUtils.streamAst(root)
            .filter(isMethod)
            .filter(candidate => candidate.$cstNode !== undefined && candidate.$cstNode.offset <= offset &&
                offset <= candidate.$cstNode.end)
            .toArray()
            .sort((left, right) => (left.$cstNode!.end - left.$cstNode!.offset) -
                (right.$cstNode!.end - right.$cstNode!.offset))[0];
        const owner = method?.$container;
        const methodPrefix = method?.$cstNode ? text.slice(method.$cstNode.offset, offset) : '';
        if (!method || !(isApplicationService(owner) || isQueryService(owner) || isProjector(owner) || isDomainService(owner)) ||
            !methodPrefix.includes('{')) {
            return [];
        }
        return [this.callbacks.createKeywordCompletionItem(
            document,
            position,
            'reads from',
            'Language keyword',
            lineStart + partial.start,
            'reads from',
            false
        )];
    }

    private getReadsFromPrefix(source: string): { start: number; value: string } | undefined {
        const match = /(?:^|\s)(r|re|rea|read|reads(?:\s+f(?:r(?:o(?:m)?)?)?)?)\s*$/iu.exec(source);
        const value = match?.[1]?.replace(/\s+/gu, ' ');
        if (!match || !value || value.length >= 'reads from'.length ||
            !'reads from'.startsWith(value.toLowerCase())) {
            return undefined;
        }
        return {
            start: match.index + match[0].lastIndexOf(match[1]!),
            value
        };
    }

    private hasReferenceText(reference: unknown): boolean {
        return typeof reference === 'object' && reference !== null &&
            '$refText' in reference && typeof reference.$refText === 'string' && reference.$refText.length > 0;
    }
}

/** True when the cursor is on the blank next-statement position for a query repository read source. */
export function isQueryRepositoryReadCompletionPosition(document: LangiumDocument, offset: number): boolean {
    const root = document.parseResult.value;
    if (!root) {
        return false;
    }
    const text = document.textDocument.getText();
    const repository = AstUtils.streamAst(root)
        .filter(isQueryRepository)
        .filter(candidate => candidate.$cstNode !== undefined && candidate.$cstNode.offset <= offset &&
            scanThinaiSource(text.slice(candidate.$cstNode.offset, offset)).openBraces > 0)
        .toArray()
        .sort((left, right) => right.$cstNode!.offset - left.$cstNode!.offset)[0];
    const servedReference = repository?.readModel;
    const referenceEnd = servedReference?.$refNode?.end;
    return repository !== undefined && typeof servedReference?.$refText === 'string' &&
        servedReference.$refText.length > 0 && referenceEnd !== undefined && offset >= referenceEnd &&
        repository.sources.length === 0 && /^[\t \r\n]*$/u.test(text.slice(referenceEnd, offset));
}
