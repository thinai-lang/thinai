import { AstUtils, type AstNode, type LangiumDocument } from 'langium';
import { type CompletionItem, type Position } from 'vscode-languageserver';
import {
    type TransitionChange,
    isApplicationService,
    isBoundedContext,
    isDomainService,
    isEntity,
    isEnumType,
    isField,
    isMethod,
    isProjector,
    isQueryService,
    isSubdomain,
    isImport,
    isTransition,
    isValueObject,
    isModule
} from './generated/ast.js';
import { canDeclareProjects, canDeclareTransition, getEventEmissionMode } from './thinai-operation-utils.js';
import { getSiblingCompletionKeywords } from './thinai-layout.js';
import { isInSharedKernel } from './thinai-scope-utils.js';
import { hasReferenceText } from './thinai-ast-utils.js';
import { THINAI_IDENTIFIER_SOURCE, THINAI_QUALIFIED_IDENTIFIER_SOURCE } from './thinai-identifiers.js';
import { getLineStartOffset } from './thinai-text-utils.js';

const identifierSource = THINAI_IDENTIFIER_SOURCE;
const qualifiedIdentifierSource = THINAI_QUALIFIED_IDENTIFIER_SOURCE;

interface KeywordContinuationCallbacks {
    createKeywordCompletionItem(
        document: LangiumDocument,
        position: Position,
        label: string,
        detail: string,
        fallbackStart?: number,
        insertText?: string,
        useLangiumTokenEdit?: boolean
    ): CompletionItem;
}

/** Handles partial keyword and same-line optional continuations. */
export class ThinaiKeywordContinuations {
    constructor(private readonly callbacks: KeywordContinuationCallbacks) {}

    getInProgressCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, offset);
        const prefix = text.slice(lineStart, offset);
        const continuations: ReadonlyArray<readonly [RegExp, string[]]> = [
            [/\bin\s+bounded\s+([\p{L}_]*)$/iu, ['context']],
            [/\bbounded\s+([\p{L}_]*)$/iu, ['context']],
            [/\bshared\s+([\p{L}_]*)$/iu, ['kernel']],
            [/\bapplication\s+([\p{L}_]*)$/iu, ['service']],
            [/\broot\s+([\p{L}_]*)$/iu, ['entity']],
            [/\bvalue\s+([\p{L}_]*)$/iu, ['object']],
            [/\bread\s+([\p{L}_]*)$/iu, ['model']],
            [/\bdata\s+([\p{L}_]*)$/iu, ['object']],
            [/\bdomain\s+([\p{L}_]*)$/iu, ['service']],
            [/\bquery\s+([\p{L}_]*)$/iu, ['repository', 'service']],
            [/\bintegration\s+([\p{L}_]*)$/iu, ['event']],
            [/\bdepends\s+([\p{L}_]*)$/iu, ['on']],
            [/\bcontext\s+([\p{L}_]*)$/iu, ['map']],
            [new RegExp(`\\bsubdomain\\s+${identifierSource}\\s+kind\\s+([\\p{L}_]*)$`, 'iu'), ['core', 'supporting', 'generic']],
            [/\bimport\s+\{[^}]*\}\s+([\p{L}_]*)$/iu, ['from']],
            [new RegExp(`\\bquery\\s+repository\\s+${identifierSource}\\s*\\{\\s*([\\p{L}_]*)$`, 'iu'), ['serves']],
            [new RegExp(`\\brepository\\s+${identifierSource}\\s*\\{\\s*([\\p{L}_]*)$`, 'iu'), ['manages']],
            [new RegExp(`\\breads\\s+from\\s+${qualifiedIdentifierSource}(?:\\s*,\\s*${qualifiedIdentifierSource})*\\s+([\\p{L}_]*)$`, 'iu'), ['when']],
            [new RegExp(`\\bsharedKernel\\s+${qualifiedIdentifierSource}\\s+\\{\\s*([\\p{L}_]*)$`, 'iu'), ['participants']],
            [/\bcustomer\s+[^\n]*?->\s*([\p{L}_]*)$/iu, ['supplier']],
            [/\bpartner\s+[^\n]*?<->\s*([\p{L}_]*)$/iu, ['partner']],
            [new RegExp(`\\b(?:customer|supplier|partner)\\s+${qualifiedIdentifierSource}\\s*\\{\\s*([\\p{L}_]*)$`, 'iu'), ['integrationPatterns']]
        ];

        const match = this.getTransitionRequiredKeywordMatch(prefix) ?? continuations
            .map(([pattern, keywords]) => ({ match: pattern.exec(prefix), keywords }))
            .find(candidate => candidate.match !== null);
        if (!match?.match) {
            const importFrom = this.getImportFromCompletion(document, position);
            return importFrom ? [importFrom] : [];
        }
        if ((match.keywords[0] === 'from' || match.keywords[0] === 'to') &&
            this.isTransitionContinuationContext(document, offset) &&
            !this.isTransitionContinuationPosition(document, offset)) {
            return [];
        }
        if (match.keywords[0] === 'map' && /\bbounded\s+context\s+[\p{L}_]*$/iu.test(prefix)) {
            return [];
        }
        const typedPrefix = match.match[1]!;
        const start = offset - typedPrefix.length;
        const needsLeadingSpace = start > 0 && !/\s/.test(text[start - 1]!);
        return match.keywords
            .filter(keyword => typedPrefix.length < keyword.length && keyword.toLowerCase().startsWith(typedPrefix.toLowerCase()))
            .map(keyword => this.callbacks.createKeywordCompletionItem(
                document,
                position,
                keyword,
                'Keyword continuation',
                start,
                `${needsLeadingSpace ? ' ' : ''}${keyword}`
            ));
    }

    private getImportFromCompletion(document: LangiumDocument, position: Position): CompletionItem | undefined {
        const root = document.parseResult.value;
        if (!root) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const importDeclaration = AstUtils.streamAst(root)
            .filter(isImport)
            .find(node => {
                const cstNode = node.$cstNode;
                return cstNode !== undefined && cstNode.offset <= offset && offset <= cstNode.end;
            });
        const importStart = importDeclaration?.$cstNode?.offset ?? text.lastIndexOf('import', offset);
        if (importStart < 0) {
            return undefined;
        }
        const source = text.slice(importStart, offset);
        const match = /^\s*import\s+\{[\s\S]*\}\s*([\p{L}_]*)$/u.exec(source);
        if (!match) {
            return undefined;
        }
        const typedPrefix = match[1] ?? '';
        if (typedPrefix.length >= 'from'.length || !'from'.startsWith(typedPrefix.toLowerCase())) {
            return undefined;
        }
        const prefixStart = offset - typedPrefix.length;
        const needsLeadingSpace = prefixStart > 0 && !/\s/u.test(text[prefixStart - 1]!);
        return this.callbacks.createKeywordCompletionItem(
            document,
            position,
            'from',
            'Keyword continuation',
            prefixStart,
            `${needsLeadingSpace ? ' ' : ''}from`
        );
    }

    getPartialSameLineCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const results = new Map<string, CompletionItem>();
        for (const node of AstUtils.streamAst(root)) {
            const cstNode = node.$cstNode;
            if (!cstNode || cstNode.offset > offset) {
                continue;
            }
            const cursorInsideNode = cstNode.offset <= offset && offset <= cstNode.end;
            const nodeTouchesCursorLine = cstNode.range.start.line === position.line ||
                cstNode.range.end.line === position.line;
            // A header may intentionally continue on the next line (for example
            // `module Api` followed by `depends ...`). Other earlier nodes must
            // not contribute keywords while editing an unrelated statement.
            const headerGap = text.slice(cstNode.end, offset);
            const continuesNodeHeader = cstNode.end <= offset &&
                (headerGap.match(/\r\n|\r|\n/gu)?.length ?? 0) <= 1 &&
                /^[\s\p{L}_]*$/u.test(headerGap);
            if (!cursorInsideNode && !nodeTouchesCursorLine && !continuesNodeHeader) {
                continue;
            }
            const source = text.slice(cstNode.offset, offset);
            const match = /\s+([\p{L}_]+)$/u.exec(source);
            if (!match) {
                continue;
            }
            const typedPrefix = match[1]!;
            const headerSource = source.replace(/\s+[\p{L}_]+$/u, '').trim();
            const continuations = new Set(this.getSameLineContinuationKeywords(node, document, position));
            if (isBoundedContext(node) && new RegExp(`^bounded\\s+context\\s+${identifierSource}$`, 'iu').test(headerSource)) {
                continuations.add('realizes');
            } else if (isSubdomain(node) && new RegExp(`^subdomain\\s+${identifierSource}$`, 'iu').test(headerSource)) {
                continuations.add('kind');
            } else if (isModule(node) && new RegExp(`^module\\s+${identifierSource}$`, 'iu').test(headerSource)) {
                continuations.add('depends');
            } else if (isValueObject(node) && new RegExp(`^value\\s+object\\s+${identifierSource}$`, 'iu').test(headerSource)) {
                continuations.add('mirrors');
            }
            for (const keyword of [...continuations].filter(candidate =>
                typedPrefix.length < candidate.length && candidate.toLowerCase().startsWith(typedPrefix.toLowerCase())
            )) {
                const prefixStart = offset - typedPrefix.length;
                results.set(keyword, this.callbacks.createKeywordCompletionItem(
                    document,
                    position,
                    keyword,
                    'Keyword continuation',
                    prefixStart
                ));
            }
        }
        return [...results.values()];
    }

    isTransitionContinuationPosition(document: LangiumDocument, offset: number): boolean {
        const root = document.parseResult.value;
        if (!root) {
            return false;
        }
        const method = AstUtils.streamAst(root)
            .filter(isMethod)
            .filter(candidate => candidate.$cstNode !== undefined && candidate.$cstNode.offset <= offset && offset <= candidate.$cstNode.end)
            .toArray()
            .sort((left, right) => (left.$cstNode!.end - left.$cstNode!.offset) - (right.$cstNode!.end - right.$cstNode!.offset))[0];
        if (!method || !this.getSiblingKeywordLabels(method).includes('transition')) {
            return false;
        }
        const transition = AstUtils.streamAst(method)
            .filter(isTransition)
            .filter(candidate => candidate.$cstNode !== undefined && candidate.$cstNode.offset <= offset)
            .toArray()
            .sort((left, right) => right.$cstNode!.offset - left.$cstNode!.offset)[0];
        const change = transition && AstUtils.streamAst(transition)
            .filter(candidate => candidate.$type === 'TransitionChange')
            .filter(candidate => candidate.$cstNode !== undefined && candidate.$cstNode.offset <= offset)
            .toArray()
            .sort((left, right) => right.$cstNode!.offset - left.$cstNode!.offset)[0] as
            TransitionChange | undefined;
        const field = change?.field?.ref;
        return isField(field) && isEnumType(field.type?.ref);
    }

    isTransitionContinuationContext(document: LangiumDocument, offset: number): boolean {
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, offset);
        return this.getTransitionRequiredKeywordMatch(text.slice(lineStart, offset)) !== undefined;
    }

    private getTransitionRequiredKeywordMatch(prefix: string): { match: RegExpExecArray; keywords: string[] } | undefined {
        const transitionMatch = [...prefix.matchAll(/\btransition\b/giu)].at(-1);
        if (!transitionMatch || transitionMatch.index === undefined) {
            return undefined;
        }
        const transitionSource = prefix.slice(transitionMatch.index + transitionMatch[0].length);
        const currentChange = transitionSource.slice(transitionSource.lastIndexOf(',') + 1).trimStart();
        const toMatch = new RegExp(`^${identifierSource}\\s+from\\s+${identifierSource}\\s+([\\p{L}_]*)$`, 'iu').exec(currentChange);
        if (toMatch) {
            return { match: toMatch, keywords: ['to'] };
        }
        const fromMatch = new RegExp(`^${identifierSource}\\s+([\\p{L}_]*)$`, 'u').exec(currentChange);
        return fromMatch ? { match: fromMatch, keywords: ['from'] } : undefined;
    }

    getSameLineContinuationKeywords(node: AstNode, document: LangiumDocument, position: Position): string[] {
        if (isBoundedContext(node)) {
            return node.subdomains.length === 0 ? ['realizes'] : [];
        }
        if (isSubdomain(node)) {
            return node.kind === undefined ? ['kind'] : [];
        }
        if (isModule(node)) {
            const start = node.$cstNode?.offset;
            const source = start === undefined ? '' : document.textDocument.getText().slice(start, document.textDocument.offsetAt(position));
            return node.dependencies.length === 0 && !source.includes('{') ? ['depends'] : [];
        }
        if (isValueObject(node)) {
            const start = node.$cstNode?.offset;
            const source = start === undefined ? '' : document.textDocument.getText().slice(start, document.textDocument.offsetAt(position));
            return node.mirrors === undefined && !source.includes('{') ? ['mirrors'] : [];
        }
        if (isField(node) && isEntity(node.$container) && !node.optional && !hasReferenceText(node.initialState) && isEnumType(node.type?.ref)) {
            return ['initial'];
        }
        if (isMethod(node) && !isProjector(node.$container) && !node.returnPrimitive && !node.returnType && !node.returnCollection) {
            const start = node.$cstNode?.offset;
            if (start === undefined) {
                return [];
            }
            const source = document.textDocument.getText().slice(start, document.textDocument.offsetAt(position));
            if (source.replace(/\s+[\p{L}_]*$/u, '').trimEnd().endsWith(')')) {
                return ['returns'];
            }
        }
        return [];
    }

    getSiblingKeywordLabelsAt(container: AstNode, offset: number): readonly string[] {
        const labels = this.getSiblingKeywordLabels(container);
        if (!isModule(container) || !labels.includes('exposes')) {
            return labels;
        }
        // Exposures must precede the module members. Once a member has been
        // parsed before the cursor, `exposes` is no longer a valid insertion.
        const members = container.members ?? [];
        const hasMemberBeforeCursor = members.some(member => {
            const cstNode = member.$cstNode;
            return cstNode !== undefined && cstNode.offset < offset;
        });
        return hasMemberBeforeCursor ? labels.filter(label => label !== 'exposes') : labels;
    }

    getSiblingKeywordLabels(container: AstNode): readonly string[] {
        let labels = getSiblingCompletionKeywords(container.$type, isModule(container) && isInSharedKernel(container));
        if (!isMethod(container)) {
            return labels;
        }
        const owner = container.$container;
        if (!(isApplicationService(owner) || isQueryService(owner) || isProjector(owner) || isDomainService(owner))) {
            labels = labels.filter(label => label !== 'reads from');
        }
        if (isProjector(container.$container)) {
            labels = labels.filter(label => label !== 'invokes');
        }
        return [
            ...labels,
            ...(canDeclareTransition(container) ? ['transition'] : []),
            ...(canDeclareProjects(container) ? ['projects'] : []),
            ...(getEventEmissionMode(container) ? ['emits'] : [])
        ];
    }

}
