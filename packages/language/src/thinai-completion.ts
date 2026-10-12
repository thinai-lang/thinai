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
    InsertTextMode,
    type CompletionItem,
    type CompletionList,
    type CompletionParams,
    type Position,
    type TextEdit
} from 'vscode-languageserver';
import type { CancellationToken } from 'vscode-jsonrpc';
import type { ThinaiServices } from './thinai-module.js';
import type { ContextMap, Method } from './generated/ast.js';
import {
    isApplicationService,
    isEnumType,
    isBoundedContext,
    isDomainEvent,
    isEventEmission,
    isEnumValue,
    isEntity,
    isFactory,
    isField,
    isIntegrationEvent,
    isJourneyStep,
    isModel,
    isMethod,
    isMethodInvocation,
    isModule,
    isParameter,
    isProjector,
    isSpecificationText,
    isSpecificationTextPart,
    isTransition,
    isSubdomain,
    isValueObject
} from './generated/ast.js';
import { getExportedName, isInSharedKernel, ThinaiScopeProvider } from './thinai-scope.js';
import { INTEGRATION_PATTERNS } from './thinai-constants.js';
import { canDeclareProjects, canDeclareTransition, getEventEmissionMode } from './thinai-operation-utils.js';
import {
    getBlockNestingDepth,
    getIncompleteStatementSuffixes,
    getSiblingCompletionKeywords,
    getSiblingKeywordPrefixes,
    getSiblingStatementPolicy,
    isBlockNodeType,
    isLineSeparatedSibling
} from './thinai-layout.js';

