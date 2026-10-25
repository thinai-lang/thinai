import {
    type AstNode,
    type AstNodeDescription,
    type LangiumDocument,
    type ReferenceInfo,
    type Stream,
    AstUtils,
    CstUtils,
    GrammarUtils,
    stream
} from 'langium';
import { DefaultCompletionProvider, type CompletionContext, type CompletionValueItem } from 'langium/lsp';
import {
    CompletionItemKind,
    type CompletionItem,
    type CompletionList,
    type CompletionParams,
    type Position
} from 'vscode-languageserver';
import type { CancellationToken } from 'vscode-jsonrpc';
import type { ThinaiServices } from './thinai-module.js';
import {
    type CollectionType,
    type Exposure,
    type Field,
    isAggregate,
    isApplicationService,
    isBoundedContext,
    isContextMap,
    isContextMapEndpoint,
    isEnumType,
    isEntity,
    isFactory,
    isField,
    isImport,
    isJourneyStep,
    isMethod,
    isMethodInvocation,
    isModel,
    isModule,
    isParameter,
    isProjector,
    isQueryRepository,
    isQueryService,
    isReadDependency,
    isReadSourceReference,
    isRepository,
    isSharedKernel,
    isSharedKernelRelationship,
    isSpecificationTextPart
} from './generated/ast.js';
import {
    formatQualifiedName,
    getComponentAliasNames,
    getComponentAliases,
    getExportedName,
    isInSharedKernel,
    resolveAstNodeDescription
} from './thinai-scope-utils.js';
import { ThinaiScopeProvider } from './thinai-scope-provider.js';
import { INTEGRATION_PATTERNS } from './thinai-constants.js';
import { ThinaiCompletionDetails } from './thinai-completion-details.js';
import {
    getIncompleteStatementSuffixes,
    getSiblingKeywordPrefixes,
    getSiblingStatementPolicy,
    isBlockNodeType,
    isLineSeparatedSibling
} from './thinai-layout.js';
import { scanThinaiSource } from './thinai-source-scanner.js';
import { ThinaiImportCompletion } from './thinai-import-completion.js';
import { ThinaiContextMapCompletion } from './thinai-context-map-completion.js';
import { ThinaiOptionalClauseCompletion } from './thinai-optional-clause-completion.js';
import { ThinaiKeywordContinuations } from './thinai-keyword-continuations.js';
import { ThinaiBlockCompletion } from './thinai-block-completion.js';
import {
    ThinaiQueryRepositoryCompletion,
    findQueryRepositoryAtOffset,
    isQueryRepositoryReadCompletionPosition
} from './thinai-query-repository-completion.js';
import { getSpecificationCompletionContext } from './thinai-specification-completion-context.js';
import { applyConfiguredIndentationToCompletions } from './thinai-indentation.js';
import { hasReferenceText } from './thinai-ast-utils.js';
import {
    normalizeIdentifierText,
    THINAI_IDENTIFIER_SOURCE,
    THINAI_QUALIFIED_IDENTIFIER_SOURCE
} from './thinai-identifiers.js';
import { getLineStartOffset } from './thinai-text-utils.js';

export { isQueryRepositoryReadCompletionPosition };

const siblingKeywordPrefixes = getSiblingKeywordPrefixes();

const incompleteFieldTypePattern = new RegExp(
    `(?:^|\\s)(?:identifier\\s+)?${THINAI_IDENTIFIER_SOURCE}\\??\\s*:\\s*(?:${THINAI_QUALIFIED_IDENTIFIER_SOURCE})?$`,
    'u'
);
const incompleteReturnTypePattern = new RegExp(
    `\\)\\s+returns\\s*(?:${THINAI_QUALIFIED_IDENTIFIER_SOURCE})?$`,
    'u'
);
const identifierTypePattern = new RegExp(
    `(?:^|\\s)identifier\\s+${THINAI_IDENTIFIER_SOURCE}\\??\\s*:\\s*(?:${THINAI_QUALIFIED_IDENTIFIER_SOURCE})?$`,
    'u'
);
const initialFieldTypePattern = new RegExp(
    `:\\s*${THINAI_QUALIFIED_IDENTIFIER_SOURCE}\\s+([\\p{L}_]*)$`,
    'u'
);

export class ThinaiCompletionProvider extends DefaultCompletionProvider {
    override readonly completionOptions = {
        triggerCharacters: [' ', '"', "'", '/', '.', '[', '>', '-', ':', '<', ',']
    };

    private readonly thinaiServices: ThinaiServices;
    private readonly importCompletion: ThinaiImportCompletion;
    private readonly contextMapCompletion: ThinaiContextMapCompletion;
    private readonly optionalClauseCompletion: ThinaiOptionalClauseCompletion;
    private readonly keywordContinuations: ThinaiKeywordContinuations;
    private readonly completionDetails: ThinaiCompletionDetails;
    private readonly queryRepositoryCompletion: ThinaiQueryRepositoryCompletion;
    private readonly blockCompletion: ThinaiBlockCompletion;

