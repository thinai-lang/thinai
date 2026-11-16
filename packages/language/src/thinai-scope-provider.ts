import {
    type AstNode,
    type AstNodeDescription,
    AstUtils,
    DefaultScopeProvider,
    type ReferenceInfo,
    type Scope,
    type Stream,
    type LangiumCoreServices,
    type LangiumDocument,
    stream,
    DocumentState,
    UriUtils,
} from 'langium';
import {
    type CollectionType,
    type ContextMap,
    type Constructor,
    type DataObject,
    type DomainEvent,
    type IntegrationEvent,
    type Entity,
    type Exposure,
    type Field,
    type Import,
    type ImportComponent,
    type JourneyStep,
    type Method,
    type Parameter,
    type ReadSourceReference,
    type ReadModel,
    type Repository,
    type Transition,
    type TransitionChange,
    type ValueObject,
    type BoundedContext,
    isAggregate,
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
    isJourney,
    isJourneyActor,
    isJourneyStep,
    isIntegrationEvent,
    isEventReference,
    isEventEmission,
    isReadDependency,
    isPartnershipRelationship,
    isCustomerSupplierRelationship,
    isSeparateWaysRelationship,
    isSharedKernelRelationship,
    isContextMap,
    isSharedKernel,
    isMethod,
    isMethodInvocation,
    isEnumType,
    isTransitionChange,
    isModel,
    isModule,
    isModuleDependency,
    isModuleReference,
    isImportComponent,
    isExposure,
    isNamedDeclarationReference,
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
    isSubdomainReference,
    isValueObject
} from './generated/ast.js';
import { getMethodInvocationViolations } from './thinai-method-invocation-policy.js';
import { isJourneyCommand, isReservedResultParameterName } from './thinai-operation-utils.js';
import {
    areRelationshipPairDefinitionsCompatible,
    createRelationshipPairSemantics,
    getRelationshipPairSemantics,
    type ContextRelationshipPairKind
} from './thinai-context-map-utils.js';
import { ThinaiReferencePolicy } from './thinai-reference-policy.js';
import { ThinaiPathScope } from './thinai-path-scope.js';
import {
    getExportedName,
    getModuleDependencies,
    getOwningAggregate,
    getOwningContextName,
    getOwningModule,
    getOwningSharedKernel,
    isInSharedKernel,
    isCrossContextOwned,
    isBareSpecificationMemberAllowed,
    isExposedByModule,
    isIdentifierValueObject,
    isPublicApiDeclaration,
    isModuleAccessibleFrom,
    moduleDependsTransitivelyOn,
    isModulePubliclyVisible,
    resolveAstNodeDescription,
    resolveImportUri
} from './thinai-scope-utils.js';
import { ThinaiExternalScope } from './thinai-external-scope.js';
import { getTypeReferences } from './thinai-type-utils.js';
import { getJourneySpecificationKind } from './thinai-journey-utils.js';
import {
    getJourneyStepOperation,
    getPriorJourneySteps
} from './thinai-journey-timeline.js';


export class ThinaiScopeProvider extends DefaultScopeProvider {
    private readonly services: LangiumCoreServices;
    private readonly externalScope: ThinaiExternalScope;
    private readonly referencePolicy: ThinaiReferencePolicy;
    private readonly pathScope: ThinaiPathScope;
    private eventPayloadUsageByValueObject: WeakMap<AstNode, 'domain' | 'integration'> | undefined;

