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
import {
    isBoundedContextPart,
    isDataObject,
    isDomainEvent,
    isEntity,
    isEnumType,
    isField,
    isImportableComponent,
    isIntegrationEvent,
    isJourneyStep,
    isMethod,
    isMethodInvocation,
    isModel,
    isModule,
    isParameter,
    isReadModel,
    isReadSourceReference,
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
import { getTypeReferences } from './thinai-type-utils.js';
import { unquoteIdentifier } from './thinai-identifiers.js';

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
        const seenSegments = new Map<AstNode, Set<string>>();
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
            candidates.set(`${segmentDescription.documentUri.toString()}#${segmentDescription.path}#${segmentName}`, segmentDescription);
        }
        return [...candidates.values()];
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
        const prefix = this.getTypedInvocationPath(context, offset);
        const scope = this.callbacks.getUnsegmentedScope(context, 'NamedDeclaration');
        const allowedTargets = new Set<AstNode>();
        const allowedPaths: string[] = [];
        for (const description of scope.getAllElements()) {
            const target = this.callbacks.getDescriptionNode(description);
            if (isMethod(target) && (isJourneyStep(container)
                ? this.callbacks.isJourneyCommand(target) && this.callbacks.isSupportedCandidate(context, target)
                : this.callbacks.isSupportedInvocationTarget(container, target) &&
                    this.callbacks.isSupportedCandidate(context, target))) {
                allowedTargets.add(target);
                allowedPaths.push(description.name);
            }
        }
        const completions = this.getPathSegmentCompletions(context, 'NamedDeclaration', prefix)
            .filter(description => {
                if (isMethod(description.node)) {
                    return allowedTargets.has(description.node);
                }
                const segmentPath = [...prefix, description.name].join('.');
                return allowedPaths.some(path => path.startsWith(`${segmentPath}.`));
            });
        if (isJourneyStep(container) && prefix.length === 0) {
            // A journey step must name at least a service or context segment;
            // bare command names are not valid journey syntax.
            return completions.filter(description => !isMethod(description.node));
        }
        return completions;
    }

    /**
     * Reads the invocation path directly from the document. The parser treats
     * the segment before a trailing dot as the terminal `target`, so the AST
     * alone cannot distinguish a completed target from a path segment that is
     * still being typed.
     */
    private getTypedInvocationPath(context: ReferenceInfo, offset?: number): string[] {
        const container = context.container;
        const cstNode = container.$cstNode;
        if (!cstNode) {
            return [];
        }
        const document = AstUtils.getDocument(container);
        const end = offset ?? cstNode.end;
        const statement = document.textDocument.getText().slice(cstNode.offset, end);
        const withoutKeyword = statement.replace(/^\s*invokes?\b/u, '').trimEnd();
        if (withoutKeyword.length === 0) {
            return [];
        }
        const segments = withoutKeyword.split('.').map(segment => unquoteIdentifier(segment));
        if (!withoutKeyword.endsWith('.')) {
            segments.pop();
        }
        return segments.filter(segment => segment.length > 0);
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
                const segmentIsTerminal = parts.length === prefix.length + 1;
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
                results.set(`${description.documentUri.toString()}#${description.path}`, description);
            }
        }
        return [...results.values()];
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
        if (isMethod(target) &&
            !this.callbacks.isSupportedSpecificationPathSegment(context, target, false)) {
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
            ? getTypeReferences(target.type, target.collection)
            : isParameter(target)
                ? getTypeReferences(target.type as Reference<TypeDeclaration> | undefined, target.collection)
                : isMethod(target)
                    ? getTypeReferences(target.returnType, target.returnCollection)
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
