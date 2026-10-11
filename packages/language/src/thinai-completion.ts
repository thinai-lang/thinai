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
import type { ContextMap } from './generated/ast.js';
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
    isModel,
    isMethod,
    isMethodInvocation,
    isModule,
    isParameter,
    isSpecificationTextPart,
    isTransition,
    isSubdomain,
    isValueObject
} from './generated/ast.js';
import { getExportedName, isInSharedKernel, ThinaiScopeProvider } from './thinai-scope.js';
import { INTEGRATION_PATTERNS } from './thinai-constants.js';
import { isLineSeparatedSibling } from './thinai-layout.js';

export class ThinaiCompletionProvider extends DefaultCompletionProvider {
    override readonly completionOptions = {
        triggerCharacters: [' ', '"', '/', '.', '[', '>', '-', ':', '<', ',']
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
        const relationshipContinuations = this.getContextMapRelationshipContinuations(document, params.position);
        const hasBoundedContextCandidates = defaultCompletion?.items.some(item =>
            item.detail?.startsWith('BoundedContext ')
        ) === true;
        const constrainedValueCompletions = [
            ...this.getInitialStateCompletions(document, params.position),
            ...this.getPartialInitialKeywordCompletions(document, params.position),
            ...this.getIntegrationPatternCompletions(document, params.position),
            ...relationshipContinuations,
            ...this.getExposureDeclarationCompletions(document, params.position, defaultCompletion),
            ...(hasBoundedContextCandidates ? [] : this.getContextMapRightContextCompletions(document, params.position))
        ];
        const inProgressKeywordCompletions = [
            ...this.getInProgressKeywordCompletions(document, params.position),
            ...this.getPartialSameLineContinuations(document, params.position)
        ];
        const blockKeywords = this.getEnclosingBlockKeywordCompletions(document, params.position);
        const modelGapKeywords = this.getModelGapKeywordCompletions(
            document,
            params.position,
            defaultCompletion,
            inProgressKeywordCompletions
        );
        const scopedDefaultCompletion = this.filterSharedKernelModuleKeywords(document, params.position, defaultCompletion);
        const completionWithBlockKeywords = this.filterContextMapKeywordsForRelationshipCompletion(
            document,
            params.position,
            this.addFallbackKeywords(scopedDefaultCompletion, blockKeywords)
        );
        const completionWithModelGapKeywords = this.addSupplementaryKeywords(completionWithBlockKeywords, modelGapKeywords);
        const completionWithKeywords = this.withCompoundKeywordCompletions(completionWithModelGapKeywords, inProgressKeywordCompletions);
        const relationshipContinuationLabels = new Set(relationshipContinuations.map(item => item.label));
        const completionItems = (completionWithKeywords?.items ?? []).filter(item =>
            !relationshipContinuationLabels.has(item.label)
        );
        const sameLineKeywordContinuations = [
            ...inProgressKeywordCompletions.map(item => item.label),
            ...constrainedValueCompletions.filter(item => item.kind === CompletionItemKind.Keyword).map(item => String(item.label)),
            ...relationshipContinuations.map(item => item.label),
            ...modelGapKeywords.map(item => String(item.label))
        ];
        const importContext = this.getImportPathContext(document, params.position);
        if (!importContext) {
            if (constrainedValueCompletions.length === 0 && inProgressKeywordCompletions.length === 0 &&
                modelGapKeywords.length === 0) {
                return this.filterSameLineSiblingCompletions(document, params.position, completionWithKeywords);
            }
            return this.filterSameLineSiblingCompletions(document, params.position, {
                isIncomplete: completionWithKeywords?.isIncomplete ?? false,
                items: [...completionItems, ...constrainedValueCompletions]
            }, sameLineKeywordContinuations);
        }

        const importItems = await this.getImportPathCompletions(document, importContext.path, importContext.pathStart);
        return this.filterSameLineSiblingCompletions(document, params.position, {
            isIncomplete: completionWithKeywords?.isIncomplete ?? false,
            items: [...completionItems, ...constrainedValueCompletions, ...importItems]
        }, sameLineKeywordContinuations);
    }

