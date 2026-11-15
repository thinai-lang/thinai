import {
    AstUtils,
    DefaultScopeProvider,
    type AstNode,
    type AstNodeDescription,
    type LangiumCoreServices,
    type Reference,
    type ReferenceInfo,
    type Scope,
    type Stream
} from 'langium';
import type { FuzzyMatcher } from 'langium/lsp';
import {
    isAggregate,
    isApplicationService,
    isBoundedContext,
    isBoundedContextPart,
    isDataObject,
    isDomainEvent,
    isDomainService,
    isEntity,
    isEnumType,
    isFactory,
    isField,
    isImportableComponent,
    isIntegrationEvent,
    isJourneyStep,
    isMethod,
    isMethodInvocation,
    isModel,
    isModule,
    isParameter,
    isProjector,
    isQueryService,
    isReadModel,
    isReadSourceReference,
    isSharedKernel,
    isSpecificationTextPart,
    isValueObject,
    type DataObject,
    type DomainEvent,
    type Entity,
    type IntegrationEvent,
    type Method,
    type ReadModel,
    type TypeDeclaration,
    type ValueObject
} from './generated/ast.js';
import { getNavigableTypeReferences } from './thinai-type-utils.js';
import { unquoteIdentifier } from './thinai-identifiers.js';
import { getOwningContextName, getDeclarationPath } from './thinai-scope-utils.js';

type FieldShape = DataObject | DomainEvent | Entity | IntegrationEvent | ReadModel | ValueObject;

function isFieldShape(node: AstNode): node is FieldShape {
    return isEntity(node) || isDataObject(node) || isReadModel(node) || isValueObject(node) ||
        isDomainEvent(node) || isIntegrationEvent(node);
}

interface ThinaiPathScopeCallbacks {
    createScope(elements: Iterable<AstNodeDescription>): Scope;
    getUnsegmentedScope(context: ReferenceInfo, referenceType: string): Scope;
    filterCompletionCandidates(context: ReferenceInfo, candidates: Iterable<AstNodeDescription>): Stream<AstNodeDescription>;
    getDescriptionNode(description: AstNodeDescription): AstNode | undefined;
    isSupportedInvocationTarget(container: AstNode, target: Method): boolean;
    isSupportedCandidate(context: ReferenceInfo, target: AstNode): boolean;
    isSupportedSpecificationPathSegment(context: ReferenceInfo, target: AstNode, terminal: boolean): boolean;
    isSupportedSpecificationModulePrefix(context: ReferenceInfo, module: AstNode, candidate: AstNode | undefined): boolean;
    isJourneyStepTarget(method: Method): boolean;
}

/** Owns qualified-reference lookup and path-segment completion for Thinai references. */
export class ThinaiPathScope extends DefaultScopeProvider {
    private readonly fuzzyMatcher: FuzzyMatcher;

    constructor(
        services: LangiumCoreServices,
        private readonly callbacks: ThinaiPathScopeCallbacks
    ) {
        super(services);
        this.fuzzyMatcher = (services.shared as unknown as {
            lsp: { FuzzyMatcher: FuzzyMatcher };
        }).lsp.FuzzyMatcher;
    }

    getPathScope(context: ReferenceInfo, referenceType: string): Scope | undefined {
        const qualifiedPathScope = this.getQualifiedPathScope(context);
        if (qualifiedPathScope) {
            return qualifiedPathScope;
        }
        if (referenceType === 'SpecificationTarget' && context.property === 'targets' &&
            isSpecificationTextPart(context.container)) {
            return this.callbacks.createScope(this.getSpecificationPathSymbols(context, referenceType));
        }
        if (referenceType === 'SpecificationTarget' && context.property === 'target' &&
            isSpecificationTextPart(context.container)) {
            return this.callbacks.createScope(this.getSpecificationRootPathSymbols(context, referenceType));
        }
        const wrapperPath = (context.container as unknown as { path?: unknown }).path;
        if (context.property === 'target' && Array.isArray(wrapperPath) && wrapperPath.length === 0) {
            return this.callbacks.getUnsegmentedScope(this.getPathScopeContext(context), referenceType);
        }
        return undefined;
    }

