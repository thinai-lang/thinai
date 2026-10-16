import {
    type AstNode,
    type AstNodeDescription,
    AstUtils,
    DefaultScopeProvider,
    type ReferenceInfo,
    type Scope,
    type Stream,
    type LangiumCoreServices,
    stream,
    DocumentState,
} from 'langium';
import {
    type CollectionType,
    type ContextMap,
    type Constructor,
    type DataObject,
    type Exposure,
    type Field,
    type ImportComponent,
    type JourneyStep,
    type Method,
    type Parameter,
    type ReadSourceReference,
    type ReadModel,
    type Repository,
    type SpecificationTextPart,
    type Transition,
    type TransitionChange,
    type ValueObject,
    isAggregate,
    isConstructor,
    isBoundedContext,
    isDomainEvent,
    isDomainService,
    isApplicationService,
    isDataObject,
    isEntity,
    isFactory,
    isField,
    isEnumValue,
    isJourneyStep,
    isIntegrationEvent,
    isEventReference,
    isPartnershipRelationship,
    isCustomerSupplierRelationship,
    isSeparateWaysRelationship,
    isSharedKernelRelationship,
    isMethod,
    isEnumType,
    isTransitionChange,
    isModule,
    isModuleReference,
    isImportComponent,
    isReadModel,
    isReadModelReference,
    isReadSourceReference,
    isAggregateReference,
    isRepository,
    isProjector,
    isQueryRepository,
    isSpecificationTextPart,
    isQueryService,
    isParameter,
    isValueObject
} from './generated/ast.js';
import { getMethodInvocationViolations } from './thinai-method-invocation-policy.js';
import { isJourneyCommand } from './thinai-operation-utils.js';
import { ThinaiReferencePolicy } from './thinai-reference-policy.js';
import { ThinaiPathScope } from './thinai-path-scope.js';
import {
    getOwningAggregate,
    getOwningContextName,
    getOwningModule,
    getOwningSharedKernel,
    isInSharedKernel,
    isCrossContextOwned,
    isExposedByModule,
    isIdentifierValueObject,
    moduleDependsTransitivelyOn,
    resolveAstNodeDescription,
    resolveImportUri
} from './thinai-scope-utils.js';
import { ThinaiExternalScope } from './thinai-external-scope.js';


export class ThinaiScopeProvider extends DefaultScopeProvider {
    private readonly services: LangiumCoreServices;
    private readonly externalScope: ThinaiExternalScope;
    private readonly referencePolicy: ThinaiReferencePolicy;
    private readonly pathScope: ThinaiPathScope;

    constructor(services: LangiumCoreServices) {
        super(services);
        this.services = services;
        this.externalScope = new ThinaiExternalScope(
            this.reflection,
            this.nameProvider,
            this.descriptions,
            this.indexManager
        );
        services.shared.workspace.DocumentBuilder.onUpdate(() => this.externalScope.clearCache());
        services.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.IndexedContent, () =>
            this.externalScope.clearCache()
        );
        this.referencePolicy = new ThinaiReferencePolicy(services);
        this.pathScope = new ThinaiPathScope(services, {
            createScope: elements => this.createScope(elements),
            getUnsegmentedScope: (context, referenceType) => this.getUnsegmentedScope(context, referenceType),
            filterCompletionCandidates: (context, candidates) => this.filterCompletionCandidates(context, candidates),
            getDescriptionNode: description => this.getDescriptionNode(description),
            isSupportedInvocationTarget: (container, target) => this.isSupportedInvocationTarget(container, target),
            isSupportedCandidate: (context, target) => this.isSupportedCandidate(context, target),
            isJourneyCommand
        });
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
        const pathScope = this.pathScope.getPathScope(context, referenceType);
        if (pathScope) {
            return pathScope;
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
        return this.getUnsegmentedScope(context, referenceType);
    }

