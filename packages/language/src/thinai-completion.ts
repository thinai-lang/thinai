import {
    type AstNode,
    type AstNodeDescription,
    type LangiumDocument,
    type ReferenceInfo,
    AstUtils,
    URI,
    UriUtils,
    stream
} from 'langium';
import { DefaultCompletionProvider, type CompletionContext, type CompletionValueItem } from 'langium/lsp';
import {
    CompletionItemKind,
    type CompletionItem,
    type CompletionList,
    type CompletionParams,
    type Position,
    type TextEdit
} from 'vscode-languageserver';
import type { CancellationToken } from 'vscode-jsonrpc';
import type { ThinaiServices } from './thinai-module.js';
import {
    isEnumType,
    isBoundedContext,
    isDomainEvent,
    isEventEmission,
    isEnumValue,
    isEntity,
    isField,
    isIntegrationEvent,
    isJourneyStep,
    isMethod,
    isMethodInvocation,
    isModule,
    isParameter,
    isSpecificationTextPart,
    isTransition,
    isSubdomain,
    isValueObject
} from './generated/ast.js';
import { getExportedName, ThinaiScopeProvider } from './thinai-scope.js';
import { INTEGRATION_PATTERNS } from './thinai-constants.js';
import { isLineSeparatedSibling } from './thinai-layout.js';

export class ThinaiCompletionProvider extends DefaultCompletionProvider {
    override readonly completionOptions = {
        triggerCharacters: ['"', '/', '.', '[', 'w']
    };

    private readonly thinaiServices: ThinaiServices;

    constructor(services: ThinaiServices) {
        super(services);
        this.thinaiServices = services;
    }

    protected override getReferenceCandidates(refInfo: ReferenceInfo, context: CompletionContext) {
        const { container, property } = refInfo;
        const pathCandidates = (this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider)
            .getPathCompletionCandidates(refInfo);
        if (pathCandidates !== undefined) {
            return stream(pathCandidates);
        }
        if ((isJourneyStep(container) || isMethodInvocation(container)) && property === 'targets') {
            const completedSegments = container.targets.filter(reference =>
                reference.$refNode !== undefined && reference.$refNode.end < context.offset
            ).length;
            return stream((this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider)
                .getInvocationCompletionCandidates({ ...refInfo, index: completedSegments }));
        }
        if (isSpecificationTextPart(container) && property === 'targets') {
            const completedSegments = container.targets.filter(reference =>
                reference.$refNode !== undefined && reference.$refNode.end < context.offset
            ).length;
            const scopedReference = { ...refInfo, index: completedSegments };
            return (this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider).filterCompletionCandidates(
                scopedReference,
                this.thinaiServices.references.ScopeProvider.getScope(scopedReference).getAllElements()
            );
        }
        return (this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider).filterCompletionCandidates(
            refInfo,
            super.getReferenceCandidates(refInfo, context)
        );
    }

    protected override createReferenceCompletionItem(
        nodeDescription: AstNodeDescription,
        refInfo: ReferenceInfo,
        context: CompletionContext
    ): CompletionValueItem {
        const item = super.createReferenceCompletionItem(nodeDescription, refInfo, context);
        item.detail = this.getCompletionDetail(nodeDescription);
        return item;
    }

    private getCompletionDetail(description: AstNodeDescription): string {
        const node = description.node;
        if (!node) {
            return `${description.type} ${description.name}`;
        }
        const name = this.getCanonicalName(node, description.name);
        if (isMethod(node)) {
            const parameters = node.parameters.map(parameter => this.getParameterDetail(parameter)).join(', ');
            const result = node.returnPrimitive ??
                (node.returnType?.ref ? this.getCanonicalName(node.returnType.ref, node.returnType.$refText) :
                    node.returnCollection ? this.getCollectionDetail(node.returnCollection) : undefined);
            return `Method ${name}(${parameters})${result ? ` returns ${result}` : ''}`;
        }
        if (isField(node)) {
            return `Field ${name}: ${this.getTypeDetail(node)}`;
        }
        if (isParameter(node)) {
            return `Parameter ${name}: ${this.getParameterDetail(node).replace(`${node.name}: `, '')}`;
        }
        if (isEnumValue(node)) {
            const enumName = this.getCanonicalName(node.$container, node.$container.name);
            return `Enum value ${name} (${enumName})`;
        }
        return `${description.type} ${name}`;
    }