    getPathCompletionCandidates(context: ReferenceInfo, offset?: number): AstNodeDescription[] | undefined {
        const { container, property } = context;
        const values = container as unknown as Record<string, unknown>;
        const metadata = this.reflection.getTypeMetaData(container.$type).properties;
        const pathProperty = this.getPathPropertyName(property, values);
        if (!pathProperty || !metadata[pathProperty]?.referenceType) {
            return undefined;
        }
        const pathValues = values[pathProperty];
        if (!Array.isArray(pathValues)) {
            return undefined;
        }
        if (this.hasForbiddenPathPrefix(container, pathProperty, pathValues)) {
            // These declarations are top-level. Their grammar rules still
            // accept a qualified form so validation can report a targeted
            // error, but completion must not continue into that dead path.
            return [];
        }
        const completingPathProperty = property === pathProperty;
        const terminalProperty = completingPathProperty
            ? pathProperty === 'path' ? 'target' : pathProperty.slice(0, -'Path'.length)
            : property;
        if (!metadata[terminalProperty]?.referenceType) {
            return completingPathProperty ? [] : undefined;
        }
        const parsedTerminalReference = values[terminalProperty];
        const hasTerminalReference = parsedTerminalReference !== undefined && parsedTerminalReference !== null &&
            typeof parsedTerminalReference === 'object' && '$refText' in parsedTerminalReference;
        const terminalReference = hasTerminalReference
            ? parsedTerminalReference as ReferenceInfo['reference']
            : { $refText: '' } as ReferenceInfo['reference'];
        // When the parsed terminal reference is followed by a dot, that
        // reference is actually the last path segment being edited. Treat it
        // as part of the prefix so completion offers its children.
        const trailingTerminalSegment = this.hasTrailingDot(terminalReference, container, offset);
        const pathReferences = pathValues as ReferenceInfo['reference'][];
        const firstPathSegment = pathReferences.length === 0 && !trailingTerminalSegment;
        const document = AstUtils.getDocument(container);
        const text = document.textDocument.getText();
        const firstPathRef = pathReferences[0];
        const firstPathRefEnd = firstPathRef?.$refNode?.end;
        const hasDotAfterFirstPath = firstPathRefEnd !== undefined && offset !== undefined &&
            /^\s*\./u.test(text.slice(firstPathRefEnd, offset));
        const singleFirstSegmentNoDot = pathReferences.length === 1 && !hasDotAfterFirstPath &&
            terminalReference.$refText.length === 0;
        const completedPathCount = offset === undefined
            ? context.index ?? pathValues.length
            : pathReferences.filter(reference =>
                reference.$refNode !== undefined && reference.$refNode.end < offset
            ).length;
        const index = completingPathProperty
            ? Math.min(completedPathCount, pathValues.length)
            : pathValues.length;
        const prefix = (pathValues as ReferenceInfo['reference'][]).slice(0, index).map(reference => reference.$refText);
        if (trailingTerminalSegment) {
            prefix.push((terminalReference as ReferenceInfo['reference']).$refText);
        }
        const finalContext: ReferenceInfo = {
            ...context,
            property: terminalProperty,
            reference: (completingPathProperty ? terminalReference : context.reference) as ReferenceInfo['reference'],
            index: undefined
        };
        const finalType = this.getDeclaredReferenceType(finalContext);
        if (!finalType) {
            return [];
        }
        const finalScope = this.callbacks.getUnsegmentedScope(this.getPathScopeContext(finalContext), finalType);
        const allowedDescriptions = this.callbacks
            .filterCompletionCandidates(finalContext, finalScope.getAllElements())
            .filter(description => this.callbacks.getDescriptionNode(description) !== undefined)
            .toArray();
        const referenceType = this.getDeclaredReferenceType(context);
        if (!referenceType) {
            return [];
        }
        if (firstPathSegment || singleFirstSegmentNoDot) {
            const firstSegmentStartOffset = firstPathSegment
                ? terminalReference.$refNode?.offset
                : firstPathRef?.$refNode?.offset;
            const typedFirstSegment = firstPathSegment
                ? terminalReference.$refText
                : firstPathRef?.$refText ?? '';
            if (!completingPathProperty) {
                // Completing the terminal reference directly: only repair a
                // partial token that actually contains the cursor. A recovered
                // reference on a later line must not shadow default completion.
                const terminalNode = terminalReference.$refNode;
                if (typedFirstSegment.length === 0 || terminalNode === undefined ||
                    offset === undefined || terminalNode.offset > offset) {
                    return undefined;
                }
            }
            const candidates = this.getFirstPathSegmentCandidates(
                context,
                allowedDescriptions,
                typedFirstSegment,
                firstSegmentStartOffset
            );
            return !completingPathProperty && candidates.length === 0 ? undefined : candidates;
        }
        const firstPathStartOffset = (pathValues as ReferenceInfo['reference'][])
            .find(reference => reference.$refNode !== undefined)?.$refNode?.offset ??
            (trailingTerminalSegment ? terminalReference.$refNode?.offset : undefined);
        const pathStartOffset = firstPathStartOffset !== undefined && offset !== undefined &&
            firstPathStartOffset > offset ? undefined : firstPathStartOffset;
        const allowedTargets = new Set(
            allowedDescriptions
                .map(description => this.callbacks.getDescriptionNode(description))
                .filter((node): node is AstNode => node !== undefined)
        );
        return this.getPathSegmentCompletions(
            context,
            referenceType,
            prefix,
            allowedTargets,
            completingPathProperty && pathProperty === 'path' && !isReadSourceReference(container),
            pathStartOffset
        );
    }

    /**
     * A partially typed first segment cannot be repaired by replacing only the
     * current token when the segment is followed by a dot later. The whole path
     * is emitted as a completion label so accepting it always produces a valid
     * reference. Full qualified paths sort before standalone names so the
     * unambiguous choice is the first one the editor offers.
     */
    private getFirstPathSegmentCandidates(
        context: ReferenceInfo,
        allowedDescriptions: AstNodeDescription[],
        typed: string,
        replaceStart: number | undefined,
        allowContainerChain = true
    ): AstNodeDescription[] {
        const sourceContext = getOwningContextName(context.container);
        if (sourceContext === undefined &&
            !isJourneyStep(context.container) && !isMethodInvocation(context.container)) {
            return [];
        }
        const results = new Map<string, AstNodeDescription>();
        const groups = new Map<AstNode, AstNodeDescription[]>();
        for (const description of allowedDescriptions) {
            const target = this.callbacks.getDescriptionNode(description);
            if (!target) {
                continue;
            }
            const group = groups.get(target) ?? [];
            group.push(description);
            groups.set(target, group);
        }
        const standaloneCounts = new Map<string, number>();
        for (const descriptions of groups.values()) {
            const standalone = descriptions.map(description => description.name)
                .find(name => !name.includes('.'));
            if (standalone !== undefined) {
                standaloneCounts.set(standalone, (standaloneCounts.get(standalone) ?? 0) + 1);
            }
        }
        for (const [target, descriptions] of groups) {
            const names = descriptions.map(description => description.name);
            const crossContext = getOwningContextName(target) !== sourceContext;
            if (crossContext) {
                // Cross-context paths need their context or shared-kernel root.
                // Inner module and aggregate segments are offered after that.
                const contextPart = AstUtils.getContainerOfType(target, isBoundedContextPart);
                const boundedContext = contextPart?.context?.ref;
                if (isBoundedContext(boundedContext)) {
                    this.addFirstPathSegment(results, context, boundedContext, boundedContext.name, replaceStart);
                } else {
                    const sharedKernel = AstUtils.getContainerOfType(target, isSharedKernel);
                    if (sharedKernel) {
                        this.addFirstPathSegment(results, context, sharedKernel, sharedKernel.name, replaceStart);
                    }
                }
            }
            let qualifiedName: string | undefined;
            if (typed.length > 0) {
                const dottedNames = names
                    .filter(name => name.includes('.'))
                    .sort((left, right) =>
                        left.split('.').length - right.split('.').length || left.length - right.length
                    );
                const standalone = names.find(name => !name.includes('.'));
                const allowChainForTarget = allowContainerChain || isMethod(target);
                const fullName = dottedNames.find(name =>
                    this.matchesTypedFirstSegment(name, undefined, typed, allowChainForTarget)
                ) ?? dottedNames[0];
                if (!this.matchesTypedFirstSegment(fullName, standalone, typed, allowChainForTarget)) {
                    continue;
                }
                const declarationDepth = typeof (target as { name?: unknown }).name === 'string'
                    ? getDeclarationPath(target as AstNode & { name: string }).length
                    : 1;
                // A declaration directly in the context has no qualified path;
                // its short name is the canonical path.
                qualifiedName = declarationDepth <= 1
                    ? standalone ?? fullName
                    : fullName ?? standalone;
                if (qualifiedName === undefined) {
                    continue;
                }
                const ambiguous = standalone !== undefined &&
                    (standaloneCounts.get(standalone) ?? 0) > 1;
                if (ambiguous) {
                    // The short name does not identify one declaration. Keep the
                    // short label but insert the qualified path that resolves.
                    this.addTerminalPathItem(
                        results,
                        target,
                        qualifiedName,
                        standalone,
                        qualifiedName,
                        '0',
                        replaceStart
                    );
                } else {
                    const exactStandalone = standalone !== undefined &&
                        standalone.toLowerCase() === typed.toLowerCase();
                    const showQualified = !exactStandalone && qualifiedName !== standalone;
                    if (showQualified) {
                        this.addTerminalPathItem(
                            results,
                            target,
                            qualifiedName,
                            qualifiedName,
                            qualifiedName,
                            '0',
                            replaceStart
                        );
                    }
                    if (standalone !== undefined) {
                        this.addTerminalPathItem(
                            results,
                            target,
                            standalone,
                            standalone,
                            qualifiedName,
                            showQualified ? '1' : '0',
                            replaceStart
                        );
                    }
                }
            }
            if (crossContext || descriptions.some(description =>
                (description as AstNodeDescription & { thinaiNoContainers?: boolean }).thinaiNoContainers
            )) {
                continue;
            }
            let current = target.$container;
            while (current) {
                if (this.isPathContainer(current)) {
                    const name = (current as AstNode & { name?: unknown }).name;
                    if (typeof name === 'string' && name.length > 0) {
                        this.addFirstPathSegment(results, context, current, name, replaceStart, qualifiedName);
                    }
                }
                current = current.$container;
            }
        }
        return [...results.values()];
    }

