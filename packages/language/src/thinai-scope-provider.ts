import {
    type AstNode,
    type AstNodeDescription,
    AstUtils,
    DefaultScopeProvider,
    type ReferenceInfo,
    type Scope,
    type Stream,
    type LangiumCoreServices,
    UriUtils,
    stream
} from 'langium';
import {
    type ContextMap,
    type Constructor,
    type DataObject,
    type Exposure,
    type Field,
    type JourneyStep,
    type Method,
    type ReadModel,
    type TransitionChange,
    isAggregate,
    isContextMap,
    isConstructor,
    isBoundedContext,
    isBoundedContextPart,
    isDomainEvent,
    isDomainService,
    isApplicationService,
    isDataObject,
    isEntity,
    isFactory,
    isField,
    isEnumValue,
    isJourneyStep,
    isMethodInvocation,
    isIntegrationEvent,
    isEventReference,
    isPartnershipRelationship,
    isCustomerSupplierRelationship,
    isSeparateWaysRelationship,
    isSharedKernelRelationship,
    isModel,
    isMethod,
    isEnumType,
    isTransitionChange,
    isModule,
    isModuleReference,
    isSharedKernel,
    isImportComponent,
    isImportableComponent,
    isReadModel,
    isReadModelReference,
    isRepository,
    isProjector,
    isQueryRepository,
    isSpecificationTextPart,
    isQueryService,
    isParameter,
    isValueObject,
    type Module
} from './generated/ast.js';
import { getReachableMethods, hasBehaviorSideEffects } from './thinai-operation-utils.js';
import { isSyntacticallyComplete } from './thinai-ast-utils.js';
import {
    getExportedName,
    getOwningAggregate,
    getOwningContextName,
    getOwningModule,
    isInSharedKernel,
    resolveImportUri
} from './thinai-scope-utils.js';
import { ThinaiExternalScope } from './thinai-external-scope.js';


export class ThinaiScopeProvider extends DefaultScopeProvider {
    private readonly documents: LangiumCoreServices['shared']['workspace']['LangiumDocuments'];
    private readonly nodeLocator: LangiumCoreServices['workspace']['AstNodeLocator'];
    private readonly externalScope: ThinaiExternalScope;

    constructor(services: LangiumCoreServices) {
        super(services);
        this.documents = services.shared.workspace.LangiumDocuments;
        this.nodeLocator = services.workspace.AstNodeLocator;
        this.externalScope = new ThinaiExternalScope(
            this.reflection,
            this.nameProvider,
            this.descriptions,
            this.indexManager
        );
    }

    override getScope(context: ReferenceInfo): Scope {
        if (isField(context.container) && context.property === 'initialState') {
            return this.getInitialStateScope(context.container);
        }
        if (isTransitionChange(context.container)) {
            if (context.property === 'field') {
                return this.getTransitionFieldScope(context.container);
            }
            if (context.property === 'from' || context.property === 'to') {
                return this.getTransitionStateScope(context.container);
            }
        }
        const referenceType = this.reflection.getReferenceType(context);
        const qualifiedPathScope = this.getQualifiedPathScope(context);
        if (qualifiedPathScope) {
            return qualifiedPathScope;
        }
        if (referenceType === 'SpecificationTarget' && context.property === 'targets' &&
            isSpecificationTextPart(context.container)) {
            return this.createScope(this.getSpecificationPathSymbols(context, referenceType));
        }
        if (context.property === 'targets' &&
            (isJourneyStep(context.container) || isMethodInvocation(context.container))) {
            return this.createScope(this.getInvocationPathSymbols(context, referenceType));
        }
        if (context.property === 'component' && isImportComponent(context.container)) {
            return this.createScope(this.getImportableComponents(context.container, referenceType));
        }
        if (context.property === 'alias' && isImportComponent(context.container)) {
            const target = context.container.component.ref;
            return this.createScope(target
                ? [this.descriptions.createDescription(target, context.reference.$refText, AstUtils.getDocument(target))]
                : []);
        }
        const wrapperPath = (context.container as unknown as { path?: unknown }).path;
        if (context.property === 'target' && Array.isArray(wrapperPath) && wrapperPath.length === 0) {
            return this.getUnsegmentedScope(this.getPathScopeContext(context), referenceType);
        }
        return this.getUnsegmentedScope(context, referenceType);
    }

    filterCompletionCandidates(context: ReferenceInfo, candidates: Iterable<AstNodeDescription>): Stream<AstNodeDescription> {
        return stream(candidates).filter(description =>
            this.isSupportedCandidate(context, this.getDescriptionNode(description)) &&
            this.isAvailableTransitionField(context, this.getDescriptionNode(description)) &&
            this.isAvailableTransitionState(context, this.getDescriptionNode(description))
        );
    }

    getContextMapBoundedContextCandidates(contextMap: ContextMap): AstNodeDescription[] {
        const context = {
            container: contextMap,
            property: 'context',
            reference: { $refText: '' } as unknown as ReferenceInfo['reference']
        } as ReferenceInfo;
        return this.getUnsegmentedScope(context, 'BoundedContext').getAllElements().toArray();
    }

    getExposureDeclarationCandidates(exposure: Exposure): AstNodeDescription[] {
        const context = {
            container: exposure,
            property: 'declarations',
            reference: { $refText: '' } as unknown as ReferenceInfo['reference']
        } as ReferenceInfo;
        const candidates = this.getUnsegmentedScope(context, 'NamedDeclaration').getAllElements();
        return this.filterCompletionCandidates(context, candidates).toArray();
    }

