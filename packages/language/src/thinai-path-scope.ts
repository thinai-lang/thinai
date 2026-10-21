import {
    AstUtils,
    DefaultScopeProvider,
    type AstNode,
    type AstNodeDescription,
    type LangiumCoreServices,
    type ReferenceInfo,
    type Scope,
    type Stream
} from 'langium';
import {
    isBoundedContextPart,
    isImportableComponent,
    isJourneyStep,
    isMethod,
    isMethodInvocation,
    isModel,
    isReadSourceReference,
    isSpecificationTextPart,
    type Method
} from './generated/ast.js';

interface ThinaiPathScopeCallbacks {
    createScope(elements: Iterable<AstNodeDescription>): Scope;
    getUnsegmentedScope(context: ReferenceInfo, referenceType: string): Scope;
    filterCompletionCandidates(context: ReferenceInfo, candidates: Iterable<AstNodeDescription>): Stream<AstNodeDescription>;
    getDescriptionNode(description: AstNodeDescription): AstNode | undefined;
    isSupportedInvocationTarget(container: AstNode, target: Method): boolean;
    isSupportedCandidate(context: ReferenceInfo, target: AstNode): boolean;
    isJourneyCommand(method: Method): boolean;
}

/** Owns qualified-reference lookup and path-segment completion for Thinai references. */
export class ThinaiPathScope extends DefaultScopeProvider {
    constructor(
        services: LangiumCoreServices,
        private readonly callbacks: ThinaiPathScopeCallbacks
    ) {
        super(services);
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
        if (context.property === 'targets' &&
            (isJourneyStep(context.container) || isMethodInvocation(context.container))) {
            return this.callbacks.createScope(this.getInvocationPathSymbols(context, referenceType));
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
        if (pathValues.length === 0 && !trailingTerminalSegment) {
            // A path property with no parsed path means the user has not begun
            // a qualified path yet; suppress its generic completion so path
            // containers are not offered as a first token. A terminal property
            // still falls through to normal reference completion.
            return completingPathProperty ? [] : undefined;
        }
        const completedPathCount = offset === undefined
            ? context.index ?? pathValues.length
            : (pathValues as ReferenceInfo['reference'][]).filter(reference =>
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
        const allowedTargets = new Set(
            this.callbacks.filterCompletionCandidates(finalContext, finalScope.getAllElements())
                .map(description => this.callbacks.getDescriptionNode(description))
                .filter((node): node is AstNode => node !== undefined)
                .toArray()
        );
        const referenceType = this.getDeclaredReferenceType(context);
        if (!referenceType) {
            return [];
        }
        return this.getPathSegmentCompletions(
            context,
            referenceType,
            prefix,
            allowedTargets,
            completingPathProperty && pathProperty === 'path' && !isReadSourceReference(container)
        );
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
        for (const description of scope.getAllElements()) {
            const target = this.callbacks.getDescriptionNode(description);
            if (!target) {
                continue;
            }
            const path = description.name.split('.');
            for (let index = 0; index < path.length; index++) {
                const segmentName = path[index]!;
                const ancestorTarget = this.getPathSegmentTarget(target, path, index, context);
                // Synthetic contract roots such as `result` are attached to the
                // operation node, so they are not ancestors of their own path
                // segments. Resolve the root through the scope in that case.
                const directRootTarget = index === 0
                    ? description.name === segmentName
                        ? target
                        : scope.getElement(segmentName)?.node
                    : undefined;
                const segmentTarget = ancestorTarget ?? directRootTarget;
                if (!segmentTarget) {
                    continue;
                }
                const segmentDescription = this.descriptions.createDescription(
                    segmentTarget,
                    segmentName,
                    AstUtils.getDocument(segmentTarget)
                );
                candidates.set(`${segmentDescription.documentUri.toString()}#${segmentDescription.path}#${segmentName}`, segmentDescription);
            }
        }
        return [...candidates.values()];
    }

    getInvocationCompletionCandidates(context: ReferenceInfo): AstNodeDescription[] {
        const referenceType = this.getDeclaredReferenceType(context);
        if (!referenceType) {
            return [];
        }
        const references = isJourneyStep(context.container) || isMethodInvocation(context.container)
            ? context.container.targets
            : [];
        const index = context.index ?? (context.reference.$refText.length === 0 ? references.length : 0);
        const path = references.map(reference => reference.$refText);
        const scope = this.callbacks.getUnsegmentedScope(context, referenceType);
        const allowedTargets = new Set<AstNode>();
        for (const description of scope.getAllElements()) {
            const target = this.callbacks.getDescriptionNode(description);
            if (isMethod(target) && (isJourneyStep(context.container)
                ? this.callbacks.isJourneyCommand(target) && this.callbacks.isSupportedCandidate(context, target)
                : this.callbacks.isSupportedInvocationTarget(context.container, target) &&
                    this.callbacks.isSupportedCandidate(context, target))) {
                allowedTargets.add(target);
            }
        }
        if (context.reference.$refText.length > 0 && index < references.length && path.length > 0) {
            const description = scope.getElement(path.join('.'));
            const target = description?.node ? this.getPathSegmentTarget(description.node, path, index, context) : undefined;
            if (target && allowedTargets.has(target)) {
                return [this.descriptions.createDescription(target, context.reference.$refText, AstUtils.getDocument(target))];
            }
        }
        return this.callbacks.filterCompletionCandidates(context, this.getPathSegmentCompletions(
            context,
            referenceType,
            references.slice(0, index).map(reference => reference.$refText),
            allowedTargets
        )).toArray();
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
        if (reference.$refText.length === 0) {
            const prefix = [part.target, ...part.targets.slice(0, index)].map(candidate => candidate.$refText);
            return this.getPathSegmentCompletions(context, referenceType, prefix);
        }
        if (index >= part.targets.length) {
            const prefix = [part.target, ...part.targets].map(candidate => candidate.$refText);
            return this.getPathSegmentCompletions(context, referenceType, prefix);
        }
        const fullPath = [part.target, ...part.targets.slice(0, index + 1)]
            .map(candidate => candidate.$refText).join('.');
        const description = this.callbacks.getUnsegmentedScope(context, referenceType).getElement(fullPath);
        if (description) {
            return [{ ...description, name: reference.$refText }];
        }
        const prefix = [part.target, ...part.targets.slice(0, index)]
            .map(candidate => candidate.$refText);
        return this.getPathSegmentCompletions(context, referenceType, prefix);
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

    private getInvocationPathSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        const references = isJourneyStep(context.container) || isMethodInvocation(context.container)
            ? context.container.targets
            : [];
        const index = context.index ?? (context.reference.$refText.length === 0 ? references.length : 0);
        const path = references.map(reference => reference.$refText);
        if (context.reference.$refText.length > 0 && index < references.length && path.length > 0) {
            const description = this.callbacks.getUnsegmentedScope(context, referenceType).getElement(path.join('.'));
            const target = description?.node ? this.getPathSegmentTarget(description.node, path, index, context) : undefined;
            if (target) {
                return [this.descriptions.createDescription(target, context.reference.$refText, AstUtils.getDocument(target))];
            }
        }
        return this.getPathSegmentCompletions(context, referenceType, references.slice(0, index).map(reference => reference.$refText));
    }

    private getPathSegmentCompletions(
        context: ReferenceInfo,
        referenceType: string,
        prefix: string[],
        allowedTargets?: Set<AstNode>,
        pathOnly = false
    ): AstNodeDescription[] {
        const prefixText = prefix.join('.');
        const pathPrefix = prefixText.length > 0 ? `${prefixText}.` : '';
        const results = new Map<string, AstNodeDescription>();
        const scope = this.callbacks.getUnsegmentedScope(this.getPathScopeContext(context), referenceType);
        for (const description of scope.getAllElements()) {
            const candidate = this.callbacks.getDescriptionNode(description);
            if (!candidate || (allowedTargets && !allowedTargets.has(candidate)) ||
                !description.name.startsWith(pathPrefix)) {
                continue;
            }
            const parts = description.name.split('.');
            if (pathOnly ? parts.length <= prefix.length + 1 : parts.length <= prefix.length) {
                continue;
            }
            const segment = parts[prefix.length];
            const segmentName = [...prefix, segment].join('.');
            const targets = new Set<AstNode>();
            const directTarget = scope.getElement(segmentName)?.node;
            const ancestorTarget = this.getPathSegmentTarget(candidate, parts, prefix.length, context);
            if (directTarget) {
                targets.add(directTarget);
            }
            if (ancestorTarget) {
                targets.add(ancestorTarget);
            }
            for (const target of targets) {
                const segmentDescription = this.descriptions.createDescription(target, segment, AstUtils.getDocument(target));
                results.set(`${segmentDescription.documentUri.toString()}#${segmentDescription.path}`, segmentDescription);
            }
        }
        return [...results.values()];
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
            component.alias?.$refText === alias && component.component.ref === node
        ));
    }
}