    private matchesTypedFirstSegment(
        fullName: string | undefined,
        standalone: string | undefined,
        typed: string,
        allowContainerChain = true
    ): boolean {
        if (typed.length === 0) {
            return true;
        }
        const parts = fullName?.split('.') ?? [];
        if (parts.slice(0, -1).some(part => this.pathSegmentMatchesTyped(part, typed))) {
            return true;
        }
        if (allowContainerChain && this.matchesContainerChain(parts.slice(0, -1), typed)) {
            return true;
        }
        if (standalone !== undefined && this.pathSegmentMatchesTyped(standalone, typed)) {
            return true;
        }
        return this.matchesConcatenatedFirstSegment(parts, typed);
    }

    /**
     * A dotless token can abbreviate a run of container segments without the
     * terminal being typed, for example `InvAggInve` before an invokes target.
     */
    private matchesContainerChain(containers: string[], typed: string): boolean {
        if (containers.length < 2) {
            return false;
        }
        for (let start = 0; start < containers.length - 1; start++) {
            if (this.matchesSegmentChain(containers.slice(start), typed)) {
                return true;
            }
        }
        return false;
    }

    private matchesSegmentChain(segments: string[], typed: string): boolean {
        if (segments.length === 0 || typed.length === 0) {
            return false;
        }
        const memo = new Map<string, boolean>();
        const match = (segmentIndex: number, typedIndex: number): boolean => {
            if (segmentIndex === segments.length) {
                return typedIndex === typed.length;
            }
            const key = `${segmentIndex}:${typedIndex}`;
            const cached = memo.get(key);
            if (cached !== undefined) {
                return cached;
            }
            const segment = segments[segmentIndex]!;
            const remainingSegments = segments.length - segmentIndex - 1;
            let matched = false;
            for (let end = typedIndex + 2; end <= typed.length; end++) {
                if (typed.length - end < remainingSegments * 2) {
                    continue;
                }
                const fragment = typed.slice(typedIndex, end);
                if (this.pathFragmentMatches(fragment, segment) && match(segmentIndex + 1, end)) {
                    matched = true;
                    break;
                }
            }
            memo.set(key, matched);
            return matched;
        };
        return match(0, 0);
    }

    /**
     * A dotless token can abbreviate both the container and the terminal, for
     * example `InvenAggreInveIte`. Every part must match consecutive segments;
     * boundaries are searched rather than assumed to be camel-case.
     */
    private matchesConcatenatedFirstSegment(parts: string[], typed: string): boolean {
        return parts.length >= 2 && this.matchesSegmentChain(parts, typed);
    }

    private pathFragmentMatches(fragment: string, segment: string): boolean {
        return segment.toLowerCase().startsWith(fragment.toLowerCase()) ||
            this.fuzzyMatcher.match(fragment, segment);
    }

    private isAllowedCompletionPath(
        actualPath: string,
        terminal: boolean,
        allowedPaths: ReadonlySet<string>
    ): boolean {
        if (allowedPaths.has(actualPath)) {
            return true;
        }
        if (terminal) {
            return false;
        }
        const prefix = `${actualPath}.`;
        return [...allowedPaths].some(path => path.startsWith(prefix));
    }

    private pathSegmentMatchesTyped(segment: string, typed: string): boolean {
        return segment.toLowerCase().startsWith(typed.toLowerCase()) ||
            this.fuzzyMatcher.match(typed, segment);
    }