    constructor(services: ThinaiServices) {
        super(services);
        this.thinaiServices = services;
        this.completionDetails = new ThinaiCompletionDetails(services);
        this.importCompletion = new ThinaiImportCompletion(services);
        this.optionalClauseCompletion = new ThinaiOptionalClauseCompletion(services);
        this.contextMapCompletion = new ThinaiContextMapCompletion(services, {
            isCompleteSameLineSibling: (node, document, position) =>
                this.isCompleteSameLineSibling(node, document, position),
            getCompletionDetail: description => this.completionDetails.getCompletionDetail(description),
            getCompletionContext: (document, position) => this.getLangiumCompletionContext(document, position),
            fillCompletionItem: (context, item) => this.fillCompletionItem(context, item)
        });
        this.keywordContinuations = new ThinaiKeywordContinuations({
            createKeywordCompletionItem: (document, position, label, detail, fallbackStart, insertText, useLangiumTokenEdit) =>
                this.createKeywordCompletionItem(document, position, label, detail, fallbackStart, insertText, useLangiumTokenEdit)
        });
        this.blockCompletion = new ThinaiBlockCompletion(this.keywordContinuations, {
            createKeywordCompletionItem: (document, position, label, detail, fallbackStart, insertText, useLangiumTokenEdit) =>
                this.createKeywordCompletionItem(document, position, label, detail, fallbackStart, insertText, useLangiumTokenEdit),
            getSameLineSiblingAt: (document, position) => this.getSameLineSiblingAt(document, position),
            isStandalonePartialKeywordPrefix: (document, position) => this.isStandalonePartialKeywordPrefix(document, position),
            isTypeKeywordCompletionPosition: (document, position) => this.isTypeKeywordCompletionPosition(document, position)
        });
        this.queryRepositoryCompletion = new ThinaiQueryRepositoryCompletion({
            createKeywordCompletionItem: (document, position, label, detail, fallbackStart, insertText, useLangiumTokenEdit) =>
                this.createKeywordCompletionItem(document, position, label, detail, fallbackStart, insertText, useLangiumTokenEdit),
            getBlockChildIndentation: (document, parent, offset) =>
                this.blockCompletion.getBlockChildIndentation(document, parent, offset)
        });
    }

    protected override getReferenceCandidates(refInfo: ReferenceInfo, context: CompletionContext) {
        const { container, property } = refInfo;
        const scopeProvider = this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider;
        if ((isJourneyStep(container) || isMethodInvocation(container)) &&
            (property === 'path' || property === 'target')) {
            return this.dedupeCompletionCandidates(refInfo, stream(
                scopeProvider.getInvocationCompletionCandidates(refInfo, context.offset)
            ));
        }
        const pathCandidates = scopeProvider.getPathCompletionCandidates(refInfo, context.offset);
        if (pathCandidates !== undefined) {
            return this.dedupeCompletionCandidates(refInfo, stream(pathCandidates));
        }
        if (isSpecificationTextPart(container) && property === 'targets') {
            const completedSegments = container.targets.filter(reference =>
                reference.$refNode !== undefined && reference.$refNode.end < context.offset
            ).length;
            const scopedReference = { ...refInfo, index: completedSegments };
            return this.dedupeCompletionCandidates(refInfo, stream(scopeProvider.filterCompletionCandidates(
                scopedReference,
                scopeProvider.getScope(scopedReference).getAllElements()
            ).toArray()));
        }
        if (isSpecificationTextPart(container) && property === 'target') {
            return this.dedupeCompletionCandidates(refInfo, stream(scopeProvider.filterCompletionCandidates(
                refInfo,
                scopeProvider.getSpecificationRootCompletionCandidates(refInfo)
            ).toArray()));
        }
        return this.dedupeCompletionCandidates(refInfo, stream(scopeProvider.filterCompletionCandidates(
            refInfo,
            super.getReferenceCandidates(refInfo, context)
        ).toArray()));
    }

    private dedupeCompletionCandidates(refInfo: ReferenceInfo, candidates: Stream<AstNodeDescription>): Stream<AstNodeDescription> {
        const document = AstUtils.getDocument(refInfo.container);
        const model = document.parseResult.value;
        const aliases = isModel(model) ? getComponentAliases(model) : [];
        const journeyReference = AstUtils.getContainerOfType(refInfo.container, isJourneyStep) !== undefined;
        const typedPrefix = refInfo.reference.$refText ?? '';
        const groups = new Map<string, AstNodeDescription[]>();
        const synthetic: AstNodeDescription[] = [];
        for (const description of candidates) {
            const target = description.node ?? resolveAstNodeDescription(description, this.thinaiServices);
            if (!target || !('name' in target) || typeof target.name !== 'string') {
                synthetic.push(description);
                continue;
            }
            const exportedName = getExportedName(target as AstNode & { name: string });
            const aliasNames = getComponentAliasNames(exportedName, aliases, target.$type);
            const pathSpelling = description.name === exportedName ||
                exportedName.endsWith(`.${description.name}`) ||
                aliasNames.includes(description.name);
            if (!pathSpelling) {
                synthetic.push(description);
                continue;
            }
            const key = `${description.documentUri.toString()}#${description.path}`;
            const group = groups.get(key) ?? [];
            group.push(description);
            groups.set(key, group);
        }
        const preservePathContinuation = (selected: AstNodeDescription, group: AstNodeDescription[]): AstNodeDescription => {
            if (!group.some(candidate =>
                (candidate as AstNodeDescription & { thinaiPathContinuation?: boolean }).thinaiPathContinuation
            )) {
                return selected;
            }
            return {
                ...selected,
                thinaiPathContinuation: true
            } as AstNodeDescription;
        };
        const preferred: AstNodeDescription[] = [];
        if (this.isQualifiedReference(refInfo)) {
            for (const group of groups.values()) {
                const name = this.chooseCompletionDescriptionName(group, journeyReference, typedPrefix);
                preferred.push(preservePathContinuation(
                    group.find(candidate => candidate.name === name) ?? group[0]!,
                    group
                ));
            }
            return stream([...preferred, ...synthetic]);
        }
        const scope = (this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider).getScope(refInfo);
        const scopeTargets = new Set<AstNode>();
        for (const description of scope.getAllElements()) {
            const target = description.node ?? resolveAstNodeDescription(description, this.thinaiServices);
            if (target) {
                scopeTargets.add(target);
            }
        }
        const resolvesTo = (name: string, target: AstNode): boolean => {
            const description = scope.getElement(name);
            if (!description) {
                return false;
            }
            const resolved = description.node ?? resolveAstNodeDescription(description, this.thinaiServices);
            return resolved === target;
        };
        for (const group of groups.values()) {
            const first = group[0]!;
            const target = first.node ?? resolveAstNodeDescription(first, this.thinaiServices);
            if (!target) {
                preferred.push(first);
                continue;
            }
            const resolving = group.filter(candidate => resolvesTo(candidate.name, target));
            if (resolving.length > 0) {
                const name = this.chooseCompletionDescriptionName(resolving, journeyReference, typedPrefix);
                preferred.push(preservePathContinuation(
                    resolving.find(candidate => candidate.name === name) ?? resolving[0]!,
                    resolving
                ));
            } else if (!scopeTargets.has(target)) {
                // Synthetic shape/result descriptions are generated on demand and
                // are not necessarily present in the visible scope.
                const name = this.chooseCompletionDescriptionName(group, journeyReference, typedPrefix);
                preferred.push(preservePathContinuation(
                    group.find(candidate => candidate.name === name) ?? first,
                    group
                ));
            }
        }
        return stream([...preferred, ...synthetic]);
    }