    private withCompoundKeywordCompletions(
        completion: CompletionList | undefined,
        continuations: CompletionItem[]
    ): CompletionList | undefined {
        if (!completion) {
            return continuations.length > 0 ? { isIncomplete: false, items: continuations } : undefined;
        }

        if (continuations.length > 0) {
            const items = completion.items.filter(item => item.kind !== CompletionItemKind.Keyword);
            const seen = new Set(items.map(item => item.label));
            items.push(...continuations.filter(item => !seen.has(item.label)));
            return { ...completion, items };
        }

        const phrases: Record<string, string[]> = {
            in: ['in bounded context'],
            bounded: ['bounded context'],
            context: ['context map'],
            shared: ['shared kernel'],
            application: ['application service'],
            domain: ['domain service'],
            query: ['query repository', 'query service'],
            read: ['read model'],
            data: ['data object'],
            value: ['value object'],
            root: ['root entity'],
            integration: ['integration event'],
            depends: ['depends on']
        };
        const items = completion.items.flatMap(item => {
            if (item.kind !== CompletionItemKind.Keyword || typeof item.label !== 'string' ||
                !Object.prototype.hasOwnProperty.call(phrases, item.label)) {
                return [item];
            }
            return phrases[item.label].map(phrase => ({
                ...item,
                label: phrase,
                insertText: phrase,
                textEdit: item.textEdit ? { ...item.textEdit, newText: phrase } : item.textEdit
            }));
        });
        const seen = new Set(items.map(item => item.label));
        items.push(...continuations.filter(item => !seen.has(item.label)));
        return { ...completion, items };
    }

    private addFallbackKeywords(
        completion: CompletionList | undefined,
        fallbacks: CompletionItem[]
    ): CompletionList | undefined {
        if (fallbacks.length === 0) {
            return completion;
        }
        const hasKeyword = completion?.items.some(item => item.kind === CompletionItemKind.Keyword) === true;
        if (hasKeyword) {
            return completion;
        }
        const items = completion?.items ?? [];
        return { isIncomplete: completion?.isIncomplete ?? false, items: [...items, ...fallbacks] };
    }

    private filterContextMapKeywordsForRelationshipCompletion(
        document: LangiumDocument,
        position: Position,
        completion: CompletionList | undefined
    ): CompletionList | undefined {
        if (!completion) {
            return completion;
        }
        const root = document.parseResult.value;
        if (!root) {
            return completion;
        }
        const offset = document.textDocument.offsetAt(position);
        const inContextMap = AstUtils.streamAst(root).some(node => {
            if (node.$type !== 'ContextMap') {
                return false;
            }
            const cstNode = node.$cstNode;
            return cstNode !== undefined && cstNode.offset <= offset && offset < cstNode.end;
        });
        const hasBoundedContextCandidates = completion.items.some(item =>
            item.detail?.startsWith('BoundedContext ')
        );
        const relationshipLineState = this.getContextMapRelationshipLineState(document, position);
        const shouldFilterKeywords = relationshipLineState === 'incomplete' ||
            hasBoundedContextCandidates && relationshipLineState !== 'complete';
        if (!inContextMap || !shouldFilterKeywords) {
            return completion;
        }
        return {
            ...completion,
            items: completion.items.filter(item =>
                item.kind !== CompletionItemKind.Keyword ||
                !['customer', 'partner', 'separateWays', 'sharedKernel'].includes(String(item.label))
            )
        };
    }

    private getContextMapRelationshipLineState(
        document: LangiumDocument,
        position: Position
    ): 'incomplete' | 'complete' | undefined {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const rawPrefix = text.slice(lineStart, offset);
        const relationshipPrefix = rawPrefix.trim();
        if (!/^(?:customer|partner|separateWays)\b/i.test(relationshipPrefix)) {
            return undefined;
        }

        const completed = this.isCompleteContextMapRelationship(relationshipPrefix);
        const endedAtRelationshipBoundary = /\s$/.test(rawPrefix) || relationshipPrefix.endsWith('}');
        if (completed && endedAtRelationshipBoundary) {
            return 'complete';
        }
        return 'incomplete';
    }

    private isCompleteContextMapRelationship(source: string): boolean {
        const relationship = source.trim();
        const endpoint = String.raw`[_a-zA-Z][\w_]*(?:\.[_a-zA-Z][\w_]*)*`;
        const integrationPatterns = String.raw`\{\s*integrationPatterns\s*:\s*\[[^\]]*\]\s*\}`;
        const completedRelationships = [
            new RegExp(String.raw`^customer\s+${endpoint}(?:\s*${integrationPatterns})?\s*->\s*supplier\s+${endpoint}(?:\s*${integrationPatterns})?$`),
            new RegExp(String.raw`^partner\s+${endpoint}(?:\s*${integrationPatterns})?\s*<->\s*partner\s+${endpoint}(?:\s*${integrationPatterns})?$`),
            new RegExp(String.raw`^separateWays\s+${endpoint}\s*-x-\s*${endpoint}$`)
        ];
        return completedRelationships.some(pattern => pattern.test(relationship));
    }

