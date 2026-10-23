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
import { getOwningAggregate, getOwningContextName, getOwningModule, isExposedByModule, resolveAstNodeDescription, resolveImportUri } from './thinai-scope-utils.js';
import { getTypeReferences } from './thinai-type-utils.js';
import { isJourneyCommand } from './thinai-operation-utils.js';

/** Shared visibility and cross-context authorization rules for linking, completion, and validation. */
export class ThinaiReferencePolicy {
    constructor(private readonly services: LangiumCoreServices) {}

    isIntegrationEventExposed(event: IntegrationEvent): boolean {
        const module = getOwningModule(event);
        return module === undefined || isExposedByModule(module, event);
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
        const targets = new Set<AstNode>();
        const visited = new Set<AstNode>();
        targets.add(event);
        for (const field of event.fields) {
            targets.add(field);
            for (const reference of getTypeReferences(field.type, field.collection)) {
                this.collectEventContractType(reference.ref, targets, visited);
            }
        }
        return targets;
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
            for (const reference of getTypeReferences(field.type, field.collection)) {
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
            isApplicationService(target) || isQueryService(target)) {
            return true;
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
        if (contractSteps.length > 0) {
            return isJourneyContractTargetVisible(referenceStep, target, kind);
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
        const module = getOwningModule(target);
        return module === undefined || isExposedByModule(module, target);
    }

    /** Containers are valid journey path segments, but not meaningful terminal links. */
    isJourneyPathOnlyTarget(target: AstNode): boolean {
        return isBoundedContext(target) || isContextMap(target) || isSharedKernel(target) || isModule(target) ||
            isApplicationService(target) || isQueryService(target);
    }

    private isJourneyQueryOperationVisible(method: Method): boolean {
        const service = method.$container;
        if (!isQueryService(service)) {
            return false;
        }
        const module = getOwningModule(service);
        return module === undefined || isExposedByModule(module, service);
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
                for (const reference of getTypeReferences(field.type, field.collection)) {
                    visit(reference.ref);
                }
            }
        };
        for (const reference of getTypeReferences(method.returnType, method.returnCollection)) {
            visit(reference.ref);
        }
        return targets;
    }

    isQueryServiceExposed(service: QueryService): boolean {
        const module = getOwningModule(service);
        return module !== undefined && isExposedByModule(module, service);
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
            return module !== undefined && isExposedByModule(module, type);
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
                getTypeReferences(field.type, field.collection).some(reference => includesType(reference.ref))
            );
        };
        return getTypeReferences(method.returnType, method.returnCollection)
            .some(reference => includesType(reference.ref));
    }
}