    private isQualifiedReference(refInfo: ReferenceInfo): boolean {
        const { container, property } = refInfo;
        if (property === 'path' || property.endsWith('Path')) {
            return true;
        }
        const values = container as unknown as Record<string, unknown>;
        const pathProperties = [
            'mirrorsPath', 'rootPath', 'typePath', 'returnTypePath',
            'elementTypePath', 'valueTypePath', 'readModelPath'
        ];
        if (Array.isArray(values.path) && values.path.length > 0) {
            return true;
        }
        if (pathProperties.some(name => Array.isArray(values[name]) && (values[name] as unknown[]).length > 0)) {
            return true;
        }
        return isSpecificationTextPart(container) &&
            (container.target !== undefined || container.targets.length > 0);
    }

    private chooseCompletionDescriptionName(
        candidates: AstNodeDescription[],
        journeyReference: boolean,
        typedPrefix: string
    ): string {
        const matching = typedPrefix.length > 0
            ? candidates.filter(candidate => candidate.name.startsWith(typedPrefix))
            : candidates;
        const pool = matching.length > 0 ? matching : candidates;
        const score = (candidate: AstNodeDescription): number => {
            const segments = candidate.name.split('.').length;
            let value = 0;
            if (typedPrefix.length > 0 && candidate.name.startsWith(typedPrefix)) {
                value += 100;
            }
            if (journeyReference) {
                value += segments * 3;
            } else {
                value -= segments;
                if (typedPrefix.includes('.')) {
                    value += segments * 3;
                }
            }
            return value;
        };
        return [...pool].sort((left, right) =>
            score(right) - score(left) ||
            left.name.length - right.name.length ||
            left.name.localeCompare(right.name)
        )[0]!.name;
    }

    protected override createReferenceCompletionItem(
        nodeDescription: AstNodeDescription,
        refInfo: ReferenceInfo,
        context: CompletionContext
    ): CompletionValueItem {
        const item = super.createReferenceCompletionItem(nodeDescription, refInfo, context);
        item.detail = this.completionDetails.getCompletionDetail(nodeDescription);
        let insertText = formatQualifiedName(nodeDescription.name);
        const target = nodeDescription.node ?? resolveAstNodeDescription(nodeDescription, this.thinaiServices);
        const pathContinuation = (nodeDescription as AstNodeDescription & { thinaiPathContinuation?: boolean })
            .thinaiPathContinuation === true;
        const readSourcePathContinuation = this.isReadSourcePathContinuation(refInfo, target, context);
        const structuralSpecificationContinuation = isSpecificationTextPart(refInfo.container) &&
            AstUtils.getContainerOfType(refInfo.container, isJourneyStep) === undefined &&
            target !== undefined &&
            (this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider)
                .isStructuralSpecificationPathTarget(target) &&
            this.shouldAppendPathDot(refInfo, context);
        if (target && (
            this.isJourneyPathContinuation(refInfo, target, context) ||
            readSourcePathContinuation ||
            structuralSpecificationContinuation ||
            pathContinuation && this.shouldAppendPathDot(refInfo, context)
        )) {
            insertText = `${insertText}.`;
        }
        if (insertText !== nodeDescription.name) {
            item.insertText = insertText;
        }
        if (item.textEdit) {
            item.textEdit = { ...item.textEdit, newText: insertText };
        }
        return item;
    }

    private isJourneyPathContinuation(
        refInfo: ReferenceInfo,
        target: AstNode,
        context: CompletionContext
    ): boolean {
        if (!isSpecificationTextPart(refInfo.container) ||
            !AstUtils.getContainerOfType(refInfo.container, isJourneyStep) ||
            !this.isJourneyPathOnlyTarget(target)) {
            return false;
        }
        return this.shouldAppendPathDot(refInfo, context);
    }

    /**
     * A cross-context or module-qualified read source may start at a structural
     * container and continue through one or more path segments. Offer the dot
     * so accepting the container keeps the user on a valid qualified path.
     */
    private isReadSourcePathContinuation(
        refInfo: ReferenceInfo,
        target: AstNode | undefined,
        context: CompletionContext
    ): boolean {
        return isReadSourceReference(refInfo.container) &&
            this.isReadSourceStructuralTarget(target) &&
            this.shouldAppendPathDot(refInfo, context);
    }

    private isReadSourceStructuralTarget(target: AstNode | undefined): boolean {
        return target !== undefined &&
            (isBoundedContext(target) || isContextMap(target) || isModule(target) ||
                isQueryService(target) || isSharedKernel(target));
    }

    private shouldAppendPathDot(refInfo: ReferenceInfo, context: CompletionContext): boolean {
        const document = AstUtils.getDocument(refInfo.container);
        const following = document.textDocument.getText().slice(context.offset);
        return !/^\s*\./u.test(following);
    }

    private isJourneyPathOnlyTarget(target: AstNode): boolean {
        return isBoundedContext(target) || isContextMap(target) || isSharedKernel(target) ||
            isModule(target) || isApplicationService(target) || isQueryService(target) ||
            isAggregate(target) || isEntity(target);
    }

    override async getCompletion(
        document: LangiumDocument,
        params: CompletionParams,
        cancelToken?: CancellationToken
    ): Promise<CompletionList | undefined> {
        const indentation = await this.getClientIndentationOptions(document);
        const completion = await this.getCompletionInternal(document, params, cancelToken);
        return completion && indentation
            ? {
                ...completion,
                items: applyConfiguredIndentationToCompletions(
                    completion.items,
                    indentation.tabSize,
                    indentation.insertSpaces
                )
            }
            : completion;
    }

