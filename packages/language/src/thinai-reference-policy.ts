import {
    AstUtils,
    type AstNode,
    type LangiumCoreServices,
    type LangiumDocument,
    type URI,
    UriUtils
} from 'langium';
import {
    isAggregate,
    isApplicationService,
    isBoundedContext,
    isContextMap,
    isDataObject,
    isDomainEvent,
    isDomainService,
    isEntity,
    isEnumType,
    isEnumValue,
    isFactory,
    isField,
    isIntegrationEvent,
    isJourneyStep,
    isMethod,
    isModel,
    isModule,
    isProjector,
    isQueryRepository,
    isQueryService,
    isReadModel,
    isRepository,
    isSharedKernel,
    isSharedKernelRelationship,
    isSpecificationTextPart,
    isValueObject,
    type ContextMap,
    type ContextRelationship,
    type DomainEvent,
    type IntegrationEvent,
    type JourneyStep,
    type Method,
    type Model,
    type QueryService,
    type SharedKernel,
    type TypeDeclaration
} from './generated/ast.js';
import { isSyntacticallyComplete } from './thinai-ast-utils.js';
import { areRelationshipPairDefinitionsCompatible, getRelationshipPairSemantics } from './thinai-context-map-utils.js';
import {
    getJourneyContractTargetSteps,
    isJourneyContractTargetVisible,
    getJourneyStepCommand,
    getJourneyStepIndex,
    getJourneyStepsFor,
    type JourneySpecificationKind
} from './thinai-journey-timeline.js';
import {
    getOwningAggregate,
    getOwningContextName,
    getOwningModule,
    getOwningSharedKernel,
    isBareSpecificationMemberAllowed,
    isExposedByModule,
    isInSharedKernel,
    isModuleAccessibleFrom,
    isPublicApiDeclaration,
    resolveAstNodeDescription,
    resolveImportUri
} from './thinai-scope-utils.js';
import { getNavigableTypeReferences, getTypeReferences } from './thinai-type-utils.js';
import { isJourneyCommand } from './thinai-operation-utils.js';
import { getJourneySpecificationKind } from './thinai-journey-utils.js';

/** Shared visibility and cross-context authorization rules for linking, completion, and validation. */
export class ThinaiReferencePolicy {
    private eventContractTargetsCache = new WeakMap<AstNode, Set<AstNode>>();

    constructor(private readonly services: LangiumCoreServices) {}

    /**
     * Event contract targets are computed from payload value-object shapes in
     * other documents. Those documents can be reparsed without reparsing the
     * event declaration, so both the scope provider and the validator must
     * invalidate this cache whenever the workspace changes.
     */
    clearCache(): void {
        this.eventContractTargetsCache = new WeakMap();
    }

    isIntegrationEventExposed(event: IntegrationEvent): boolean {
        return isPublicApiDeclaration(event);
    }

    /**
     * A specification inside an event handler may navigate the event payload
     * contract, including nested value objects, data objects, and enum values.
     * Cross-context access still requires an exposed event and an authorized
     * context-map relationship.
     */
    isEventContractTargetVisible(source: AstNode, target: AstNode): boolean {
        const method = AstUtils.getContainerOfType(source, isMethod);
        if (!method) {
            return false;
        }
        for (const parameter of method.parameters) {
            const event = parameter.type?.ref;
            if (!isDomainEvent(event) && !isIntegrationEvent(event)) {
                continue;
            }
            if (!this.getEventContractTargets(event).has(target)) {
                continue;
            }
            if (getOwningContextName(source) === getOwningContextName(event)) {
                return true;
            }
            if (isIntegrationEvent(event) &&
                this.isIntegrationEventExposed(event) &&
                this.hasAuthorizedEventRelationship(source, event)) {
                return true;
            }
        }
        return false;
    }