    constructor(services: LangiumCoreServices) {
        super(services);
        this.services = services;
        this.externalScope = new ThinaiExternalScope(
            this.reflection,
            this.nameProvider,
            this.descriptions,
            this.indexManager
        );
        const clearCaches = () => {
            this.externalScope.clearCache();
            this.eventPayloadUsageByValueObject = undefined;
            this.referencePolicy.clearCache();
        };
        services.shared.workspace.DocumentBuilder.onUpdate(clearCaches);
        services.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.IndexedContent, clearCaches);
        this.referencePolicy = new ThinaiReferencePolicy(services);
        this.pathScope = new ThinaiPathScope(services, {
            createScope: elements => this.createScope(elements),
            getUnsegmentedScope: (context, referenceType) => this.getUnsegmentedScope(context, referenceType),
            filterCompletionCandidates: (context, candidates) => this.filterCompletionCandidates(context, candidates),
            getDescriptionNode: description => this.getDescriptionNode(description),
            isSupportedInvocationTarget: (container, target) => this.isSupportedInvocationTarget(container, target),
            isSupportedCandidate: (context, target) => this.isSupportedCandidate(context, target),
            isSupportedSpecificationPathSegment: (context, target, terminal) =>
                this.referencePolicy.isVisibleSpecificationPathSegment(context.container, target, terminal),
            isSupportedSpecificationModulePrefix: (context, module, candidate) =>
                this.referencePolicy.isVisibleSpecificationModulePrefix(context.container, module, candidate),
            isJourneyStepTarget: target => this.referencePolicy.isJourneyStepTarget(target)
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
        const declaredReferenceType = this.reflection
            .getTypeMetaData(context.container.$type)
            .properties[context.property]?.referenceType;
        if (!declaredReferenceType) {
            return this.createScope([]);
        }
        const referenceType = declaredReferenceType;
        const pathScope = this.pathScope.getPathScope(context, referenceType);
        if (pathScope) {
            return pathScope;
        }
        if (context.property === 'component' && isImportComponent(context.container)) {
            return this.createScope(this.getImportableComponents(context.container, referenceType));
        }
        return this.getUnsegmentedScope(context, referenceType);
    }

    /**
     * Thinai's outer scopes depend on the referencing document and declaration,
     * so they cannot use Langium's workspace-wide global-scope cache.
     */
    protected override getGlobalScope(referenceType: string, context: ReferenceInfo): Scope {
        const document = AstUtils.getDocument(context.container);
        let result = this.createScope(this.filterUnqualifiedSpecificationTargets(
            context,
            referenceType,
            this.externalScope.getImportedSymbols(context, document, referenceType)
        ));
        result = this.createScope(this.filterUnqualifiedSpecificationTargets(
            context,
            referenceType,
            this.externalScope.getDocumentSymbols(context, document, referenceType)
        ), result);
        const dependencyReference = isModuleReference(context.container);
        const moduleSymbols = dependencyReference
            ? []
            : this.externalScope.getModuleSymbols(context, referenceType);
        return this.createScope(
            this.filterUnqualifiedSpecificationTargets(context, referenceType, moduleSymbols),
            result
        );
    }

    filterCompletionCandidates(context: ReferenceInfo, candidates: Iterable<AstNodeDescription>): Stream<AstNodeDescription> {
        return stream(candidates).filter(description =>
            this.isAllowedUnqualifiedSpecificationTarget(context, description) &&
            this.isAllowedInvocationTarget(context, this.getDescriptionNode(description)) &&
            this.isSupportedCandidate(context, this.getDescriptionNode(description)) &&
            this.isAvailableTransitionField(context, this.getDescriptionNode(description)) &&
            this.isAvailableTransitionState(context, this.getDescriptionNode(description))
        );
    }

    private isAllowedInvocationTarget(context: ReferenceInfo, target: AstNode | undefined): boolean {
        if (!isMethod(target) || context.property !== 'target') {
            return true;
        }
        if (isMethodInvocation(context.container)) {
            return this.canInvokeMethod(context.container, target);
        }
        if (isJourneyStep(context.container)) {
            return this.referencePolicy.isJourneyStepTarget(target);
        }
        return true;
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
        const candidates = this.getUnsegmentedScope(context, 'ExposableDeclaration').getAllElements();
        return this.filterCompletionCandidates(context, candidates).toArray();
    }

    getSpecificationRootCompletionCandidates(context: ReferenceInfo): AstNodeDescription[] {
        return this.pathScope.getSpecificationRootCompletionCandidates(context);
    }

    getPathCompletionCandidates(context: ReferenceInfo, offset?: number): AstNodeDescription[] | undefined {
        return this.pathScope.getPathCompletionCandidates(context, offset);
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

    private filterUnqualifiedSpecificationTargets(
        context: ReferenceInfo,
        referenceType: string,
        candidates: AstNodeDescription[]
    ): AstNodeDescription[] {
        if (referenceType !== 'SpecificationTarget' || !isSpecificationTextPart(context.container)) {
            return candidates;
        }
        return candidates.filter(candidate => this.isAllowedUnqualifiedSpecificationTarget(context, candidate));
    }

    private isAllowedUnqualifiedSpecificationTarget(context: ReferenceInfo, candidate: AstNodeDescription): boolean {
        const target = this.getDescriptionNode(candidate);
        if (!target || !isSpecificationTextPart(context.container)) {
            return true;
        }
        const targetName = 'name' in target && typeof target.name === 'string' ? target.name : undefined;
        return isBareSpecificationMemberAllowed(
            context.container,
            target,
            targetName !== undefined && candidate.name === targetName,
            context.property === 'target'
        );
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
            const target = enclosingOperation.target?.ref;
            operation = isMethod(target) ? target : undefined;
        } else if (isMethod(enclosingOperation) || isConstructor(enclosingOperation)) {
            operation = enclosingOperation;
        }
        if (!operation && !journeyStep) {
            return pending;
        }

        const hasOperationResult = operation !== undefined && isMethod(operation) && (
            operation.returnPrimitive !== undefined ||
            operation.returnType !== undefined ||
            operation.returnCollection !== undefined
        );
        if (operation) {
            for (const parameter of operation.parameters) {
                // `result` is the implicit operation result binding. A colliding
                // parameter is diagnosed by validation, and the implicit binding wins
                // in scope so specification lookups remain unambiguous.
                if (isMethod(operation) && isReservedResultParameterName(operation, parameter.name) &&
                    (hasOperationResult || isJourneyCommand(operation))) {
                    continue;
                }
                this.addSpecificationSymbol(pending, parameter, parameter.name, referenceType);
                this.addTypeShapeSymbols(pending, parameter.type?.ref, parameter.name, referenceType, new Set());
                if (parameter.collection) {
                    this.addCollectionShapeFields(pending, parameter.collection, parameter.name, referenceType, new Set());
                }
            }

            if (isMethod(operation) && !journeyStep) {
                this.addOperationResultSymbols(pending, operation, 'result', referenceType);
            }
        }
        if (journeyStep) {
            // A journey is a timeline. Current inputs are available, but the
            // current step's result only becomes a private binding for later
            // command steps. Query results are independently visible public
            // contracts and are added separately below.
            const methodScope = this.getUnsegmentedScope(context, 'Method');
            const priorSteps = getPriorJourneySteps(journeyStep);
            const seenPriorOperations = new Set<Method>();
            const contractPrefixes = new Set<string>();
            for (const prior of priorSteps.reverse()) {
                const operation = getJourneyStepOperation(prior);
                if (!operation || seenPriorOperations.has(operation)) {
                    continue;
                }
                seenPriorOperations.add(operation);
                const operationPath = [
                    ...prior.path.map(reference => reference.$refText),
                    prior.target?.$refText
                ].filter((text): text is string => typeof text === 'string' && text.length > 0).join('.');
                const spellings = new Set<string>();
                if (operationPath.length > 0) {
                    spellings.add(operationPath);
                }
                const exportedName = getExportedName(operation as AstNode & { name: string });
                if (exportedName) {
                    spellings.add(exportedName);
                }
                for (const description of methodScope.getAllElements()) {
                    if (this.getDescriptionNode(description) === operation) {
                        spellings.add(description.name);
                    }
                }
                for (const spelling of spellings) {
                    if (contractPrefixes.has(spelling)) {
                        continue;
                    }
                    contractPrefixes.add(spelling);
                    this.addJourneyStepContractSymbols(
                        pending,
                        operation,
                        spelling,
                        referenceType
                    );
                }
            }

            const kind = getJourneySpecificationKind(context.container) ?? 'when';
            const resultPrefixes = new Set<string>();
            for (const description of methodScope.getAllElements()) {
                const queryMethod = this.getDescriptionNode(description);
                if (!isMethod(queryMethod) || !isQueryService(queryMethod.$container)) {
                    continue;
                }
                if (!this.referencePolicy.isJourneyVisibleTarget(journeyStep, queryMethod, kind)) {
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
                this.addTypeShapeSymbols(pending, queryMethod.returnType?.ref, resultPrefix, referenceType, new Set());
                if (queryMethod.returnCollection) {
                    this.addCollectionShapeFields(pending, queryMethod.returnCollection, resultPrefix, referenceType, new Set());
                }
            }
        }
        return pending;
    }

    private addOperationResultSymbols(
        descriptions: AstNodeDescription[],
        operation: Method,
        prefix: string,
        referenceType: string
    ): void {
        const resultType = operation.returnType?.ref;
        if (resultType || operation.returnPrimitive || operation.returnCollection) {
            this.addSpecificationSymbol(descriptions, operation, prefix, referenceType);
        }
        this.addTypeShapeSymbols(descriptions, resultType, prefix, referenceType, new Set());
        if (operation.returnCollection) {
            this.addCollectionShapeFields(descriptions, operation.returnCollection, prefix, referenceType, new Set());
        }
    }

    private addJourneyStepContractSymbols(
        descriptions: AstNodeDescription[],
        operation: Method,
        prefix: string,
        referenceType: string
    ): void {
        for (const parameter of operation.parameters) {
            const parameterPrefix = `${prefix}.${parameter.name}`;
            this.addSpecificationSymbol(descriptions, parameter, parameterPrefix, referenceType);
            this.addTypeShapeSymbols(descriptions, parameter.type?.ref, parameterPrefix, referenceType, new Set());
            if (parameter.collection) {
                this.addCollectionShapeFields(descriptions, parameter.collection, parameterPrefix, referenceType, new Set());
            }
        }
        this.addOperationResultSymbols(descriptions, operation, `${prefix}.result`, referenceType);
    }

    getInvocationCompletionCandidates(context: ReferenceInfo, offset?: number): AstNodeDescription[] {
        return this.pathScope.getInvocationCompletionCandidates(context, offset);
    }

    canInvokeMethod(context: AstNode, target: Method): boolean {
        return this.isSupportedInvocationTarget(context, target);
    }

    isJourneyStepTarget(target: AstNode): boolean {
        return this.referencePolicy.isJourneyStepTarget(target);
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

    private addTypeShapeSymbols(
        descriptions: AstNodeDescription[],
        type: AstNode | undefined,
        prefix: string,
        referenceType: string,
        visited: Set<AstNode>
    ): void {
        if (!type) {
            return;
        }
        if (isEnumType(type)) {
            for (const value of type.values) {
                this.addSpecificationSymbol(descriptions, value, `${prefix}.${value.name}`, referenceType);
            }
            return;
        }
        if (isEntity(type) || isDataObject(type) || isReadModel(type) || isValueObject(type) ||
            isDomainEvent(type) || isIntegrationEvent(type)) {
            this.addShapeFields(descriptions, type, prefix, referenceType, visited);
        }
    }

    private addShapeFields(
        descriptions: AstNodeDescription[],
        shape: Entity | DataObject | ReadModel | ValueObject | DomainEvent | IntegrationEvent,
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
            this.addTypeShapeSymbols(descriptions, field.type?.ref, name, referenceType, visited);
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
        // Specification paths through a Map follow its value shape. Keys are
        // identity, not navigable data.
        this.addCollectionMemberShape(
            descriptions,
            collection.kind === 'Map' ? collection.valueCollection : collection.elementCollection,
            collection.kind === 'Map' ? collection.valueType?.ref : collection.elementType?.ref,
            prefix,
            referenceType,
            visited
        );
    }

    private addCollectionMemberShape(
        descriptions: AstNodeDescription[],
        nestedCollection: CollectionType | undefined,
        type: AstNode | undefined,
        prefix: string,
        referenceType: string,
        visited: Set<AstNode>
    ): void {
        if (nestedCollection) {
            this.addCollectionShapeFields(descriptions, nestedCollection, prefix, referenceType, visited);
            return;
        }
        this.addTypeShapeSymbols(descriptions, type, prefix, referenceType, visited);
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

        if (isParameter(target) && target.name === 'result' &&
            isMethod(target.$container) && isReservedResultParameterName(target.$container, target.name)) {
            return false;
        }

        if (isImportComponent(context.container) && context.property === 'component') {
            const document = AstUtils.getDocument(context.container);
            const root = document.parseResult.value;
            if (isModel(root)) {
                const currentComponent = context.container;
                const targetUri = AstUtils.getDocument(target).uri.toString();
                for (const importDeclaration of root.imports) {
                    if (importDeclaration.components.length === 0) {
                        const uri = resolveImportUri(document, importDeclaration);
                        if (uri?.toString() === targetUri) {
                            return false;
                        }
                    }
                    for (const component of importDeclaration.components) {
                        if (component !== currentComponent && component.component?.ref === target) {
                            return false;
                        }
                    }
                }
            }
            return true;
        }

        if (isJourneyStep(context.container)) {
            // Journeys are model-level timelines, not modules. Command targets
            // are constrained by command kind and import scope; query targets
            // also need their query service to be context-level or exposed.
            return !isMethod(target) || this.referencePolicy.isJourneyStepTarget(target);
        }

        if (isJourneyActor(context.container) && context.property === 'actor') {
            const journey = context.container.$container;
            return !isJourney(journey) || !journey.actors.some(actorBlock =>
                actorBlock !== context.container && actorBlock.actor?.ref === target
            );
        }

        if (isSubdomainReference(context.container) && context.property === 'target') {
            const boundedContext = context.container.$container;
            return !isBoundedContext(boundedContext) || !boundedContext.subdomains.some(reference =>
                reference !== context.container && reference.target?.ref === target
            );
        }

        const exposure = AstUtils.getContainerOfType(context.container, isExposure);
        const declarationReference = exposure
            ? undefined
            : AstUtils.getContainerOfType(context.container, isNamedDeclarationReference);
        if (exposure || declarationReference) {
            // NamedDeclarationReference nodes are only used by `exposes`
            // clauses. Resolve ownership from the enclosing module even when
            // completion supplies a synthetic reference whose Exposure node
            // has not been parsed yet.
            const owningModule = getOwningModule(exposure ?? declarationReference!);
            if (owningModule === undefined || getOwningModule(target) !== owningModule) {
                return false;
            }
            if (context.property === 'target') {
                const currentDeclaration = AstUtils.getContainerOfType(context.container, isNamedDeclarationReference);
                if (currentDeclaration && owningModule.exposures.some(candidate =>
                    candidate.declarations.some(declaration =>
                        declaration !== currentDeclaration && declaration.target?.ref === target
                    )
                )) {
                    return false;
                }
            }
            return true;
        }

        if (!this.isAvailableContextMapContext(context, target)) {
            return false;
        }

        const sourceModule = getOwningModule(context.container);
        const targetModule = getOwningModule(target);
        const specificationPathContainer = isSpecificationTextPart(context.container) &&
            this.isStructuralSpecificationPathTarget(target) && !this.isTerminalSpecificationSegment(context);
        if (isModuleReference(context.container) && context.property === 'target') {
            // Completion can synthesize a ModuleReference nested inside the
            // parsed one; locate the owning clause instead of using $container.
            const dependencyClause = AstUtils.getContainerOfType(context.container, isModuleDependency);
            if (!dependencyClause) {
                return false;
            }
            const dependencySource = AstUtils.getContainerOfType(dependencyClause, isModule);
            if (!dependencySource) {
                return false;
            }
            const alreadyDependsOn = getModuleDependencies(dependencySource).some(dependency =>
                dependency !== context.container && dependency.target?.ref === target
            );
            return isModule(target) && target !== dependencySource && !alreadyDependsOn &&
                getOwningContextName(dependencySource) === getOwningContextName(target) &&
                !moduleDependsTransitivelyOn(target, dependencySource);
        }
        if (!specificationPathContainer && !sourceModule && targetModule && !isModule(target) &&
            getOwningContextName(context.container) === getOwningContextName(targetModule)) {
            if (!isPublicApiDeclaration(target)) {
                return false;
            }
        }
        if (!specificationPathContainer && sourceModule && targetModule && sourceModule !== targetModule && !isModule(target) &&
            getOwningContextName(sourceModule) === getOwningContextName(targetModule)) {
            if (!isModulePubliclyVisible(sourceModule, targetModule) || !isExposedByModule(targetModule, target)) {
                return false;
            }
        }

        if (isSpecificationTextPart(context.container)) {
            return this.isSupportedSpecificationCandidate(context, target);
        }

        if (isEventReference(context.container)) {
            if (context.property === 'target') {
                const emission = context.container.$container;
                if (isEventEmission(emission) && emission.events.some(candidate =>
                    candidate !== context.container && candidate.target?.ref === target
                )) {
                    return false;
                }
            }
            return this.isSupportedEventEmission(context, target);
        }

        if (isReadSourceReference(context.container)) {
            if (context.property === 'target') {
                const dependency = context.container.$container;
                if (isReadDependency(dependency) && dependency.sources.some(candidate =>
                    candidate !== context.container && candidate.target?.ref === target
                )) {
                    return false;
                }
            }
            return this.isSupportedReadSource(context.container, target);
        }

        if (isAggregateReference(context.container)) {
            const repository = context.container.$container;
            return isAggregate(target) && isQueryRepository(repository) &&
                getOwningContextName(target) === getOwningContextName(context.container) &&
                !repository.sources.some(source =>
                    source !== context.container && source.target?.ref === target
                );
        }

        if (isReadModelReference(context.container)) {
            let current: AstNode | undefined = context.container.$container;
            while (current && !isMethod(current)) {
                current = current.$container;
            }
            if (!isMethod(current) || !isProjector(current.$container)) {
                return false;
            }
            if (context.property === 'target' && current.projects.some(project =>
                project !== context.container && project.target?.ref === target
            )) {
                return false;
            }
            return isReadModel(target)
                ? getOwningContextName(current) === getOwningContextName(target)
                : this.hasReadModelDescendant(target, current);
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
            const sourceSharedKernel = getOwningSharedKernel(context.container);
            if (sourceSharedKernel !== sharedKernel) {
                if (sharedKernel === undefined ||
                    !this.referencePolicy.hasSharedKernelRelationship(context.container, sharedKernel)) {
                    return false;
                }
                const targetModule = getOwningModule(target);
                if (targetModule && !isPublicApiDeclaration(target)) {
                    return false;
                }
            }
            return true;
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
        let kind: Exclude<ContextRelationshipPairKind, 'sharedKernel'> | undefined;
        let otherContext: BoundedContext | undefined;
        let relationship: AstNode | undefined;
        if (container.$type === 'ContextMapEndpoint' && context.property === 'context') {
            const parent = container.$container;
            if (isCustomerSupplierRelationship(parent)) {
                const otherEndpoint = parent.customer === container ? parent.supplier : parent.customer;
                kind = 'customerSupplier';
                otherContext = otherEndpoint?.context?.ref;
                relationship = parent;
            } else if (isPartnershipRelationship(parent)) {
                const otherEndpoint = parent.left === container ? parent.right : parent.left;
                kind = 'partnership';
                otherContext = otherEndpoint?.context?.ref;
                relationship = parent;
            }
        } else if (isSeparateWaysRelationship(container) && (context.property === 'left' || context.property === 'right')) {
            kind = 'separateWays';
            otherContext = context.property === 'left' ? container.right?.ref : container.left?.ref;
            relationship = container;
        }
        if (kind !== undefined) {
            if (otherContext === target) {
                return false;
            }
            const contextMap = relationship ? AstUtils.getContainerOfType(relationship, isContextMap) : undefined;
            if (contextMap && otherContext) {
                const prospective = createRelationshipPairSemantics(kind, otherContext, target);
                if (!prospective) {
                    return false;
                }
                const existing = contextMap.relationships.flatMap(relationship => getRelationshipPairSemantics(relationship));
                if (existing.some(pair => pair.key === prospective.key &&
                    (pair.identity === prospective.identity ||
                        !areRelationshipPairDefinitionsCompatible(pair, prospective)))) {
                    return false;
                }
            }
            return true;
        }
        if (container.$type === 'BoundedContextReference' && context.property === 'target' &&
            isSharedKernelRelationship(container.$container)) {
            const parent = container.$container;
            if (parent.participants.some(participant =>
                participant !== container && participant.target?.ref === target
            )) {
                return false;
            }
            const contextMap = AstUtils.getContainerOfType(parent, isContextMap);
            if (contextMap && isBoundedContext(target)) {
                const selected = parent.participants
                    .map(participant => participant.target?.ref)
                    .filter((candidate): candidate is BoundedContext => isBoundedContext(candidate))
                    .filter(candidate => candidate !== target);
                const existingPairs = contextMap.relationships.flatMap(relationship =>
                    getRelationshipPairSemantics(relationship)
                );
                for (const other of selected) {
                    const key = JSON.stringify([other.name, target.name].sort());
                    if (existingPairs.some(pair => pair.key === key && pair.kind === 'separateWays')) {
                        return false;
                    }
                }
            }
            return true;
        }
        return true;
    }

    private isValidTypeCandidate(context: ReferenceInfo, target: AstNode): boolean {
        const terminalType = ['type', 'returnType', 'elementType', 'valueType'].includes(context.property);
        if (terminalType && !this.isAllowedTypeShape(context, target)) {
            return false;
        }
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
                    const targetModule = getOwningModule(target);
                    if (targetModule !== undefined &&
                        ((!isValueObject(target) && !isEnumType(target)) ||
                            !isExposedByModule(targetModule, target))) {
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
            if (isEntity(target)) {
                const sourceAggregate = getOwningAggregate(parameter);
                const targetAggregate = getOwningAggregate(target);
                if (sourceAggregate !== undefined && sourceAggregate !== targetAggregate) {
                    return false;
                }
                if (isFactory(methodOwner)) {
                    return false;
                }
                if (methodOwner && (isEntity(methodOwner) || isValueObject(methodOwner)) && !sourceAggregate) {
                    return false;
                }
            }
            if (isDataObject(target) && (
                isFactory(methodOwner) ||
                isDomainService(methodOwner) ||
                methodOwner && (isEntity(methodOwner) || isValueObject(methodOwner))
            )) {
                return false;
            }
            if (isConstructor(parent)) {
                if (isDomainEvent(target) || isIntegrationEvent(target) || isDataObject(target)) {
                    return false;
                }
                const sourceAggregate = getOwningAggregate(parent);
                if (isEntity(target) && (!sourceAggregate || getOwningAggregate(target) !== sourceAggregate)) {
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
            if (isEntity(target) && (isEntity(owner) || isValueObject(owner))) {
                const sourceAggregate = getOwningAggregate(method);
                if (!sourceAggregate || sourceAggregate !== getOwningAggregate(target)) {
                    return false;
                }
            }
            if (isDataObject(target) && (
                isDomainService(owner) ||
                isEntity(owner) ||
                isValueObject(owner)
            )) {
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

    private isAllowedTypeShape(context: ReferenceInfo, target: AstNode): boolean {
        if (!isValueObject(target) && !isDataObject(target) && !isReadModel(target) &&
            !isEnumType(target) && !isEntity(target)) {
            return true;
        }
        if (!this.isWellFormedValueShape(target)) {
            return false;
        }

        // A value object that participates in an event payload inherits that
        // event's payload restrictions, even when the type is edited inside its
        // own declaration.
        const eventUsage = this.getEventPayloadUsage(context.container);
        if (eventUsage === 'integration' && !this.isPublicIntegrationPayloadShape(target, new Set())) {
            return false;
        }
        if (eventUsage === 'domain' && !this.isDomainEventPayloadShape(target, new Set())) {
            return false;
        }

        const typeContext = this.getTypeContextNode(context.container);
        if (!typeContext) {
            return true;
        }
        if (isField(typeContext)) {
            const owner = typeContext.$container;
            if (isIntegrationEvent(owner)) {
                return this.isPublicIntegrationPayloadShape(target, new Set());
            }
            if (isDomainEvent(owner)) {
                return this.isDomainEventPayloadShape(target, new Set());
            }
            if (isDataObject(owner)) {
                return !this.shapeContainsEntity(target) && !this.shapeContainsReadModel(target);
            }
            if (isReadModel(owner)) {
                return !this.shapeContainsEntity(target);
            }
            if (isEntity(owner) || isValueObject(owner)) {
                return !this.shapeContainsForeignEntity(target, getOwningAggregate(typeContext));
            }
            return true;
        }

        if (isParameter(typeContext)) {
            const parent = typeContext.$container;
            const owner = parent.$container;
            if (isApplicationService(owner) || isQueryService(owner) || isFactory(owner)) {
                return !this.shapeContainsEntity(target);
            }
            if (isConstructor(parent)) {
                return !this.shapeContainsForeignEntity(target, getOwningAggregate(typeContext));
            }
            if (isEntity(owner) || isValueObject(owner)) {
                return !this.shapeContainsForeignEntity(target, getOwningAggregate(typeContext));
            }
            if (isDomainService(owner)) {
                if (typeContext.collection && (isEntity(target) || this.shapeContainsEntity(target))) {
                    return false;
                }
                if (!isEntity(target) && this.shapeContainsEntity(target)) {
                    return false;
                }
                return true;
            }
            // Projector parameters are constrained to a single event by
            // isValidTypeCandidate/checkMethod.
            return true;
        }

        if (isMethod(typeContext)) {
            const owner = typeContext.$container;
            if (isApplicationService(owner) || isQueryService(owner) || isDomainService(owner)) {
                return !this.shapeContainsEntity(target);
            }
            if (isEntity(owner) || isValueObject(owner)) {
                return !this.shapeContainsForeignEntity(target, getOwningAggregate(typeContext));
            }
            return true;
        }

        return true;
    }

    private getEventPayloadUsage(node: AstNode): 'domain' | 'integration' | undefined {
        const valueObject = AstUtils.getContainerOfType(node, isValueObject);
        if (!valueObject) {
            return undefined;
        }
        return this.getEventPayloadUsageIndex().get(valueObject);
    }

    /**
     * Build one value-object usage index for the whole build instead of
     * scanning every event for every edited value object.
     */
    private getEventPayloadUsageIndex(): WeakMap<AstNode, 'domain' | 'integration'> {
        if (this.eventPayloadUsageByValueObject) {
            return this.eventPayloadUsageByValueObject;
        }
        const index = new WeakMap<AstNode, 'domain' | 'integration'>();
        const markEvent = (event: DomainEvent | IntegrationEvent, usage: 'domain' | 'integration'): void => {
            const visited = new Set<AstNode>();
            const visit = (type: AstNode | undefined): void => {
                if (!type || visited.has(type)) {
                    return;
                }
                if (isValueObject(type) && (usage === 'integration' || !index.has(type))) {
                    index.set(type, usage);
                }
                if (!isValueObject(type) && !isDataObject(type) && !isReadModel(type)) {
                    return;
                }
                visited.add(type);
                for (const field of type.fields) {
                    for (const reference of getTypeReferences(field.type, field.collection)) {
                        visit(reference.ref);
                    }
                }
            };
            for (const field of event.fields) {
                for (const reference of getTypeReferences(field.type, field.collection)) {
                    visit(reference.ref);
                }
            }
        };
        for (const description of this.indexManager.allElements('DomainEvent')) {
            const event = this.getDescriptionNode(description);
            if (isDomainEvent(event)) {
                markEvent(event, 'domain');
            }
        }
        for (const description of this.indexManager.allElements('IntegrationEvent')) {
            const event = this.getDescriptionNode(description);
            if (isIntegrationEvent(event)) {
                markEvent(event, 'integration');
            }
        }
        this.eventPayloadUsageByValueObject = index;
        return index;
    }

    private isWellFormedValueShape(type: AstNode | undefined, visited = new Set<AstNode>()): boolean {
        if (!type || visited.has(type)) {
            return true;
        }
        if (isEntity(type) || isEnumType(type)) {
            return true;
        }
        const shape = type as ValueObject | DataObject | ReadModel;
        const nested = (allowDataObjects: boolean, allowReadModels: boolean): boolean =>
            shape.fields.every(field =>
                getTypeReferences(field.type, field.collection).every(reference => {
                    const target = reference.ref;
                    if (!target) {
                        return true;
                    }
                    if (isDataObject(target) && !allowDataObjects) {
                        return false;
                    }
                    if (isReadModel(target) && !allowReadModels) {
                        return false;
                    }
                    if (isEntity(target)) {
                        return true;
                    }
                    return this.isWellFormedValueShape(target, visited);
                })
            );
        if (isValueObject(type)) {
            visited.add(type);
            const valid = nested(false, false);
            visited.delete(type);
            return valid;
        }
        if (isDataObject(type)) {
            visited.add(type);
            const valid = nested(true, false);
            visited.delete(type);
            return valid;
        }
        if (isReadModel(type)) {
            visited.add(type);
            const valid = nested(false, true);
            visited.delete(type);
            return valid;
        }
        return true;
    }

    private shapeContainsEntity(type: AstNode | undefined, visited = new Set<AstNode>()): boolean {
        if (!type || visited.has(type)) {
            return false;
        }
        if (isEntity(type)) {
            return true;
        }
        if (!isValueObject(type) && !isDataObject(type) && !isReadModel(type)) {
            return false;
        }
        visited.add(type);
        return type.fields.some(field =>
            getTypeReferences(field.type, field.collection).some(reference =>
                this.shapeContainsEntity(reference.ref, visited)
            )
        );
    }

    private shapeContainsReadModel(type: AstNode | undefined, visited = new Set<AstNode>()): boolean {
        if (!type || visited.has(type)) {
            return false;
        }
        if (isReadModel(type)) {
            return true;
        }
        if (!isValueObject(type) && !isDataObject(type)) {
            return false;
        }
        visited.add(type);
        return type.fields.some(field =>
            getTypeReferences(field.type, field.collection).some(reference =>
                this.shapeContainsReadModel(reference.ref, visited)
            )
        );
    }

    private shapeContainsForeignEntity(
        type: AstNode | undefined,
        sourceAggregate: AstNode | undefined,
        visited = new Set<AstNode>()
    ): boolean {
        if (!type || visited.has(type)) {
            return false;
        }
        if (isEntity(type)) {
            return getOwningAggregate(type) !== sourceAggregate;
        }
        if (!isValueObject(type) && !isDataObject(type) && !isReadModel(type)) {
            return false;
        }
        visited.add(type);
        return type.fields.some(field =>
            getTypeReferences(field.type, field.collection).some(reference =>
                this.shapeContainsForeignEntity(reference.ref, sourceAggregate, visited)
            )
        );
    }

    private isPublicIntegrationPayloadShape(type: AstNode | undefined, visited: Set<AstNode>): boolean {
        if (!type || visited.has(type)) {
            return true;
        }
        if (isEntity(type) || isDataObject(type) || isReadModel(type)) {
            return false;
        }
        if (getOwningAggregate(type) !== undefined) {
            return false;
        }
        const module = getOwningModule(type);
        if (module !== undefined && !isPublicApiDeclaration(type)) {
            return false;
        }
        if (isValueObject(type)) {
            visited.add(type);
            return type.fields.every(field =>
                getTypeReferences(field.type, field.collection).every(reference =>
                    this.isPublicIntegrationPayloadShape(reference.ref, visited)
                )
            );
        }
        return true;
    }

    private isDomainEventPayloadShape(type: AstNode | undefined, visited: Set<AstNode>): boolean {
        if (!type || visited.has(type)) {
            return true;
        }
        if (isEntity(type) || isDataObject(type) || isReadModel(type)) {
            return false;
        }
        if (isValueObject(type)) {
            visited.add(type);
            return type.fields.every(field =>
                getTypeReferences(field.type, field.collection).every(reference =>
                    this.isDomainEventPayloadShape(reference.ref, visited)
                )
            );
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
            if (this.isAstAncestor(target, entity)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Structural containers are legitimate intermediate segments of a qualified
     * specification path. Whether the final target is visible is checked on the
     * terminal segment by validation.
     */
    private isSpecificationPathContainer(target: AstNode): boolean {
        return isBoundedContext(target) || isContextMap(target) || isSharedKernel(target) || isModule(target);
    }

    isStructuralSpecificationPathTarget(target: AstNode): boolean {
        return this.isSpecificationPathContainer(target) || isAggregate(target) || isEntity(target) ||
            isApplicationService(target) || isQueryService(target) || isDomainService(target) ||
            isFactory(target) || isProjector(target);
    }

    private isSpecificationPathContainerVisible(context: ReferenceInfo, target: AstNode): boolean {
        const journeyStep = AstUtils.getContainerOfType(context.container, isJourneyStep);
        if (journeyStep) {
            return true;
        }
        const targetSharedKernel = getOwningSharedKernel(target);
        if (targetSharedKernel === undefined) {
            return true;
        }
        const sourceSharedKernel = getOwningSharedKernel(context.container);
        return sourceSharedKernel === targetSharedKernel ||
            this.referencePolicy.hasSharedKernelRelationship(context.container, targetSharedKernel);
    }

    private isSupportedSpecificationCandidate(context: ReferenceInfo, target: AstNode): boolean {
        if (this.isSpecificationPathContainer(target)) {
            return this.isSpecificationPathContainerVisible(context, target);
        }
        if (isField(target) && !(
            isEntity(target.$container) || isValueObject(target.$container) || isDomainEvent(target.$container) ||
            isIntegrationEvent(target.$container) || isReadModel(target.$container) || isDataObject(target.$container)
        )) {
            return false;
        }
        const journeyStep = AstUtils.getContainerOfType(context.container, isJourneyStep);
        if (journeyStep) {
            // Aggregates and entities are private as terminal targets, but they
            // are necessary path containers when a command contract exposes a
            // type declared inside an aggregate.
            if ((isAggregate(target) || isEntity(target)) &&
                !this.isTerminalSpecificationSegment(context)) {
                return true;
            }
            const kind = getJourneySpecificationKind(context.container) ?? 'when';
            return this.referencePolicy.isJourneyVisibleTarget(journeyStep, target, kind);
        }

        // Aggregate and entity containers are structural segments of published
        // contract paths. Their terminal declarations are still checked by the
        // other branches below.
        if ((isAggregate(target) || isEntity(target)) &&
            !this.isTerminalSpecificationSegment(context)) {
            return true;
        }

        if (isMethod(target) && isQueryService(target.$container) &&
            AstUtils.getContainerOfType(context.container, isMethod) !== target) {
            return false;
        }

        const sourceContext = getOwningContextName(context.container);
        const targetContext = getOwningContextName(target);
        if (!sourceContext || !targetContext || sourceContext === targetContext) {
            return true;
        }
        if (isInSharedKernel(target)) {
            const sharedKernel = getOwningSharedKernel(target);
            if (sharedKernel === undefined ||
                !this.referencePolicy.hasSharedKernelRelationship(context.container, sharedKernel)) {
                return false;
            }
            const targetModule = getOwningModule(target);
            return targetModule === undefined || isPublicApiDeclaration(target);
        }
        if (this.referencePolicy.isEventContractTargetVisible(context.container, target) ||
            this.referencePolicy.isIntegrationEventContractTarget(context.container, target)) {
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
        if (isDataObject(target) || isValueObject(target) || isEnumType(target) || isEnumValue(target)) {
            return this.referencePolicy.isPublishedReadResponseType(context.container, target);
        }
        return false;
    }

    private isTerminalSpecificationSegment(context: ReferenceInfo): boolean {
        const part = context.container;
        if (!isSpecificationTextPart(part)) {
            return false;
        }
        if (context.property === 'target') {
            return part.targets.length === 0;
        }
        if (context.property !== 'targets') {
            return false;
        }
        const referenceText = context.reference?.$refText ?? '';
        const index = context.index ?? part.targets.indexOf(context.reference as (typeof part.targets)[number]);
        return index === part.targets.length - 1 && referenceText.length > 0;
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
        const source = AstUtils.getContainerOfType(context.container, isMethod);
        if (!source) {
            return false;
        }
        for (const type of ['DomainEvent', 'IntegrationEvent']) {
            for (const description of this.indexManager.allElements(type)) {
                const event = this.getDescriptionNode(description);
                if (event && this.isEmittableEvent(context, event) &&
                    this.isVisibleFromSource(source, event) && this.isAstAncestor(candidate, event)) {
                    return true;
                }
            }
        }
        return false;
    }

    private hasReadModelDescendant(candidate: AstNode, source: Method): boolean {
        const contextName = getOwningContextName(source);
        if (!contextName) {
            return false;
        }
        for (const description of this.indexManager.allElements('ReadModel')) {
            const readModel = this.getDescriptionNode(description);
            if (isReadModel(readModel) && getOwningContextName(readModel) === contextName &&
                this.isVisibleFromSource(source, readModel) && this.isAstAncestor(candidate, readModel)) {
                return true;
            }
        }
        return false;
    }

    private isVisibleFromSource(source: AstNode, target: AstNode): boolean {
        return this.referencePolicy.isDeclarationVisibleFrom(source, target) &&
            isModuleAccessibleFrom(source, getOwningModule(target));
    }

    private isAstAncestor(ancestor: AstNode, node: AstNode): boolean {
        if (AstUtils.getContainerOfType(node, (candidate): candidate is AstNode => candidate === ancestor) !== undefined) {
            return true;
        }
        // The canonical BoundedContext node is not an AST container of its
        // `in bounded context ... { ... }` contributions; the contribution
        // points at it through a cross-reference instead.
        if (isBoundedContext(ancestor)) {
            const part = AstUtils.getContainerOfType(node, isBoundedContextPart);
            return part?.context?.ref === ancestor;
        }
        return false;
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
        if (!sourceContext || !targetContext || !this.referencePolicy.isDeclarationVisibleFrom(method, target)) {
            return false;
        }
        if (sourceContext === targetContext) {
            if (isApplicationService(owner) || isDomainService(owner) || isProjector(owner)) {
                return this.hasVisibleReadRepositoryDescendant(target, method, 'Repository');
            }
            if (isQueryService(owner)) {
                return this.hasVisibleReadRepositoryDescendant(target, method, 'QueryRepository');
            }
            return false;
        }
        if (!(isApplicationService(owner) || isQueryService(owner) || isProjector(owner) || isDomainService(owner))) {
            return false;
        }
        return this.hasPublishedQueryMethodDescendant(target, method);
    }

    private hasVisibleReadRepositoryDescendant(
        candidate: AstNode,
        source: Method,
        type: 'Repository' | 'QueryRepository'
    ): boolean {
        const sourceContext = getOwningContextName(source);
        if (!sourceContext) {
            return false;
        }
        for (const description of this.indexManager.allElements(type)) {
            const repository = this.getDescriptionNode(description);
            if (!repository || getOwningContextName(repository) !== sourceContext ||
                !this.isAstAncestor(candidate, repository) ||
                !this.isVisibleFromSource(source, repository)) {
                continue;
            }
            return true;
        }
        return false;
    }

    private hasPublishedQueryMethodDescendant(candidate: AstNode, source: Method): boolean {
        return this.indexManager.allElements('Method').some(description => {
            const method = this.getDescriptionNode(description);
            return isMethod(method) && isQueryService(method.$container) &&
                getOwningContextName(source) !== getOwningContextName(method) &&
                this.referencePolicy.isDeclarationVisibleFrom(source, method) &&
                this.referencePolicy.isQueryServiceExposed(method.$container) &&
                this.referencePolicy.isExposedQueryResult(method) &&
                this.referencePolicy.hasAuthorizedQueryRelationship(source, method) &&
                this.isAstAncestor(candidate, method);
        });
    }

    getImportableComponentsForImport(importDeclaration: Import, referenceType: string): AstNodeDescription[] {
        const document = AstUtils.getDocument(importDeclaration);
        const resolvedUri = resolveImportUri(document, importDeclaration);
        return resolvedUri ? this.getImportableComponentsForUri(resolvedUri.toString(), referenceType) : [];
    }

    getImportableComponentsForPath(
        document: LangiumDocument,
        path: string,
        referenceType: string
    ): AstNodeDescription[] {
        const resolvedUri = UriUtils.resolvePath(UriUtils.dirname(document.uri), path);
        return this.getImportableComponentsForUri(resolvedUri.toString(), referenceType);
    }

    private getImportableComponentsForUri(uri: string, referenceType: string): AstNodeDescription[] {
        return this.indexManager.allElements(referenceType, new Set([uri]))
            .filter(description => ['BoundedContext', 'ContextMap', 'SharedKernel'].includes(description.type))
            .toArray();
    }

    private getImportableComponents(component: ImportComponent, referenceType: string): AstNodeDescription[] {
        return this.getImportableComponentsForImport(component.$container, referenceType);
    }


}