    private getContextMapRelationshipContinuations(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const contextMap = AstUtils.streamAst(root)
            .filter(node => node.$type === 'ContextMap')
            .find(node => {
                const cstNode = node.$cstNode;
                return cstNode !== undefined && cstNode.offset <= offset && offset < cstNode.end;
            });
        if (!contextMap) {
            return [];
        }

        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const prefixes = AstUtils.streamAst(contextMap)
            .filter(node => node.$type === 'CustomerSupplierRelationship' ||
                node.$type === 'PartnershipRelationship' || node.$type === 'SeparateWaysRelationship')
            .map(node => node.$cstNode)
            .filter((cstNode): cstNode is NonNullable<typeof cstNode> => cstNode !== undefined && cstNode.offset <= offset)
            .toArray()
            .sort((left, right) => right.offset - left.offset)
            .map(cstNode => text.slice(cstNode.offset, offset));
        prefixes.push(text.slice(lineStart, offset));
        const endpoint = String.raw`[_a-zA-Z][\w_]*(?:\.[_a-zA-Z][\w_]*)*`;
        const integrationPatterns = String.raw`\{\s*integrationPatterns\s*:\s*\[[^\]]*\]\s*\}`;
        const continuations: ReadonlyArray<readonly [RegExp, string]> = [
            [new RegExp(String.raw`^\s*customer\s+${endpoint}(?:\s*${integrationPatterns})?\s+$`), '-> supplier'],
            [new RegExp(String.raw`^\s*partner\s+${endpoint}(?:\s*${integrationPatterns})?\s+$`), '<-> partner'],
            [new RegExp(String.raw`^\s*separateWays\s+${endpoint}\s+$`), '-x-']
        ];
        const continuation = prefixes.flatMap(prefix =>
            continuations.filter(([pattern]) => pattern.test(prefix)).map(([, label]) => label)
        )[0];
        if (!continuation) {
            return [];
        }

        return [{
            label: continuation,
            kind: CompletionItemKind.Operator,
            detail: 'Context-map relationship continuation',
            sortText: '0',
            textEdit: {
                range: { start: position, end: position },
                newText: `${continuation} `
            }
        }];
    }

    private getContextMapRightContextCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const endpoint = String.raw`[_a-zA-Z][\w_]*(?:\.[_a-zA-Z][\w_]*)*`;
        const integrationPatterns = String.raw`\{\s*integrationPatterns\s*:\s*\[[^\]]*\]\s*\}`;
        const rightContextPatterns = [
            new RegExp(String.raw`^\s*customer\s+${endpoint}(?:\s*${integrationPatterns})?\s*->\s*supplier\s*([\w.]*)$`, 'i'),
            new RegExp(String.raw`^\s*partner\s+${endpoint}(?:\s*${integrationPatterns})?\s*<->\s*partner\s*([\w.]*)$`, 'i'),
            new RegExp(String.raw`^\s*separateWays\s+${endpoint}\s+-x-\s*([\w.]*)$`, 'i')
        ];
        const contextMap = AstUtils.streamAst(root)
            .filter(candidate => candidate.$type === 'ContextMap')
            .find(candidate => {
                const cstNode = candidate.$cstNode;
                return cstNode !== undefined && cstNode.offset <= offset && offset < cstNode.end;
            }) as ContextMap | undefined;
        if (!contextMap) {
            return [];
        }

        const prefixes = AstUtils.streamAst(contextMap)
            .filter(candidate => candidate.$type === 'CustomerSupplierRelationship' ||
                candidate.$type === 'PartnershipRelationship' || candidate.$type === 'SeparateWaysRelationship')
            .map(candidate => candidate.$cstNode)
            .filter((cstNode): cstNode is NonNullable<typeof cstNode> => cstNode !== undefined && cstNode.offset <= offset)
            .toArray()
            .sort((left, right) => right.offset - left.offset)
            .map(cstNode => text.slice(cstNode.offset, offset));
        prefixes.push(text.slice(lineStart, offset));
        const match = prefixes.flatMap(prefix =>
            rightContextPatterns.map(pattern => pattern.exec(prefix)).filter((result): result is RegExpExecArray => result !== null)
        )[0];
        if (!match) {
            return [];
        }