    private getEventContractTargets(event: DomainEvent | IntegrationEvent): Set<AstNode> {
        const cached = this.eventContractTargetsCache.get(event);
        if (cached) {
            return cached;
        }
        const targets = new Set<AstNode>();
        const visited = new Set<AstNode>();
        targets.add(event);
        for (const field of event.fields) {
            targets.add(field);
            for (const reference of getNavigableTypeReferences(field.type, field.collection)) {
                this.collectEventContractType(reference.ref, targets, visited);
            }
        }
        this.eventContractTargetsCache.set(event, targets);
        return targets;
    }

    /**
     * An IntegrationEvent is a public cross-context contract once it is exposed
     * and authorized. Any method in the consumer context may link its payload
     * shape, not only the event handler that declares the event parameter.
     */
    isIntegrationEventContractTarget(source: AstNode, target: AstNode): boolean {
        return this.isIntegrationEventContractTargetInternal(source, target, true);
    }

    private isJourneyIntegrationEventContractTarget(source: AstNode, target: AstNode): boolean {
        return this.isIntegrationEventContractTargetInternal(source, target, false);
    }

    private isIntegrationEventContractTargetInternal(
        source: AstNode,
        target: AstNode,
        requireAuthorization: boolean
    ): boolean {
        const document = AstUtils.getDocument(source);
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return false;
        }
        const visibleUris = new Set<string>([document.uri.toString()]);
        for (const declaration of model.imports) {
            const uri = resolveImportUri(document, declaration);
            if (uri) {
                visibleUris.add(uri.toString());
            }
        }
        for (const description of this.services.shared.workspace.IndexManager.allElements('IntegrationEvent', visibleUris)) {
            const event = description.node ?? resolveAstNodeDescription(description, this.services);
            if (!isIntegrationEvent(event) || !this.getEventContractTargets(event).has(target) ||
                !this.isIntegrationEventVisibleFrom(source, event) ||
                !this.isIntegrationEventExposed(event)) {
                continue;
            }
            if (getOwningContextName(source) === getOwningContextName(event)) {
                return true;
            }
            if (!requireAuthorization || this.hasAuthorizedEventRelationship(source, event)) {
                return true;
            }
        }
        return false;
    }

    private isIntegrationEventVisibleFrom(source: AstNode, event: IntegrationEvent): boolean {
        return this.isDeclarationVisibleFrom(source, event);
    }

    /**
     * True when the target declaration is reachable from the source document
     * through its direct imports. A bare import exposes the whole imported
     * document; a component import exposes only declarations owned by the
     * selected bounded context, context map, or shared kernel.
     *
     * This mirrors the import visibility used for integration-event contracts
     * and is also used for completion-only structural descendants (for example,
     * a context path that leads to an authorized external query operation).
     */
    isDeclarationVisibleFrom(source: AstNode, target: AstNode): boolean {
        const sourceDocument = AstUtils.getDocument(source);
        const targetDocument = AstUtils.getDocument(target);
        if (UriUtils.equals(sourceDocument.uri, targetDocument.uri)) {
            return true;
        }
        const model = sourceDocument.parseResult.value;
        if (!isModel(model)) {
            return false;
        }
        const targetContext = getOwningContextName(target);
        return model.imports.some(declaration => {
            const uri = resolveImportUri(sourceDocument, declaration);
            if (!uri || !UriUtils.equals(uri, targetDocument.uri)) {
                return false;
            }
            if (declaration.components.length === 0) {
                return true;
            }
            return declaration.components.some(component => {
                const componentTarget = component.component.ref;
                return componentTarget !== undefined &&
                    getOwningContextName(componentTarget) === targetContext;
            });
        });
    }

    /**
     * Path containers in specification prose have their own visibility rules.
     * Modules and operations must be reachable; aggregates and entities are
     * structural containers and are checked through the terminal declaration.
     */
    isVisibleSpecificationPathSegment(source: AstNode, target: AstNode, terminal: boolean): boolean {
        if (isSpecificationTextPart(source)) {
            const targetName = 'name' in target && typeof target.name === 'string' ? target.name : undefined;
            const isFirstSegment = source.target?.ref === target;
            const isBare = isFirstSegment && targetName !== undefined && source.target?.$refText === targetName;
            if (!isBareSpecificationMemberAllowed(source, target, isBare, isFirstSegment)) {
                return false;
            }
        }
        if (terminal) {
            return true;
        }
        if (isModule(target)) {
            return isModuleAccessibleFrom(source, target) || this.isAuthorizedSpecificationContractPath(source);
        }
        if (isMethod(target)) {
            const enclosing = AstUtils.getContainerOfType(source, isMethod);
            if (enclosing === target) {
                return true;
            }
            const journeyStep = AstUtils.getContainerOfType(source, isJourneyStep);
            if (journeyStep) {
                const kind = getJourneySpecificationKind(source) ?? 'when';
                return this.isJourneyVisibleTarget(journeyStep, target, kind);
            }
            if (isQueryService(target.$container)) {
                // Non-journey prose links the published result type or field,
                // not the query operation itself.
                return false;
            }
            if (!isInSharedKernel(target) &&
                getOwningContextName(source) !== getOwningContextName(target)) {
                return false;
            }
            const targetModule = getOwningModule(target);
            if (targetModule === undefined) {
                return true;
            }
            const sourceModule = getOwningModule(source);
            if (sourceModule === targetModule) {
                return true;
            }
            // A method is a declared API member, not a structural container.
            // Reaching it from another module requires the owning module to
            // expose it, just like a terminal method reference.
            return isExposedByModule(targetModule, target) &&
                isModuleAccessibleFrom(source, targetModule);
        }
        const journeyStep = AstUtils.getContainerOfType(source, isJourneyStep);
        if (journeyStep) {
            // Aggregates and entities are structural containers in canonical
            // contract paths. Every other non-terminal segment must be visible
            // in its own right; otherwise private entity/DomainEvent fields and
            // aggregate internals could be used as stepping stones to public
            // declarations.
            if (isAggregate(target) || isEntity(target)) {
                return true;
            }
            const kind = getJourneySpecificationKind(source) ?? 'when';
            return this.isJourneyVisibleTarget(journeyStep, target, kind);
        }
        if (isValueObject(target) || isDataObject(target) || isReadModel(target) ||
            isEnumType(target) || isEnumValue(target) || isField(target)) {
            return this.isVisibleDataBearingSpecificationSegment(source, target);
        }
        return true;
    }

    /**
     * Data-bearing declarations are not free structural containers. Using one
     * as a non-terminal path segment exposes its shape, so the source must
     * reach it through the module API, share its module, or traverse an
     * authorized event/published-query contract.
     */
    private isVisibleDataBearingSpecificationSegment(source: AstNode, target: AstNode): boolean {
        const sourceModule = getOwningModule(source);
        const targetModule = getOwningModule(target);
        if (sourceModule !== undefined && sourceModule === targetModule) {
            return true;
        }
        if (this.isAuthorizedSpecificationContractTarget(source, target)) {
            return true;
        }
        const targetSharedKernel = getOwningSharedKernel(target);
        if (targetSharedKernel !== undefined) {
            const sourceSharedKernel = getOwningSharedKernel(source);
            if (sourceSharedKernel !== targetSharedKernel &&
                !this.hasSharedKernelRelationship(source, targetSharedKernel)) {
                return false;
            }
            // Across shared kernels, only the full public API is a contract.
            // Inside one shared kernel, ordinary module exposure/dependency
            // rules apply, including a direct dependency on a nested module.
            return this.isDeclarationVisibleThroughModule(
                source,
                target,
                sourceSharedKernel !== targetSharedKernel
            );
        }
        if (getOwningContextName(source) !== getOwningContextName(target)) {
            // Cross-context data shapes are reachable only through the event
            // and published-query contracts checked above.
            return false;
        }
        return this.isDeclarationVisibleThroughModule(source, target, false);
    }

    /**
     * Resolves a declaration through its owning module. From another module in
     * the same context, exposure by the owning module plus a direct dependency
     * (or an exposing ancestor) is sufficient; from outside all modules or
     * across contexts, the complete public exposure chain is required.
     */
    private isDeclarationVisibleThroughModule(
        source: AstNode,
        target: AstNode,
        requirePublicChain: boolean
    ): boolean {
        const targetModule = getOwningModule(target);
        if (targetModule === undefined) {
            return true;
        }
        if (getOwningModule(source) === targetModule) {
            return true;
        }
        if (requirePublicChain) {
            return isPublicApiDeclaration(target) &&
                isModuleAccessibleFrom(source, targetModule);
        }
        return isExposedByModule(targetModule, target) &&
            isModuleAccessibleFrom(source, targetModule);
    }

    private getTerminalSpecificationTarget(source: AstNode): AstNode | undefined {
        if (!isSpecificationTextPart(source)) {
            return undefined;
        }
        const reference = source.targets.length > 0 ? source.targets.at(-1) : source.target;
        return reference?.ref;
    }

    private isAuthorizedSpecificationContractPath(source: AstNode): boolean {
        const terminal = this.getTerminalSpecificationTarget(source);
        return terminal !== undefined && this.isAuthorizedSpecificationContractTarget(source, terminal);
    }

    /**
     * True when a candidate terminal is authorized by a command, query, or
     * event contract rather than merely being independently visible. This is
     * used for module prefixes during completion.
     */
    isAuthorizedSpecificationContractTarget(source: AstNode, target: AstNode): boolean {
        const journeyStep = AstUtils.getContainerOfType(source, isJourneyStep);
        if (journeyStep) {
            const kind = getJourneySpecificationKind(source) ?? 'when';
            if (isMethod(target)) {
                return (isJourneyCommand(target) || isQueryService(target.$container)) &&
                    this.isJourneyVisibleTarget(journeyStep, target, kind);
            }
            if (isIntegrationEvent(target)) {
                return this.isIntegrationEventExposed(target);
            }
            const contractSteps = getJourneyContractTargetSteps(journeyStep, target);
            if (contractSteps.length > 0) {
                return isJourneyContractTargetVisible(journeyStep, target, kind);
            }
            return this.isJourneyQueryResultTarget(journeyStep, target) ||
                this.isJourneyIntegrationEventContractTarget(source, target);
        }
        if (this.isEventContractTargetVisible(source, target) ||
            this.isIntegrationEventContractTarget(source, target)) {
            return true;
        }
        const contractType = isField(target) ? target.$container : target;
        return (isDataObject(contractType) || isValueObject(contractType) ||
            isEnumType(contractType) || isEnumValue(contractType)) &&
            this.isPublishedReadResponseType(source, contractType);
    }

    /**
     * Completion-only module prefix check. A private nested module is offered
     * only when the specific terminal candidate under it is contract-authorized.
     */
    isVisibleSpecificationModulePrefix(source: AstNode, module: AstNode, candidate: AstNode | undefined): boolean {
        if (!isModule(module)) {
            return true;
        }
        const journeyStep = AstUtils.getContainerOfType(source, isJourneyStep);
        if (!journeyStep) {
            const sharedKernel = getOwningSharedKernel(module);
            const sourceSharedKernel = getOwningSharedKernel(source);
            if (sharedKernel !== undefined && sourceSharedKernel !== sharedKernel &&
                !this.hasSharedKernelRelationship(source, sharedKernel)) {
                return false;
            }
        }
        return isModuleAccessibleFrom(source, module) ||
            (candidate !== undefined && this.isAuthorizedSpecificationContractTarget(source, candidate));
    }

    private collectEventContractType(
        type: AstNode | undefined,
        targets: Set<AstNode>,
        visited: Set<AstNode>
    ): void {
        if (!type || visited.has(type) || isEntity(type) || isDomainEvent(type) ||
            isIntegrationEvent(type) || isReadModel(type)) {
            return;
        }
        if (!isDataObject(type) && !isValueObject(type) && !isEnumType(type)) {
            return;
        }
        visited.add(type);
        targets.add(type);
        if (isEnumType(type)) {
            for (const value of type.values) {
                targets.add(value);
            }
            return;
        }
        for (const field of type.fields) {
            targets.add(field);
            for (const reference of getNavigableTypeReferences(field.type, field.collection)) {
                this.collectEventContractType(reference.ref, targets, visited);
            }
        }
    }

    /**
     * Journey visibility is command-contract and public-API based. Journeys are
     * model-level command timelines, not module clients; command targets and
     * their contract closure do not require module exposure. Other declarations
     * must be public (context-level or exposed by their module), while aggregate
     * internals, event handlers, query repositories, and domain events remain
     * hidden. Context-map authorization is intentionally not applied here; it
     * governs actual event/query consumption.
     */
    isJourneyVisibleTarget(
        referenceStep: JourneyStep,
        target: AstNode,
        kind: JourneySpecificationKind
    ): boolean {
        if (isBoundedContext(target) || isContextMap(target) || isSharedKernel(target) || isModule(target) ||
            isApplicationService(target)) {
            return true;
        }
        if (isQueryService(target)) {
            return getOwningModule(target) === undefined || this.isQueryServiceExposed(target);
        }
        if (isQueryRepository(target)) {
            return false;
        }
        if (isMethod(target)) {
            const owner = target.$container;
            if (isApplicationService(owner)) {
                if (!isJourneyCommand(target)) {
                    return false;
                }
                const commandSteps = getJourneyStepsFor(referenceStep)
                    .filter(step => getJourneyStepCommand(step) === target);
                if (commandSteps.length === 0) {
                    return true;
                }
                const referenceIndex = getJourneyStepIndex(referenceStep);
                return commandSteps.some(step => getJourneyStepIndex(step) <= referenceIndex);
            }
            if (isQueryService(owner)) {
                return this.isJourneyQueryOperationVisible(target);
            }
            return false;
        }

        const contractSteps = getJourneyContractTargetSteps(referenceStep, target);
        if (contractSteps.length > 0 && isJourneyContractTargetVisible(referenceStep, target, kind)) {
            return true;
        }

        if (isField(target)) {
            const owner = target.$container;
            if (isEntity(owner) || isDomainEvent(owner)) {
                return false;
            }
            if (isIntegrationEvent(owner)) {
                return this.isIntegrationEventExposed(owner);
            }
            if (this.isJourneyQueryResultTarget(referenceStep, target)) {
                return true;
            }
            if (isValueObject(owner) || isDataObject(owner) || isReadModel(owner)) {
                if (getOwningAggregate(owner) !== undefined) {
                    return false;
                }
                return this.isContextLevelOrExposed(owner);
            }
            return false;
        }
        if (isEnumValue(target)) {
            const enumType = target.$container;
            if (this.isJourneyQueryResultTarget(referenceStep, enumType)) {
                return true;
            }
            if (getOwningAggregate(enumType) !== undefined) {
                return false;
            }
            return this.isContextLevelOrExposed(enumType);
        }
        if (isValueObject(target) || isDataObject(target) || isReadModel(target) || isEnumType(target)) {
            if (this.isJourneyQueryResultTarget(referenceStep, target)) {
                return true;
            }
            if (getOwningAggregate(target) !== undefined) {
                return false;
            }
            return this.isContextLevelOrExposed(target);
        }
        if (isIntegrationEvent(target)) {
            return this.isIntegrationEventExposed(target);
        }
        if (isDomainEvent(target) || isEntity(target) || isAggregate(target) || isRepository(target) ||
            isDomainService(target) || isProjector(target) || isFactory(target)) {
            return false;
        }
        return false;
    }

    private isContextLevelOrExposed(target: AstNode): boolean {
        return isPublicApiDeclaration(target);
    }

    /** Containers are valid journey path segments, but not meaningful terminal links. */
    isJourneyPathOnlyTarget(target: AstNode): boolean {
        return isBoundedContext(target) || isContextMap(target) || isSharedKernel(target) || isModule(target) ||
            isApplicationService(target) || isQueryService(target) || isAggregate(target) || isEntity(target);
    }

    private isJourneyQueryOperationVisible(method: Method): boolean {
        const service = method.$container;
        if (!isQueryService(service)) {
            return false;
        }
        return getOwningModule(service) === undefined || this.isQueryServiceExposed(service);
    }

    private isJourneyQueryResultTarget(referenceStep: JourneyStep, target: AstNode): boolean {
        const sourceDocument = AstUtils.getDocument(referenceStep);
        const model = sourceDocument.parseResult.value;
        if (!isModel(model)) {
            return false;
        }
        const contractTarget = isEnumValue(target) ? target.$container : target;
        for (const description of this.services.shared.workspace.IndexManager.allElements('Method')) {
            const method = description.node ?? resolveAstNodeDescription(description, this.services);
            if (!isMethod(method) || !isQueryService(method.$container) ||
                !this.isJourneyQueryOperationVisible(method)) {
                continue;
            }
            const methodDocument = AstUtils.getDocument(method);
            if (!UriUtils.equals(sourceDocument.uri, methodDocument.uri) &&
                !this.importsDocument(model, sourceDocument, methodDocument.uri)) {
                continue;
            }
            if (this.getQueryResultTargets(method).has(contractTarget)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Computes the recursively reachable result shape of a query operation.
     * Result shapes are contract data, so entities and events are excluded just
     * like command contracts.
     */
    private getQueryResultTargets(method: Method): Set<AstNode> {
        const targets = new Set<AstNode>();
        const visited = new Set<AstNode>();
        const visit = (type: AstNode | undefined): void => {
            if (!type || visited.has(type) || isEntity(type) || isDomainEvent(type) ||
                isIntegrationEvent(type)) {
                return;
            }
            if (!isDataObject(type) && !isValueObject(type) && !isReadModel(type) && !isEnumType(type)) {
                return;
            }
            visited.add(type);
            targets.add(type);
            if (isEnumType(type)) {
                for (const value of type.values) {
                    targets.add(value);
                }
                return;
            }
            for (const field of type.fields) {
                targets.add(field);
                for (const reference of getNavigableTypeReferences(field.type, field.collection)) {
                    visit(reference.ref);
                }
            }
        };
        for (const reference of getNavigableTypeReferences(method.returnType, method.returnCollection)) {
            visit(reference.ref);
        }
        return targets;
    }

    isQueryServiceExposed(service: QueryService): boolean {
        return getOwningModule(service) !== undefined && isPublicApiDeclaration(service);
    }

    isExposedQueryResult(method: Method): boolean {
        if (!method.returnPrimitive && !method.returnType && !method.returnCollection) {
            return false;
        }
        const references = getTypeReferences(method.returnType, method.returnCollection);
        const resultTypes: TypeDeclaration[] = [];
        for (const reference of references) {
            if (!reference.ref) {
                // An incomplete or unresolved result type is not a published
                // contract yet.
                return false;
            }
            resultTypes.push(reference.ref);
        }
        return resultTypes.every(type => {
            if (!isDataObject(type)) {
                return false;
            }
            const module = getOwningModule(type);
            // Context-level DataObjects are public by default, just like
            // context-level integration events and their payload types. Only
            // module-nested result types need an explicit exposure.
            return module === undefined || isExposedByModule(module, type);
        });
    }

    hasVisibleSharedKernel(source: AstNode, sharedKernel: SharedKernel): boolean {
        const model = AstUtils.getDocument(source).parseResult.value;
        if (!isModel(model)) {
            return false;
        }
        if (model.declarations.includes(sharedKernel)) {
            return true;
        }
        const sharedKernelUri = AstUtils.getDocument(sharedKernel).uri;
        return model.imports.some(declaration => {
            const uri = resolveImportUri(AstUtils.getDocument(source), declaration);
            return uri !== undefined && UriUtils.equals(uri, sharedKernelUri) &&
                (declaration.components.length === 0 || declaration.components.some(component =>
                    component.component.ref === sharedKernel
                ));
        });
    }

    hasSharedKernelRelationship(source: AstNode, sharedKernel: SharedKernel): boolean {
        const contextName = getOwningContextName(source);
        const document = AstUtils.getDocument(source);
        const model = document.parseResult.value;
        if (!contextName || !isModel(model)) {
            return false;
        }
        const contextMaps = this.getVisibleContextMaps(model);
        return contextMaps.some(contextMap => contextMap.relationships.some(relationship => {
            if (!isSyntacticallyComplete(relationship) || !isSharedKernelRelationship(relationship) ||
                relationship.sharedKernel?.ref !== sharedKernel) {
                return false;
            }
            const participants = relationship.participants
                .map(participant => participant.target?.ref?.name)
                .filter((name): name is string => name !== undefined);
            if (!participants.includes(contextName)) {
                return false;
            }
            // Conflicting relationship definitions must not authorize shared-kernel
            // use either. Event/query authorization already applies this rule.
            return [...new Set(participants)]
                .filter(participant => participant !== contextName)
                .every(participant =>
                    this.haveCompatibleRelationshipDefinitions(contextMaps, contextName, participant, 'event')
                );
        }));
    }

    hasAuthorizedEventRelationship(source: AstNode, event: IntegrationEvent): boolean {
        return this.isIntegrationEventExposed(event) && this.hasAuthorizedRelationship(source, event, 'event');
    }

    hasAuthorizedQueryRelationship(source: AstNode, target: Method): boolean {
        return this.hasAuthorizedRelationship(source, target, 'query');
    }

    private hasAuthorizedRelationship(source: AstNode, target: AstNode, purpose: 'event' | 'query'): boolean {
        const consumer = getOwningContextName(source);
        const provider = getOwningContextName(target);
        const document = AstUtils.getDocument(source);
        const targetDocument = AstUtils.getDocument(target);
        const model = document.parseResult.value;
        const sameDocument = UriUtils.equals(document.uri, targetDocument.uri);
        if (!consumer || !provider || !isModel(model) ||
            (!sameDocument && !this.importsDocument(model, document, targetDocument.uri))) {
            return false;
        }
        // Local context maps authorize relationships declared in the same
        // document. Imported maps remain required for external declarations.
        const contextMaps = sameDocument ? this.getVisibleContextMaps(model) : this.getImportedContextMaps(model);
        if (!this.haveCompatibleRelationshipDefinitions(contextMaps, consumer, provider, purpose)) {
            return false;
        }
        return contextMaps.some(contextMap => contextMap.relationships.some(relationship =>
            this.authorizesTeamRelationship(relationship, consumer, provider)
        ));
    }

    isPublishedReadResponseType(source: AstNode, type: AstNode): boolean {
        if (!isDataObject(type) && !isValueObject(type) && !isEnumType(type) && !isEnumValue(type)) {
            return false;
        }
        const contractType = isEnumValue(type) ? type.$container : type;
        const method = AstUtils.getContainerOfType(source, (node): node is Method => node.$type === 'Method');
        return method !== undefined && method.reads.some(read => read.sources.some(reference => {
            const query = reference.target?.ref;
            return query?.$type === 'Method' && isQueryService(query.$container) &&
                this.isExposedQueryResult(query) && this.hasQueryResultType(query, contractType) &&
                getOwningContextName(query) !== getOwningContextName(method) &&
                this.isQueryServiceExposed(query.$container) && this.hasAuthorizedQueryRelationship(method, query);
        }));
    }

    getVisibleContextMaps(model: Model): ContextMap[] {
        const contextMaps = new Set(model.declarations.filter(isContextMap));
        for (const contextMap of this.getImportedContextMaps(model)) {
            contextMaps.add(contextMap);
        }
        return [...contextMaps];
    }

    getImportedContextMaps(model: Model): ContextMap[] {
        const contextMaps = new Set<ContextMap>();
        const document = AstUtils.getDocument(model);
        for (const declaration of model.imports) {
            const uri = resolveImportUri(document, declaration);
            if (!uri) {
                continue;
            }
            const importedModel = this.services.shared.workspace.LangiumDocuments.getDocument(uri)?.parseResult.value;
            if (!isModel(importedModel)) {
                continue;
            }
            for (const contextMap of importedModel.declarations.filter(isContextMap)) {
                if (declaration.components.length === 0 || declaration.components.some(component =>
                    component.component.ref === contextMap
                )) {
                    contextMaps.add(contextMap);
                }
            }
        }
        return [...contextMaps];
    }

    private importsDocument(model: Model, document: LangiumDocument, target: URI): boolean {
        return model.imports.some(declaration => {
            const uri = resolveImportUri(document, declaration);
            return uri !== undefined && UriUtils.equals(uri, target);
        });
    }

    private haveCompatibleRelationshipDefinitions(
        contextMaps: ContextMap[],
        left: string,
        right: string,
        purpose: 'event' | 'query'
    ): boolean {
        const pairKey = JSON.stringify([left, right].sort());
        const definitions = contextMaps.flatMap(contextMap => contextMap.relationships.flatMap(relationship =>
            getRelationshipPairSemantics(relationship).filter(pair => pair.key === pairKey)
        ));
        for (let leftIndex = 0; leftIndex < definitions.length; leftIndex++) {
            for (let rightIndex = leftIndex + 1; rightIndex < definitions.length; rightIndex++) {
                if (!areRelationshipPairDefinitionsCompatible(definitions[leftIndex]!, definitions[rightIndex]!)) {
                    return false;
                }
            }
        }
        const teamDefinitions = definitions.filter(pair => pair.kind !== 'sharedKernel');
        if (purpose === 'query' && teamDefinitions.some(pair => pair.kind === 'separateWays')) {
            return false;
        }
        return true;
    }

    private authorizesTeamRelationship(
        relationship: ContextRelationship,
        consumer: string,
        provider: string
    ): boolean {
        if (!isSyntacticallyComplete(relationship)) {
            return false;
        }
        if (relationship.$type === 'CustomerSupplierRelationship') {
            return relationship.customer.context?.ref?.name === consumer &&
                relationship.supplier.context?.ref?.name === provider;
        }
        if (relationship.$type === 'PartnershipRelationship') {
            const left = relationship.left.context?.ref?.name;
            const right = relationship.right.context?.ref?.name;
            return (left === consumer && right === provider) || (right === consumer && left === provider);
        }
        return false;
    }

    private hasQueryResultType(method: Method, type: AstNode): boolean {
        const visited = new Set<AstNode>();
        const includesType = (candidate: AstNode | undefined): boolean => {
            if (candidate === type) {
                return true;
            }
            if ((!isDataObject(candidate) && !isValueObject(candidate)) || visited.has(candidate)) {
                return false;
            }
            visited.add(candidate);
            return candidate.fields.some(field =>
                getNavigableTypeReferences(field.type, field.collection).some(reference => includesType(reference.ref))
            );
        };
        return getNavigableTypeReferences(method.returnType, method.returnCollection)
            .some(reference => includesType(reference.ref));
    }
}