    private async getClientIndentationOptions(document: LangiumDocument) {
        const connection = this.thinaiServices.shared.lsp.Connection;
        if (!connection) {
            return undefined;
        }
        try {
            const configuration = await connection.workspace.getConfiguration({
                section: 'editor',
                scopeUri: document.uri.toString()
            }) as { tabSize?: unknown; insertSpaces?: unknown } | null;
            const tabSize = typeof configuration?.tabSize === 'number' && Number.isFinite(configuration.tabSize) &&
                configuration.tabSize > 0 ? Math.floor(configuration.tabSize) : undefined;
            const insertSpaces = typeof configuration?.insertSpaces === 'boolean'
                ? configuration.insertSpaces
                : undefined;
            if (tabSize !== undefined && insertSpaces !== undefined) {
                return { tabSize, insertSpaces };
            }
        } catch {
            // The client may not support a scoped editor configuration request.
        }
        return undefined;
    }

    private async getCompletionInternal(
        document: LangiumDocument,
        params: CompletionParams,
        cancelToken?: CancellationToken
    ): Promise<CompletionList | undefined> {
        const offset = document.textDocument.offsetAt(params.position);
        const sourceStructure = scanThinaiSource(document.textDocument.getText().slice(0, offset));
        if (sourceStructure.inComment) {
            return { isIncomplete: false, items: [] };
        }
        const defaultCompletion = await super.getCompletion(document, params, cancelToken);
        const specificationContext = getSpecificationCompletionContext(
            document,
            offset
        );
        if (specificationContext === 'text') {
            return { isIncomplete: false, items: [] };
        }
        if (specificationContext === 'reference') {
            return defaultCompletion
                ? { ...defaultCompletion, items: defaultCompletion.items.filter(item => item.kind !== CompletionItemKind.Keyword) }
                : defaultCompletion;
        }
        const readSourceContinuation = this.getReadSourceContinuationCompletions(document, params.position);
        if (readSourceContinuation.active) {
            return { isIncomplete: false, items: readSourceContinuation.items };
        }
        const incompleteSibling = document.parseResult.value
            ? this.getLastIncompleteSiblingBeforeOffset(document.parseResult.value, document, params.position)
            : undefined;
        const incompleteStatement = incompleteSibling !== undefined ||
            this.isInsideUnopenedRequiredBlockHeader(document, params.position);
        const optionalClauseCompletions = this.optionalClauseCompletion.getCompletions(document, params.position);
        const optionalClauseLabels = new Set(optionalClauseCompletions.map(item => item.label));
        const relationshipContinuations = this.contextMapCompletion.getRelationshipContinuations(document, params.position);
        const hasBoundedContextCandidates = defaultCompletion?.items.some(item =>
            item.detail?.startsWith('BoundedContext ')
        ) === true;
        const constrainedValueCompletions = [
            ...optionalClauseCompletions,
            ...this.getPartialInitialKeywordCompletions(document, params.position),
            ...this.getIntegrationPatternCompletions(document, params.position),
            ...relationshipContinuations,
            ...this.getExposureDeclarationCompletions(document, params.position, defaultCompletion),
            ...(hasBoundedContextCandidates ? [] : this.contextMapCompletion.getRightContextCompletions(document, params.position))
        ];
        const constrainedLabels = new Set(constrainedValueCompletions.map(item => item.label));
        const inProgressKeywordCompletions = [
            ...this.keywordContinuations.getInProgressCompletions(document, params.position),
            ...this.keywordContinuations.getPartialSameLineCompletions(document, params.position),
            ...this.queryRepositoryCompletion.getQueryRepositoryReadCompletions(
                document,
                params.position,
                sourceStructure
            ),
            ...this.queryRepositoryCompletion.getMethodReadsFromCompletions(document, params.position)
        ].filter(item => typeof item.label !== 'string' ||
            !constrainedLabels.has(item.label) && !optionalClauseLabels.has(item.label));
        const blockKeywords = incompleteStatement
            ? []
            : this.blockCompletion.getEnclosingBlockKeywordCompletions(document, params.position);
        const modelGapKeywords = incompleteStatement
            ? []
            : this.blockCompletion.getModelGapKeywordCompletions(
                document,
                params.position,
                defaultCompletion,
                inProgressKeywordCompletions
            );
        const scopedDefaultCompletion = this.filterSharedKernelModuleKeywords(document, params.position, defaultCompletion);
        const completionWithBlockKeywords = this.contextMapCompletion.filterKeywords(
            document,
            params.position,
            this.addFallbackKeywords(scopedDefaultCompletion, blockKeywords)
        );
        const completionWithModelGapKeywords = this.addSupplementaryKeywords(completionWithBlockKeywords, modelGapKeywords);
        const rawCompletionWithKeywords = this.withCompoundKeywordCompletions(
            completionWithModelGapKeywords,
            inProgressKeywordCompletions,
            document,
            params.position
        );
        const offersCompoundReadsFrom = [...blockKeywords, ...inProgressKeywordCompletions]
            .some(item => item.label === 'reads from');
        const completionWithKeywords = offersCompoundReadsFrom && rawCompletionWithKeywords
            ? {
                ...rawCompletionWithKeywords,
                items: rawCompletionWithKeywords.items.filter(item => item.label !== 'reads')
            }
            : rawCompletionWithKeywords;
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
            .filter(item => item.kind !== CompletionItemKind.Keyword || typeof item.label !== 'string' ||
                !constrainedLabels.has(item.label))
            .map(item => emptyBlockReplacements.get(item.label) ?? item);
        const sameLineKeywordContinuations = [
            ...inProgressKeywordCompletions.map(item => item.label),
            ...constrainedValueCompletions.filter(item => item.kind === CompletionItemKind.Keyword).map(item => String(item.label)),
            ...relationshipContinuations.map(item => item.label),
            ...modelGapKeywords.map(item => String(item.label))
        ];
        const importContext = this.importCompletion.getPathContext(document, params.position);
        if (!importContext) {
            if (constrainedValueCompletions.length === 0 && inProgressKeywordCompletions.length === 0 &&
                modelGapKeywords.length === 0) {
                const completion = this.blockCompletion.filterSameLineSiblingCompletions(document, params.position, completionWithEmptyBlockEdits);
                return this.filterContextSensitiveKeywordCompletions(document, params.position, completion, sourceStructure);
            }
            const completion = this.blockCompletion.filterSameLineSiblingCompletions(document, params.position, {
                isIncomplete: completionWithKeywords?.isIncomplete ?? false,
                items: [...completionItems, ...constrainedValueCompletions]
            }, sameLineKeywordContinuations);
            return this.filterContextSensitiveKeywordCompletions(document, params.position, completion, sourceStructure);
        }

        const importItems = await this.importCompletion.getCompletions(
            document,
            importContext.path,
            importContext.pathStart,
            importContext.pathEnd
        );
        const completion = this.blockCompletion.filterSameLineSiblingCompletions(document, params.position, {
            isIncomplete: completionWithKeywords?.isIncomplete ?? false,
            items: [...completionItems, ...constrainedValueCompletions, ...importItems]
        }, sameLineKeywordContinuations);
        return this.filterContextSensitiveKeywordCompletions(document, params.position, completion, sourceStructure);
    }