    private getCanonicalName(node: AstNode, fallback: string): string {
        if (!('name' in node) || typeof node.name !== 'string') {
            return fallback;
        }
        return getExportedName(node as AstNode & { name: string }) || node.name;
    }

    private getParameterDetail(parameter: import('./generated/ast.js').Parameter): string {
        const optional = parameter.optional ? '?' : '';
        const parameterTarget = parameter.type?.ref;
        const type = parameter.primitive ??
            (isDomainEvent(parameterTarget) || isIntegrationEvent(parameterTarget)
                ? `event ${this.getCanonicalName(parameterTarget, parameter.type!.$refText)}`
                : parameterTarget ? this.getCanonicalName(parameterTarget, parameter.type!.$refText) :
                    parameter.collection ? this.getCollectionDetail(parameter.collection) : 'unknown');
        return `${parameter.name}${optional}: ${type}`;
    }

    private getTypeDetail(field: import('./generated/ast.js').Field): string {
        return field.primitive ??
            (field.type?.ref ? this.getCanonicalName(field.type.ref, field.type.$refText) :
                field.collection ? this.getCollectionDetail(field.collection) : 'unknown');
    }

    private getCollectionDetail(collection: import('./generated/ast.js').CollectionType): string {
        const element = collection.elementPrimitive ??
            (collection.elementType?.ref ? this.getCanonicalName(collection.elementType.ref, collection.elementType.$refText) :
                collection.elementCollection ? this.getCollectionDetail(collection.elementCollection) : 'unknown');
        if (collection.kind !== 'Map') {
            return `${collection.kind}<${element}>`;
        }
        const value = collection.valuePrimitive ??
            (collection.valueType?.ref ? this.getCanonicalName(collection.valueType.ref, collection.valueType.$refText) :
                collection.valueCollection ? this.getCollectionDetail(collection.valueCollection) : 'unknown');
        return `Map<${element}, ${value}>`;
    }

    override async getCompletion(
        document: LangiumDocument,
        params: CompletionParams,
        cancelToken?: CancellationToken
    ): Promise<CompletionList | undefined> {
        const defaultCompletion = await super.getCompletion(document, params, cancelToken);
        const optionalClauseCompletions = this.getOptionalClauseCompletions(document, params.position);
        if (optionalClauseCompletions.length > 0) {
            const optionalLabels = new Set(optionalClauseCompletions.map(item => item.label));
            const items = (defaultCompletion?.items ?? []).filter(item =>
                typeof item.label !== 'string' || !optionalLabels.has(item.label)
            );
            items.push(...optionalClauseCompletions);
            return this.filterSameLineSiblingCompletions(document, params.position, {
                isIncomplete: defaultCompletion?.isIncomplete ?? false,
                items
            }, optionalClauseCompletions.map(item => item.label));
        }
        const constrainedValueCompletions = [
            ...this.getInitialStateCompletions(document, params.position),
            ...this.getIntegrationPatternCompletions(document, params.position)
        ];
        const importContext = this.getImportPathContext(document, params.position);
        if (!importContext) {
            if (constrainedValueCompletions.length === 0) {
                return this.filterSameLineSiblingCompletions(document, params.position, defaultCompletion);
            }
            return this.filterSameLineSiblingCompletions(document, params.position, {
                isIncomplete: defaultCompletion?.isIncomplete ?? false,
                items: [...(defaultCompletion?.items ?? []), ...constrainedValueCompletions]
            });
        }

        const importItems = await this.getImportPathCompletions(document, importContext.path, importContext.pathStart);
        return this.filterSameLineSiblingCompletions(document, params.position, {
            isIncomplete: defaultCompletion?.isIncomplete ?? false,
            items: [...(defaultCompletion?.items ?? []), ...constrainedValueCompletions, ...importItems]
        });
    }