        const typedPrefix = match[1] ?? '';
        const prefixStart = offset - typedPrefix.length;
        const needsLeadingSpace = prefixStart > 0 && !/\s/.test(text[prefixStart - 1]!);
        const scopeProvider = this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider;
        const completionContext = this.getLangiumCompletionContext(document, position);
        return scopeProvider.getContextMapBoundedContextCandidates(contextMap)
            .filter(description => description.name.toLowerCase().startsWith(typedPrefix.toLowerCase()))
            .map(description => {
                const insertText = `${needsLeadingSpace ? ' ' : ''}${description.name}`;
                const item: CompletionValueItem = {
                    nodeDescription: description,
                    kind: this.thinaiServices.shared.lsp.NodeKindProvider.getCompletionItemKind(description),
                    detail: this.getCompletionDetail(description),
                    sortText: '0',
                    insertText
                };
                const langiumItem = completionContext ? this.fillCompletionItem(completionContext, item) : undefined;
                return langiumItem ?? {
                    ...item,
                    label: description.name,
                    textEdit: {
                        range: { start: document.textDocument.positionAt(prefixStart), end: position },
                        newText: insertText
                    }
                };
            });
    }

    private getExposureDeclarationCompletions(
        document: LangiumDocument,
        position: Position,
        defaultCompletion: CompletionList | undefined
    ): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const exposure = AstUtils.streamAst(root)
            .filter(node => node.$type === 'Exposure')
            .find(node => {
                const cstNode = node.$cstNode;
                return cstNode !== undefined && cstNode.offset <= offset && offset <= cstNode.end;
            });
        if (!exposure?.$cstNode) {
            return [];
        }

        const source = text.slice(exposure.$cstNode.offset, offset).trimStart();
        const match = /^exposes\s+(?:(?:[_a-zA-Z][\w.]*)\s*,\s*)*([\w.]*)$/iu.exec(source);
        if (!match) {
            return [];
        }
        const typedPrefix = match[1] ?? '';
        const prefixStart = offset - typedPrefix.length;
        const existingItems = defaultCompletion?.items ?? [];
        const completionContext = this.getLangiumCompletionContext(document, position);
        const scopeProvider = this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider;
        return scopeProvider.getExposureDeclarationCandidates(exposure as import('./generated/ast.js').Exposure)
            .filter(description => {
                const detail = this.getCompletionDetail(description);
                return description.name.toLowerCase().startsWith(typedPrefix.toLowerCase()) &&
                    !existingItems.some(item => item.label === description.name && item.detail === detail);
            })
            .map(description => {
                const needsLeadingSpace = prefixStart > 0 && !/\s/.test(text[prefixStart - 1]!);
                const insertText = `${needsLeadingSpace ? ' ' : ''}${description.name}`;
                const item: CompletionValueItem = {
                    nodeDescription: description,
                    kind: this.thinaiServices.shared.lsp.NodeKindProvider.getCompletionItemKind(description),
                    detail: this.getCompletionDetail(description),
                    sortText: '0',
                    insertText
                };
                const langiumItem = completionContext ? this.fillCompletionItem(completionContext, item) : undefined;
                return langiumItem ?? {
                    ...item,
                    label: description.name,
                    textEdit: {
                        range: { start: document.textDocument.positionAt(prefixStart), end: position },
                        newText: insertText
                    }
                };
            });
    }

    private addSupplementaryKeywords(
        completion: CompletionList | undefined,
        additions: CompletionItem[]
    ): CompletionList | undefined {
        if (additions.length === 0) {
            return completion;
        }
        const items = completion?.items ?? [];
        const labels = new Set(items.map(item => item.label));
        return {
            isIncomplete: completion?.isIncomplete ?? false,
            items: [...items, ...additions.filter(item => !labels.has(item.label))]
        };
    }

    private getModelGapKeywordCompletions(
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
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const rawPrefix = text.slice(lineStart, offset);
        const typedPrefix = rawPrefix.trimStart();
        const labels = [
            'import', 'shared kernel', 'subdomain', 'bounded context', 'in bounded context',
            'context map', 'actor', 'journey'
        ];
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

    private getEnclosingBlockKeywordCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const labelsByType: Record<string, string[]> = {
            BoundedContextPart: [
                'application service', 'query service', 'projector', 'aggregate', 'domain service', 'repository',
                'query repository', 'factory', 'event', 'integration event', 'module', 'root entity', 'entity',
                'value object', 'enum', 'read model', 'data object'
            ],
            SharedKernel: ['value object', 'enum', 'domain service', 'module'],
            SharedKernelModule: ['exposes', 'domain service', 'module', 'value object', 'enum'],
            Module: [
                'exposes', 'application service', 'query service', 'projector', 'aggregate', 'domain service',
                'repository', 'query repository', 'factory', 'event', 'integration event', 'module',
                'root entity', 'entity', 'value object', 'enum', 'read model', 'data object'
            ],
            ContextMap: ['customer', 'partner', 'separateWays', 'sharedKernel'],
            Aggregate: ['entity', 'root entity', 'value object', 'enum', 'invariant'],
            Entity: ['constructor', 'method'],
            ValueObject: ['constructor', 'method'],
            ApplicationService: ['method'],
            DomainService: ['method'],
            QueryService: ['method'],
            Projector: ['method'],
            Factory: ['method'],
            Method: ['invariant', 'precondition', 'postcondition', 'behavior', 'transition', 'invokes', 'emits', 'projects'],
            Constructor: ['invariant', 'precondition', 'postcondition', 'behavior'],
            Journey: ['by'],
            JourneyActor: ['invoke']
        };
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const linePrefixStart = (openingBrace: number) => openingBrace >= lineStart ? openingBrace + 1 : lineStart;
        const container = AstUtils.streamAst(root)
            .filter(candidate => labelsByType[candidate.$type] !== undefined)
            .filter(candidate => {
                const cstNode = candidate.$cstNode;
                return cstNode !== undefined && cstNode.offset <= offset && offset < cstNode.end;
            })
            .toArray()
            .sort((left, right) => (left.$cstNode!.end - left.$cstNode!.offset) - (right.$cstNode!.end - right.$cstNode!.offset))
            .find(candidate => {
                const cstNode = candidate.$cstNode!;
                const beforeCursor = text.slice(cstNode.offset, offset);
                if (!beforeCursor.includes('{')) {
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
                const openingBrace = text.lastIndexOf('{', offset - 1);
                const prefix = text.slice(linePrefixStart(openingBrace), offset).trim();
                const labels = isModule(candidate) && isInSharedKernel(candidate)
                    ? labelsByType.SharedKernelModule
                    : labelsByType[candidate.$type];
                return this.matchesKeywordPrefix(labels, prefix);
            });
        if (!container) {
            return [];
        }
        const labels = isModule(container) && isInSharedKernel(container)
            ? labelsByType.SharedKernelModule
            : labelsByType[container.$type];
        const openingBrace = text.lastIndexOf('{', offset - 1);
        const prefix = text.slice(linePrefixStart(openingBrace), offset).trim();
        const typedPrefix = /^[\p{L}_][\p{L}_ ]*$/u.test(prefix) ? prefix : '';
        const matchingLabels = typedPrefix ? labels.filter(label => this.matchesKeywordPrefix([label], typedPrefix)) : labels;
        return this.createKeywordCompletions(matchingLabels, document, position, typedPrefix);
    }

    private filterSharedKernelModuleKeywords(
        document: LangiumDocument,
        position: Position,
        completion: CompletionList | undefined
    ): CompletionList | undefined {
        const root = document.parseResult.value;
        if (!root || !completion) {
            return completion;
        }
        const offset = document.textDocument.offsetAt(position);
        const module = AstUtils.streamAst(root)
            .filter(isModule)
            .filter(isInSharedKernel)
            .filter(candidate => {
                const cstNode = candidate.$cstNode;
                return cstNode !== undefined && cstNode.offset <= offset && offset < cstNode.end;
            })
            .toArray()
            .sort((left, right) => (left.$cstNode!.end - left.$cstNode!.offset) - (right.$cstNode!.end - right.$cstNode!.offset))[0];
        if (!module) {
            return completion;
        }
        const allowed = new Set(['exposes', 'domain', 'domain service', 'depends', 'depends on', 'on', 'module', 'value', 'value object', 'enum']);
        const typeKeywords = new Set(['string', 'number', 'boolean', 'date', 'List', 'Set', 'Map']);
        const inTypePosition = this.isTypeKeywordCompletionPosition(document, position);
        return {
            ...completion,
            items: completion.items.filter(item => {
                if (item.kind !== CompletionItemKind.Keyword || typeof item.label !== 'string') {
                    return true;
                }
                const firstWord = item.label.split(/\s+/)[0];
                return allowed.has(item.label) || allowed.has(firstWord) ||
                    inTypePosition && typeKeywords.has(item.label);
            })
        };
    }

    private isTypeKeywordCompletionPosition(document: LangiumDocument, position: Position): boolean {
        const root = document.parseResult.value;
        if (!root) {
            return false;
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        return AstUtils.streamAst(root).some(node => {
            if (!isField(node) && !isParameter(node) && !isMethod(node)) {
                return false;
            }
            const cstNode = node.$cstNode;
            return cstNode !== undefined && cstNode.offset <= offset && cstNode.end <= offset &&
                cstNode.range.end.line === position.line && !/[\r\n]/.test(text.slice(cstNode.end, offset)) &&
                this.isInIncompleteTypePosition(node, document, position);
        });
    }

    private createKeywordCompletions(
        labels: string[],
        document: LangiumDocument,
        position: Position,
        typedPrefix: string
    ): CompletionItem[] {
        const prefixStart = document.textDocument.offsetAt(position) - typedPrefix.length;
        return labels.map(label => this.createKeywordCompletionItem(
            document,
            position,
            label,
            'Language keyword',
            prefixStart,
            label,
            !typedPrefix.includes(' ')
        ));
    }

    private matchesKeywordPrefix(labels: string[], prefix: string): boolean {
        const normalizedPrefix = prefix.toLowerCase().replace(/\s+/g, ' ');
        return labels.some(label => normalizedPrefix.length < label.length &&
            label.toLowerCase().startsWith(normalizedPrefix));
    }

    private filterSameLineSiblingCompletions(
        document: LangiumDocument,
        position: Position,
        completion: CompletionList | undefined,
        extraAllowedKeywords: string[] = []
    ): CompletionList | undefined {
        const sibling = this.getSameLineSiblingAt(document, position);
        if (!sibling) {
            return completion;
        }
        if (this.isStandalonePartialKeywordPrefix(document, position)) {
            return completion;
        }
        const continuations = this.getSameLineContinuationKeywords(sibling, document, position);
        const inProgressContinuations = extraAllowedKeywords.filter(keyword =>
            ['-> supplier', '<-> partner', '-x-', 'supplier', 'partner', 'integrationPatterns',
                'participants', 'manages', 'serves', 'from', 'to', 'on', 'realizes', 'kind', 'depends',
                'mirrors', 'returns', 'initial', 'when', 'with',
                'core', 'supporting', 'generic']
                .includes(keyword)
        );
        const allowed = new Set([...continuations, ...inProgressContinuations]);
        if (allowed.size === 0) {
            const items = completion?.items.filter(item => item.kind !== CompletionItemKind.Keyword) ?? [];
            return {
                isIncomplete: completion?.isIncomplete ?? false,
                items
            };
        }
        if (!completion) {
            return undefined;
        }
        return {
            ...completion,
            items: completion.items.filter(item => {
                if (item.kind !== CompletionItemKind.Keyword || typeof item.label !== 'string') {
                    return true;
                }
                const firstWord = item.label.split(/\s+/)[0];
                return allowed.has(item.label) || allowed.has(firstWord);
            })
        };
    }

    private isStandalonePartialKeywordPrefix(document: LangiumDocument, position: Position): boolean {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const prefix = text.slice(lineStart, offset);
        const normalizedPrefix = prefix.trim().toLowerCase().replace(/\s+/g, ' ');
        const statementKeywords = [
            'import', 'shared kernel', 'subdomain', 'bounded context', 'in bounded context', 'context map',
            'actor', 'journey', 'customer', 'partner', 'separateWays', 'sharedKernel',
            'application service', 'query service', 'query repository', 'projector', 'aggregate',
            'domain service', 'repository', 'factory', 'event', 'integration event', 'module',
            'root entity', 'entity', 'value object', 'enum', 'read model', 'data object',
            'exposes', 'constructor', 'method', 'invariant', 'precondition', 'postcondition', 'behavior',
            'transition', 'invokes', 'emits', 'projects', 'by', 'invoke'
        ];
        if (normalizedPrefix && statementKeywords.some(keyword =>
            keyword.toLowerCase().startsWith(normalizedPrefix)
        )) {
            return true;
        }
        return [
            /^\s*in\s+bounded\s+[\p{L}_]*$/iu,
            /^\s*(?:bounded|shared|application|domain|root|value|read|data|query|integration|depends|context)\s+[\p{L}_]*$/iu,
            /^\s*import\s+\{[^}]*\}\s+[\p{L}_]*$/iu,
            /^\s*query\s+repository\s+[_a-zA-Z][\w_]*\s+[\p{L}_]*$/iu,
            /^\s*repository\s+[_a-zA-Z][\w_]*\s+[\p{L}_]*$/iu,
            /^\s*transition\s+[_a-zA-Z][\w_]*\s+[\p{L}_]*$/iu,
            /^\s*transition\s+[_a-zA-Z][\w_]*\s+from\s+[_a-zA-Z][\w_]*\s+[\p{L}_]*$/iu,
            /^\s*sharedKernel\s+[_a-zA-Z][\w_.]*\s+\{\s*[\p{L}_]*$/iu,
            /^\s*customer\s+[^\n]*?->\s*[\p{L}_]*$/iu,
            /^\s*partner\s+[^\n]*?<->\s*[\p{L}_]*$/iu,
            /^\s*(?:customer|supplier)\s+[_a-zA-Z][\w.]*\s*\{\s*[\p{L}_]*$/iu
        ].some(pattern => pattern.test(prefix));
    }

    private getTopLevelKeywordCompletions(
        document: LangiumDocument,
        position: Position,
        typedPrefix = ''
    ): CompletionItem[] {
        const offset = document.textDocument.offsetAt(position);
        const prefixStart = offset - typedPrefix.length;
        return [
            'import', 'shared kernel', 'subdomain', 'bounded context', 'in bounded context',
            'context map', 'actor', 'journey'
        ].filter(label => !typedPrefix ||
            typedPrefix.length < label.length && label.toLowerCase().startsWith(typedPrefix.toLowerCase().replace(/\s+/g, ' ')))
            .map(label => this.createKeywordCompletionItem(
                document,
                position,
                label,
                'Top-level declaration',
                prefixStart,
                label,
                !typedPrefix.includes(' ')
            ));
    }

    private createKeywordCompletionItem(
        document: LangiumDocument,
        position: Position,
        label: string,
        detail: string,
        fallbackStart = document.textDocument.offsetAt(position),
        insertText = label,
        useLangiumTokenEdit = true
    ): CompletionItem {
        const baseItem: CompletionValueItem = {
            label,
            kind: CompletionItemKind.Keyword,
            detail,
            sortText: '0',
            insertText
        };
        const context = useLangiumTokenEdit ? this.getLangiumCompletionContext(document, position) : undefined;
        const langiumItem = context ? this.fillCompletionItem(context, baseItem) : undefined;
        if (langiumItem) {
            return langiumItem;
        }
        return {
            ...baseItem,
            label,
            textEdit: {
                range: { start: document.textDocument.positionAt(fallbackStart), end: position },
                newText: insertText
            }
        };
    }

    private getLangiumCompletionContext(document: LangiumDocument, position: Position): CompletionContext | undefined {
        const offset = document.textDocument.offsetAt(position);
        return [...this.buildContexts(document, position)].find(context =>
            context.offset === offset && context.tokenOffset <= offset && context.tokenEndOffset >= offset
        );
    }

    private getInProgressKeywordCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
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
            [/\bsubdomain\s+[_a-zA-Z][\w_]*\s+kind\s+([\p{L}_]*)$/iu, ['core', 'supporting', 'generic']],
            [/\bimport\s+\{[^}]*\}\s+([\p{L}_]*)$/iu, ['from']],
            [/\bquery\s+repository\s+[_a-zA-Z][\w_]*\s+([\p{L}_]*)$/iu, ['serves']],
            [/\brepository\s+[_a-zA-Z][\w_]*\s+([\p{L}_]*)$/iu, ['manages']],
            [/\btransition\s+[_a-zA-Z][\w_]*\s+([\p{L}_]*)$/iu, ['from']],
            [/\btransition\s+[_a-zA-Z][\w_]*\s+from\s+[_a-zA-Z][\w_]*\s+([\p{L}_]*)$/iu, ['to']],
            [/\bsharedKernel\s+[_a-zA-Z][\w_.]*\s+\{\s*([\p{L}_]*)$/iu, ['participants']],
            [/\bcustomer\s+[^\n]*?->\s*([\p{L}_]*)$/iu, ['supplier']],
            [/\bpartner\s+[^\n]*?<->\s*([\p{L}_]*)$/iu, ['partner']],
            [/\b(?:customer|supplier)\s+[_a-zA-Z][\w.]*\s*\{\s*([\p{L}_]*)$/iu, ['integrationPatterns']]
        ];

        const match = continuations
            .map(([pattern, keywords]) => ({ match: pattern.exec(prefix), keywords }))
            .find(candidate => candidate.match !== null);
        if (!match?.match) {
            return [];
        }
        if (match.keywords[0] === 'map' && /\bbounded\s+context\s+[\p{L}_]*$/iu.test(prefix)) {
            return [];
        }
        const typedPrefix = match.match[1];
        const start = offset - typedPrefix.length;
        const needsLeadingSpace = start > 0 && !/\s/.test(text[start - 1]!);
        return match.keywords
            .filter(keyword => typedPrefix.length < keyword.length &&
                keyword.toLowerCase().startsWith(typedPrefix.toLowerCase()))
            .map(keyword => this.createKeywordCompletionItem(
                document,
                position,
                keyword,
                'Keyword continuation',
                start,
                `${needsLeadingSpace ? ' ' : ''}${keyword}`
            ));
    }

    private getPartialSameLineContinuations(document: LangiumDocument, position: Position): CompletionItem[] {
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
            const source = text.slice(cstNode.offset, offset);
            const match = /\s+([\p{L}_]+)$/u.exec(source);
            if (!match) {
                continue;
            }
            const typedPrefix = match[1]!;
            const headerSource = source.replace(/\s+[\p{L}_]+$/u, '').trim();
            const continuations = new Set(this.getSameLineContinuationKeywords(node, document, position));
            if (isBoundedContext(node) && /^bounded\s+context\s+[_a-zA-Z][\w_]*$/iu.test(headerSource)) {
                continuations.add('realizes');
            } else if (isSubdomain(node) && /^subdomain\s+[_a-zA-Z][\w_]*$/iu.test(headerSource)) {
                continuations.add('kind');
            } else if (isModule(node) && /^module\s+[_a-zA-Z][\w_]*$/iu.test(headerSource)) {
                continuations.add('depends');
            } else if (isValueObject(node) && /^value\s+object\s+[_a-zA-Z][\w_]*$/iu.test(headerSource)) {
                continuations.add('mirrors');
            }
            for (const keyword of [...continuations].filter(candidate =>
                typedPrefix.length < candidate.length && candidate.toLowerCase().startsWith(typedPrefix.toLowerCase())
            )) {
                const prefixStart = offset - typedPrefix.length;
                results.set(keyword, this.createKeywordCompletionItem(
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
            if (this.isInIncompleteTypePosition(node, document, position)) {
                continue;
            }
            if (text.slice(cstNode.offset, offset).trimEnd().endsWith('{')) {
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

    private isInIncompleteTypePosition(node: AstNode, document: LangiumDocument, position: Position): boolean {
        if (!isField(node) && !isParameter(node) && !isMethod(node)) {
            return false;
        }

        if (isField(node) || isParameter(node)) {
            if (node.primitive !== undefined || this.hasCompletedTypeReference(node.type) ||
                node.collection && !this.isIncompleteCollectionType(node.collection)) {
                return false;
            }
            if (node.collection) {
                return true;
            }
            const source = document.textDocument.getText().slice(
                node.$cstNode?.offset ?? document.textDocument.offsetAt(position),
                document.textDocument.offsetAt(position)
            );
            return /(?:^|\s)(?:identifier\s+)?[_a-zA-Z][\w_]*\??\s*:\s*(?:[snbd][\w]*)?$/iu.test(source);
        }

        if (node.returnCollection) {
            return this.isIncompleteCollectionType(node.returnCollection);
        }
        if (node.returnPrimitive !== undefined || this.hasCompletedTypeReference(node.returnType)) {
            return false;
        }
        const source = document.textDocument.getText().slice(
            node.$cstNode?.offset ?? document.textDocument.offsetAt(position),
            document.textDocument.offsetAt(position)
        );
        return /\)\s+returns\s*(?:[snbd][\w]*)?$/iu.test(source);
    }

    private isIncompleteCollectionType(collection: import('./generated/ast.js').CollectionType): boolean {
        const hasElement = collection.elementPrimitive !== undefined || this.hasCompletedTypeReference(collection.elementType) ||
            collection.elementCollection !== undefined;
        if (!hasElement || collection.elementCollection && this.isIncompleteCollectionType(collection.elementCollection)) {
            return true;
        }
        if (collection.kind === 'Map') {
            const hasValue = collection.valuePrimitive !== undefined || this.hasCompletedTypeReference(collection.valueType) ||
                collection.valueCollection !== undefined;
            return !hasValue || collection.valueCollection !== undefined &&
                this.isIncompleteCollectionType(collection.valueCollection);
        }
        return false;
    }

    private hasCompletedTypeReference(reference: { $refText: string } | undefined): boolean {
        if (!reference?.$refText) {
            return false;
        }
        return !['string', 'number', 'boolean', 'date'].some(primitive =>
            primitive.startsWith(reference.$refText.toLowerCase())
        );
    }

    private getSameLineContinuationKeywords(node: AstNode, document: LangiumDocument, position: Position): string[] {
        if (isBoundedContext(node)) {
            return node.subdomains.length === 0 ? ['realizes'] : [];
        }
        if (isSubdomain(node)) {
            return node.kind === undefined ? ['kind'] : [];
        }
        if (isModule(node)) {
            const start = node.$cstNode?.offset;
            const source = start === undefined
                ? ''
                : document.textDocument.getText().slice(start, document.textDocument.offsetAt(position));
            return node.dependencies.length === 0 && !source.includes('{') ? ['depends'] : [];
        }
        if (isValueObject(node)) {
            const start = node.$cstNode?.offset;
            const source = start === undefined
                ? ''
                : document.textDocument.getText().slice(start, document.textDocument.offsetAt(position));
            return node.mirrors === undefined && !source.includes('{') ? ['mirrors'] : [];
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
            const beforePartialKeyword = source.replace(/\s+[\p{L}_]*$/u, '');
            if (beforePartialKeyword.trimEnd().endsWith(')')) {
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

    private getPartialInitialKeywordCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const completions: CompletionItem[] = [];
        for (const node of AstUtils.streamAst(root)) {
            if (!isField(node) || !isEntity(node.$container) || node.optional ||
                !isEnumType(node.type?.ref) || !node.$cstNode || offset < node.$cstNode.offset) {
                continue;
            }
            const source = text.slice(node.$cstNode.offset, offset);
            if (/\binitial\b/i.test(source)) {
                continue;
            }
            const match = /:\s*[_a-zA-Z][\w.]*(?:\.[_a-zA-Z][\w_]*)?\s+([\p{L}_]*)$/u.exec(source);
            const typedPrefix = match?.[1];
            if (typedPrefix === undefined || typedPrefix.length >= 'initial'.length ||
                !'initial'.startsWith(typedPrefix.toLowerCase())) {
                continue;
            }
            const prefixStart = offset - typedPrefix.length;
            completions.push(this.createKeywordCompletionItem(
                document,
                position,
                'initial',
                'Field initial-state clause',
                prefixStart
            ));
        }
        return completions;
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