    private filterContextSensitiveKeywordCompletions(
        document: LangiumDocument,
        position: Position,
        completion: CompletionList | undefined,
        sourceStructure: ReturnType<typeof scanThinaiSource>
    ): CompletionList | undefined {
        const root = document.parseResult.value;
        if (!root || !completion) {
            return completion;
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const braceOwners: Array<'aggregate' | 'other'> = [];
        let previousBrace = -1;
        const sourcePrefix = text.slice(0, offset);
        for (const brace of sourceStructure.braces) {
            if (brace.character === '{') {
                const declaration = sourcePrefix.slice(previousBrace + 1, brace.offset).trim();
                braceOwners.push(/\baggregate\s+[_a-zA-Z][\w]*\s*$/iu.test(declaration) ? 'aggregate' : 'other');
                previousBrace = brace.offset;
            } else {
                braceOwners.pop();
                previousBrace = brace.offset;
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
        const activeQueryRepository = findQueryRepositoryAtOffset(document, offset, sourceStructure);
        const terminalBlock = activeQueryRepository ?? innermostBlock;
        const terminalKeywords = this.getTerminalBlockKeywords(terminalBlock);
        const allowedMethodClauses = activeMethod ? new Set(this.keywordContinuations.getSiblingKeywordLabels(activeMethod)) : undefined;
        const transitionContinuationAllowed = this.keywordContinuations.isTransitionContinuationPosition(document, offset);
        const entityDeclarationsAllowed = innermostBlock?.$type === 'Aggregate' || braceOwners.at(-1) === 'aggregate';
        const rootEntityAlreadyDeclared = entityDeclarationsAllowed && innermostBlock?.$type === 'Aggregate' &&
            'members' in innermostBlock && Array.isArray(innermostBlock.members) &&
            innermostBlock.members.some(member => isEntity(member) && member.root);
        const insideImportComponents = this.isInsideImportComponentList(document, offset);
        const entityIdentifierAlreadyDeclared = isEntity(identifierOwner) &&
            identifierOwner.fields.some(field => field.identifier);
        const linePrefix = text.slice(getLineStartOffset(document, offset), offset);
        const identifierTypePosition = (
            activeField !== undefined && activeField.identifier && isEntity(activeField.$container) &&
            this.isTypeKeywordCompletionPosition(document, position)
        ) || (
            isEntity(innermostBlock) &&
            identifierTypePattern.test(linePrefix)
        );
        const typeKeywords = new Set(['string', 'number', 'boolean', 'date', 'time', 'instant', 'List', 'Set', 'Map']);
        const validInitialCompletion = this.isValidInitialCompletion(offset, activeField, innermostBlock);
        return {
            ...completion,
            items: completion.items.filter(item => {
                if (item.kind !== CompletionItemKind.Keyword || typeof item.label !== 'string') {
                    return true;
                }
                if (insideImportComponents) {
                    return false;
                }
                if (item.label === 'identifier' &&
                    (!isEntity(identifierOwner) || entityIdentifierAlreadyDeclared)) {
                    return false;
                }
                if (item.label === 'initial' && !validInitialCompletion) {
                    return false;
                }
                if (identifierTypePosition && typeKeywords.has(item.label)) {
                    return false;
                }
                if (item.label === 'returns' && activeMethod && isProjector(activeMethod.$container)) {
                    return false;
                }
                if (item.label === 'reads') {
                    return false;
                }
                if (item.label === 'reads from' && activeMethod && allowedMethodClauses &&
                    !allowedMethodClauses.has('reads from')) {
                    return false;
                }
                if (terminalKeywords !== undefined && !terminalKeywords.includes(item.label)) {
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
                    this.keywordContinuations.isTransitionContinuationContext(document, offset) && !transitionContinuationAllowed) {
                    return false;
                }
                return true;
            })
        };
    }

    private getTerminalBlockKeywords(block: AstNode | undefined): readonly string[] | undefined {
        if (!block) {
            return undefined;
        }
        if (block.$type === 'EnumType') {
            return [];
        }
        if (isRepository(block)) {
            if (block.root?.ref !== undefined) {
                return [];
            }
            const typed = this.getReferenceText(block.root);
            return typed.length === 0 || 'manages'.startsWith(typed) ? ['manages'] : [];
        }
        if (isQueryRepository(block)) {
            if (block.readModel?.ref !== undefined) {
                return block.sources.length === 0 ? ['reads from'] : [];
            }
            const typed = this.getReferenceText(block.readModel);
            return typed.length === 0 || 'serves'.startsWith(typed) ? ['serves'] : [];
        }
        if (isContextMapEndpoint(block)) {
            return block.integrationPatterns.length === 0 ? ['integrationPatterns'] : [];
        }
        if (isSharedKernelRelationship(block)) {
            return block.participants.length === 0 ? ['participants'] : [];
        }
        return undefined;
    }

    private getReferenceText(reference: { $refText?: string } | undefined): string {
        return (reference?.$refText ?? '').trim();
    }

    private withCompoundKeywordCompletions(
        completion: CompletionList | undefined,
        continuations: CompletionItem[],
        document: LangiumDocument,
        position: Position
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
            reads: ['reads from'],
            depends: ['depends on']
        };
        const items = completion.items.flatMap(item => {
            if (item.kind !== CompletionItemKind.Keyword || typeof item.label !== 'string' ||
                !Object.prototype.hasOwnProperty.call(phrases, item.label)) {
                return [item];
            }
            if (item.label === 'context' && this.isBoundedContextKeywordContext(document, position)) {
                // `context` is the second word of `bounded context`; it must
                // not be rewritten to the unrelated top-level phrase
                // `context map` when a bounded-context header is being typed
                // across a line break.
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

    private isBoundedContextKeywordContext(document: LangiumDocument, position: Position): boolean {
        const text = document.textDocument.getText();
        const offset = document.textDocument.offsetAt(position);
        const lineStart = getLineStartOffset(document, offset);
        const currentLine = text.slice(lineStart, offset).trim().toLowerCase();
        if (currentLine.length > 0 && !'context'.startsWith(currentLine)) {
            return false;
        }
        const before = text.slice(0, lineStart).trimEnd();
        const previousLine = before.slice(before.lastIndexOf('\n') + 1).trim();
        return /\bbounded$/iu.test(previousLine) || /\bin\s+bounded$/iu.test(previousLine);
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

    private getReadSourceContinuationCompletions(
        document: LangiumDocument,
        position: Position
    ): { active: boolean; items: CompletionItem[] } {
        const root = document.parseResult.value;
        if (!root) {
            return { active: false, items: [] };
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const read = AstUtils.streamAst(root)
            .filter(isReadDependency)
            .filter(node => this.endsWithTrailingComma(node, text, offset))
            .toArray()
            .sort((left, right) => right.$cstNode!.end - left.$cstNode!.end)[0];
        if (!read) {
            return { active: false, items: [] };
        }
        const lastSource = read.sources.at(-1);
        const lastTarget = lastSource?.target?.ref;
        if (!lastSource?.$cstNode || !lastTarget) {
            // The list is still incomplete even when the last item cannot be
            // resolved; suppress sibling completions rather than suggesting
            // unrelated declarations.
            return { active: true, items: [] };
        }
        const context = {
            container: lastSource,
            property: 'target',
            reference: { $refText: '' } as ReferenceInfo['reference']
        } as ReferenceInfo;
        const scopeProvider = this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider;
        const usedTargets = new Set<AstNode>();
        for (const source of read.sources) {
            const target = source.target?.ref;
            if (target) {
                usedTargets.add(target);
            }
        }
        const descriptions = scopeProvider.filterCompletionCandidates(
            context,
            scopeProvider.getScope(context).getAllElements()
        ).filter(description => {
            const target = description.node ?? resolveAstNodeDescription(description, this.thinaiServices);
            return target !== undefined && !usedTargets.has(target);
        }).toArray();
        const completionContext = this.getLangiumCompletionContext(document, position);
        return {
            active: true,
            items: this.dedupeCompletionCandidates(context, stream(descriptions)).map(description => {
                const target = description.node ?? resolveAstNodeDescription(description, this.thinaiServices);
                const insertText = `${formatQualifiedName(description.name)}${this.isReadSourceStructuralTarget(target) ? '.' : ''}`;
                const item: CompletionValueItem = {
                    nodeDescription: description,
                    kind: this.thinaiServices.shared.lsp.NodeKindProvider.getCompletionItemKind(description),
                    detail: this.completionDetails.getCompletionDetail(description),
                    sortText: '0',
                    insertText
                };
                const langiumItem = completionContext ? this.fillCompletionItem(completionContext, item) : undefined;
                return langiumItem ?? {
                    ...item,
                    label: description.name,
                    textEdit: {
                        range: { start: position, end: position },
                        newText: insertText
                    }
                };
            }).toArray()
        };
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
        const exposesMatch = /^exposes\b/u.exec(source);
        if (!exposesMatch) {
            return [];
        }
        const listSource = source.slice(exposesMatch[0].length);
        const typedRaw = listSource.split(',').at(-1)?.trim() ?? '';
        const typedPrefix = normalizeIdentifierText(typedRaw);
        const prefixStart = offset - typedRaw.length;
        const existingItems = defaultCompletion?.items ?? [];
        const completionContext = this.getLangiumCompletionContext(document, position);
        const scopeProvider = this.thinaiServices.references.ScopeProvider as ThinaiScopeProvider;
        return scopeProvider.getExposureDeclarationCandidates(exposure as Exposure)
            .filter(description => {
                const detail = this.completionDetails.getCompletionDetail(description);
                return description.name.toLowerCase().startsWith(typedPrefix.toLowerCase()) &&
                    !existingItems.some(item => item.label === description.name && item.detail === detail);
            })
            .map(description => {
                const needsLeadingSpace = prefixStart > 0 && !/\s/.test(text[prefixStart - 1]!);
                const insertText = `${needsLeadingSpace ? ' ' : ''}${formatQualifiedName(description.name)}`;
                const item: CompletionValueItem = {
                    nodeDescription: description,
                    kind: this.thinaiServices.shared.lsp.NodeKindProvider.getCompletionItemKind(description),
                    detail: this.completionDetails.getCompletionDetail(description),
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
                if (!cstNode || cstNode.offset > offset) {
                    return false;
                }
                const closingBrace = [...CstUtils.flattenCst(cstNode)].reverse()
                    .find(leaf => leaf.text === '}');
                return offset < cstNode.end || closingBrace === undefined || closingBrace.offset >= offset;
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

    private getSameLineSiblingAt(document: LangiumDocument, position: Position): AstNode | null | undefined {
        const model = document.parseResult.value;
        if (!model) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(position);
        if (AstUtils.streamAst(model).filter(isReadSourceReference).some(reference => {
            const cstNode = reference.$cstNode;
            return cstNode !== undefined && cstNode.offset <= offset && offset <= cstNode.end &&
                reference.target?.ref === undefined;
        })) {
            return null;
        }
        if (this.getLastIncompleteSiblingBeforeOffset(model, document, position)) {
            return null;
        }
        const currentLine = position.line;
        const text = document.textDocument.getText();
        const lineStart = getLineStartOffset(document, offset);
        const linePrefix = text.slice(lineStart, offset);
        if (this.hasUnterminatedStringLiteral(linePrefix) || this.hasIncompleteStatementSuffix(linePrefix) ||
            this.isAfterTrailingComma(model, text, offset)) {
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

    private isValidInitialCompletion(
        offset: number,
        activeField: Field | undefined,
        innermostBlock: AstNode | undefined
    ): boolean {
        if (activeField) {
            if (this.isEnumEntityFieldWithoutInitial(activeField)) {
                return true;
            }
            // Parsing `status: Status ini` can recover as a separate typeless
            // field named `ini`; treat a prefix of `initial` as the keyword
            // continuation of the preceding enum field.
            if (isEntity(activeField.$container) && !activeField.type && !activeField.primitive &&
                !activeField.collection && !activeField.initialState &&
                'initial'.startsWith(activeField.name)) {
                const previousField = this.previousEntityField(activeField);
                if (!previousField?.$cstNode || !activeField.$cstNode ||
                    !this.isEnumEntityFieldWithoutInitial(previousField)) {
                    return false;
                }
                const hasInterveningDeclaration = AstUtils.streamContents(activeField.$container).some(child =>
                    child !== previousField && child !== activeField &&
                    child.$container === activeField.$container && child.$cstNode !== undefined &&
                    child.$cstNode.offset >= previousField.$cstNode!.end &&
                    child.$cstNode.end <= activeField.$cstNode!.offset
                );
                return !hasInterveningDeclaration;
            }
            return false;
        }
        if (!isEntity(innermostBlock)) {
            return false;
        }
        const fields = innermostBlock.fields
            .filter(field => field.$cstNode !== undefined && field.$cstNode.end <= offset)
            .sort((left, right) => left.$cstNode!.end - right.$cstNode!.end);
        const previousField = fields.at(-1);
        if (!previousField?.$cstNode || !this.isEnumEntityFieldWithoutInitial(previousField)) {
            return false;
        }
        return !AstUtils.streamContents(innermostBlock).some(child =>
            child !== previousField && child.$container === innermostBlock &&
            child.$cstNode !== undefined &&
            child.$cstNode.offset >= previousField.$cstNode!.end &&
            child.$cstNode.end <= offset
        );
    }

    private isEnumEntityFieldWithoutInitial(field: Field): boolean {
        return isEntity(field.$container) && !field.optional &&
            !hasReferenceText(field.initialState) && isEnumType(field.type?.ref);
    }

    private previousEntityField(field: Field): Field | undefined {
        if (!isEntity(field.$container)) {
            return undefined;
        }
        const fields = field.$container.fields
            .filter(candidate => candidate.$cstNode !== undefined)
            .sort((left, right) => left.$cstNode!.offset - right.$cstNode!.offset);
        const index = fields.indexOf(field);
        return index > 0 ? fields[index - 1] : undefined;
    }

    private isInsideImportComponentList(document: LangiumDocument, offset: number): boolean {
        const root = document.parseResult.value;
        if (!root) {
            return false;
        }
        const text = document.textDocument.getText();
        const importNode = AstUtils.streamAst(root)
            .filter(isImport)
            .find(node => {
                const cstNode = node.$cstNode;
                return cstNode !== undefined && cstNode.offset <= offset && offset <= cstNode.end;
            });
        if (!importNode?.$cstNode) {
            return false;
        }
        const source = text.slice(importNode.$cstNode.offset, offset);
        return source.includes('{') && !source.includes('}');
    }

    private isAfterTrailingComma(model: AstNode, text: string, offset: number): boolean {
        return AstUtils.streamAst(model).some(node => {
            if (!isLineSeparatedSibling(node)) {
                return false;
            }
            return this.endsWithTrailingComma(node, text, offset);
        });
    }

    private endsWithTrailingComma(node: AstNode, text: string, offset: number): boolean {
        const cstNode = node.$cstNode;
        if (!cstNode || cstNode.end > offset) {
            return false;
        }
        // The next list item may be on a later line. The comma still requires
        // another item, so whitespace (including newlines) is a valid gap.
        if (text.slice(cstNode.end, offset).trim().length > 0) {
            return false;
        }
        const source = text.slice(cstNode.offset, cstNode.end).trimEnd();
        return source.endsWith(',') && !this.hasUnterminatedStringLiteral(source);
    }

    private isInsideUnopenedRequiredBlockHeader(document: LangiumDocument, position: Position): boolean {
        const root = document.parseResult.value;
        if (!root) {
            return false;
        }
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        for (const node of AstUtils.streamAst(root)) {
            const cstNode = node.$cstNode;
            if (!cstNode || cstNode.offset > offset || cstNode.end < offset ||
                getSiblingStatementPolicy(node.$type).block !== 'required') {
                continue;
            }
            const openingBrace = GrammarUtils.findNodeForKeyword(cstNode, '{');
            if ((!openingBrace || openingBrace.offset > offset) &&
                text.slice(cstNode.offset, offset).trim().length > 0) {
                return true;
            }
        }
        return false;
    }

    private getLastIncompleteSiblingBeforeOffset(
        model: AstNode,
        document: LangiumDocument,
        position: Position
    ): AstNode | undefined {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const activeOpenBlock = this.getInnermostOpenBlockAtOffset(model, offset);
        // Only direct children of the block containing the cursor (or the
        // model at top level) can be the current/previous statement. An
        // incomplete statement in an unrelated sibling block must not disable
        // completion in the block being edited.
        const activeContainer = activeOpenBlock ?? model;
        const activeOpenBlockAncestors = new Set<AstNode>();
        for (let ancestor = activeOpenBlock?.$container; ancestor; ancestor = ancestor.$container) {
            activeOpenBlockAncestors.add(ancestor);
        }
        const lastByContainer = new Map<AstNode, AstNode>();
        for (const node of AstUtils.streamAst(model)) {
            const cstNode = node.$cstNode;
            if (!cstNode || !isLineSeparatedSibling(node) || cstNode.end > offset ||
                node.$container !== activeContainer) {
                continue;
            }
            if (activeOpenBlockAncestors.has(node)) {
                // An enclosing relationship/declaration is not the statement
                // being typed merely because its child block is still open.
                continue;
            }
            if (cstNode.range.start.line < position.line && cstNode.range.end.line === position.line) {
                // A statement that began on an earlier line and reaches the
                // cursor line is the multi-line statement currently being
                // edited, not an incomplete previous sibling.
                continue;
            }
            if (this.isPartialSiblingKeywordNode(node, document, position)) {
                lastByContainer.delete(node.$container!);
                continue;
            }
            const openingBrace = GrammarUtils.findNodeForKeyword(cstNode, '{');
            const closingBrace = [...CstUtils.flattenCst(cstNode)].reverse()
                .find(leaf => leaf.text === '}');
            const insideUnclosedBlock = isBlockNodeType(node.$type) &&
                openingBrace !== undefined && openingBrace.offset < offset &&
                (closingBrace === undefined || closingBrace.offset >= offset);
            if (insideUnclosedBlock) {
                // The cursor is already inside this block; only its direct
                // children can be the current statement.
                continue;
            }
            const previous = lastByContainer.get(node.$container!);
            if (!previous || cstNode.end > previous.$cstNode!.end) {
                lastByContainer.set(node.$container!, node);
            }
        }
        for (const node of lastByContainer.values()) {
            if (this.endsWithTrailingComma(node, text, offset) ||
                !this.isCompleteSameLineSibling(node, document, position)) {
                return node;
            }
        }
        return undefined;
    }

    private getInnermostOpenBlockAtOffset(model: AstNode, offset: number): AstNode | undefined {
        let innermost: AstNode | undefined;
        let innermostBraceOffset = -1;
        for (const node of AstUtils.streamAst(model)) {
            if (!isBlockNodeType(node.$type) || !node.$cstNode) {
                continue;
            }
            const openingBrace = GrammarUtils.findNodeForKeyword(node.$cstNode, '{');
            if (!openingBrace || openingBrace.offset >= offset) {
                continue;
            }
            const closingBrace = [...CstUtils.flattenCst(node.$cstNode)].reverse()
                .find(leaf => leaf.text === '}');
            if (closingBrace && closingBrace.offset < offset) {
                continue;
            }
            if (openingBrace.offset > innermostBraceOffset) {
                innermost = node;
                innermostBraceOffset = openingBrace.offset;
            }
        }
        return innermost;
    }

    private isOpenBlockContainerAtCursor(node: AstNode, source: string): boolean {
        if (!isBlockNodeType(node.$type)) {
            return false;
        }
        return scanThinaiSource(source).openBraces > 0;
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
        if ((isMethodInvocation(node) || isJourneyStep(node)) && source.trimEnd().endsWith('.')) {
            return false;
        }
        if ((isMethodInvocation(node) || isJourneyStep(node)) && !hasReferenceText(node.target)) {
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
        if (isField(node) && !hasReferenceText(node.initialState) && /\binitial\s*$/iu.test(source)) {
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

    private hasCompleteSiblingReferences(
        node: AstNode,
        policy: ReturnType<typeof getSiblingStatementPolicy>
    ): boolean {
        const properties = node as AstNode & Record<string, unknown>;
        const paths = [
            ...(policy.requiredReferences ?? []).map(property => [property]),
            ...(policy.requiredReferencePaths ?? [])
        ];
        if (paths.some(path => !hasReferenceText(this.getNodePropertyPath(properties, path)))) {
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
                        hasReferenceText(this.getNodePropertyPath(item, [property]))
                    );
                }
                const path = referenceList.targetProperty ? [referenceList.targetProperty] : [];
                const reference = path.length > 0 ? this.getNodePropertyPath(item, path) : item;
                return hasReferenceText(reference);
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
        return scanThinaiSource(source).unterminatedString;
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
        const lineStart = getLineStartOffset(document, offset);
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
            return incompleteFieldTypePattern.test(source);
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
        return incompleteReturnTypePattern.test(source);
    }

    private isIncompleteCollectionType(collection: CollectionType): boolean {
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

    private hasCompletedTypeReference(reference: { $refText: string; ref?: unknown } | undefined): boolean {
        return reference?.ref !== undefined;
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
            const gapAfterField = text.slice(node.$cstNode.end, offset);
            if (/\binitial\b/i.test(source) ||
                /[\r\n]/u.test(gapAfterField) && !/^[\s\p{L}_]*$/u.test(gapAfterField)) {
                continue;
            }
            const match = initialFieldTypePattern.exec(source);
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
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const endpoint = AstUtils.streamAst(root)
            .filter(node => node.$type === 'ContextMapEndpoint')
            .filter(node => node.$cstNode !== undefined && node.$cstNode.offset <= offset && offset <= node.$cstNode.end)
            .toArray()
            .sort((left, right) => right.$cstNode!.offset - left.$cstNode!.offset)[0];
        const property = endpoint?.$cstNode
            ? (GrammarUtils.findNodesForKeyword(endpoint.$cstNode, 'integrationPatterns')
                .filter(node => node.offset < offset)
                .sort((left, right) => right.offset - left.offset)[0])
            : undefined;
        if (!property) {
            return [];
        }
        const propertyStart = property.offset;
        const propertyMatch = /^integrationPatterns\s*:\s*\[/u.exec(text.slice(propertyStart));
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
            } else if (character === ']' || (character === '\n' || character === '\r') &&
                text.slice(index, offset).trim().length === 0) {
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

}