    private filterSameLineSiblingCompletions(
        document: LangiumDocument,
        position: Position,
        completion: CompletionList | undefined,
        extraAllowedKeywords: string[] = []
    ): CompletionList | undefined {
        if (!completion) {
            return undefined;
        }
        const sibling = this.getSameLineSiblingAt(document, position);
        if (!sibling) {
            return completion;
        }
        const allowed = new Set([
            ...this.getSameLineContinuationKeywords(sibling, document, position),
            ...this.getInProgressKeywordContinuations(document, position),
            ...extraAllowedKeywords
        ]);
        return {
            ...completion,
            items: completion.items.filter(item => item.kind !== CompletionItemKind.Keyword || allowed.has(item.label))
        };
    }

    private getInProgressKeywordContinuations(document: LangiumDocument, position: Position): string[] {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const prefix = text.slice(lineStart, offset);
        const words = prefix.trimEnd().split(/\s+/);
        if (words.at(-1)?.toLowerCase() === 'context' && words.at(-2)?.toLowerCase() !== 'bounded') {
            return ['map'];
        }
        const continuations: ReadonlyArray<readonly [RegExp, string[]]> = [
            [/\bin\s+bounded\s*$/i, ['context']],
            [/\bbounded\s*$/i, ['context']],
            [/\bshared\s*$/i, ['kernel']],
            [/\bapplication\s*$/i, ['service']],
            [/\broot\s*$/i, ['entity']],
            [/\bvalue\s*$/i, ['object']],
            [/\bread\s*$/i, ['model']],
            [/\bdata\s*$/i, ['object']],
            [/\bdomain\s*$/i, ['service']],
            [/\bquery\s*$/i, ['repository', 'service']],
            [/\bintegration\s*$/i, ['event']],
            [/\bdepends\s*$/i, ['on']],
            [/\bimport\s+\{[^}]*\}\s*$/i, ['from']],
            [/\brepository\s+[_a-zA-Z][\w_]*\s*$/i, ['manages']],
            [/\bquery\s+repository\s+[_a-zA-Z][\w_]*\s*$/i, ['serves']],
            [/\btransition\s+[_a-zA-Z][\w_]*\s*$/i, ['from']],
            [/\btransition\s+[_a-zA-Z][\w_]*\s+from\s+[_a-zA-Z][\w_]*\s*$/i, ['to']],
            [/\bsharedKernel\s+[_a-zA-Z][\w_.]*\s+\{\s*$/i, ['participants']],
            [/\bcustomer\s+[^\n]*?->\s*$/i, ['supplier']],
            [/\bpartner\s+[^\n]*?<->\s*$/i, ['partner']],
            [/\b(?:customer|supplier)\s+[_a-zA-Z][\w.]*\s*\{\s*$/i, ['integrationPatterns']]
        ];

        return continuations.find(([pattern]) => pattern.test(prefix))?.[1] ?? [];
    }

    private getSameLineSiblingAt(document: LangiumDocument, position: Position): AstNode | undefined {
        const model = document.parseResult.value;
        if (!model) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(position);
        const currentLine = position.line;
        const text = document.textDocument.getText();
        let best: AstNode | undefined;
        let bestEnd = -1;
        for (const node of AstUtils.streamAst(model)) {
            const cstNode = node.$cstNode;
            if (!cstNode || !isLineSeparatedSibling(node) || cstNode.end > offset || cstNode.range.end.line !== currentLine) {
                continue;
            }
            if (/[\r\n]/.test(text.slice(cstNode.end, offset))) {
                continue;
            }
            if (cstNode.end > bestEnd) {
                best = node;
                bestEnd = cstNode.end;
            }
        }
        return best;
    }

    private getSameLineContinuationKeywords(node: AstNode, document: LangiumDocument, position: Position): string[] {
        if (isBoundedContext(node)) {
            return node.subdomains.length === 0 ? ['realizes'] : [];
        }
        if (isSubdomain(node)) {
            return node.kind === undefined ? ['kind'] : [];
        }
        if (isModule(node)) {
            return node.dependencies.length === 0 ? ['depends'] : [];
        }
        if (isValueObject(node)) {
            return node.mirrors === undefined ? ['mirrors'] : [];
        }
        if (isField(node) && isEntity(node.$container) && !node.optional && node.initialState === undefined && isEnumType(node.type?.ref)) {
            return ['initial'];
        }
        if (isMethod(node) && !node.returnPrimitive && !node.returnType && !node.returnCollection) {
            const start = node.$cstNode?.offset;
            if (start === undefined) {
                return [];
            }
            const source = document.textDocument.getText().slice(start, document.textDocument.offsetAt(position));
            if (source.trimEnd().endsWith(')')) {
                return ['returns'];
            }
        }
        return [];
    }

    private getOptionalClauseCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const model = document.parseResult.value;
        if (!model) {
            return [];
        }

        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        let best: { end: number; prefix: string; keywords: string[]; needsLeadingSpace: boolean } | undefined;
        for (const node of AstUtils.streamAst(model)) {
            const keywords = isJourneyStep(node)
                ? [
                    ...(!node.arguments ? ['with'] : []),
                    ...(!node.guard ? ['when'] : [])
                ]
                : isTransition(node) || isEventEmission(node) || isMethodInvocation(node)
                    ? (!node.guard ? ['when'] : [])
                    : [];
            if (keywords.length === 0) {
                continue;
            }
            const cstNode = node.$cstNode;
            if (!cstNode) {
                continue;
            }
            const end = document.textDocument.offsetAt(cstNode.range.end);
            if (end > offset) {
                continue;
            }
            const gap = text.slice(end, offset);
            const match = /^(\s*)([\p{L}_]*)$/u.exec(gap);
            if (!match || !keywords.some(keyword =>
                match[2].length < keyword.length && keyword.startsWith(match[2].toLowerCase())
            )) {
                continue;
            }
            if (!best || end > best.end) {
                best = { end, prefix: match[2], keywords, needsLeadingSpace: match[1].length === 0 };
            }
        }
        if (!best) {
            return [];
        }

        const prefixStart = offset - best.prefix.length;
        return best.keywords
            .filter(keyword => keyword.startsWith(best!.prefix.toLowerCase()))
            .map(keyword => ({
                label: keyword,
                kind: CompletionItemKind.Keyword,
                detail: keyword === 'when' ? 'Guard clause' : 'Journey input clause',
                sortText: '1',
                textEdit: {
                    range: {
                        start: document.textDocument.positionAt(prefixStart),
                        end: position
                    },
                    newText: `${best!.needsLeadingSpace ? ' ' : ''}${keyword}`
                }
            }));
    }