    /**
     * Thinai's outer scopes depend on the referencing document and declaration,
     * so they cannot use Langium's workspace-wide global-scope cache.
     */
    protected override getGlobalScope(referenceType: string, context: ReferenceInfo): Scope {
        const document = AstUtils.getDocument(context.container);
        let result = this.createScope(this.filterUnqualifiedSpecificationFields(
            context,
            referenceType,
            this.externalScope.getImportedSymbols(document, referenceType)
        ));
        result = this.createScope(this.filterUnqualifiedSpecificationFields(
            context,
            referenceType,
            this.externalScope.getDocumentSymbols(context, document, referenceType)
        ), result);
        const moduleSymbols = context.property === 'dependencies'
            ? []
            : this.externalScope.getModuleSymbols(context, referenceType);
        return this.createScope(
            this.filterUnqualifiedSpecificationFields(context, referenceType, moduleSymbols),
            result
        );
    }

    filterCompletionCandidates(context: ReferenceInfo, candidates: Iterable<AstNodeDescription>): Stream<AstNodeDescription> {
        return stream(candidates).filter(description =>
            this.isAllowedUnqualifiedSpecificationField(context, description) &&
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

    getSpecificationRootCompletionCandidates(context: ReferenceInfo): AstNodeDescription[] {
        return this.pathScope.getSpecificationRootCompletionCandidates(context);
    }

    getPathCompletionCandidates(context: ReferenceInfo): AstNodeDescription[] | undefined {
        return this.pathScope.getPathCompletionCandidates(context);
    }

    private getTransitionFieldScope(transition: TransitionChange): Scope {
        let current: AstNode | undefined = transition.$container;
        while (current && !isEntity(current)) {
            current = current.$container;
        }
        const aggregate = current && isEntity(current) ? getOwningAggregate(current) : undefined;
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
        return !(transition as Transition).changes.some(change =>
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
        const aggregate = entity ? getOwningAggregate(entity) : undefined;
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
        const aggregate = entity ? getOwningAggregate(entity) : undefined;
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

    private getUnsegmentedScope(context: ReferenceInfo, referenceType: string): Scope {
        let result: Scope;
        const declaredReferenceType = this.reflection
            .getTypeMetaData(context.container.$type)
            .properties[context.property]?.referenceType;
        if (declaredReferenceType === referenceType) {
            // Reuse Langium's standard local-scope traversal and only customize
            // the document/context-specific outer scope via getGlobalScope.
            result = super.getScope(context);
        } else {
            // Some path-completion queries intentionally ask for a broader
            // intermediate type than the AST reference's declared target type.
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
            result = this.getGlobalScope(referenceType, context);
            for (let index = localScopes.length - 1; index >= 0; index--) {
                result = this.createScope(localScopes[index]!, result);
            }
        }
        const specificationSymbols = this.getSpecificationSymbols(context, referenceType);
        if (specificationSymbols.length > 0) {
            result = this.createScope(specificationSymbols, result);
        }
        return result;
    }

    private filterUnqualifiedSpecificationFields(
        context: ReferenceInfo,
        referenceType: string,
        candidates: AstNodeDescription[]
    ): AstNodeDescription[] {
        if (referenceType !== 'SpecificationTarget' || !isSpecificationTextPart(context.container)) {
            return candidates;
        }
        return candidates.filter(candidate => this.isAllowedUnqualifiedSpecificationField(context, candidate));
    }

    private isAllowedUnqualifiedSpecificationField(context: ReferenceInfo, candidate: AstNodeDescription): boolean {
        const target = this.getDescriptionNode(candidate);
        if (!isSpecificationTextPart(context.container) || !isField(target) || candidate.name !== target.name) {
            return true;
        }
        if (this.hasSpecificationPathPrefix(context.container, context)) {
            return true;
        }
        const owner = AstUtils.getContainerOfType(context.container,
            (node): node is AstNode => isEntity(node) || isValueObject(node)
        );
        return target.$container === owner;
    }

    private hasSpecificationPathPrefix(
        part: SpecificationTextPart,
        context: ReferenceInfo
    ): boolean {
        if (context.property === 'target') {
            return part.targets.some(reference => reference.$refText.length > 0);
        }
        if (context.property === 'targets') {
            const index = context.index ?? part.targets.length;
            return part.target !== undefined && part.target.$refText.length > 0 ||
                part.targets.slice(0, index).some(reference => reference.$refText.length > 0);
        }
        return false;
    }

    private getSpecificationSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        const pending: AstNodeDescription[] = [];
        if (referenceType !== 'SpecificationTarget' || !isSpecificationTextPart(context.container)) {
            return pending;
        }
        let operation: Method | Constructor | undefined;
        let journeyStep: JourneyStep | undefined;
        const enclosingOperation = AstUtils.getContainerOfType(context.container,
            (node): node is JourneyStep | Method | Constructor =>
                isJourneyStep(node) || isMethod(node) || isConstructor(node)
        );
        if (isJourneyStep(enclosingOperation)) {
            journeyStep = enclosingOperation;
            const target = enclosingOperation.targets.at(-1)?.ref;
            operation = isMethod(target) ? target : undefined;
        } else if (isMethod(enclosingOperation) || isConstructor(enclosingOperation)) {
            operation = enclosingOperation;
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
                this.addCollectionShapeFields(pending, parameter.collection, parameter.name, referenceType, new Set());
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
                this.addCollectionShapeFields(pending, operation.returnCollection, 'result', referenceType, new Set());
            }
        }
        if (journeyStep) {
            const resultPrefixes = new Set<string>();
            for (const description of this.getUnsegmentedScope(context, 'Method').getAllElements()) {
                const queryMethod = description.node;
                if (!isMethod(queryMethod) || !isQueryService(queryMethod.$container)) {
                    continue;
                }
                if (!queryMethod.returnType && !queryMethod.returnPrimitive && !queryMethod.returnCollection) {
                    continue;
                }
                const resultPrefix = `${description.name}.result`;
                if (resultPrefixes.has(resultPrefix)) {
                    continue;
                }
                resultPrefixes.add(resultPrefix);
                this.addSpecificationSymbol(pending, queryMethod, resultPrefix, referenceType);
                const shape = queryMethod.returnType?.ref;
                if (shape && (isDataObject(shape) || isReadModel(shape) || isValueObject(shape))) {
                    this.addShapeFields(pending, shape, resultPrefix, referenceType, new Set());
                }
                if (queryMethod.returnCollection) {
                    this.addCollectionShapeFields(pending, queryMethod.returnCollection, resultPrefix, referenceType, new Set());
                }
            }
        }
        return pending;
    }

    getInvocationCompletionCandidates(context: ReferenceInfo): AstNodeDescription[] {
        return this.pathScope.getInvocationCompletionCandidates(context);
    }

    canInvokeMethod(context: AstNode, target: Method): boolean {
        return this.isSupportedInvocationTarget(context, target);
    }

    private isSupportedInvocationTarget(container: AstNode, target: Method): boolean {
        let source: AstNode | undefined = container;
        while (source && !isMethod(source)) {
            source = source.$container;
        }
        if (!isMethod(source) || isProjector(source.$container)) {
            return false;
        }
        const owner = source.$container;
        const applicationService = isApplicationService(owner) ? owner : undefined;
        const queryService = isQueryService(owner) ? owner : undefined;
        const eventParameters = source.parameters.filter(parameter =>
            isDomainEvent(parameter.type?.ref) || isIntegrationEvent(parameter.type?.ref)
        );
        return getMethodInvocationViolations(source, target, applicationService, queryService, eventParameters, {
            getOwningSharedKernel: node => getOwningSharedKernel(node),
            hasVisibleSharedKernel: (node, sharedKernel) => this.referencePolicy.hasVisibleSharedKernel(node, sharedKernel),
            hasSharedKernelRelationship: (node, sharedKernel) =>
                this.referencePolicy.hasSharedKernelRelationship(node, sharedKernel),
            isCrossContextOwned,
            isEventParameter: parameter => isDomainEvent(parameter.type?.ref) || isIntegrationEvent(parameter.type?.ref),
            getOwningAggregate,
            isAggregateRootMethod: (method, aggregate) =>
                method.$container === aggregate.members.find(member => isEntity(member) && member.root)
        }).length === 0;
    }

    private addShapeFields(
        descriptions: AstNodeDescription[],
        shape: DataObject | ReadModel | ValueObject,
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
            if (field.collection) {
                this.addCollectionShapeFields(descriptions, field.collection, name, referenceType, visited);
            }
        }
        visited.delete(shape);
    }

    private addCollectionShapeFields(
        descriptions: AstNodeDescription[],
        collection: CollectionType,
        prefix: string,
        referenceType: string,
        visited: Set<AstNode>
    ): void {
        const nestedCollection = collection.kind === 'Map' ? collection.valueCollection : collection.elementCollection;
        if (nestedCollection) {
            this.addCollectionShapeFields(descriptions, nestedCollection, prefix, referenceType, visited);
            return;
        }

        const shape = (collection.kind === 'Map' ? collection.valueType : collection.elementType)?.ref;
        if (shape && (isDataObject(shape) || isReadModel(shape) || isValueObject(shape))) {
            this.addShapeFields(descriptions, shape, prefix, referenceType, visited);
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

        if (isJourneyStep(context.container)) {
            const targetModule = getOwningModule(target);
            return !targetModule || isExposedByModule(targetModule, target);
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
                !moduleDependsTransitivelyOn(target, dependencySource);
        }
        if (!sourceModule && targetModule && !isModule(target) &&
            getOwningContextName(context.container) === getOwningContextName(targetModule)) {
            if (!isExposedByModule(targetModule, target)) {
                return false;
            }
        }
        if (sourceModule && targetModule && sourceModule !== targetModule && !isModule(target) &&
            getOwningContextName(sourceModule) === getOwningContextName(targetModule)) {
            const dependsOn = sourceModule.dependencies.some(dependency => dependency.target.ref === targetModule);
            if (!dependsOn || !isExposedByModule(targetModule, target)) {
                return false;
            }
        }

        if (isSpecificationTextPart(context.container)) {
            return this.isSupportedSpecificationCandidate(context, target);
        }

        if (isEventReference(context.container)) {
            return this.isSupportedEventEmission(context, target);
        }

        if (isReadSourceReference(context.container)) {
            return this.isSupportedReadSource(context.container, target);
        }

        if (isAggregateReference(context.container)) {
            return isAggregate(target) && isQueryRepository(context.container.$container) &&
                getOwningContextName(target) === getOwningContextName(context.container);
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
                sourceContext !== targetContext && isIdentifierValueObject(target);
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
            const sharedKernel = getOwningSharedKernel(target);
            return sharedKernel !== undefined &&
                this.referencePolicy.hasSharedKernelRelationship(context.container, sharedKernel);
        }

        if (isIntegrationEvent(target) && isParameter(context.container)) {
            return this.referencePolicy.isIntegrationEventExposed(target) &&
                this.referencePolicy.hasAuthorizedEventRelationship(context.container, target);
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
        const typeContext = this.getTypeContextNode(context.container);
        const field = isField(typeContext) ? typeContext : undefined;
        const parameter = isParameter(typeContext) ? typeContext : undefined;
        const method = isMethod(typeContext) ? typeContext : undefined;

        if (field) {
            const owner = field.$container;
            if (field.identifier && context.container !== field) {
                return false;
            }
            if (field.identifier && (!isValueObject(target) || getOwningAggregate(field) !== target.$container)) {
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
                if (getOwningAggregate(target)) {
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
            const sourceAggregate = getOwningAggregate(field);
            const targetAggregate = isEntity(target) ? getOwningAggregate(target) : undefined;
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
                const sourceAggregate = getOwningAggregate(parent);
                if (isEntity(target) && target.root && getOwningAggregate(target) !== sourceAggregate) {
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

    private isValidRepositoryRootPathCandidate(repository: Repository, target: AstNode): boolean {
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
            if (AstUtils.getContainerOfType(entity, (candidate): candidate is AstNode => candidate === target)) {
                return true;
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
            return isIntegrationEvent(target.$container)
                ? this.referencePolicy.isIntegrationEventExposed(target.$container) &&
                    this.referencePolicy.hasAuthorizedEventRelationship(context.container, target.$container)
                : (isDataObject(target.$container) || isValueObject(target.$container)) &&
                    this.referencePolicy.isPublishedReadResponseType(context.container, target.$container);
        }
        if (isIntegrationEvent(target)) {
            return this.referencePolicy.isIntegrationEventExposed(target) &&
                this.referencePolicy.hasAuthorizedEventRelationship(context.container, target);
        }
        if (isDataObject(target)) {
            return this.referencePolicy.isPublishedReadResponseType(context.container, target);
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
        const current = AstUtils.getContainerOfType(context.container, isMethod);
        if (!current || isCrossContextOwned(current, target)) {
            return false;
        }

        const aggregate = getOwningAggregate(current);
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
        return AstUtils.getContainerOfType(node, (candidate): candidate is AstNode => candidate === ancestor) !== undefined;
    }

    private getDescriptionNode(description: AstNodeDescription): AstNode | undefined {
        return resolveAstNodeDescription(description, this.services);
    }

    private isTypeReference(context: ReferenceInfo): boolean {
        if (!['type', 'returnType', 'elementType', 'valueType', 'typePath', 'returnTypePath', 'elementTypePath', 'valueTypePath']
            .includes(context.property)) {
            return false;
        }
        return this.getTypeContextNode(context.container) !== undefined;
    }

    private getTypeContextNode(node: AstNode): Field | Parameter | Method | undefined {
        return AstUtils.getContainerOfType(node,
            (candidate): candidate is Field | Parameter | Method =>
                isField(candidate) || isParameter(candidate) || isMethod(candidate)
        );
    }

    private isSupportedReadSource(reference: ReadSourceReference, target: AstNode): boolean {
        const method = AstUtils.getContainerOfType(reference, isMethod);
        if (!method) {
            return false;
        }
        const owner = method.$container;
        const sourceContext = getOwningContextName(method);
        const targetContext = getOwningContextName(target);
        if (!sourceContext || !targetContext) {
            return false;
        }
        if (sourceContext === targetContext) {
            if (isApplicationService(owner) || isDomainService(owner)) {
                return isRepository(target);
            }
            if (isQueryService(owner)) {
                return isQueryRepository(target);
            }
            if (isProjector(owner)) {
                return isRepository(target);
            }
            return false;
        }
        if (!(isApplicationService(owner) || isQueryService(owner) || isProjector(owner) || isDomainService(owner))) {
            return false;
        }
        return this.hasPublishedQueryMethodDescendant(target, method);
    }

    private hasPublishedQueryMethodDescendant(candidate: AstNode, source: Method): boolean {
        return this.indexManager.allElements('Method').some(description => {
            const method = description.node;
            return isMethod(method) && isQueryService(method.$container) &&
                getOwningContextName(source) !== getOwningContextName(method) &&
                this.referencePolicy.isQueryServiceExposed(method.$container) &&
                this.referencePolicy.isExposedQueryResult(method) &&
                this.referencePolicy.hasAuthorizedQueryRelationship(source, method) &&
                this.isAstAncestor(candidate, method);
        });
    }

    private getImportableComponents(component: ImportComponent, referenceType: string): AstNodeDescription[] {
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