    private addTerminalPathItem(
        results: Map<string, AstNodeDescription>,
        target: AstNode,
        name: string,
        label: string,
        filterText: string,
        sortText: string,
        replaceStart: number | undefined
    ): void {
        const description = this.descriptions.createDescription(target, name, AstUtils.getDocument(target));
        const metadata = description as AstNodeDescription & {
            thinaiNoDedupe?: boolean;
            thinaiCompletionLabel?: string;
            thinaiFilterText?: string;
            thinaiSortText?: string;
            thinaiPathReplacement?: string;
            thinaiPathReplaceStart?: number;
        };
        metadata.thinaiNoDedupe = true;
        metadata.thinaiCompletionLabel = label;
        metadata.thinaiFilterText = filterText;
        metadata.thinaiSortText = sortText;
        this.addPathReplacement(metadata, name, replaceStart);
        results.set(`${description.documentUri.toString()}#${description.path}#${sortText}`, description);
    }

    private addFirstPathSegment(
        results: Map<string, AstNodeDescription>,
        context: ReferenceInfo,
        target: AstNode,
        fallbackName: string,
        replaceStart: number | undefined,
        filterText?: string
    ): void {
        const name = this.getImportedRootName(context, target, fallbackName);
        const document = AstUtils.getDocument(target);
        const description = this.descriptions.createDescription(target, name, document);
        const metadata = description as AstNodeDescription & {
            thinaiPathContinuation?: boolean;
            thinaiNoDedupe?: boolean;
            thinaiSortText?: string;
            thinaiFilterText?: string;
            thinaiPathReplacement?: string;
            thinaiPathReplaceStart?: number;
        };
        metadata.thinaiPathContinuation = true;
        metadata.thinaiNoDedupe = true;
        metadata.thinaiSortText = '2';
        if (filterText !== undefined) {
            metadata.thinaiFilterText = filterText;
        }
        this.addPathReplacement(metadata, name, replaceStart);
        results.set(`${description.documentUri.toString()}#${description.path}`, description);
    }

    private addPathReplacement(
        metadata: {
            thinaiPathReplacement?: string;
            thinaiPathReplaceStart?: number;
        },
        name: string,
        replaceStart: number | undefined
    ): void {
        if (replaceStart === undefined) {
            return;
        }
        metadata.thinaiPathReplacement = name;
        metadata.thinaiPathReplaceStart = replaceStart;
    }

    private findPathSegmentRun(
        parts: string[],
        typed: string,
        searchFrom: number
    ): { index: number; count: number } | undefined {
        let best: { index: number; count: number } | undefined;
        for (let index = searchFrom; index < parts.length; index++) {
            const part = parts[index]!;
            if (part.toLowerCase().startsWith(typed.toLowerCase())) {
                return { index, count: 1 };
            }
            if (!best && this.fuzzyMatcher.match(typed, part)) {
                best = { index, count: 1 };
            }
            for (let count = 2; index + count <= parts.length; count++) {
                if (!this.matchesSegmentChain(parts.slice(index, index + count), typed)) {
                    continue;
                }
                if (!best || index < best.index) {
                    best = { index, count };
                }
                break;
            }
        }
        return best;
    }

    private matchPathPrefix(
        parts: string[],
        prefix: string[]
    ): { start: number; matched: string[]; nextIndex: number } | undefined {
        if (prefix.length === 0) {
            return { start: 0, matched: [], nextIndex: 0 };
        }
        let searchFrom = 0;
        let start = -1;
        const matched: string[] = [];
        for (const typed of prefix) {
            const found = this.findPathSegmentRun(parts, typed, searchFrom);
            if (!found) {
                return undefined;
            }
            if (start < 0) {
                start = found.index;
            }
            matched.push(parts.slice(found.index, found.index + found.count).join('.'));
            searchFrom = found.index + found.count;
        }
        return searchFrom < parts.length
            ? { start, matched, nextIndex: searchFrom }
            : undefined;
    }

    private getImportedRootName(context: ReferenceInfo, target: AstNode, fallbackName: string): string {
        const model = AstUtils.getDocument(context.container).parseResult.value;
        if (!isModel(model)) {
            return fallbackName;
        }
        const component = model.imports
            .flatMap(declaration => declaration.components)
            .find(candidate => candidate.component.ref === target);
        return component?.alias ?? fallbackName;
    }

    private isPathContainer(target: AstNode): boolean {
        return isModule(target) || isAggregate(target) || isEntity(target) || isValueObject(target) ||
            isApplicationService(target) || isQueryService(target) || isDomainService(target) ||
            isProjector(target) || isFactory(target) || isSharedKernel(target);
    }

    private getPathPropertyName(property: string, container: Record<string, unknown>): string | undefined {
        if (property.endsWith('Path') || property === 'path') {
            return property;
        }
        if (property === 'target' && Array.isArray(container.path)) {
            return 'path';
        }
        return `${property}Path`;
    }

    private hasForbiddenPathPrefix(
        container: AstNode,
        pathProperty: string,
        pathValues: unknown[]
    ): boolean {
        if (pathValues.length === 0) {
            return false;
        }
        switch (container.$type) {
            case 'BoundedContextPart':
            case 'ContextMapEndpoint':
                return pathProperty === 'contextPath';
            case 'SeparateWaysRelationship':
                return pathProperty === 'leftPath' || pathProperty === 'rightPath';
            case 'SharedKernelRelationship':
                return pathProperty === 'sharedKernelPath';
            case 'SubdomainReference':
            case 'BoundedContextReference':
                return pathProperty === 'path';
            default:
                return false;
        }
    }

    private hasTrailingDot(
        reference: ReferenceInfo['reference'],
        container: AstNode,
        offset: number | undefined
    ): boolean {
        const refNode = reference.$refNode;
        if (!refNode || reference.$refText.length === 0 || offset === undefined || offset <= refNode.end) {
            return false;
        }
        const text = AstUtils.getDocument(container).textDocument.getText();
        return /^[\t \r\n]*\.[\t \r\n]*$/u.test(text.slice(refNode.end, offset));
    }