const siblingKeywordPrefixes = getSiblingKeywordPrefixes();

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
        const specificationContext = this.getSpecificationTextCompletionContext(
            document,
            document.textDocument.offsetAt(params.position)
        );
        if (specificationContext === 'text') {
            return { isIncomplete: false, items: [] };
        }
        if (specificationContext === 'reference') {
            return defaultCompletion
                ? { ...defaultCompletion, items: defaultCompletion.items.filter(item => item.kind !== CompletionItemKind.Keyword) }
                : defaultCompletion;
        }
        const optionalClauseCompletions = this.getOptionalClauseCompletions(document, params.position);
        if (optionalClauseCompletions.length > 0) {
            const optionalLabels = new Set(optionalClauseCompletions.map(item => item.label));
            const items = (defaultCompletion?.items ?? []).filter(item =>
                typeof item.label !== 'string' || !optionalLabels.has(item.label)
            );
            items.push(...optionalClauseCompletions);
            const completion = this.filterSameLineSiblingCompletions(document, params.position, {
                isIncomplete: defaultCompletion?.isIncomplete ?? false,
                items
            }, optionalClauseCompletions.map(item => item.label));
            return this.filterContextSensitiveKeywordCompletions(document, params.position, completion);
        }
        const relationshipContinuations = this.getContextMapRelationshipContinuations(document, params.position);
        const hasBoundedContextCandidates = defaultCompletion?.items.some(item =>
            item.detail?.startsWith('BoundedContext ')
        ) === true;
        const constrainedValueCompletions = [
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
        const emptyBlockReplacements = new Map(blockKeywords
            .filter(item => this.isSiblingStatementCompletion(item))
            .map(item => [item.label, item]));
        const completionWithEmptyBlockEdits = completionWithKeywords
            ? {
                ...completionWithKeywords,
                items: completionWithKeywords.items.map(item => emptyBlockReplacements.get(item.label) ?? item)
            }
            : completionWithKeywords;
        const completionItems = (completionWithKeywords?.items ?? [])
            .filter(item => !relationshipContinuationLabels.has(item.label))
            .map(item => emptyBlockReplacements.get(item.label) ?? item);
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
                const completion = this.filterSameLineSiblingCompletions(document, params.position, completionWithEmptyBlockEdits);
                return this.filterContextSensitiveKeywordCompletions(document, params.position, completion);
            }
            const completion = this.filterSameLineSiblingCompletions(document, params.position, {
                isIncomplete: completionWithKeywords?.isIncomplete ?? false,
                items: [...completionItems, ...constrainedValueCompletions]
            }, sameLineKeywordContinuations);
            return this.filterContextSensitiveKeywordCompletions(document, params.position, completion);
        }

        const importItems = await this.getImportPathCompletions(document, importContext.path, importContext.pathStart);
        const completion = this.filterSameLineSiblingCompletions(document, params.position, {
            isIncomplete: completionWithKeywords?.isIncomplete ?? false,
            items: [...completionItems, ...constrainedValueCompletions, ...importItems]
        }, sameLineKeywordContinuations);
        return this.filterContextSensitiveKeywordCompletions(document, params.position, completion);
    }

    private getSpecificationTextCompletionContext(
        document: LangiumDocument,
        offset: number
    ): 'text' | 'reference' | undefined {
        const model = document.parseResult.value;
        if (!model) {
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
            if (!isSpecificationTextPart(part) || !part.target || !part.$cstNode) {
                return false;
            }
            return part.$cstNode.offset <= offset && offset <= part.$cstNode.end;
        });
        return inReference ? 'reference' : 'text';
    }

    private filterContextSensitiveKeywordCompletions(
        document: LangiumDocument,
        position: Position,
        completion: CompletionList | undefined
    ): CompletionList | undefined {
        const root = document.parseResult.value;
        if (!root || !completion) {
            return completion;
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const braceOwners: Array<'aggregate' | 'other'> = [];
        let previousBrace = -1;
        const syntaxTokens = /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|[{}]/gu;
        for (const token of text.slice(0, offset).matchAll(syntaxTokens)) {
            if (token[0] === '{') {
                const declaration = text.slice(previousBrace + 1, token.index).trim();
                braceOwners.push(/\baggregate\s+[_a-zA-Z][\w]*\s*$/iu.test(declaration) ? 'aggregate' : 'other');
                previousBrace = token.index;
            } else if (token[0] === '}') {
                braceOwners.pop();
                previousBrace = token.index;
            }
        }
        const containsCursor = (node: AstNode): boolean => {
            const cstNode = node.$cstNode;
            if (!cstNode || cstNode.offset > offset || cstNode.end < offset) {
                return false;
            }
            return cstNode.end > offset || !text.slice(cstNode.offset, offset).trimEnd().endsWith('}');
        };
        const innermostBlock = AstUtils.streamAst(root)
            .filter(node => isBlockNodeType(node.$type) && containsCursor(node))
            .toArray()
            .sort((left, right) =>
                (left.$cstNode!.end - left.$cstNode!.offset) - (right.$cstNode!.end - right.$cstNode!.offset)
            )[0];
        const activeField = AstUtils.streamAst(root)
            .filter(isField)
            .filter(containsCursor)
            .toArray()
            .sort((left, right) =>
                (left.$cstNode!.end - left.$cstNode!.offset) - (right.$cstNode!.end - right.$cstNode!.offset)
            )[0];
        const identifierOwner = activeField?.$container ??
            (innermostBlock && ['Entity', 'ValueObject', 'DataObject', 'ReadModel'].includes(innermostBlock.$type)
                ? innermostBlock
                : undefined);
        const activeMethod = AstUtils.streamAst(root)
            .filter(isMethod)
            .filter(containsCursor)
            .toArray()
            .sort((left, right) =>
                (left.$cstNode!.end - left.$cstNode!.offset) - (right.$cstNode!.end - right.$cstNode!.offset)
            )[0];
        const allowedMethodClauses = activeMethod ? new Set(this.getSiblingKeywordLabels(activeMethod)) : undefined;
        const transitionContinuationAllowed = this.isTransitionContinuationPosition(document, offset);
        const entityDeclarationsAllowed = braceOwners.at(-1) === 'aggregate';
        const rootEntityAlreadyDeclared = entityDeclarationsAllowed && innermostBlock?.$type === 'Aggregate' &&
            'members' in innermostBlock && Array.isArray(innermostBlock.members) &&
            innermostBlock.members.some(member => isEntity(member) && member.root);
        return {
            ...completion,
            items: completion.items.filter(item => {
                if (item.kind !== CompletionItemKind.Keyword || typeof item.label !== 'string') {
                    return true;
                }
                if (item.label === 'identifier' && !isEntity(identifierOwner)) {
                    return false;
                }
                if (item.label === 'returns' && activeMethod && isProjector(activeMethod.$container)) {
                    return false;
                }
                if ((item.label === 'entity' || item.label === 'root entity') && !entityDeclarationsAllowed) {
                    return false;
                }
                if (item.label === 'root entity' && rootEntityAlreadyDeclared) {
                    return false;
                }
                if (['invokes', 'transition', 'projects', 'emits'].includes(item.label) && allowedMethodClauses &&
                    !allowedMethodClauses.has(item.label)) {
                    return false;
                }
                if ((item.label === 'from' || item.label === 'to') &&
                    this.isTransitionContinuationContext(document, offset) && !transitionContinuationAllowed) {
                    return false;
                }
                return true;
            })
        };
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
                !getSiblingCompletionKeywords('ContextMap').includes(String(item.label))
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
        const model = document.parseResult.value;
        if (!model) {
            return 'incomplete';
        }
        const relationship = AstUtils.streamAst(model)
            .filter(node => node.$type === 'CustomerSupplierRelationship' ||
                node.$type === 'PartnershipRelationship' || node.$type === 'SeparateWaysRelationship')
            .filter(node => node.$cstNode?.range.start.line === position.line &&
                node.$cstNode.offset <= offset && node.$cstNode.end <= offset)
            .toArray()
            .sort((left, right) => right.$cstNode!.end - left.$cstNode!.end)[0];
        if (!relationship?.$cstNode || !this.isCompleteSameLineSibling(relationship, document, position)) {
            return 'incomplete';
        }
        return /^[\t ]+$/.test(text.slice(relationship.$cstNode.end, offset)) ? 'complete' : 'incomplete';
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
                return cstNode !== undefined && cstNode.offset <= offset && offset <= cstNode.end;
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
            new RegExp(String.raw`^\s*customer\s+(${endpoint})(?:\s*${integrationPatterns})?\s*->\s*supplier\s*([\w.]*)$`, 'i'),
            new RegExp(String.raw`^\s*partner\s+(${endpoint})(?:\s*${integrationPatterns})?\s*<->\s*partner\s*([\w.]*)$`, 'i'),
            new RegExp(String.raw`^\s*separateWays\s+(${endpoint})\s+-x-\s*([\w.]*)$`, 'i')
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

        const leftContextName = match[1] ?? '';
        const typedPrefix = match[2] ?? '';
        const prefixStart = offset - typedPrefix.length;
        const needsLeadingSpace = prefixStart > 0 && !/\s/.test(text[prefixStart - 1]!);
        const scopeProvider = this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider;
        const completionContext = this.getLangiumCompletionContext(document, position);
        const contextCandidates = scopeProvider.getContextMapBoundedContextCandidates(contextMap);
        const leftContext = contextCandidates.find(description => description.name === leftContextName)?.node;
        return contextCandidates
            .filter(description => !leftContext || description.node !== leftContext)
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
        const replacements = new Map(additions
            .filter(item => this.isSiblingStatementCompletion(item))
            .map(item => [item.label, item]));
        const items = (completion?.items ?? []).map(item => replacements.get(item.label) ?? item);
        const labels = new Set(items.map(item => item.label));
        return {
            isIncomplete: completion?.isIncomplete ?? false,
            items: [...items, ...additions.filter(item => !labels.has(item.label))]
        };
    }

    private isSiblingStatementCompletion(item: CompletionItem): boolean {
        const data = item.data;
        return typeof data === 'object' && data !== null &&
            'thinaiSiblingCompletion' in data && data.thinaiSiblingCompletion === true;
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

    private getEnclosingBlockKeywordCompletions(document: LangiumDocument, position: Position): CompletionItem[] {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const linePrefixStart = (openingBrace: number) => openingBrace >= lineStart ? openingBrace + 1 : lineStart;
        const container = AstUtils.streamAst(root)
            .filter(candidate => this.getSiblingKeywordLabels(candidate).length > 0)
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
                const labels = this.getSiblingKeywordLabels(candidate);
                return this.matchesKeywordPrefix(labels, prefix);
            });
        if (!container) {
            return [];
        }
        const labels = this.getSiblingKeywordLabels(container);
        const openingBrace = text.lastIndexOf('{', offset - 1);
        const prefix = text.slice(linePrefixStart(openingBrace), offset).trim();
        const typedPrefix = /^[\p{L}_][\p{L}_ ]*$/u.test(prefix) ? prefix : '';
        const matchingLabels = typedPrefix ? labels.filter(label => this.matchesKeywordPrefix([label], typedPrefix)) : labels;
        const completions = this.createKeywordCompletions(matchingLabels, document, position, typedPrefix);
        return this.moveEmptyBlockCompletionsToNextLine(completions, document, position, container, openingBrace);
    }

    private getSiblingKeywordLabels(container: AstNode): readonly string[] {
        let labels = getSiblingCompletionKeywords(container.$type, isModule(container) && isInSharedKernel(container));
        if (!isMethod(container)) {
            return labels;
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
            return completions;
        }
        const newline = text.includes('\r\n') ? '\r\n' : '\n';
        const childIndent = this.getBlockChildIndentation(document, parent, offset);
        const indentationDepth = getBlockNestingDepth(parent);
        const parentLineStart = text.lastIndexOf('\n', Math.max(0, openingBrace - 1)) + 1;
        const parentIndent = /^[\t ]*/u.exec(text.slice(parentLineStart, openingBrace))?.[0] ?? '';
        const closeBrace = /^[\t ]*\}/u.exec(text.slice(offset));
        const closeOffset = closeBrace ? offset + closeBrace[0].lastIndexOf('}') : offset;
        const hasClosingBrace = closeBrace !== null;
        return completions.map(item => ({
            ...item,
            detail: 'Language keyword',
            preselect: true,
            insertTextMode: InsertTextMode.asIs,
            data: { thinaiSiblingCompletion: true, thinaiIndentationDepth: indentationDepth },
            textEdit: {
                range: {
                    start: document.textDocument.positionAt(openingBrace + 1),
                    end: document.textDocument.positionAt(closeOffset)
                },
                newText: `${newline}${childIndent}${item.label}${hasClosingBrace ? `${newline}${parentIndent}` : ''}`
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
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
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
        const lineStart = text.lastIndexOf('\n', Math.max(0, cstNode.offset - 1)) + 1;
        const prefix = text.slice(lineStart, cstNode.offset);
        return /^[\t ]*$/.test(prefix) ? prefix : undefined;
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
        const typeKeywords = new Set(['string', 'number', 'boolean', 'date', 'time', 'instant', 'List', 'Set', 'Map']);
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
            if (cstNode === undefined || cstNode.offset > offset || cstNode.end > offset ||
                cstNode.range.end.line !== position.line || /[\r\n]/.test(text.slice(cstNode.end, offset)) ||
                !this.isInIncompleteTypePosition(node, document, position)) {
                return false;
            }
            if (isMethod(node) && (isProjector(node.$container) || isFactory(node.$container))) {
                return false;
            }
            return !(isParameter(node) && isMethod(node.$container) && isProjector(node.$container.$container));
        });
    }

    private createKeywordCompletions(
        labels: readonly string[],
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

    private matchesKeywordPrefix(labels: readonly string[], prefix: string): boolean {
        const normalizedPrefix = prefix.toLowerCase().replace(/\s+/g, ' ');
        return labels.some(label => normalizedPrefix.length <= label.length &&
            label.toLowerCase().startsWith(normalizedPrefix));
    }

    private filterSameLineSiblingCompletions(
        document: LangiumDocument,
        position: Position,
        completion: CompletionList | undefined,
        extraAllowedKeywords: string[] = []
    ): CompletionList | undefined {
        const sibling = this.getSameLineSiblingAt(document, position);
        const inProgressContinuations = extraAllowedKeywords.filter(keyword =>
            ['-> supplier', '<-> partner', '-x-', 'supplier', 'partner', 'integrationPatterns',
                'participants', 'manages', 'serves', 'from', 'to', 'on', 'realizes', 'kind', 'depends',
                'mirrors', 'returns', 'initial', 'when', 'with',
                'core', 'supporting', 'generic']
                .includes(keyword)
        );
        if (sibling === null) {
            const allowedContinuations = new Set(extraAllowedKeywords);
            const inTypePosition = this.isTypeKeywordCompletionPosition(document, position);
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
        if (sibling === undefined) {
            return completion;
        }
        if (this.isStandalonePartialKeywordPrefix(document, position)) {
            return completion;
        }
        const continuations = this.getSameLineContinuationKeywords(sibling, document, position);
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
        const labels = this.getSiblingKeywordLabels(parent);
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

        const lineStart = text.lastIndexOf('\n', Math.max(0, (siblingStart ?? end) - 1)) + 1;
        const prefixBeforeSibling = text.slice(lineStart, siblingStart ?? end);
        const requiresStructuralIndentation = !/^[\t ]*$/.test(prefixBeforeSibling);
        const indentationDepth = requiresStructuralIndentation
            ? getBlockNestingDepth(sibling.$container)
            : undefined;
        const indent = requiresStructuralIndentation
            ? this.getBlockChildIndentation(document, sibling.$container, offset)
            : prefixBeforeSibling;
        const newline = text.includes('\r\n') ? '\r\n' : '\n';
        return matchingLabels.map(label => ({
            label,
            kind: CompletionItemKind.Keyword,
            detail: 'Language keyword',
            preselect: true,
            insertTextMode: InsertTextMode.asIs,
            data: {
                thinaiSiblingCompletion: true,
                ...(indentationDepth === undefined ? {} : { thinaiIndentationDepth: indentationDepth })
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

    private getBlockChildIndentation(
        document: LangiumDocument,
        parent: AstNode | undefined,
        offset: number
    ): string {
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const depth = getBlockNestingDepth(parent);
        const indentationCandidates = text.slice(0, offset).split(/\r?\n/u)
            .map(line => /^[\t ]+/u.exec(line)?.[0] ?? '')
            .filter(indentation => indentation.length > 0);
        const unit = indentationCandidates.some(indentation => indentation.startsWith('\t')) ? '\t' : '  ';
        const lineIndent = /^[\t ]*/u.exec(text.slice(lineStart, offset))?.[0] ?? '';
        return `${lineIndent}${unit.repeat(Math.max(0, depth - Math.floor(lineIndent.length / unit.length)))}`;
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
            [/\bsharedKernel\s+[_a-zA-Z][\w_.]*\s+\{\s*([\p{L}_]*)$/iu, ['participants']],
            [/\bcustomer\s+[^\n]*?->\s*([\p{L}_]*)$/iu, ['supplier']],
            [/\bpartner\s+[^\n]*?<->\s*([\p{L}_]*)$/iu, ['partner']],
            [/\b(?:customer|supplier)\s+[_a-zA-Z][\w.]*\s*\{\s*([\p{L}_]*)$/iu, ['integrationPatterns']]
        ];

        const match = this.getTransitionRequiredKeywordMatch(prefix) ?? continuations
            .map(([pattern, keywords]) => ({ match: pattern.exec(prefix), keywords }))
            .find(candidate => candidate.match !== null);
        if (!match?.match) {
            return [];
        }
        if ((match.keywords[0] === 'from' || match.keywords[0] === 'to') &&
            this.isTransitionContinuationContext(document, offset) &&
            !this.isTransitionContinuationPosition(document, offset)) {
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

    private getTransitionRequiredKeywordMatch(prefix: string): { match: RegExpExecArray; keywords: string[] } | undefined {
        const transitionStart = prefix.toLowerCase().lastIndexOf('transition');
        if (transitionStart < 0) {
            return undefined;
        }
        const transitionSource = prefix.slice(transitionStart + 'transition'.length);
        const currentChange = transitionSource.slice(transitionSource.lastIndexOf(',') + 1).trimStart();
        const toMatch = /^[_a-zA-Z][\w_]*\s+from\s+[_a-zA-Z][\w_]*\s+([\p{L}_]*)$/iu.exec(currentChange);
        if (toMatch) {
            return { match: toMatch, keywords: ['to'] };
        }
        const fromMatch = /^[_a-zA-Z][\w_]*\s+([\p{L}_]*)$/u.exec(currentChange);
        return fromMatch ? { match: fromMatch, keywords: ['from'] } : undefined;
    }

    private isTransitionContinuationPosition(document: LangiumDocument, offset: number): boolean {
        const root = document.parseResult.value;
        if (!root) {
            return false;
        }
        const method = AstUtils.streamAst(root)
            .filter(isMethod)
            .filter(candidate => candidate.$cstNode !== undefined && candidate.$cstNode.offset <= offset &&
                offset <= candidate.$cstNode.end)
            .toArray()
            .sort((left, right) =>
                (left.$cstNode!.end - left.$cstNode!.offset) - (right.$cstNode!.end - right.$cstNode!.offset)
            )[0];
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
                import('./generated/ast.js').TransitionChange | undefined;
        const field = change?.field?.ref;
        return isField(field) && isEnumType(field.type?.ref);
    }

    private isTransitionContinuationContext(document: LangiumDocument, offset: number): boolean {
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const prefix = text.slice(lineStart, offset);
        return this.getTransitionRequiredKeywordMatch(prefix) !== undefined;
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

    private getSameLineSiblingAt(document: LangiumDocument, position: Position): AstNode | null | undefined {
        const model = document.parseResult.value;
        if (!model) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(position);
        const currentLine = position.line;
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const linePrefix = text.slice(lineStart, offset);
        if (this.hasUnterminatedStringLiteral(linePrefix) || this.hasIncompleteStatementSuffix(linePrefix) ||
            this.isAfterTransitionChangeComma(model, text, offset)) {
            return null;
        }
        let best: AstNode | undefined;
        let bestEnd = -1;
        let hasIncompleteStatement = false;
        for (const node of AstUtils.streamAst(model)) {
            const cstNode = node.$cstNode;
            if (!cstNode || !isLineSeparatedSibling(node) || cstNode.end > offset || cstNode.range.end.line !== currentLine) {
                continue;
            }
            if (this.isStandalonePartialKeywordPrefix(document, position) && cstNode.range.start.line === currentLine) {
                continue;
            }
            if (cstNode.range.start.line === currentLine && this.isPartialSiblingKeywordNode(node, document, position)) {
                continue;
            }
            if (!this.isCompleteSameLineSibling(node, document, position)) {
                if (cstNode.range.start.line === currentLine &&
                    !this.isOpenBlockContainerAtCursor(node, text.slice(cstNode.offset, offset))) {
                    hasIncompleteStatement = true;
                }
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
        return hasIncompleteStatement ? null : best;
    }

    private isAfterTransitionChangeComma(model: AstNode, text: string, offset: number): boolean {
        return AstUtils.streamAst(model).filter(isTransition).some(transition => {
            const cstNode = transition.$cstNode;
            if (!cstNode || cstNode.offset > offset) {
                return false;
            }
            const source = text.slice(cstNode.offset, offset);
            return source.trimEnd().endsWith(',') && !this.hasUnterminatedStringLiteral(source);
        });
    }

    private isOpenBlockContainerAtCursor(node: AstNode, source: string): boolean {
        if (!isBlockNodeType(node.$type)) {
            return false;
        }
        return this.getSourceStructure(source).openBraces > 0;
    }

    private isCompleteSameLineSibling(node: AstNode, document: LangiumDocument, position: Position): boolean {
        const cstNode = node.$cstNode;
        if (!cstNode || this.isInIncompleteTypePosition(node, document, position)) {
            return false;
        }
        const text = document.textDocument.getText();
        const source = text.slice(cstNode.offset, cstNode.end).trimEnd();
        if (this.hasUnterminatedStringLiteral(source)) {
            return false;
        }
        const parserErrors = document.parseResult.parserErrors as Array<{ token?: { startOffset: number } }>;
        if (parserErrors.some(error => error.token && error.token.startOffset >= cstNode.offset &&
            error.token.startOffset <= cstNode.end)) {
            return false;
        }
        const lexerErrors = document.parseResult.lexerErrors as Array<{ offset: number }>;
        if (lexerErrors.some(error => error.offset >= cstNode.offset && error.offset <= cstNode.end)) {
            return false;
        }
        if (isMethod(node) && !this.hasClosedParameterList(source, 'method')) {
            return false;
        }
        if (node.$type === 'Constructor' && !this.hasClosedParameterList(source, 'constructor')) {
            return false;
        }
        const parameters = (node as AstNode & { parameters?: AstNode[] }).parameters ?? [];
        if (parameters.some(parameter => this.isInIncompleteTypePosition(parameter, document, position))) {
            return false;
        }
        if (isField(node) && !this.hasReferenceText(node.initialState) && /\binitial\s*$/iu.test(source)) {
            return false;
        }
        const policy = getSiblingStatementPolicy(node.$type);
        if (!this.hasCompleteSiblingReferences(node, policy)) {
            return false;
        }
        if (this.hasIncompleteKeywordSuffix(source, policy.incompleteSuffixes ?? [])) {
            return false;
        }

        if (policy.block === 'required' && (!source.includes('{') || !source.endsWith('}')) ||
            policy.block === 'optional' && source.includes('{') && !source.endsWith('}')) {
            return false;
        }
        return true;
    }

    private hasReferenceText(reference: unknown): boolean {
        return typeof reference === 'object' && reference !== null &&
            '$refText' in reference && typeof reference.$refText === 'string' && reference.$refText.length > 0;
    }

    private hasCompleteSiblingReferences(
        node: AstNode,
        policy: ReturnType<typeof getSiblingStatementPolicy>
    ): boolean {
        const properties = node as AstNode & Record<string, unknown>;
        const paths = [
            ...(policy.requiredReferences ?? []).map(property => [property]),
            ...(policy.requiredReferencePaths ?? [])
        ];
        if (paths.some(path => !this.hasReferenceText(this.getNodePropertyPath(properties, path)))) {
            return false;
        }
        return (policy.referenceLists ?? []).every(referenceList => {
            const items = properties[referenceList.property];
            if (!Array.isArray(items) || items.length === 0) {
                return false;
            }
            return items.every(item => {
                if (referenceList.nestedReferences) {
                    return referenceList.nestedReferences.every(property =>
                        this.hasReferenceText(this.getNodePropertyPath(item, [property]))
                    );
                }
                const path = referenceList.targetProperty ? [referenceList.targetProperty] : [];
                const reference = path.length > 0 ? this.getNodePropertyPath(item, path) : item;
                return this.hasReferenceText(reference);
            });
        });
    }

    private getNodePropertyPath(value: unknown, path: readonly string[]): unknown {
        let current = value;
        for (const property of path) {
            if (typeof current !== 'object' || current === null || !(property in current)) {
                return undefined;
            }
            current = (current as Record<string, unknown>)[property];
        }
        return current;
    }

    private hasUnterminatedStringLiteral(source: string): boolean {
        return this.getSourceStructure(source).unterminatedString;
    }

    private hasIncompleteStatementSuffix(source: string): boolean {
        const prefix = source.replace(/\s+$/, '');
        return this.hasIncompleteKeywordSuffix(prefix, getIncompleteStatementSuffixes()) || [
            /\bmethod\s+[_a-zA-Z][\w_]*$/iu,
            /\bmethod\s+[_a-zA-Z][\w_]*\s*\([^)]*$/iu,
            /\bconstructor$/iu,
            /\bconstructor\s*\([^)]*$/iu
        ].some(pattern => pattern.test(prefix));
    }

    private hasIncompleteKeywordSuffix(source: string, suffixes: readonly string[]): boolean {
        const normalized = source.trimEnd().toLowerCase();
        return suffixes.some(suffix => {
            const candidate = suffix.toLowerCase();
            return normalized.endsWith(candidate) &&
                (normalized.length === candidate.length || /\s/u.test(normalized[normalized.length - candidate.length - 1]!));
        });
    }

    private getSourceStructure(source: string): { openBraces: number; unterminatedString: boolean } {
        let quote: '"' | "'" | undefined;
        let tripleQuoted = false;
        let escaped = false;
        let blockComment = false;
        let lineComment = false;
        let openBraces = 0;
        for (let index = 0; index < source.length; index++) {
            const character = source[index]!;
            const next = source[index + 1];
            if (lineComment) {
                if (character === '\n' || character === '\r') {
                    lineComment = false;
                }
                continue;
            }
            if (blockComment) {
                if (character === '*' && next === '/') {
                    blockComment = false;
                    index++;
                }
                continue;
            }
            if (quote && escaped) {
                escaped = false;
            } else if (quote && character === '\\') {
                escaped = true;
            } else if (quote && tripleQuoted) {
                if (character === '"' && source.slice(index, index + 3) === '"""') {
                    quote = undefined;
                    tripleQuoted = false;
                    index += 2;
                }
            } else if (quote && character === quote) {
                quote = undefined;
            } else if (quote) {
                continue;
            } else if (character === '/' && next === '/') {
                lineComment = true;
                index++;
            } else if (character === '/' && next === '*') {
                blockComment = true;
                index++;
            } else if (character === '"' && source.slice(index, index + 3) === '"""') {
                quote = '"';
                tripleQuoted = true;
                index += 2;
            } else if (character === '"' || character === "'") {
                quote = character;
            } else if (character === '{') {
                openBraces++;
            } else if (character === '}') {
                openBraces--;
            }
        }
        return { openBraces, unterminatedString: quote !== undefined };
    }

    private hasClosedParameterList(source: string, keyword: 'constructor' | 'method'): boolean {
        const signaturePattern = keyword === 'method'
            ? /^\s*method\s+[_a-zA-Z][\w_]*\s*\(/iu
            : /^\s*constructor\s*\(/iu;
        const signature = signaturePattern.exec(source);
        if (!signature) {
            return false;
        }
        const open = source.indexOf('(', signature.index);
        let depth = 0;
        for (let index = open; index < source.length; index++) {
            if (source[index] === '(') {
                depth++;
            } else if (source[index] === ')') {
                depth--;
                if (depth === 0) {
                    return true;
                }
            }
        }
        return false;
    }

    private isPartialSiblingKeywordNode(node: AstNode, document: LangiumDocument, position: Position): boolean {
        const cstNode = node.$cstNode;
        if (!cstNode) {
            return false;
        }
        const source = document.textDocument.getText().slice(cstNode.offset, document.textDocument.offsetAt(position))
            .trim().toLowerCase().replace(/\s+/g, ' ');
        if (!source || !/^[\p{L}_]+(?: [\p{L}_]+)*$/u.test(source)) {
            return false;
        }
        return siblingKeywordPrefixes.some(keyword => keyword.toLowerCase().startsWith(source));
    }

    private isStandalonePartialKeywordPrefix(document: LangiumDocument, position: Position): boolean {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const prefix = text.slice(lineStart, offset).trim().toLowerCase().replace(/\s+/g, ' ');
        return prefix.length > 0 && siblingKeywordPrefixes.some(keyword => keyword.toLowerCase().startsWith(prefix));
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
            return /(?:^|\s)(?:identifier\s+)?[_a-zA-Z][\w_]*\??\s*:\s*(?:[snbdti][\w]*)?$/iu.test(source);
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
        return /\)\s+returns\s*(?:[snbdti][\w]*)?$/iu.test(source);
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
        return !['string', 'number', 'boolean', 'date', 'time', 'instant'].some(primitive =>
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
        if (isField(node) && isEntity(node.$container) && !node.optional && !this.hasReferenceText(node.initialState) && isEnumType(node.type?.ref)) {
            return ['initial'];
        }
        if (isMethod(node) && !isProjector(node.$container) && !node.returnPrimitive && !node.returnType && !node.returnCollection) {
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
        const hasCompletedReference = (reference?: {
            ref?: AstNode;
            $refText?: string;
            $refNode?: { end: number };
        }) => reference?.ref !== undefined ||
            typeof reference?.$refText === 'string' && reference.$refText.length > 0 &&
            reference.$refNode !== undefined && reference.$refNode.end < offset;
        const getEnclosingMethod = (node: AstNode): Method | undefined => {
            let current = node.$container;
            while (current && !isMethod(current)) {
                current = current.$container;
            }
            return isMethod(current) ? current : undefined;
        };
        const isJourneyCommand = (targets: Array<{ ref?: AstNode }>): boolean => {
            const target = targets.at(-1)?.ref;
            return isMethod(target) && isApplicationService(target.$container) && !target.parameters.some(parameter =>
                isDomainEvent(parameter.type?.ref) || isIntegrationEvent(parameter.type?.ref)
            );
        };
        const scopeProvider = this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider;
        for (const node of AstUtils.streamAst(model)) {
            const nodeSource = node.$cstNode?.text ?? '';
            const whenAlreadyTyped = /\bwhen\b/iu.test(nodeSource);
            let keywords: string[] = [];
            if (isJourneyStep(node) && isJourneyCommand(node.targets) && !whenAlreadyTyped) {
                keywords = [
                    ...(!node.arguments ? ['with'] : []),
                    ...(!node.guard ? ['when'] : [])
                ];
            } else if (isTransition(node)) {
                const method = getEnclosingMethod(node);
                if (method && canDeclareTransition(method) && node.changes.length > 0 && node.changes.every(change =>
                    hasCompletedReference(change.field) && hasCompletedReference(change.from) && hasCompletedReference(change.to)
                ) && !node.guard && !whenAlreadyTyped && !nodeSource.trimEnd().endsWith(',')) {
                    keywords = ['when'];
                }
            } else if (isEventEmission(node)) {
                const method = getEnclosingMethod(node);
                const emissionMode = method ? getEventEmissionMode(method) : undefined;
                const hasAllowedEvents = emissionMode !== undefined && node.events.length > 0 && node.events.every(event => {
                    const target = event.target?.ref;
                    return target
                        ? emissionMode === 'domain' ? isDomainEvent(target) : isIntegrationEvent(target)
                        : hasCompletedReference(event.target);
                });
                if (hasAllowedEvents && !node.guard && !whenAlreadyTyped) {
                    keywords = ['when'];
                }
            } else if (isMethodInvocation(node)) {
                const target = node.targets.at(-1)?.ref;
                if (isMethod(target) && scopeProvider.canInvokeMethod(node, target) && !node.guard && !whenAlreadyTyped) {
                    keywords = ['when'];
                }
            }
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