    getPathCompletionCandidates(context: ReferenceInfo): AstNodeDescription[] | undefined {
        const { container, property } = context;
        const wrapperPath = property === 'path';
        const pathProperty = wrapperPath ? 'path' : property.endsWith('Path') ? property : undefined;
        if (!pathProperty) {
            return undefined;
        }

        const values = (container as unknown as Record<string, unknown>)[pathProperty];
        if (!Array.isArray(values)) {
            return undefined;
        }
        const terminalProperty = wrapperPath ? 'target' : pathProperty.slice(0, -'Path'.length);
        const terminalReference = (container as unknown as Record<string, unknown>)[terminalProperty];
        if (!terminalReference || typeof terminalReference !== 'object' || !('$refText' in terminalReference)) {
            return [];
        }

        const finalContext: ReferenceInfo = {
            ...context,
            property: terminalProperty,
            reference: terminalReference as ReferenceInfo['reference'],
            index: undefined
        };
        const finalType = this.reflection.getReferenceType(finalContext);
        const finalScope = this.getUnsegmentedScope(this.getPathScopeContext(finalContext), finalType);
        const allowedTargets = new Set(
            this.filterCompletionCandidates(finalContext, finalScope.getAllElements())
                .map(description => this.getDescriptionNode(description))
                .filter((node): node is AstNode => node !== undefined)
                .toArray()
        );
        const index = context.index ?? 0;
        const prefix = (values as ReferenceInfo['reference'][]).slice(0, index).map(reference => reference.$refText);
        return this.getPathSegmentCompletions(context, this.reflection.getReferenceType(context), prefix, allowedTargets, true);
    }

    private getPathScopeContext(context: ReferenceInfo): ReferenceInfo {
        if ((context.property === 'path' || context.property === 'target') && context.container.$containerProperty) {
            return { ...context, property: context.container.$containerProperty };
        }
        return context;
    }

    private getTransitionFieldScope(transition: TransitionChange): Scope {
        let current: AstNode | undefined = transition.$container;
        while (current && !isEntity(current)) {
            current = current.$container;
        }
        const aggregate = current && isEntity(current) ? this.getOwningAggregateNode(current) : undefined;
        const fields = current && isEntity(current)
            ? current.fields.filter(field => {
                const stateType = field.type?.ref;
                const enumField = isEnumType(stateType) || aggregate?.members.some(member =>
                    isEnumType(member) && member.name === field.type?.$refText
                ) === true;
                return enumField;
            })
            : [];
        return this.createScope(fields.map(field =>
            this.descriptions.createDescription(field, field.name, AstUtils.getDocument(field))
        ));
    }

    private isAvailableTransitionField(context: ReferenceInfo, target: AstNode | undefined): boolean {
        if (!isTransitionChange(context.container) || context.property !== 'field' || !isField(target)) {
            return true;
        }
        const transition = context.container.$container;
        if (transition?.$type !== 'Transition') {
            return true;
        }
        return !(transition as import('./generated/ast.js').Transition).changes.some(change =>
            change !== context.container && change.field?.$refText === target.name
        );
    }

    private isAvailableTransitionState(context: ReferenceInfo, target: AstNode | undefined): boolean {
        if (!isTransitionChange(context.container) || !isEnumValue(target)) {
            return true;
        }
        const otherState = context.property === 'to'
            ? context.container.from?.ref
            : context.property === 'from'
                ? context.container.to?.ref
                : undefined;
        return otherState !== target;
    }

    private getTransitionStateScope(transition: TransitionChange): Scope {
        const fieldTarget = transition.field?.ref;
        let current: AstNode | undefined = transition.$container;
        while (current && !isEntity(current)) {
            current = current.$container;
        }
        const entity = isEntity(current) ? current : undefined;
        const field = isField(fieldTarget)
            ? fieldTarget
            : entity?.fields.find(candidate => candidate.name === transition.field?.$refText);
        const aggregate = entity ? this.getOwningAggregateNode(entity) : undefined;
        const stateType = field?.type?.ref;
        const enumType = isEnumType(stateType)
            ? stateType
            : aggregate?.members.find(member => isEnumType(member) && member.name === field?.type?.$refText);
        if (!isEnumType(enumType)) {
            return this.createScope([]);
        }
        const document = AstUtils.getDocument(enumType);
        return this.createScope(enumType.values.map(value =>
            this.descriptions.createDescription(value, value.name, document)
        ));
    }

    private getInitialStateScope(field: Field): Scope {
        if (!isEntity(field.$container) || field.optional) {
            return this.createScope([]);
        }
        const stateType = field.type?.ref;
        let current: AstNode | undefined = field.$container;
        while (current && !isEntity(current)) {
            current = current.$container;
        }
        const entity = isEntity(current) ? current : undefined;
        const aggregate = entity ? this.getOwningAggregateNode(entity) : undefined;
        const enumType = isEnumType(stateType)
            ? stateType
            : aggregate?.members.find(member => isEnumType(member) && member.name === field.type?.$refText);
        if (!isEnumType(enumType)) {
            return this.createScope([]);
        }
        const document = AstUtils.getDocument(enumType);
        return this.createScope(enumType.values.map(value =>
            this.descriptions.createDescription(value, value.name, document)
        ));
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
            ? context.index ?? 0
            : path.length - 1;
        const completePath = path.join('.');
        const finalDescription = this.getUnsegmentedScope(
            scopeContext,
            this.reflection.getReferenceType(finalContext)
        ).getElement(completePath);
        if (!finalDescription?.node) {
            return this.createScope([]);
        }

        const targetDescription = segmentIndex === path.length - 1
            ? finalDescription
            : this.getUnsegmentedScope(scopeContext, 'NamedDeclaration')
                .getElement(path.slice(0, segmentIndex + 1).join('.'));
        const target = targetDescription?.node ?? this.getPathSegmentTarget(finalDescription.node, path, segmentIndex, context);
        if (!target) {
            return this.createScope([]);
        }

        return this.createScope([
            this.descriptions.createDescription(target, context.reference.$refText, AstUtils.getDocument(target))
        ]);
    }