    private getInitialStateCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const model = document.parseResult.value;
        if (!model) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        let match: RegExpExecArray | null = null;
        let selected: import('./generated/ast.js').Field | undefined;
        let selectedStart = -1;
        for (const node of AstUtils.streamAst(model)) {
            if (!isField(node) || !node.$cstNode) {
                continue;
            }
            const start = document.textDocument.offsetAt(node.$cstNode.range.start);
            if (start < selectedStart || start > offset) {
                continue;
            }
            const fieldPrefix = text.slice(start, offset);
            const candidateMatch = /\binitial\s+([\p{L}_]*)$/u.exec(fieldPrefix);
            if (candidateMatch) {
                selected = node;
                selectedStart = start;
                match = candidateMatch;
            }
        }
        if (!selected || !match || !isEntity(selected.$container) || selected.optional || !isEnumType(selected.type?.ref)) {
            return [];
        }
        const prefix = match[1];
        const start = offset - prefix.length;
        return selected.type.ref.values
            .filter(value => value.name.startsWith(prefix))
            .map(value => ({
                label: value.name,
                kind: CompletionItemKind.EnumMember,
                detail: `Initial state of ${selected!.name}`,
                sortText: '0',
                textEdit: {
                    range: { start: document.textDocument.positionAt(start), end: position },
                    newText: value.name
                }
            }));
    }

    private getIntegrationPatternCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const values = [...INTEGRATION_PATTERNS];
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const propertyStart = text.lastIndexOf('integrationPatterns', offset);
        if (propertyStart < 0) {
            return [];
        }
        const propertyMatch = /^integrationPatterns\s*:\s*\[/.exec(text.slice(propertyStart));
        if (!propertyMatch) {
            return [];
        }

        let quote: string | undefined;
        let valueStart = -1;
        let escaped = false;
        const usedValues = new Set<string>();
        const arrayStart = propertyStart + propertyMatch[0].length;
        for (let index = arrayStart; index < offset; index++) {
            const character = text[index];
            if (quote) {
                if (escaped) {
                    escaped = false;
                } else if (character === '\\') {
                    escaped = true;
                } else if (character === quote) {
                    usedValues.add(text.slice(valueStart, index));
                    quote = undefined;
                    valueStart = -1;
                }
            } else if (character === ']' || character === '\n' && text.slice(index, offset).trim().length === 0) {
                return [];
            } else if (character === '"' || character === "'") {
                quote = character;
                valueStart = index + 1;
            }
        }
        if (!quote || valueStart < 0) {
            return [];
        }

        const prefix = text.slice(valueStart, offset);
        return values
            .filter(value => value.startsWith(prefix) && !usedValues.has(value))
            .map(value => ({
                label: value,
                kind: CompletionItemKind.EnumMember,
                detail: 'Context-map integration pattern',
                sortText: '0',
                textEdit: {
                    range: { start: document.textDocument.positionAt(valueStart), end: position },
                    newText: value
                }
            }));
    }

    private getImportPathContext(document: LangiumDocument, position: Position): {
        path: string;
        pathStart: number;
    } | undefined {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const prefix = text.slice(lineStart, offset);
        const match = /^\s*import\s+(["'])([^"']*)$/.exec(prefix);
        if (!match) {
            return undefined;
        }

        return {
            path: match[2],
            pathStart: offset - match[2].length
        };
    }

    private async getImportPathCompletions(
        document: LangiumDocument,
        typedPath: string,
        pathStart: number
    ): Promise<Array<{ label: string; kind: CompletionItemKind; textEdit: TextEdit; detail: string }>> {
        const files = new Map<string, URI>();
        for (const knownDocument of this.thinaiServices.shared.workspace.LangiumDocuments.all) {
            if (UriUtils.extname(knownDocument.uri) === '.tni') {
                files.set(knownDocument.uri.toString(), knownDocument.uri);
            }
        }

        for (const folder of this.thinaiServices.shared.workspace.WorkspaceManager.workspaceFolders ?? []) {
            const folderUri = URI.parse(folder.uri);
            for (const uri of await this.thinaiServices.shared.workspace.WorkspaceManager.searchFolder(folderUri)) {
                if (UriUtils.extname(uri) === '.tni') {
                    files.set(uri.toString(), uri);
                }
            }
        }

        const currentDirectory = UriUtils.dirname(document.uri);
        const items = [] as Array<{ label: string; kind: CompletionItemKind; textEdit: TextEdit; detail: string }>;
        for (const uri of files.values()) {
            if (UriUtils.equals(uri, document.uri)) {
                continue;
            }

            const relativePath = this.toImportPath(currentDirectory, uri);
            if (!relativePath.startsWith(typedPath)) {
                continue;
            }

            items.push({
                label: relativePath,
                kind: CompletionItemKind.File,
                textEdit: {
                    range: {
                        start: document.textDocument.positionAt(pathStart),
                        end: document.textDocument.positionAt(pathStart + typedPath.length)
                    },
                    newText: relativePath
                },
                detail: 'Thinai import'
            });
        }
        return items;
    }

    private toImportPath(currentDirectory: URI, target: URI): string {
        const relativePath = UriUtils.relative(currentDirectory, target);
        return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
    }
}