    getSpecificationRootCompletionCandidates(context: ReferenceInfo): AstNodeDescription[] {
        if (!isSpecificationTextPart(context.container)) {
            return [];
        }
        const referenceType = this.getDeclaredReferenceType(context);
        if (!referenceType) {
            return [];
        }
        const scope = this.callbacks.getUnsegmentedScope(context, referenceType);
        const candidates = new Map<string, AstNodeDescription>();
        const seenSegments = new Map<AstNode, Set<string>>();
        const allowedDescriptions: AstNodeDescription[] = [];
        for (const description of scope.getAllElements()) {
            const target = this.callbacks.getDescriptionNode(description);
            if (!target) {
                continue;
            }
            const path = description.name.split('.');
            const segmentName = path[0]!;
            if (segmentName === 'result' && this.isBareResultCollision(context, target)) {
                continue;
            }
            const ancestorTarget = this.getPathSegmentTarget(target, path, 0, context);
            // Synthetic contract roots such as `result` are attached to the
            // operation node, so they are not ancestors of their own path
            // segments. Resolve the root through the scope in that case.
            const directRootTarget = description.name === segmentName
                ? target
                : scope.getElement(segmentName)?.node;
            const segmentTarget = ancestorTarget ?? directRootTarget;
            if (!segmentTarget) {
                continue;
            }
            if (isSpecificationTextPart(context.container) && isModule(segmentTarget) &&
                !this.callbacks.isSupportedSpecificationModulePrefix(context, segmentTarget, target)) {
                continue;
            }
            allowedDescriptions.push(description);
            const names = seenSegments.get(segmentTarget) ?? new Set<string>();
            if (names.has(segmentName)) {
                continue;
            }
            names.add(segmentName);
            seenSegments.set(segmentTarget, names);
            const segmentDescription = this.descriptions.createDescription(
                segmentTarget,
                segmentName,
                AstUtils.getDocument(segmentTarget)
            );
            if (this.hasNavigableShapeMembers(segmentTarget)) {
                (segmentDescription as AstNodeDescription & { thinaiPathContinuation?: boolean })
                    .thinaiPathContinuation = true;
            }
            candidates.set(`${segmentDescription.documentUri.toString()}#${segmentDescription.path}#${segmentName}`, segmentDescription);
        }
        const part = context.container as AstNode & { target?: ReferenceInfo['reference'] };
        const typed = part.target?.$refText ?? '';
        const rootMatchesTyped = [...candidates.values()]
            .some(description => this.pathSegmentMatchesTyped(description.name, typed));
            if (typed.length > 0 && !rootMatchesTyped) {
                const pathCandidates = this.getFirstPathSegmentCandidates(
                    context,
                    this.expandSpecificationShapeDescriptions(context, allowedDescriptions, scope),
                    typed,
                    part.target?.$refNode?.offset,
                    false
                );
                if (pathCandidates.length > 0) {
                    return pathCandidates;
                }
            }
        return [...candidates.values()];
    }

    /**
     * Nested shape members are not part of the normal scope. Add their full
     * paths so a dotless chain such as `DomOrPlalinsk` can resolve to
     * `Domain.OrderPlaced.lines.sku`.
     */
    private expandSpecificationShapeDescriptions(
        context: ReferenceInfo,
        descriptions: AstNodeDescription[],
        scope: Scope
    ): AstNodeDescription[] {
        const results = new Map<string, AstNodeDescription>();
        const queue: AstNodeDescription[] = [];
        const add = (description: AstNodeDescription): void => {
            const key = `${description.documentUri.toString()}#${description.path}#${description.name}`;
            if (results.has(key)) {
                return;
            }
            results.set(key, description);
            queue.push(description);
        };
        for (const description of descriptions) {
            add(description);
        }
        while (queue.length > 0) {
            const description = queue.shift()!;
            const target = this.callbacks.getDescriptionNode(description);
            if (!target || !this.hasNavigableShapeMembers(target)) {
                continue;
            }
            const prefix = description.name.split('.');
            for (const member of this.getSpecificationShapeMembers(context, prefix, scope)) {
                const name = this.nameProvider.getName(member);
                if (!name) {
                    continue;
                }
                const memberDescription = this.descriptions.createDescription(
                    member,
                    [...prefix, name].join('.'),
                    AstUtils.getDocument(member)
                );
                (memberDescription as AstNodeDescription & { thinaiNoContainers?: boolean })
                    .thinaiNoContainers = true;
                add(memberDescription);
            }
        }
        return [...results.values()];
    }

    private isBareResultCollision(context: ReferenceInfo, target: AstNode): boolean {
        if ((!isField(target) && !isMethod(target) && !isParameter(target)) || target.name !== 'result') {
            return false;
        }
        const operation = AstUtils.getContainerOfType(context.container, isMethod);
        return isMethod(operation) && (operation.returnPrimitive !== undefined ||
            operation.returnType !== undefined || operation.returnCollection !== undefined);
    }

    getInvocationCompletionCandidates(context: ReferenceInfo, offset?: number): AstNodeDescription[] {
        const container = context.container;
        if (!isJourneyStep(container) && !isMethodInvocation(container)) {
            return [];
        }
        const typed = this.getTypedInvocationPath(context, offset);
        const scope = this.callbacks.getUnsegmentedScope(context, 'NamedDeclaration');
        const allowedDescriptions: AstNodeDescription[] = [];
        const allowedTargets = new Set<AstNode>();
        for (const description of scope.getAllElements()) {
            const target = this.callbacks.getDescriptionNode(description);
            if (isMethod(target) && (isJourneyStep(container)
                ? this.callbacks.isJourneyStepTarget(target) && this.callbacks.isSupportedCandidate(context, target)
                : this.callbacks.isSupportedInvocationTarget(container, target) &&
                    this.callbacks.isSupportedCandidate(context, target))) {
                allowedDescriptions.push(description);
                allowedTargets.add(target);
            }
        }
        const firstReference = container.path[0] ?? container.target;
        const pathStart = firstReference?.$refNode?.offset;
        const replaceStart = pathStart !== undefined && offset !== undefined && pathStart <= offset
            ? pathStart
            : undefined;

        let completions: AstNodeDescription[];
        const allowedPaths = new Set(allowedDescriptions.map(description => description.name));
        if (typed.prefix.length === 0 && !typed.trailingDot) {
            if (typed.token.length > 0) {
                // A dotless token can be the first path segment or a command name.
                completions = this.getFirstPathSegmentCandidates(
                    context,
                    allowedDescriptions,
                    typed.token,
                    replaceStart
                );
            } else {
                completions = this.markInvocationContinuations(this.getPathSegmentCompletions(
                    context,
                    'NamedDeclaration',
                    [],
                    undefined,
                    false,
                    undefined,
                    allowedPaths
                ));
            }
        } else {
            completions = this.markInvocationContinuations(this.getPathSegmentCompletions(
                context,
                'NamedDeclaration',
                typed.prefix,
                undefined,
                false,
                replaceStart,
                allowedPaths
            ))
                .filter(description => !isMethod(description.node) || allowedTargets.has(description.node));
        }
        if (isJourneyStep(container) && typed.prefix.length === 0) {
            // A journey step must name at least a service or context segment;
            // bare command names are not valid journey syntax.
            return completions.filter(description => {
                if (!isMethod(description.node)) {
                    return true;
                }
                const label = (description as AstNodeDescription & { thinaiCompletionLabel?: string })
                    .thinaiCompletionLabel ?? description.name;
                return label.includes('.');
            });
        }
        return completions;
    }