    private getUnsegmentedScope(context: ReferenceInfo, referenceType: string): Scope {
        const document = AstUtils.getDocument(context.container);
        const localScopes: Stream<AstNodeDescription>[] = [];

        if (document.localSymbols) {
            let current: AstNode | undefined = context.container;
            while (current) {
                if (document.localSymbols.has(current)) {
                    localScopes.push(document.localSymbols.getStream(current).filter(description =>
                        this.reflection.isSubtype(description.type, referenceType)
                    ));
                }
                current = current.$container;
            }
        }

        let result = this.createScope(this.externalScope.getImportedSymbols(document, referenceType));
        result = this.createScope(this.externalScope.getDocumentSymbols(context, document, referenceType), result);
        const moduleSymbols = context.property === 'dependencies'
            ? []
            : this.externalScope.getModuleSymbols(context, referenceType);
        result = this.createScope(moduleSymbols, result);
        for (let index = localScopes.length - 1; index >= 0; index--) {
            result = this.createScope(localScopes[index], result);
        }
        const specificationSymbols = this.getSpecificationSymbols(context, referenceType);
        if (specificationSymbols.length > 0) {
            result = this.createScope(specificationSymbols, result);
        }
        return result;
    }

    private getSpecificationSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        const pending: AstNodeDescription[] = [];
        if (referenceType !== 'SpecificationTarget' || !isSpecificationTextPart(context.container)) {
            return pending;
        }
        let current: AstNode | undefined = context.container;
        let operation: Method | Constructor | undefined;
        let journeyStep: JourneyStep | undefined;
        while (current) {
            if (isJourneyStep(current)) {
                journeyStep = current;
                const target = current.targets.at(-1)?.ref;
                operation = isMethod(target) ? target : undefined;
                break;
            }
            if (isMethod(current) || isConstructor(current)) {
                operation = current;
                break;
            }
            current = current.$container;
        }
        if (!operation) {
            return pending;
        }

        for (const parameter of operation.parameters) {
            this.addSpecificationSymbol(pending, parameter, parameter.name, referenceType);
            const parameterType = parameter.type?.ref;
            if (parameterType && (isDataObject(parameterType) || isReadModel(parameterType) || isValueObject(parameterType))) {
                this.addShapeFields(pending, parameterType, parameter.name, referenceType, new Set());
            }
            if (parameter.collection) {
                const elementType = parameter.collection.elementType?.ref;
                if (elementType && (isDataObject(elementType) || isReadModel(elementType) || isValueObject(elementType))) {
                    this.addShapeFields(pending, elementType, parameter.name, referenceType, new Set());
                }
            }
        }

