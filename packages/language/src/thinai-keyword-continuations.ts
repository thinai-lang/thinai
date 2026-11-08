import { AstUtils, CstUtils, type AstNode, type LangiumDocument } from 'langium';
import { type CompletionItem, type Position } from 'vscode-languageserver';
import {
    type TransitionChange,
    isApplicationService,
    isBoundedContext,
    isBoundedContextPart,
    isContextMap,
    isDomainService,
    isEntity,
    isEnumType,
    isField,
    isImport,
    isMethod,
    isModel,
    isModule,
    isProjector,
    isQueryRepository,
    isQueryService,
    isRepository,
    isSharedKernel,
    isSubdomain,
    isTransition,
    isValueObject
} from './generated/ast.js';
import { canDeclareProjects, canDeclareTransition, getEventEmissionMode } from './thinai-operation-utils.js';
import { getSiblingCompletionKeywords, isBlockNodeType } from './thinai-layout.js';
import { isInSharedKernel } from './thinai-scope-utils.js';
import { hasReferenceText } from './thinai-ast-utils.js';
import { THINAI_IDENTIFIER_SOURCE, THINAI_QUALIFIED_IDENTIFIER_SOURCE } from './thinai-identifiers.js';
import { getLineStartOffset } from './thinai-text-utils.js';
import { findPreviousImportStart } from './thinai-source-scanner.js';

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
        const beforeCurrentLine = text.slice(0, lineStart).trimEnd();
        const previousLine = beforeCurrentLine.slice(beforeCurrentLine.lastIndexOf('\n') + 1).trim();
        const currentPartial = prefix.trim();
        if (/^(?:in\s+)?bounded$/iu.test(previousLine) &&
            currentPartial.length > 0 && currentPartial.length < 'context'.length &&
            'context'.startsWith(currentPartial) &&
            /^[\p{L}_]*$/u.test(currentPartial)) {
            return [this.callbacks.createKeywordCompletionItem(
                document,
                position,
                'context',
                'Keyword continuation',
                offset - currentPartial.length,
                'context'
            )];
        }
        const container = this.getContinuationContainer(document, offset);
        const allowsSibling = (phrase: string): boolean =>
            this.hasOpenedBody(container) && this.containerAllowsSibling(container, phrase);
        const allowsAnySibling = (...phrases: string[]): boolean => phrases.some(allowsSibling);
        const continuations: ReadonlyArray<readonly [RegExp, string[], () => boolean, boolean?]> = [
            [/\bin\s+bounded\s+([\p{L}_]*)$/iu, ['context'], () =>
                isModel(container) || (isBoundedContext(container) || isBoundedContextPart(container)) &&
                !this.hasOpenedBody(container)],
            [/\bbounded\s+([\p{L}_]*)$/iu, ['context'], () =>
                isModel(container) || isBoundedContext(container) && !this.hasOpenedBody(container)],
            [/\bshared\s+([\p{L}_]*)$/iu, ['kernel'], () => isModel(container)],
            [/\bapplication\s+([\p{L}_]*)$/iu, ['service'], () => allowsSibling('application service'), true],
            [/\broot\s+([\p{L}_]*)$/iu, ['entity'], () => allowsSibling('root entity'), true],
            [/\bvalue\s+([\p{L}_]*)$/iu, ['object'], () => allowsSibling('value object'), true],
            [/\bread\s+([\p{L}_]*)$/iu, ['model'], () => allowsSibling('read model'), true],
            [/\bdata\s+([\p{L}_]*)$/iu, ['object'], () => allowsSibling('data object'), true],
            [/\bdomain\s+([\p{L}_]*)$/iu, ['service'], () => allowsSibling('domain service'), true],
            [/\bquery\s+([\p{L}_]*)$/iu, ['repository', 'service'], () =>
                allowsAnySibling('query repository', 'query service'), true],
            [/\bintegration\s+([\p{L}_]*)$/iu, ['event'], () => allowsSibling('integration event'), true],
            [/\bdepends\s+([\p{L}_]*)$/iu, ['on'], () =>
                this.hasOpenedBody(container) && this.isModuleDeclarationOwner(container), true],
            [/\bcontext\s+([\p{L}_]*)$/iu, ['map'], () => isModel(container)],
            [new RegExp(`\\bsubdomain\\s+${identifierSource}\\s+kind\\s+([\\p{L}_]*)$`, 'iu'),
                ['core', 'supporting', 'generic'], () => isSubdomain(container) ||
                    new RegExp(`^\\s*subdomain\\s+${identifierSource}\\s+kind(?:\\s+[\\p{L}_]*)?$`, 'iu').test(prefix)],
            [/\bimport\s+\{[^}]*\}\s+([\p{L}_]*)$/iu, ['from'], () => isImport(container) || isModel(container)],
            [new RegExp(`\\bquery\\s+repository\\s+${identifierSource}\\s*\\{\\s*([\\p{L}_]*)$`, 'iu'),
                ['serves'], () => this.isRepositoryOwner(container, true)],
            [new RegExp(`\\brepository\\s+${identifierSource}\\s*\\{\\s*([\\p{L}_]*)$`, 'iu'),
                ['manages'], () => this.isRepositoryOwner(container, false)],
            [new RegExp(`\\breads\\s+from\\s+${qualifiedIdentifierSource}(?:\\s*,\\s*${qualifiedIdentifierSource})*\\s+([\\p{L}_]*)$`, 'iu'),
                ['when'], () => this.isReadClauseOwner(container)],
            [new RegExp(`\\bsharedKernel\\s+${qualifiedIdentifierSource}\\s+\\{\\s*([\\p{L}_]*)$`, 'iu'),
                ['participants'], () => this.isWithinContextMap(container)],
            [/\bcustomer\s+[^\n]*?->\s*([\p{L}_]*)$/iu, ['supplier'], () =>
                this.isWithinContextMap(container)],
            [/\bpartner\s+[^\n]*?<->\s*([\p{L}_]*)$/iu, ['partner'], () =>
                this.isWithinContextMap(container)],
            [new RegExp(`\\b(?:customer|supplier|partner)\\s+${qualifiedIdentifierSource}\\s*\\{\\s*([\\p{L}_]*)$`, 'iu'),
                ['integrationPatterns'], () => this.isWithinContextMap(container)]
        ];

        const match = this.getTransitionRequiredKeywordMatch(prefix) ??
            this.getTransitionContinuationMatch(document, position) ??
            continuations
            .map(([pattern, keywords, allowed, requireStatementStart]) => ({
                match: pattern.exec(prefix),
                keywords,
                allowed,
                requireStatementStart
            }))
            .find(candidate => candidate.match !== null && candidate.allowed() &&
                (!candidate.requireStatementStart ||
                    (candidate.match[1] ?? '').length > 0 ||
                    this.isStatementStartInPrefix(prefix, candidate.match.index)));
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

    private containerAllowsSibling(container: AstNode | undefined, phrase: string): boolean {
        return container !== undefined &&
            getSiblingCompletionKeywords(container.$type, isModule(container) && isInSharedKernel(container))
                .includes(phrase);
    }

    private isWithinContextMap(node: AstNode | undefined): boolean {
        return node !== undefined &&
            AstUtils.getContainerOfType(node, isContextMap) !== undefined;
    }

    private isModuleMemberOwner(module: AstNode): boolean {
        const parent = module.$container;
        return isBoundedContextPart(parent) || isSharedKernel(parent) || isModule(parent);
    }

    private isModuleDeclarationOwner(container: AstNode | undefined): boolean {
        if (!container) {
            return false;
        }
        return isBoundedContextPart(container) || isSharedKernel(container) ||
            isModule(container) && this.isModuleMemberOwner(container);
    }

    private isRepositoryOwner(container: AstNode | undefined, query: boolean): boolean {
        if (!container) {
            return false;
        }
        const repository = query ? isQueryRepository(container) : isRepository(container);
        if (repository) {
            const parent = container.$container;
            return isBoundedContextPart(parent) ||
                isModule(parent) && !isInSharedKernel(parent);
        }
        return isBoundedContextPart(container) ||
            isModule(container) && !isInSharedKernel(container);
    }

    private isReadClauseOwner(container: AstNode | undefined): boolean {
        if (!container || !isMethod(container)) {
            return false;
        }
        const owner = container.$container;
        return isApplicationService(owner) || isQueryService(owner) ||
            isProjector(owner) || isDomainService(owner);
    }

    private hasOpenedBody(container: AstNode | undefined): boolean {
        return container?.$cstNode?.text.includes('{') === true;
    }

    private isStatementStartInPrefix(prefix: string, keywordIndex: number): boolean {
        const before = prefix.slice(0, keywordIndex).trimEnd();
        return before.length === 0 || /[{}]$/u.test(before);
    }

    private isStatementKeywordAllowed(document: LangiumDocument, offset: number, keyword: string): boolean {
        const lineStart = getLineStartOffset(document, offset);
        const prefix = document.textDocument.getText().slice(lineStart, offset);
        const index = prefix.toLowerCase().lastIndexOf(keyword.toLowerCase());
        return index < 0 || this.isStatementStartInPrefix(prefix, index);
    }

    /** True when a partial compound keyword may be expanded in the cursor's scope. */
    isCompoundKeywordAllowed(document: LangiumDocument, position: Position, base: string): boolean {
        const offset = document.textDocument.offsetAt(position);
        const container = this.getContinuationContainer(document, offset);
        const statementBases = new Set([
            'application', 'root', 'value', 'read', 'data', 'domain', 'query', 'integration', 'depends'
        ]);
        if (statementBases.has(base.toLowerCase()) &&
            !this.isStatementKeywordAllowed(document, offset, base)) {
            return false;
        }
        const allowsOpenedSibling = (phrase: string): boolean =>
            this.hasOpenedBody(container) && this.containerAllowsSibling(container, phrase);
        switch (base) {
            case 'in':
                return isModel(container) ||
                    (isBoundedContext(container) || isBoundedContextPart(container)) &&
                    !this.hasOpenedBody(container);
            case 'bounded':
                return isModel(container) ||
                    isBoundedContext(container) && !this.hasOpenedBody(container);
            case 'context':
            case 'shared':
                return isModel(container);
            case 'application':
                return allowsOpenedSibling('application service');
            case 'root':
                return allowsOpenedSibling('root entity');
            case 'value':
                return allowsOpenedSibling('value object');
            case 'read':
                return allowsOpenedSibling('read model');
            case 'data':
                return allowsOpenedSibling('data object');
            case 'domain':
                return allowsOpenedSibling('domain service');
            case 'query':
                return allowsOpenedSibling('query repository') ||
                    allowsOpenedSibling('query service');
            case 'integration':
                return allowsOpenedSibling('integration event');
            case 'depends':
                return this.hasOpenedBody(container) && this.isModuleDeclarationOwner(container);
            case 'reads':
                return this.isReadClauseOwner(container);
            default:
                return true;
        }
    }

    private getContinuationContainer(document: LangiumDocument, offset: number): AstNode | undefined {
        const root = document.parseResult.value;
        const cstRoot = root?.$cstNode;
        if (!cstRoot) {
            return root;
        }
        const text = document.textDocument.getText();
        // Prefer the nearest unclosed brace block. Parser recovery can attach a
        // token to an outer declaration, but the source braces still identify the
        // method or block the cursor is actually inside.
        const unclosed = AstUtils.streamAst(root)
            .filter(node => isBlockNodeType(node.$type) && node.$cstNode !== undefined)
            .map(node => {
                const cstNode = node.$cstNode!;
                const openIndex = cstNode.text.indexOf('{');
                return { node, openOffset: openIndex >= 0 ? cstNode.offset + openIndex : -1 };
            })
            .filter(candidate => candidate.openOffset >= 0 && candidate.openOffset < offset &&
                !text.slice(candidate.openOffset, offset).includes('}'))
            .toArray()
            .sort((left, right) => right.openOffset - left.openOffset)[0];
        if (unclosed) {
            return unclosed.node;
        }
        const leaf = CstUtils.findLeafNodeAtOffset(cstRoot, Math.min(offset, cstRoot.end)) ??
            CstUtils.findLeafNodeBeforeOffset(cstRoot, offset);
        let node = leaf?.astNode;
        while (node && !isModel(node)) {
            const cstNode = node.$cstNode;
            const containsCursor = cstNode !== undefined &&
                cstNode.offset <= offset && offset <= cstNode.end;
            if (containsCursor && isBlockNodeType(node.$type)) {
                return node;
            }
            node = node.$container;
        }
        return node ?? root;
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
        const importStart = importDeclaration?.$cstNode?.offset ?? findPreviousImportStart(text, offset);
        if (importStart === undefined) {
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
            if (continuations.size === 0) {
                continue;
            }
            const gapToCursor = cstNode.end <= offset
                ? text.slice(cstNode.end, offset).trim().toLowerCase().replace(/\s+/gu, ' ')
                : '';
            if (gapToCursor.length > 0 && ![...continuations].some(keyword =>
                keyword.toLowerCase().startsWith(gapToCursor)
            )) {
                // A complete keyword on the current line (for example `actor`)
                // starts a new declaration; only a partial continuation
                // keyword may continue the earlier declaration across a
                // newline.
                continue;
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
        const transitionIndex = this.findLastKeywordOutsideQuotes(prefix, 'transition');
        if (transitionIndex === undefined) {
            return undefined;
        }
        const transitionSource = prefix.slice(transitionIndex + 'transition'.length);
        const currentChange = transitionSource.slice(transitionSource.lastIndexOf(',') + 1).trimStart();
        const toMatch = new RegExp(`^${identifierSource}\\s+from\\s+${identifierSource}\\s+([\\p{L}_]*)$`, 'iu').exec(currentChange);
        if (toMatch) {
            return { match: toMatch, keywords: ['to'] };
        }
        const fromMatch = new RegExp(`^${identifierSource}\\s+([\\p{L}_]*)$`, 'u').exec(currentChange);
        return fromMatch ? { match: fromMatch, keywords: ['from'] } : undefined;
    }

    private getTransitionContinuationMatch(
        document: LangiumDocument,
        position: Position
    ): { match: RegExpExecArray; keywords: string[] } | undefined {
        const root = document.parseResult.value;
        if (!root) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(position);
        if (!this.isTransitionContinuationPosition(document, offset)) {
            return undefined;
        }
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, offset);
        const linePrefix = text.slice(lineStart, offset).trimStart();
        const toMatch = new RegExp(`^${identifierSource}\\s+from\\s+${identifierSource}\\s+([\\p{L}_]*)$`, 'iu')
            .exec(linePrefix);
        if (toMatch) {
            return { match: toMatch, keywords: ['to'] };
        }
        const fromMatch = new RegExp(`^${identifierSource}\\s+([\\p{L}_]*)$`, 'u')
            .exec(linePrefix);
        return fromMatch ? { match: fromMatch, keywords: ['from'] } : undefined;
    }

    /**
     * Finds the last occurrence of a keyword outside quoted identifiers,
     * strings, and line comments. A field named `transition` must not be
     * mistaken for the transition clause keyword.
     */
    private findLastKeywordOutsideQuotes(source: string, keyword: string): number | undefined {
        let last: number | undefined;
        let quote: '"' | "'" | '`' | undefined;
        let escaped = false;
        for (let index = 0; index < source.length; index++) {
            const character = source[index]!;
            if (quote) {
                if (escaped) {
                    escaped = false;
                } else if (character === '\\') {
                    escaped = true;
                } else if (character === quote) {
                    quote = undefined;
                }
                continue;
            }
            if (character === '`' || character === '"' || character === "'") {
                quote = character;
                continue;
            }
            if (character === '/' && source[index + 1] === '/') {
                break;
            }
            if (source.startsWith(keyword, index)) {
                const before = source[index - 1];
                const after = source[index + keyword.length];
                if ((before === undefined || !/[\p{ID_Continue}]/u.test(before)) &&
                    (after === undefined || !/[\p{ID_Continue}]/u.test(after))) {
                    last = index;
                    index += keyword.length - 1;
                }
            }
        }
        return last;
    }

    getSameLineContinuationKeywords(node: AstNode, document: LangiumDocument, position: Position): string[] {
        if (isBoundedContext(node)) {
            if (node.subdomains.length > 0) {
                return [];
            }
            const start = node.$cstNode?.offset;
            const source = start === undefined ? '' : document.textDocument.getText().slice(start, document.textDocument.offsetAt(position));
            return /\s$/u.test(source) ? ['realizes'] : [];
        }
        if (isSubdomain(node)) {
            if (node.kind !== undefined) {
                return [];
            }
            const start = node.$cstNode?.offset;
            const source = start === undefined ? '' : document.textDocument.getText().slice(start, document.textDocument.offsetAt(position));
            return /\s$/u.test(source) ? ['kind'] : [];
        }
        if (isValueObject(node)) {
            const start = node.$cstNode?.offset;
            const source = start === undefined ? '' : document.textDocument.getText().slice(start, document.textDocument.offsetAt(position));
            return node.mirrors === undefined && !source.includes('{') && /\s$/u.test(source) ? ['mirrors'] : [];
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

    getSiblingKeywordLabelsAt(container: AstNode, _offset: number): readonly string[] {
        const labels = this.getSiblingKeywordLabels(container);
        if (!isModule(container)) {
            return labels;
        }
        const hidden = new Set<string>();
        if ((container.exposures?.length ?? 0) > 0) {
            hidden.add('exposes');
        }
        if ((container.dependencyClauses?.length ?? 0) > 0) {
            hidden.add('depends');
            hidden.add('depends on');
        }
        return hidden.size > 0 ? labels.filter(label => !hidden.has(label)) : labels;
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