    private markInvocationContinuations(descriptions: AstNodeDescription[]): AstNodeDescription[] {
        return descriptions.map(description => {
            if (!isMethod(description.node)) {
                (description as AstNodeDescription & { thinaiPathContinuation?: boolean })
                    .thinaiPathContinuation = true;
            }
            return description;
        });
    }

    /**
     * Reads the invocation path directly from the document. The parser treats
     * the segment before a trailing dot as the terminal `target`, so the AST
     * alone cannot distinguish a completed target from a path segment that is
     * still being typed.
     */
    private getTypedInvocationPath(
        context: ReferenceInfo,
        offset?: number
    ): { prefix: string[]; token: string; trailingDot: boolean } {
        const container = context.container;
        const cstNode = container.$cstNode;
        if (!cstNode) {
            return { prefix: [], token: '', trailingDot: false };
        }
        const document = AstUtils.getDocument(container);
        const end = offset ?? cstNode.end;
        const statement = document.textDocument.getText().slice(cstNode.offset, end);
        const withoutKeyword = statement.replace(/^\s*invokes?\b/u, '').trimEnd();
        if (withoutKeyword.length === 0) {
            return { prefix: [], token: '', trailingDot: false };
        }
        const segments = withoutKeyword.split('.').map(segment => unquoteIdentifier(segment.trim()));
        const trailingDot = withoutKeyword.endsWith('.');
        const prefix = (trailingDot ? segments : segments.slice(0, -1))
            .filter(segment => segment.length > 0);
        const token = trailingDot ? '' : segments.at(-1) ?? '';
        return { prefix, token, trailingDot };
    }

    private getDeclaredReferenceType(context: ReferenceInfo): string | undefined {
        return this.reflection
            .getTypeMetaData(context.container.$type)
            .properties[context.property]?.referenceType;
    }

    private getPathScopeContext(context: ReferenceInfo): ReferenceInfo {
        if ((context.property === 'path' || context.property === 'target') && context.container.$containerProperty) {
            return { ...context, property: context.container.$containerProperty };
        }
        return context;
    }

    private getQualifiedPathScope(context: ReferenceInfo): Scope | undefined {
        const wrapperPath = context.property === 'path' || context.property === 'target';
        const prefixProperty = wrapperPath
            ? 'path'
            : context.property.endsWith('Path')
                ? context.property
                : `${context.property}Path`;
        const container = context.container as unknown as Record<string, unknown>;
        const prefixReferences = container[prefixProperty];
        if (!Array.isArray(prefixReferences) || prefixReferences.length === 0) {
            return undefined;
        }
        const terminalProperty = wrapperPath ? 'target' : prefixProperty.slice(0, -'Path'.length);
        const terminalReference = container[terminalProperty];
        if (!terminalReference || typeof terminalReference !== 'object' || Array.isArray(terminalReference) || !('$refText' in terminalReference)) {
            return undefined;
        }
        const pathReferences = [...prefixReferences, terminalReference] as ReferenceInfo['reference'][];
        if (!pathReferences.every(reference => reference && typeof reference === 'object' && '$refText' in reference)) {
            return undefined;
        }
        const path = pathReferences.map(reference => reference.$refText);
        const finalContext: ReferenceInfo = {
            ...context,
            property: terminalProperty,
            reference: terminalReference as ReferenceInfo['reference'],
            index: undefined
        };
        const scopeContext = wrapperPath ? this.getPathScopeContext(finalContext) : finalContext;
        const segmentIndex = context.property === prefixProperty
            ? context.index ?? Math.max(0, path.length - 1)
            : path.length - 1;
        const completePath = path.join('.');
        const finalType = this.getDeclaredReferenceType(finalContext);
        if (!finalType) {
            return this.callbacks.createScope([]);
        }
        const finalDescription = this.callbacks.getUnsegmentedScope(
            scopeContext,
            finalType
        ).getElement(completePath);
        if (!finalDescription?.node) {
            // The qualified path is not fully valid yet. Resolve the current
            // segment against its valid prefix so fixing a later segment does
            // not also invalidate an earlier one.
            if (context.property === prefixProperty) {
                const prefixType = this.getDeclaredReferenceType(context);
                const prefixPath = path.slice(0, segmentIndex + 1).join('.');
                const prefixDescription = prefixType
                    ? this.callbacks.getUnsegmentedScope(this.getPathScopeContext(context), prefixType)
                        .getElement(prefixPath)
                    : undefined;
                if (prefixDescription?.node) {
                    const name = context.reference.$refText || prefixDescription.name;
                    return this.callbacks.createScope([
                        this.descriptions.createDescription(
                            prefixDescription.node,
                            name,
                            AstUtils.getDocument(prefixDescription.node)
                        )
                    ]);
                }
            }
            return this.callbacks.createScope([]);
        }
        const targetDescription = segmentIndex === path.length - 1
            ? finalDescription
            : this.callbacks.getUnsegmentedScope(scopeContext, 'NamedDeclaration')
                .getElement(path.slice(0, segmentIndex + 1).join('.'));
        const target = targetDescription?.node ?? this.getPathSegmentTarget(finalDescription.node, path, segmentIndex, context);
        const targetName = target ? this.nameProvider.getName(target) : undefined;
        if (!target || !targetName) {
            return this.callbacks.createScope([]);
        }
        const requestedName = context.reference.$refText;
        return this.callbacks.createScope([
            this.descriptions.createDescription(
                target,
                requestedName.length > 0 ? requestedName : targetName,
                AstUtils.getDocument(target)
            )
        ]);
    }