        if (isMethod(operation)) {
            const resultType = operation.returnType?.ref;
            if (resultType || operation.returnPrimitive || operation.returnCollection) {
                this.addSpecificationSymbol(pending, operation, 'result', referenceType);
            }
            if (resultType && (isDataObject(resultType) || isReadModel(resultType) || isValueObject(resultType))) {
                this.addShapeFields(pending, resultType, 'result', referenceType, new Set());
            }
            if (operation.returnCollection) {
                const elementType = operation.returnCollection.elementType?.ref;
                if (elementType && (isDataObject(elementType) || isReadModel(elementType) || isValueObject(elementType))) {
                    this.addShapeFields(pending, elementType, 'result', referenceType, new Set());
                }
            }
        }
        if (journeyStep) {
            for (const description of this.getUnsegmentedScope(context, 'Method').getAllElements()) {
                const queryMethod = description.node;
                if (!isMethod(queryMethod) || !isQueryService(queryMethod.$container)) {
                    continue;
                }
                if (!queryMethod.returnType && !queryMethod.returnPrimitive && !queryMethod.returnCollection) {
                    continue;
                }
                const shape = queryMethod.returnType?.ref ?? queryMethod.returnCollection?.elementType?.ref;
                const resultPrefix = `${getExportedName(queryMethod as AstNode & { name: string })}.result`;
                this.addSpecificationSymbol(pending, queryMethod, resultPrefix, referenceType);
                if (shape && (isDataObject(shape) || isReadModel(shape) || isValueObject(shape))) {
                    this.addShapeFields(pending, shape, resultPrefix, referenceType, new Set());
                }
            }
        }
        return pending;
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
        const description = this.getUnsegmentedScope(context, referenceType).getElement(fullPath);
        if (description) {
            return [{ ...description, name: reference.$refText }];
        }
        const prefix = [part.target, ...part.targets.slice(0, index)]
            .map(candidate => candidate.$refText);
        return this.getPathSegmentCompletions(context, referenceType, prefix);
    }

    private getInvocationPathSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        const references = isJourneyStep(context.container) || isMethodInvocation(context.container)
            ? context.container.targets
            : [];
        const index = context.index ?? (context.reference.$refText.length === 0 ? references.length : 0);
        const path = references.map(reference => reference.$refText);
        if (context.reference.$refText.length > 0 && index < references.length && path.length > 0) {
            const description = this.getUnsegmentedScope(context, referenceType).getElement(path.join('.'));
            const target = description?.node ? this.getPathSegmentTarget(description.node, path, index, context) : undefined;
            if (target) {
                return [this.descriptions.createDescription(target, context.reference.$refText, AstUtils.getDocument(target))];
            }
        }
        return this.getPathSegmentCompletions(context, referenceType, references.slice(0, index).map(reference => reference.$refText));
    }

    getInvocationCompletionCandidates(context: ReferenceInfo): AstNodeDescription[] {
        const referenceType = this.reflection.getReferenceType(context);
        const references = isJourneyStep(context.container) || isMethodInvocation(context.container)
            ? context.container.targets
            : [];
        const index = context.index ?? (context.reference.$refText.length === 0 ? references.length : 0);
        const path = references.map(reference => reference.$refText);
        const scope = this.getUnsegmentedScope(context, referenceType);
        const allowedTargets = new Set<AstNode>();
        for (const description of scope.getAllElements()) {
            const target = this.getDescriptionNode(description);
            if (isMethod(target) && (isJourneyStep(context.container)
                ? this.isJourneyCommand(target)
                : this.isSupportedInvocationTarget(context.container, target) &&
                    this.isSupportedCandidate(context, target))) {
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
        return this.getPathSegmentCompletions(
            context,
            referenceType,
            references.slice(0, index).map(reference => reference.$refText),
            allowedTargets
        );
    }

    canInvokeMethod(context: AstNode, target: Method): boolean {
        return this.isSupportedInvocationTarget(context, target);
    }

    private isJourneyCommand(method: Method): boolean {
        return isApplicationService(method.$container) && !method.parameters.some(parameter =>
            isDomainEvent(parameter.type?.ref) || isIntegrationEvent(parameter.type?.ref)
        );
    }

    private isSupportedInvocationTarget(container: AstNode, target: Method): boolean {
        let source: AstNode | undefined = container;
        while (source && !isMethod(source)) {
            source = source.$container;
        }
        if (!isMethod(source) || target.parameters.some(parameter =>
            isDomainEvent(parameter.type?.ref) || isIntegrationEvent(parameter.type?.ref)
        )) {
            return false;
        }
        if (isProjector(source.$container)) {
            return false;
        }
        const targetSharedKernel = this.getOwningSharedKernel(target);
        const sharedKernelServiceCall = targetSharedKernel !== undefined && isDomainService(target.$container) &&
            (isApplicationService(source.$container) || isDomainService(source.$container)) &&
            this.hasVisibleSharedKernel(source, targetSharedKernel) &&
            this.hasSharedKernelRelationship(source, targetSharedKernel);
        if (this.isCrossContext(source, target) && !sharedKernelServiceCall) {
            return false;
        }

        if (isDomainService(source.$container) && !isDomainService(target.$container)) {
            return false;
        }

        const sourceApplication = isApplicationService(source.$container);
        const sourceQueryService = isQueryService(source.$container) ? source.$container : undefined;
        const sourceAggregate = this.getOwningAggregateNode(source);
        const reachable = getReachableMethods(target);
        if (sourceQueryService && (target.$container !== sourceQueryService || hasBehaviorSideEffects(target))) {
            return false;
        }
        if (isDomainService(source.$container) && (this.getOwningAggregateNode(target) !== undefined ||
            reachable.some(method => this.getOwningAggregateNode(method) !== undefined))) {
            return false;
        }
        if (sourceAggregate && (isDomainService(target.$container) ||
            reachable.some(method => isDomainService(method.$container)))) {
            return false;
        }

        if (isApplicationService(target.$container) && target.$container !== source.$container) {
            const eventParameterCount = source.parameters.filter(parameter =>
                isDomainEvent(parameter.type?.ref) || isIntegrationEvent(parameter.type?.ref)
            ).length;
            if (!sourceApplication || eventParameterCount !== 1 || source.parameters.length !== 1) {
                return false;
            }
        }

        const targetAggregate = this.getOwningAggregateNode(target);
        const targetIsRootMethod = targetAggregate !== undefined &&
            target.$container === targetAggregate.members.find(member => isEntity(member) && member.root);
        const factoryRoot = target.returnType?.ref;
        const factoryReturnsRoot = isFactory(target.$container) && isEntity(factoryRoot) && factoryRoot.root &&
            this.getOwningAggregateNode(factoryRoot) !== undefined;
        // Application services may target aggregate-root methods or factory methods;
        // other method containers remain subject to the validator's structural rules.
        if (sourceApplication && !targetIsRootMethod && !factoryReturnsRoot &&
            !isApplicationService(target.$container) && !isDomainService(target.$container)) {
            return false;
        }
        if (!sourceApplication && isApplicationService(target.$container)) {
            return false;
        }
        if (targetAggregate && !targetIsRootMethod && !isEntity(source.$container)) {
            return false;
        }
        if (sourceAggregate && targetAggregate && sourceAggregate !== targetAggregate) {
            return false;
        }

        if (!sourceApplication && !isApplicationService(target.$container) &&
            reachable.some(method => isApplicationService(method.$container))) {
            return false;
        }
        if (sourceApplication && !isApplicationService(target.$container) && (
            reachable.some(method => isApplicationService(method.$container)) ||
            (!targetIsRootMethod && reachable.some(method => this.getOwningAggregateNode(method) !== undefined))
        )) {
            return false;
        }
        if (!sourceApplication && sourceAggregate && reachable.some(method => {
            const aggregate = this.getOwningAggregateNode(method);
            return aggregate !== undefined && aggregate !== sourceAggregate;
        })) {
            return false;
        }
        return true;
    }

    private isCrossContext(source: AstNode, target: AstNode): boolean {
        const sourceContext = getOwningContextName(source);
        const targetContext = getOwningContextName(target);
        return sourceContext !== undefined && targetContext !== undefined && sourceContext !== targetContext;
    }

    private getOwningAggregateNode(node: AstNode): import('./generated/ast.js').Aggregate | undefined {
        return getOwningAggregate(node);
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
        const scope = this.getUnsegmentedScope(this.getPathScopeContext(context), referenceType);
        for (const description of scope.getAllElements()) {
            const candidate = this.getDescriptionNode(description);
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
            if (isBoundedContextPart(current) && current.context.ref) {
                ancestors.push(current.context.ref);
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
        for (const importDeclaration of root.imports) {
            if (importDeclaration.components.some(component =>
                component.alias?.$refText === alias && component.component.ref === node
            )) {
                return true;
            }
        }
        return false;
    }

    private addShapeFields(
        descriptions: AstNodeDescription[],
        shape: DataObject | ReadModel | import('./generated/ast.js').ValueObject,
        prefix: string,
        referenceType: string,
        visited: Set<AstNode>
    ): void {
        if (visited.has(shape)) {
            return;
        }
        visited.add(shape);
        for (const field of shape.fields) {
            const name = `${prefix}.${field.name}`;
            this.addSpecificationSymbol(descriptions, field, name, referenceType);
            const nested = field.type?.ref;
            if (nested && (isDataObject(nested) || isReadModel(nested) || isValueObject(nested))) {
                this.addShapeFields(descriptions, nested, name, referenceType, visited);
            }
        }
    }

    private addSpecificationSymbol(
        descriptions: AstNodeDescription[],
        node: AstNode,
        name: string,
        referenceType: string
    ): void {
        if (this.reflection.isSubtype(node.$type, referenceType)) {
            descriptions.push(this.descriptions.createDescription(node, name, AstUtils.getDocument(node)));
        }
    }

    private isSupportedCandidate(context: ReferenceInfo, target: AstNode | undefined): boolean {
        if (!target) {
            return true;
        }

        const exposure = context.container.$type === 'Exposure'
            ? context.container
            : context.container.$container?.$type === 'Exposure'
                ? context.container.$container
                : undefined;
        if (exposure && (context.property === 'declarations' || context.property === 'target')) {
            const owningModule = getOwningModule(exposure);
            return owningModule !== undefined && getOwningModule(target) === owningModule;
        }

        if (!this.isAvailableContextMapContext(context, target)) {
            return false;
        }

        const sourceModule = getOwningModule(context.container);
        const targetModule = getOwningModule(target);
        if (isModuleReference(context.container) && context.property === 'target') {
            const dependencySource = context.container.$container;
            return isModule(target) && target !== dependencySource &&
                getOwningContextName(dependencySource) === getOwningContextName(target) &&
                !this.moduleDependsTransitivelyOn(target, dependencySource);
        }
        if (!sourceModule && targetModule && !isModule(target) &&
            getOwningContextName(context.container) === getOwningContextName(targetModule)) {
            const exposedTarget = isField(target) || isParameter(target) || isEnumValue(target)
                ? target.$container
                : target;
            const exposed = targetModule.exposures.some(exposure =>
                exposure.declarations.some(declaration => declaration.target.ref === exposedTarget)
            );
            if (!exposed) {
                return false;
            }
        }
        if (sourceModule && targetModule && sourceModule !== targetModule && !isModule(target) &&
            getOwningContextName(sourceModule) === getOwningContextName(targetModule)) {
            const dependsOn = sourceModule.dependencies.some(dependency => dependency.target.ref === targetModule);
            const exposedTarget = isField(target) || isParameter(target) || isEnumValue(target)
                ? target.$container
                : target;
            const exposed = targetModule.exposures.some(exposure =>
                exposure.declarations.some(declaration => declaration.target.ref === exposedTarget)
            );
            if (!dependsOn || !exposed) {
                return false;
            }
        }

        if (isSpecificationTextPart(context.container)) {
            return this.isSupportedSpecificationCandidate(context, target);
        }

        if (isEventReference(context.container)) {
            return this.isSupportedEventEmission(context, target);
        }

        if (isReadModelReference(context.container)) {
            let current: AstNode | undefined = context.container.$container;
            while (current && !isMethod(current)) {
                current = current.$container;
            }
            if (!isMethod(current) || !isProjector(current.$container)) {
                return false;
            }
            return isReadModel(target)
                ? getOwningContextName(current) === getOwningContextName(target)
                : this.hasReadModelDescendant(target, getOwningContextName(current));
        }

        if (isRepository(context.container) && (context.property === 'root' || context.property === 'rootPath')) {
            return this.isValidRepositoryRootPathCandidate(context.container, target);
        }

        if (context.property === 'mirrors' && isValueObject(context.container)) {
            const sourceContext = getOwningContextName(context.container);
            const targetContext = getOwningContextName(target);
            return isValueObject(target) && sourceContext !== undefined && targetContext !== undefined &&
                sourceContext !== targetContext && this.isIdentifierValueObject(target);
        }

        if (context.property === 'readModel' && isQueryRepository(context.container)) {
            return isReadModel(target) && getOwningContextName(context.container) === getOwningContextName(target);
        }

        if (this.isTypeReference(context) && !this.isValidTypeCandidate(context, target)) {
            return false;
        }

        if (!this.isTypeReference(context)) {
            return true;
        }

        const sourceContext = getOwningContextName(context.container);
        const targetContext = getOwningContextName(target);
        if (!sourceContext || !targetContext || sourceContext === targetContext) {
            return true;
        }

        if (isInSharedKernel(target)) {
            const sharedKernel = this.getOwningSharedKernel(target);
            return sharedKernel !== undefined && this.hasSharedKernelRelationship(context.container, sharedKernel);
        }

        if (isIntegrationEvent(target) && isParameter(context.container)) {
            return this.isIntegrationEventExposed(target) && this.hasAuthorizedEventRelationship(context.container, target);
        }

        return false;
    }

    private isAvailableContextMapContext(context: ReferenceInfo, target: AstNode): boolean {
        if (!isBoundedContext(target)) {
            return true;
        }
        const container = context.container;
        if (container.$type === 'ContextMapEndpoint' && context.property === 'context') {
            const relationship = container.$container;
            if (isCustomerSupplierRelationship(relationship)) {
                const otherEndpoint = relationship.customer === container ? relationship.supplier : relationship.customer;
                return otherEndpoint.context?.ref !== target;
            }
            if (isPartnershipRelationship(relationship)) {
                const otherEndpoint = relationship.left === container ? relationship.right : relationship.left;
                return otherEndpoint.context?.ref !== target;
            }
        }
        if (isSeparateWaysRelationship(container) && (context.property === 'left' || context.property === 'right')) {
            const otherContext = context.property === 'left' ? container.right?.ref : container.left?.ref;
            return otherContext !== target;
        }
        if (container.$type === 'BoundedContextReference' && context.property === 'target' &&
            isSharedKernelRelationship(container.$container)) {
            const relationship = container.$container;
            return !relationship.participants.some(participant =>
                participant !== container && participant.target?.ref === target
            );
        }
        return true;
    }

    private isValidTypeCandidate(context: ReferenceInfo, target: AstNode): boolean {
        let current: AstNode | undefined = context.container;
        let field: import('./generated/ast.js').Field | undefined;
        let parameter: import('./generated/ast.js').Parameter | undefined;
        let method: Method | undefined;
        while (current) {
            if (isField(current)) {
                field = current;
                break;
            }
            if (isParameter(current)) {
                parameter = current;
                break;
            }
            if (isMethod(current)) {
                method = current;
                break;
            }
            current = current.$container;
        }

        if (field) {
            const owner = field.$container;
            if (field.identifier && context.container !== field) {
                return false;
            }
            if (field.identifier && (!isValueObject(target) || this.getOwningAggregateNode(field) !== target.$container)) {
                return false;
            }
            if (isDataObject(owner) && (isEntity(target) || isReadModel(target))) {
                return false;
            }
            if (!isDataObject(owner) && isDataObject(target)) {
                return false;
            }
            if (isReadModel(target) && !isReadModel(owner)) {
                return false;
            }
            if (isReadModel(owner) && isEntity(target)) {
                return false;
            }
            if ((isDomainEvent(owner) || isIntegrationEvent(owner)) && isEntity(target)) {
                return false;
            }
            if (isIntegrationEvent(owner)) {
                if (this.getOwningAggregateNode(target)) {
                    return false;
                }
                if (!isInSharedKernel(target)) {
                    const contractModule = getOwningModule(owner);
                    if (!contractModule || getOwningModule(target) !== contractModule ||
                        (!isValueObject(target) && !isEnumType(target)) ||
                        !contractModule.exposures.some(exposure =>
                            exposure.declarations.some(declaration => declaration.target.ref === target)
                        )) {
                        return false;
                    }
                }
            }
            const sourceAggregate = this.getOwningAggregateNode(field);
            const targetAggregate = isEntity(target) ? this.getOwningAggregateNode(target) : undefined;
            if (targetAggregate && targetAggregate !== sourceAggregate) {
                return false;
            }
        }

        if (parameter) {
            const parent = parameter.$container;
            const methodOwner = isMethod(parent) ? parent.$container : undefined;
            if (isProjector(methodOwner) && (!isMethod(parent) || parent.parameters.length !== 1 ||
                parent.parameters[0] !== parameter || parameter.collection ||
                !isDomainEvent(target) && !isIntegrationEvent(target))) {
                return false;
            }
            if (isReadModel(target)) {
                return false;
            }
            if (isConstructor(parent)) {
                if (isDomainEvent(target) || isIntegrationEvent(target) || isDataObject(target)) {
                    return false;
                }
                const sourceAggregate = this.getOwningAggregateNode(parent);
                if (isEntity(target) && target.root && this.getOwningAggregateNode(target) !== sourceAggregate) {
                    return false;
                }
            }
            if (isDomainEvent(target) || isIntegrationEvent(target)) {
                const eventHandler = isApplicationService(methodOwner) || isProjector(methodOwner);
                const eventParameters = isMethod(parent)
                    ? parent.parameters.filter(candidate => isDomainEvent(candidate.type?.ref) || isIntegrationEvent(candidate.type?.ref))
                    : [];
                if (!eventHandler || !isMethod(parent) || parent.parameters.length !== 1 || eventParameters.length > 1) {
                    return false;
                }
            }
            if (isEntity(target) && (isApplicationService(methodOwner) || isQueryService(methodOwner))) {
                return false;
            }
        }

        if (method) {
            const owner = method.$container;
            if (isProjector(owner)) {
                return false;
            }
            if (isFactory(owner)) {
                return context.property === 'returnType' && !method.returnCollection && isEntity(target) &&
                    target.root && getOwningContextName(target) === getOwningContextName(method);
            }
            if (isEntity(target) && (isDomainService(owner) || isApplicationService(owner) || isQueryService(owner))) {
                return false;
            }
            if (isReadModel(target) && !isQueryService(owner)) {
                return false;
            }
            if (isReadModel(target) && getOwningContextName(method) !== getOwningContextName(target)) {
                return false;
            }
        }
        return true;
    }

    private isIdentifierValueObject(valueObject: import('./generated/ast.js').ValueObject, visited = new Set<AstNode>()): boolean {
        if (visited.has(valueObject)) {
            return false;
        }
        visited.add(valueObject);
        const aggregate = valueObject.$container;
        const isRootIdentifier = isAggregate(aggregate) && aggregate.members.some(member =>
            isEntity(member) && member.root && member.fields.some(field => field.identifier && field.type?.ref === valueObject)
        );
        return isRootIdentifier || (valueObject.mirrors?.ref !== undefined &&
            this.isIdentifierValueObject(valueObject.mirrors.ref, visited));
    }

    private moduleDependsTransitivelyOn(module: Module, target: Module, visited = new Set<Module>()): boolean {
        if (module === target) {
            return true;
        }
        if (visited.has(module)) {
            return false;
        }
        visited.add(module);
        return module.dependencies.some(dependency => dependency.target.ref !== undefined &&
            this.moduleDependsTransitivelyOn(dependency.target.ref, target, visited));
    }

    private isValidRepositoryRootPathCandidate(repository: import('./generated/ast.js').Repository, target: AstNode): boolean {
        const contextName = getOwningContextName(repository);
        if (!contextName) {
            return false;
        }
        if (isEntity(target)) {
            return target.root && getOwningContextName(target) === contextName;
        }
        for (const description of this.indexManager.allElements('Entity')) {
            const entity = this.getDescriptionNode(description);
            if (!isEntity(entity) || !entity.root || getOwningContextName(entity) !== contextName) {
                continue;
            }
            let current: AstNode | undefined = entity;
            while (current) {
                if (current === target) {
                    return true;
                }
                current = current.$container;
            }
        }
        return false;
    }

    private isSupportedSpecificationCandidate(context: ReferenceInfo, target: AstNode): boolean {
        if (isField(target) && !(
            isEntity(target.$container) || isValueObject(target.$container) || isDomainEvent(target.$container) ||
            isIntegrationEvent(target.$container) || isReadModel(target.$container) || isDataObject(target.$container)
        )) {
            return false;
        }

        const sourceContext = getOwningContextName(context.container);
        const targetContext = getOwningContextName(target);
        if (!sourceContext || !targetContext || sourceContext === targetContext || isInSharedKernel(target)) {
            return true;
        }

        if (isField(target)) {
            return isIntegrationEvent(target.$container) && this.isIntegrationEventExposed(target.$container) &&
                this.hasAuthorizedEventRelationship(context.container, target.$container);
        }
        if (isIntegrationEvent(target)) {
            return this.isIntegrationEventExposed(target) && this.hasAuthorizedEventRelationship(context.container, target);
        }
        return false;
    }

    private isSupportedEventEmission(context: ReferenceInfo, target: AstNode): boolean {
        if (!isDomainEvent(target) && !isIntegrationEvent(target)) {
            return this.hasEmittableEventDescendant(context, target);
        }
        return this.isEmittableEvent(context, target);
    }

    private isEmittableEvent(context: ReferenceInfo, target: AstNode): boolean {
        if (!isDomainEvent(target) && !isIntegrationEvent(target)) {
            return false;
        }
        let current: AstNode | undefined = context.container;
        while (current && !isMethod(current)) {
            current = current.$container;
        }
        if (!isMethod(current) || this.isCrossContext(current, target)) {
            return false;
        }

        const aggregate = this.getOwningAggregateNode(current);
        const root = aggregate?.members.find(member => isEntity(member) && member.root);
        if (isEntity(root) && current.$container === root) {
            return isDomainEvent(target);
        }
        const eventParameters = current.parameters.filter(parameter =>
            isDomainEvent(parameter.type?.ref) || isIntegrationEvent(parameter.type?.ref)
        );
        return isApplicationService(current.$container) && current.parameters.length === 1 &&
            eventParameters.length === 1 && isDomainEvent(eventParameters[0].type?.ref) && isIntegrationEvent(target);
    }

    private hasEmittableEventDescendant(context: ReferenceInfo, candidate: AstNode): boolean {
        for (const type of ['DomainEvent', 'IntegrationEvent']) {
            for (const description of this.indexManager.allElements(type)) {
                const event = this.getDescriptionNode(description);
                if (event && this.isEmittableEvent(context, event) && this.isAstAncestor(candidate, event)) {
                    return true;
                }
            }
        }
        return false;
    }

    private hasReadModelDescendant(candidate: AstNode, contextName: string | undefined): boolean {
        if (!contextName) {
            return false;
        }
        for (const description of this.indexManager.allElements('ReadModel')) {
            const readModel = this.getDescriptionNode(description);
            if (isReadModel(readModel) && getOwningContextName(readModel) === contextName &&
                this.isAstAncestor(candidate, readModel)) {
                return true;
            }
        }
        return false;
    }

    private isAstAncestor(ancestor: AstNode, node: AstNode): boolean {
        let current: AstNode | undefined = node;
        while (current) {
            if (current === ancestor) {
                return true;
            }
            current = current.$container;
        }
        return false;
    }

    private getDescriptionNode(description: AstNodeDescription): AstNode | undefined {
        if (description.node) {
            return description.node;
        }
        const document = this.documents.getDocument(description.documentUri);
        return document?.parseResult.value
            ? this.nodeLocator.getAstNode(document.parseResult.value, description.path)
            : undefined;
    }

    private isTypeReference(context: ReferenceInfo): boolean {
        if (!['type', 'returnType', 'elementType', 'valueType', 'typePath', 'returnTypePath', 'elementTypePath', 'valueTypePath']
            .includes(context.property)) {
            return false;
        }
        let current: AstNode | undefined = context.container;
        while (current) {
            if (isField(current) || isParameter(current) || isMethod(current)) {
                return true;
            }
            current = current.$container;
        }
        return false;
    }

    private getOwningSharedKernel(node: AstNode): import('./generated/ast.js').SharedKernel | undefined {
        let current: AstNode | undefined = node;
        while (current) {
            if (isSharedKernel(current)) {
                return current;
            }
            current = current.$container;
        }
        return undefined;
    }

    private hasSharedKernelRelationship(source: AstNode, sharedKernel: import('./generated/ast.js').SharedKernel): boolean {
        const contextName = getOwningContextName(source);
        const document = AstUtils.getDocument(source);
        const root = document.parseResult.value;
        if (!contextName || !isModel(root)) {
            return false;
        }
        const contextMaps = [...root.declarations.filter(isContextMap)];
        for (const declaration of root.imports) {
            const resolvedUri = resolveImportUri(document, declaration);
            if (!resolvedUri) {
                continue;
            }
            const uri = resolvedUri.toString();
            contextMaps.push(...this.indexManager.allElements('ContextMap', new Set([uri]))
                .map(description => description.node)
                .filter((node): node is import('./generated/ast.js').ContextMap =>
                    isContextMap(node) && (declaration.components.length === 0 ||
                        declaration.components.some(component => component.component.ref === node))
                ).toArray());
        }
        return contextMaps.some(contextMap => contextMap.relationships.some(relationship =>
            isSyntacticallyComplete(relationship) && isSharedKernelRelationship(relationship) &&
            relationship.sharedKernel?.ref === sharedKernel &&
            relationship.participants.some(participant => participant?.target?.ref?.name === contextName)
        ));
    }

    private hasVisibleSharedKernel(source: AstNode, sharedKernel: import('./generated/ast.js').SharedKernel): boolean {
        const document = AstUtils.getDocument(source);
        const root = document.parseResult.value;
        if (!isModel(root)) {
            return false;
        }
        if (root.declarations.includes(sharedKernel)) {
            return true;
        }
        const sharedKernelUri = AstUtils.getDocument(sharedKernel).uri;
        return root.imports.some(declaration => {
            const uri = resolveImportUri(document, declaration);
            return uri !== undefined && UriUtils.equals(uri, sharedKernelUri) &&
                (declaration.components.length === 0 || declaration.components.some(component => component.component.ref === sharedKernel));
        });
    }

    private hasAuthorizedEventRelationship(source: AstNode, event: import('./generated/ast.js').IntegrationEvent): boolean {
        const consumer = getOwningContextName(source);
        const producer = getOwningContextName(event);
        const document = AstUtils.getDocument(source);
        const root = document.parseResult.value;
        if (!consumer || !producer || !isModel(root) || !root.imports.some(declaration => {
            const uri = resolveImportUri(document, declaration);
            return uri !== undefined && UriUtils.equals(uri, AstUtils.getDocument(event).uri);
        })) {
            return false;
        }
        for (const declaration of root.imports) {
            const resolvedUri = resolveImportUri(document, declaration);
            if (!resolvedUri) {
                continue;
            }
            const uri = resolvedUri.toString();
            const contextMaps = this.indexManager.allElements('ContextMap', new Set([uri]))
                .map(description => description.node)
                .filter((node): node is import('./generated/ast.js').ContextMap => isContextMap(node))
                .toArray();
            for (const contextMap of contextMaps) {
                if (declaration.components.length > 0 && !declaration.components.some(component => component.component.ref === contextMap)) {
                    continue;
                }
                for (const relationship of contextMap.relationships) {
                    if (!isSyntacticallyComplete(relationship)) {
                        continue;
                    }
                    if (isCustomerSupplierRelationship(relationship) &&
                        relationship.customer?.context?.ref?.name === consumer &&
                        relationship.supplier?.context?.ref?.name === producer) {
                        return true;
                    }
                    if (isPartnershipRelationship(relationship)) {
                        const left = relationship.left?.context?.ref?.name;
                        const right = relationship.right?.context?.ref?.name;
                        if ((left === consumer && right === producer) || (right === consumer && left === producer)) {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    }

    private isIntegrationEventExposed(event: import('./generated/ast.js').IntegrationEvent): boolean {
        const module = getOwningModule(event);
        return module === undefined || module.exposures.some(exposure =>
            exposure.declarations.some(declaration => declaration.target.ref === event)
        );
    }

    private getImportableComponents(component: import('./generated/ast.js').ImportComponent, referenceType: string): AstNodeDescription[] {
        const importDeclaration = component.$container;
        const document = AstUtils.getDocument(importDeclaration);
        const resolvedUri = resolveImportUri(document, importDeclaration);
        if (!resolvedUri) {
            return [];
        }
        const uri = resolvedUri.toString();
        return this.indexManager.allElements(referenceType, new Set([uri]))
            .filter(description => ['BoundedContext', 'ContextMap', 'SharedKernel'].includes(description.type))
            .toArray();
    }


}