    private getSpecificationPathSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        if (!isSpecificationTextPart(context.container)) {
            return [];
        }
        const part = context.container;
        const index = context.index ?? (context.reference.$refText.length === 0 ? part.targets.length : 0);
        const reference = context.reference;
        if (!part.target) {
            return [];
        }
        const firstPathStartOffset = part.target.$refNode?.offset;
        if (reference.$refText.length === 0) {
            const prefix = [part.target, ...part.targets.slice(0, index)].map(candidate => candidate.$refText);
            return this.getPathSegmentCompletions(context, referenceType, prefix, undefined, false, firstPathStartOffset);
        }
        if (index >= part.targets.length) {
            const prefix = [part.target, ...part.targets].map(candidate => candidate.$refText);
            return this.getPathSegmentCompletions(context, referenceType, prefix, undefined, false, firstPathStartOffset);
        }
        const fullPath = [part.target, ...part.targets.slice(0, index + 1)]
            .map(candidate => candidate.$refText).join('.');
        const description = this.callbacks.getUnsegmentedScope(context, referenceType).getElement(fullPath);
        if (description) {
            return [{ ...description, name: reference.$refText }];
        }
        const prefix = [part.target, ...part.targets.slice(0, index)]
            .map(candidate => candidate.$refText);
        return this.getPathSegmentCompletions(context, referenceType, prefix, undefined, false, firstPathStartOffset);
    }

    private getSpecificationRootPathSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        if (!isSpecificationTextPart(context.container)) {
            return [];
        }
        const part = context.container;
        if (!part.target) {
            return this.callbacks.getUnsegmentedScope(context, referenceType).getAllElements().toArray();
        }
        const path = [part.target, ...part.targets].map(reference => reference.$refText);
        if (path.length < 2 || path.some(segment => segment.length === 0)) {
            return this.callbacks.getUnsegmentedScope(context, referenceType).getAllElements().toArray();
        }
        const scope = this.callbacks.getUnsegmentedScope(context, referenceType);
        const description = scope.getElement(path.join('.'));
        let target = description?.node ? this.getPathSegmentTarget(description.node, path, 0, context) : undefined;
        if (!target) {
            const matchingRoots = new Set<AstNode>();
            for (const candidate of scope.getAllElements()) {
                const candidateTarget = this.callbacks.getDescriptionNode(candidate);
                if (!candidateTarget) {
                    continue;
                }
                const candidatePath = candidate.name.split('.');
                if (candidatePath.length < path.length || path.some((segment, index) =>
                    index === path.length - 1
                        ? !candidatePath[index]!.toLowerCase().startsWith(segment.toLowerCase())
                        : candidatePath[index] !== segment
                )) {
                    continue;
                }
                const root = this.getPathSegmentTarget(candidateTarget, candidatePath, 0, context);
                if (root) {
                    matchingRoots.add(root);
                }
            }
            if (matchingRoots.size === 1) {
                target = matchingRoots.values().next().value;
            }
        }
        if (!target) {
            return scope.getAllElements().toArray();
        }
        return [this.descriptions.createDescription(target, path[0]!, AstUtils.getDocument(target))];
    }

    private getPathSegmentCompletions(
        context: ReferenceInfo,
        referenceType: string,
        prefix: string[],
        allowedTargets?: Set<AstNode>,
        pathOnly = false,
        firstPathStartOffset?: number,
        allowedPaths?: ReadonlySet<string>
    ): AstNodeDescription[] {
        const results = new Map<string, AstNodeDescription>();
        const scope = this.callbacks.getUnsegmentedScope(this.getPathScopeContext(context), referenceType);
        for (const description of scope.getAllElements()) {
            const candidate = this.callbacks.getDescriptionNode(description);
            const parts = description.name.split('.');
            const match = this.matchPathPrefix(parts, prefix);
            if (!candidate || (allowedTargets && !allowedTargets.has(candidate)) || !match) {
                continue;
            }
            const segmentIsTerminal = parts.length === match.nextIndex + 1;
            if (pathOnly && segmentIsTerminal) {
                continue;
            }
            const actualPath = parts.slice(0, match.nextIndex + 1).join('.');
            if (allowedPaths && !this.isAllowedCompletionPath(actualPath, segmentIsTerminal, allowedPaths)) {
                continue;
            }
            const partialPrefix = match.matched.some((part, index) => part !== prefix[index]);
            const segment = parts[match.nextIndex];
            const actualSegmentName = parts.slice(match.start, match.nextIndex + 1).join('.');
            const targets = new Set<AstNode>();
            const directTarget = scope.getElement(parts.slice(0, match.nextIndex + 1).join('.'))?.node;
            const ancestorTarget = this.getPathSegmentTarget(candidate, parts, match.nextIndex, context);
            if (directTarget) {
                targets.add(directTarget);
            }
            if (ancestorTarget) {
                targets.add(ancestorTarget);
            }
            for (const target of targets) {
                if (isSpecificationTextPart(context.container)) {
                    if (isModule(target)) {
                        if (!this.callbacks.isSupportedSpecificationModulePrefix(context, target, candidate)) {
                            continue;
                        }
                    } else if (!segmentIsTerminal &&
                        !this.callbacks.isSupportedSpecificationPathSegment(context, target, segmentIsTerminal)) {
                        continue;
                    }
                }
                const segmentDescription = this.descriptions.createDescription(target, segment, AstUtils.getDocument(target));
                if (!segmentIsTerminal) {
                    (segmentDescription as AstNodeDescription & { thinaiPathContinuation?: boolean })
                        .thinaiPathContinuation = true;
                }
                if (partialPrefix && firstPathStartOffset !== undefined) {
                    const replacement = segmentDescription as AstNodeDescription & {
                        thinaiNoDedupe?: boolean;
                        thinaiPathReplacement?: string;
                        thinaiPathReplaceStart?: number;
                        thinaiCompletionLabel?: string;
                        thinaiFilterText?: string;
                        thinaiSortText?: string;
                    };
                    // After a dot the user has committed to a qualified path, so
                    // show the full path instead of a bare terminal name.
                    replacement.thinaiNoDedupe = true;
                    replacement.thinaiPathReplacement = actualSegmentName;
                    replacement.thinaiPathReplaceStart = firstPathStartOffset;
                    replacement.thinaiCompletionLabel = actualSegmentName;
                    replacement.thinaiFilterText = actualSegmentName;
                    replacement.thinaiSortText = '0';
                }
                results.set(`${segmentDescription.documentUri.toString()}#${segmentDescription.path}`, segmentDescription);
            }
        }
        if (isSpecificationTextPart(context.container)) {
            for (const target of this.getSpecificationShapeMembers(context, prefix, scope)) {
                const name = this.nameProvider.getName(target);
                if (!name) {
                    continue;
                }
                const description = this.descriptions.createDescription(target, name, AstUtils.getDocument(target));
                if (this.hasNavigableShapeMembers(target)) {
                    (description as AstNodeDescription & { thinaiPathContinuation?: boolean })
                        .thinaiPathContinuation = true;
                }
                results.set(`${description.documentUri.toString()}#${description.path}`, description);
            }
        }
        return [...results.values()];
    }

    /**
     * True when completing a field should continue into a nested shape.
     * Parameter roots and type containers stay terminal-friendly because they
     * are also valid standalone links.
     */
    private hasNavigableShapeMembers(target: AstNode): boolean {
        if (!isField(target) && !isParameter(target) && !isMethod(target)) {
            return false;
        }
        return this.getShapeTypes(target).some(type => {
            if (isEnumType(type)) {
                return type.values.length > 0;
            }
            return isFieldShape(type) && type.fields.length > 0;
        });
    }

    /**
     * Resolves the field shape at the end of a prefix. A specification path can
     * continue through a field's declared type (and collection element/value
     * types), which is not represented by AST containment and therefore cannot
     * be resolved by getPathSegmentTarget alone.
     */
    private getSpecificationShapeMembers(
        context: ReferenceInfo,
        prefix: string[],
        scope: Scope
    ): AstNode[] {
        const target = this.resolveSpecificationShapePrefix(context, prefix, scope);
        if (!target) {
            return [];
        }
        if (!this.callbacks.isSupportedSpecificationPathSegment(context, target, false)) {
            return [];
        }
        const members = new Set<AstNode>();
        for (const type of this.getShapeTypes(target)) {
            if (isEnumType(type)) {
                for (const value of type.values) {
                    members.add(value);
                }
                continue;
            }
            if (isFieldShape(type)) {
                for (const field of type.fields) {
                    members.add(field);
                }
            }
        }
        return [...members];
    }

    private resolveSpecificationShapePrefix(
        context: ReferenceInfo,
        prefix: string[],
        scope: Scope
    ): AstNode | undefined {
        if (prefix.length === 0) {
            return undefined;
        }
        const direct = scope.getElement(prefix.join('.'))?.node;
        if (direct) {
            return direct;
        }
        const parent = this.resolveSpecificationShapePrefix(context, prefix.slice(0, -1), scope);
        if (!parent) {
            return undefined;
        }
        const segment = prefix[prefix.length - 1]!;
        return this.getShapeMemberTargets(parent, segment)[0];
    }

    private getShapeMemberTargets(target: AstNode, name: string): AstNode[] {
        const matches: AstNode[] = [];
        for (const type of this.getShapeTypes(target)) {
            if (isEnumType(type)) {
                matches.push(...type.values.filter(value => value.name === name));
                continue;
            }
            if (isFieldShape(type)) {
                matches.push(...type.fields.filter(field => field.name === name));
            }
        }
        return matches;
    }

    private getShapeTypes(target: AstNode): AstNode[] {
        const references = isField(target)
            ? getNavigableTypeReferences(target.type, target.collection)
            : isParameter(target)
                ? getNavigableTypeReferences(target.type as Reference<TypeDeclaration> | undefined, target.collection)
                : isMethod(target)
                    ? getNavigableTypeReferences(target.returnType, target.returnCollection)
                    : [];
        if (references.length > 0) {
            return references
                .map(reference => reference.ref as AstNode | undefined)
                .filter((node): node is AstNode => node !== undefined);
        }
        return [target];
    }

    private getPathSegmentTarget(target: AstNode, path: string[], segmentIndex: number, context: ReferenceInfo): AstNode | undefined {
        const ancestors: AstNode[] = [];
        let current: AstNode | undefined = target;
        while (current) {
            const contextReference = isBoundedContextPart(current) ? current.context?.ref : undefined;
            if (contextReference) {
                ancestors.push(contextReference);
            } else if (this.nameProvider.getName(current)) {
                ancestors.push(current);
            }
            current = current.$container;
        }
        let nextAncestor = 0;
        let selected: AstNode | undefined;
        for (let index = path.length - 1; index >= 0; index--) {
            const found = ancestors.findIndex((candidate, ancestorIndex) =>
                ancestorIndex >= nextAncestor && (
                    this.nameProvider.getName(candidate) === path[index] ||
                    this.isImportedComponentAlias(candidate, path[index], context)
                )
            );
            if (found < 0) {
                return undefined;
            }
            if (index === segmentIndex) {
                selected = ancestors[found];
            }
            nextAncestor = found + 1;
        }
        return selected;
    }

    private isImportedComponentAlias(node: AstNode, alias: string, context: ReferenceInfo): boolean {
        if (!isImportableComponent(node)) {
            return false;
        }
        const root = AstUtils.getDocument(context.container).parseResult.value;
        if (!isModel(root)) {
            return false;
        }
        return root.imports.some(importDeclaration => importDeclaration.components.some(component =>
            component.alias === alias && component.component.ref === node
        ));
    }
}
