import {
    type AstNode,
    type Reference,
    AstUtils,
    DocumentState,
    type ValidationAcceptor,
    type ValidationChecks,
    isReference
} from 'langium';
import type {
    Aggregate,
    Actor,
    ApplicationService,
    BoundedContext,
    BoundedContextPart,
    ContextMap,
    ContextRelationship,
    CollectionType,
    Constructor,
    DataObject,
    DomainEvent,
    DomainService,
    Entity,
    EnumType,
    Factory,
    Import,
    IntegrationEvent,
    Field,
    Journey,
    JourneyStep,
    Method,
    Model,
    Module,
    Parameter,
    Projector,
    QueryRepository,
    ReadDependency,
    QueryService,
    ReadModel,
    Repository,
    Subdomain,
    ThinaiAstType,
    Transition,
    TypeDeclaration,
    ValueObject,
    SharedKernel
} from './generated/ast.js';
import {
    isAggregate,
    isApplicationService,
    isDomainEvent,
    isDomainService,
    isEntity,
    isEnumValue,
    isFactory,
    isField,
    isIntegrationEvent,
    isEnumType,
    isModule,
    isMethod,
    isProjector,
    isDataObject,
    isQueryRepository,
    isParameter,
    isRepository,
    isQueryService,
    isReadModel,
    isSpecificationTextPart,
    isJourneyStep,
    isValueObject
} from './generated/ast.js';
import type { ThinaiServices } from './thinai-module.js';
import {
    getExportedName,
    getOwningAggregate,
    getOwningContextName,
    getOwningModule,
    getOwningSharedKernel,
    isInSharedKernel,
    isCrossContextOwned,
    isExposedByModule,
    isIdentifierValueObject,
    moduleDependsTransitivelyOn
} from './thinai-scope-utils.js';
import { isSyntacticallyComplete } from './thinai-ast-utils.js';
import { getJourneySpecificationKind } from './thinai-journey-utils.js';
import {
    canDeclareProjects,
    canDeclareTransition,
    getEventEmissionMode,
    isJourneyCommand
} from './thinai-operation-utils.js';
import { getCommandContractTypes } from './thinai-journey-timeline.js';
import { validateMethodInvocations } from './thinai-method-invocation-validator.js';
import { ThinaiReferencePolicy } from './thinai-reference-policy.js';
import { ThinaiModelValidator } from './thinai-model-validator.js';
import { ThinaiReadDependencyValidator } from './thinai-read-dependency-validator.js';
import { formatCollectionType, getTypeReferences } from './thinai-type-utils.js';

export function registerValidationChecks(services: ThinaiServices): void {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.ThinaiValidator;
    const checks: ValidationChecks<ThinaiAstType> = {
        Aggregate: validator.checkAggregate,
        AstNode: validator.checkReferences,
        BoundedContext: validator.checkBoundedContext,
        BoundedContextPart: validator.checkBoundedContextPart,
        CollectionType: validator.checkCollectionType,
        Constructor: validator.checkConstructor,
        ContextRelationship: validator.checkContextRelationship,
        ContextMap: [validator.checkNamedDeclaration, validator.checkContextMapRelationships],
        DataObject: validator.checkDataObject,
        DomainEvent: validator.checkDomainEvent,
        DomainService: validator.checkNamedDeclaration,
        Entity: validator.checkEntity,
        EnumType: validator.checkEnumType,
        Factory: validator.checkFactory,
        Field: validator.checkField,
        Import: validator.checkImport,
        IntegrationEvent: validator.checkIntegrationEvent,
        Actor: validator.checkActor,
        Journey: validator.checkJourney,
        ApplicationService: validator.checkApplicationService,
        Method: validator.checkMethod,
        ReadDependency: validator.checkReadDependency,
        Transition: validator.checkTransition,
        Model: [validator.checkModelImports, validator.checkModelLineBreaks],
        Module: validator.checkModule,
        Parameter: validator.checkParameter,
        QueryRepository: validator.checkQueryRepository,
        QueryService: validator.checkQueryService,
        ReadModel: validator.checkReadModel,
        Projector: validator.checkProjector,
        Repository: validator.checkRepository,
        SharedKernel: validator.checkSharedKernel,
        Subdomain: validator.checkNamedDeclaration,
        ValueObject: validator.checkValueObject
    };
    registry.register(checks, validator);
}

export class ThinaiValidator {
    private readonly referencePolicy: ThinaiReferencePolicy;
    private readonly modelValidator: ThinaiModelValidator;
    private readonly readDependencyValidator: ThinaiReadDependencyValidator;
    private duplicateNameCounts: Map<string, number> | undefined;
    private writeRepositoriesByAggregate: Map<Aggregate, Repository[]> | undefined;

    constructor(private readonly services: ThinaiServices) {
        this.referencePolicy = new ThinaiReferencePolicy(services);
        this.modelValidator = new ThinaiModelValidator(
            services,
            this.referencePolicy,
            (node, accept) => this.checkDuplicateDeclaration(node, accept)
        );
        this.readDependencyValidator = new ThinaiReadDependencyValidator(
            this.referencePolicy,
            parameter => this.isEventParameter(parameter)
        );
        const clearWorkspaceCaches = () => {
            this.duplicateNameCounts = undefined;
            this.writeRepositoriesByAggregate = undefined;
        };
        services.shared.workspace.DocumentBuilder.onUpdate(clearWorkspaceCaches);
        services.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Validated, clearWorkspaceCaches);
    }

    checkBoundedContext(context: BoundedContext, accept: ValidationAcceptor): void {
        this.modelValidator.checkBoundedContext(context, accept);
        const seen = new Set<AstNode>();
        for (const reference of context.subdomains) {
            const target = reference.target.ref;
            if (!target) {
                continue;
            }
            if (seen.has(target)) {
                accept('error', `Subdomain '${target.name}' is realized more than once.`, {
                    node: reference,
                    property: 'target'
                });
            }
            seen.add(target);
        }
    }

    checkBoundedContextPart(part: BoundedContextPart, accept: ValidationAcceptor): void {
        this.modelValidator.checkBoundedContextPart(part, accept);
    }

    checkImport(importDeclaration: Import, accept: ValidationAcceptor): void {
        this.modelValidator.checkImport(importDeclaration, accept);
    }

    checkModelImports(model: Model, accept: ValidationAcceptor): void {
        this.modelValidator.checkModelImports(model, accept);
    }

    checkContextMapRelationships(contextMap: ContextMap, accept: ValidationAcceptor): void {
        this.modelValidator.checkContextMapRelationships(contextMap, accept);
    }

    checkModelLineBreaks(model: Model, accept: ValidationAcceptor): void {
        this.modelValidator.checkModelLineBreaks(model, accept);
    }

    checkAggregate(aggregate: Aggregate, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(aggregate, accept);
        const roots = aggregate.members.filter(member => isEntity(member) && member.root);
        if (roots.length !== 1 && isSyntacticallyComplete(aggregate)) {
            accept('error', 'An aggregate must declare exactly one root entity.', {
                node: aggregate,
                property: 'members'
            });
        }
    }

    checkEntity(entity: Entity, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(entity, accept);
        this.checkFieldMethodNameConflicts(entity.fields, entity.methods, accept);
        this.checkDuplicateFieldNames(entity.fields, accept);
        this.checkDuplicateConstructorSignatures(entity.constructors, accept);
        if (isSyntacticallyComplete(entity)) {
            this.checkEntityStateGraph(entity, accept);
        }
        const aggregate = getOwningAggregate(entity);
        if (!aggregate && isSyntacticallyComplete(entity)) {
            accept('error', 'An entity must belong to an aggregate.', {
                node: entity,
                property: 'name'
            });
        }
        const identifierFields = entity.fields.filter(field => field.identifier);
        if (identifierFields.length !== 1 && isSyntacticallyComplete(entity)) {
            accept('error', 'An entity must declare exactly one identifier field.', {
                node: entity,
                property: 'fields'
            });
        }
        const optionalIdentifier = identifierFields.find(field => field.optional);
        if (optionalIdentifier) {
            accept('error', 'An entity identifier field cannot be optional.', {
                node: optionalIdentifier,
                property: 'optional'
            });
        }
        const identifierType = identifierFields[0]?.type?.ref;
        if (identifierType && aggregate && identifierType.$container !== aggregate) {
            accept('error', 'An entity identifier value object must be declared in the same aggregate.', {
                node: identifierFields[0],
                property: 'type'
            });
        }
        if (entity.root) {
            if (!isAggregate(entity.$container)) {
                accept('error', 'A root entity must be declared directly inside an aggregate.', {
                    node: entity,
                    keyword: 'root'
                });
            }
        }
    }

    checkField(field: Field, accept: ValidationAcceptor): void {
        const owner = field.$container;
        const typeReferences = getTypeReferences(field.type, field.collection);
        const isDataObjectField = isDataObject(owner);
        const isReadModelField = isReadModel(owner);
        this.checkCrossContextTypeUse(field, typeReferences, accept);
        // Data-object fields have their own entity/read-model diagnostic below;
        // avoid reporting the same shape violation twice.
        if (!isDataObjectField) {
            this.checkReadModelTypeUse(field, typeReferences, accept, 'type', isReadModelField);
        }
        if (field.identifier && !isEntity(owner)) {
            const message = isDataObjectField
                ? 'Data objects have no entity identity.'
                : isReadModelField
                    ? 'Read-model fields are projection data, not DDD entity identifiers.'
                    : 'Only entity fields may be marked as identifiers.';
            accept('error', message, { node: field, property: 'identifier' });
        }
        if (!isDataObjectField && typeReferences.some(reference => isDataObject(reference.ref))) {
            accept('error', 'Data objects may be used in method signatures or nested in other data objects, not as domain or read-model state.', {
                node: field,
                property: 'type'
            });
        }
        if (isDataObjectField && typeReferences.some(reference =>
            isEntity(reference.ref) || isReadModel(reference.ref)
        )) {
            accept('error', 'Data objects may contain value data, but not entities or read models.', {
                node: field,
                property: 'type'
            });
        }
        if (isReadModelField && typeReferences.some(reference =>
            isEntity(reference.ref)
        )) {
            accept('error', 'Read models must project data rather than reference entity instances.', {
                node: field,
                property: 'type'
            });
        }
        if (field.initialState !== undefined) {
            const stateType = field.type?.ref;
            const initialState = field.initialState.ref;
            if (!isEntity(owner) || !stateType || !isEnumType(stateType) || field.optional) {
                accept('error', 'An initial state must be a declared value of a non-optional enum field on an entity.', {
                    node: field,
                    keyword: 'initial'
                });
            } else if (!isEnumValue(initialState) || initialState.$container !== stateType) {
                accept('error', 'An initial state must be a declared value of a non-optional enum field on an entity.', {
                    node: field,
                    property: 'initialState'
                });
            }
        }
        if (isDomainEvent(owner) || isIntegrationEvent(owner)) {
            if (typeReferences.some(reference => isEntity(reference.ref))) {
                accept('error', 'Event payloads must not expose entity instances; use stable value data instead.', {
                    node: field,
                    property: 'type'
                });
            }
            if (isIntegrationEvent(owner) && typeReferences.some(reference =>
                reference.ref !== undefined && !isEntity(reference.ref) &&
                getOwningAggregate(reference.ref) !== undefined
            )) {
                accept('error', 'An integration-event payload must not expose types owned by an aggregate.', {
                    node: field,
                    property: 'type'
                });
            }
            if (isIntegrationEvent(owner)) {
                const contractModule = getOwningModule(owner);
                const privateContractType = typeReferences.find(reference => {
                    const target = reference.ref;
                    if (!target || isInSharedKernel(target) || getOwningAggregate(target) !== undefined ||
                        (target.$type !== 'ValueObject' && target.$type !== 'EnumType')) {
                        return false;
                    }
                    return !contractModule || getOwningModule(target) !== contractModule ||
                        !isExposedByModule(contractModule, target);
                });
                if (privateContractType) {
                    accept('error', 'Integration-event payload types must be public contract types exposed by their module or belong to a shared kernel.', {
                        node: field,
                        property: 'type'
                    });
                }
            }
        }
        if (isEntity(owner) || isValueObject(owner)) {
            const sourceAggregate = getOwningAggregate(field);
            for (const reference of typeReferences) {
                const target = reference.ref;
                const targetAggregate = target && isEntity(target) ? getOwningAggregate(target) : undefined;
                if (targetAggregate && targetAggregate !== sourceAggregate) {
                    accept('error', 'An aggregate must reference another aggregate through its identifier, not its entity.', {
                        node: field,
                        property: 'type'
                    });
                    break;
                }
            }
        }
        if (!field.identifier || !isEntity(owner)) {
            return;
        }
        const identifierType = field.type?.ref;
        if (!identifierType || !isValueObject(identifierType)) {
            accept('error', 'An identifier field must reference a value object.', {
                node: field,
                property: 'type'
            });
        }
    }

    private checkFieldMethodNameConflicts(fields: Field[], methods: Method[], accept: ValidationAcceptor): void {
        const methodNames = new Set(methods.map(method => method.name));
        for (const field of fields) {
            if (methodNames.has(field.name)) {
                accept('error', `Field and method names cannot both be '${field.name}'.`, {
                    node: field,
                    property: 'name'
                });
            }
        }
    }

    private checkDuplicateFieldNames(fields: Field[], accept: ValidationAcceptor): void {
        const names = new Set<string>();
        for (const field of fields) {
            if (names.has(field.name)) {
                accept('error', `Duplicate field '${field.name}'.`, { node: field, property: 'name' });
            }
            names.add(field.name);
        }
    }

    private checkDuplicateConstructorSignatures(constructors: Constructor[], accept: ValidationAcceptor): void {
        const signatures = new Set<string>();
        for (const constructor of constructors) {
            const parameterSignatures = constructor.parameters.map(parameter => this.getParameterTypeSignature(parameter));
            if (parameterSignatures.some(signature => signature === undefined)) {
                continue;
            }
            const signature = parameterSignatures.join(',');
            if (signatures.has(signature)) {
                accept('error', 'Duplicate constructor signature.', {
                    node: constructor,
                    property: 'parameters'
                });
            }
            signatures.add(signature);
        }
    }

    private getParameterTypeSignature(parameter: Parameter): string | undefined {
        const eventType = this.getEventParameterType(parameter);
        if (eventType) {
            return `event:${getExportedName(eventType as AstNode & { name: string })}`;
        }
        if (parameter.primitive) {
            return parameter.primitive;
        }
        if (parameter.type) {
            return parameter.type.ref
                ? getExportedName(parameter.type.ref as AstNode & { name: string })
                : undefined;
        }
        if (parameter.collection && this.isCompleteCollectionType(parameter.collection)) {
            return this.getCollectionTypeSignature(parameter.collection);
        }
        return undefined;
    }

    private isCompleteCollectionType(collection: CollectionType): boolean {
        const hasElement = collection.elementPrimitive !== undefined || collection.elementType?.ref !== undefined ||
            collection.elementCollection !== undefined && this.isCompleteCollectionType(collection.elementCollection);
        if (!hasElement) {
            return false;
        }
        if (collection.kind !== 'Map') {
            return collection.valuePrimitive === undefined && collection.valueType === undefined &&
                collection.valueCollection === undefined;
        }
        return collection.valuePrimitive !== undefined || collection.valueType?.ref !== undefined ||
            collection.valueCollection !== undefined && this.isCompleteCollectionType(collection.valueCollection);
    }

    private getEventParameterType(parameter: Parameter): DomainEvent | IntegrationEvent | undefined {
        const target = parameter.type?.ref;
        return isDomainEvent(target) || isIntegrationEvent(target) ? target : undefined;
    }

    private isEventParameter(parameter: Parameter): boolean {
        return this.getEventParameterType(parameter) !== undefined;
    }

    private getCollectionTypeSignature(collection?: CollectionType): string {
        return formatCollectionType(
            collection,
            reference => getExportedName(reference.ref as AstNode & { name: string }),
            { missingType: '?', mapSeparator: ',' }
        );
    }

    private checkEntityStateGraph(entity: Entity, accept: ValidationAcceptor): void {
        for (const field of entity.fields) {
            const stateType = field.type?.ref;
            if (!stateType || !isEnumType(stateType)) {
                continue;
            }
            const edges = entity.methods.flatMap(method => method.transitions.flatMap(transition =>
                transition.changes
                    .filter(change => change.field?.ref === field && change.from?.ref !== undefined && change.to?.ref !== undefined)
                    .map(change => ({ method, change }))
            ));
            for (const method of entity.methods) {
                const seenEdges = new Set<string>();
                for (const { change } of edges.filter(edge => edge.method === method)) {
                    const from = change.from.ref!.name;
                    const to = change.to.ref!.name;
                    const key = `${from}->${to}`;
                    if (seenEdges.has(key)) {
                        accept('warning', `Duplicate state transition '${from} -> ${to}' for '${field.name}' in the same method.`, {
                            node: change,
                            property: 'from'
                        });
                    }
                    seenEdges.add(key);
                }
            }

            const initialState = field.initialState?.ref;
            if (!isEnumValue(initialState)) {
                continue;
            }
            const reachable = new Set<string>([initialState.name]);
            let changed = true;
            while (changed) {
                changed = false;
                for (const { change } of edges) {
                    const from = change.from.ref!.name;
                    const to = change.to.ref!.name;
                    if (reachable.has(from) && !reachable.has(to)) {
                        reachable.add(to);
                        changed = true;
                    }
                }
            }
            const unreachable = stateType.values.find(value => !reachable.has(value.name));
            if (unreachable) {
                accept('error', `State '${unreachable.name}' is unreachable from initial state '${initialState.name}'.`, {
                    node: field,
                    property: 'initialState'
                });
            }
        }
    }

    checkEnumType(enumType: EnumType, accept: ValidationAcceptor): void {
        this.checkNamedDeclaration(enumType, accept);
        const names = new Set<string>();
        for (const value of enumType.values) {
            if (names.has(value.name)) {
                accept('error', `Duplicate enum value '${value.name}'.`, { node: value, property: 'name' });
            }
            names.add(value.name);
        }
    }

    checkCollectionType(collection: CollectionType, accept: ValidationAcceptor): void {
        if (!isSyntacticallyComplete(collection) || !collection.$cstNode?.text.trimEnd().endsWith('>')) {
            return;
        }
        const hasValueType = collection.valuePrimitive !== undefined || collection.valueType !== undefined || collection.valueCollection !== undefined;
        const hasElementType = collection.elementPrimitive !== undefined || collection.elementType !== undefined || collection.elementCollection !== undefined;
        if (!hasElementType) {
            accept('error', `${collection.kind} requires an element type.`, {
                node: collection,
                property: 'kind'
            });
        }
        if (collection.kind === 'Map' && !hasValueType) {
            accept('error', 'A Map type requires both a key and a value type, for example Map<string, OrderLine>.', {
                node: collection,
                property: 'elementType'
            });
        } else if (collection.kind !== 'Map' && hasValueType) {
            accept('error', `${collection.kind} accepts exactly one element type.`, {
                node: collection,
                property: 'valueType'
            });
        }
    }

    checkMethod(method: Method, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(method, accept);
        this.checkUniqueParameterNames(method.parameters, accept);
        const eventParameters = method.parameters.filter(parameter => this.isEventParameter(parameter));
        const applicationService = isApplicationService(method.$container) ? method.$container : undefined;
        const queryService = isQueryService(method.$container) ? method.$container : undefined;
        const projectorService = isProjector(method.$container) ? method.$container : undefined;
        const domainService = isDomainService(method.$container) ? method.$container : undefined;
        const emissionMode = getEventEmissionMode(method);
        if (method.projects.length > 0 && !canDeclareProjects(method)) {
            accept('error', 'The projects clause is allowed only in projector methods.', {
                node: method,
                keyword: 'projects'
            });
        }
        if (queryService) {
            if (!method.returnPrimitive && !method.returnType && !method.returnCollection &&
                isSyntacticallyComplete(method)) {
                accept('error', 'A query must declare a result type.', {
                    node: method,
                    property: 'returnType'
                });
            }
            if (eventParameters.length > 0) {
                accept('error', 'A query cannot handle events.', {
                    node: eventParameters[0]!,
                    property: 'type'
                });
            }
        }
        if (eventParameters.length > 0) {
            if (!applicationService && !projectorService) {
                accept('error', 'Event-typed method parameters are allowed only on application-service handlers and projectors.', {
                    node: method,
                    property: 'parameters'
                });
            }
            const optionalEventParameter = eventParameters.find(parameter => parameter.optional);
            if (optionalEventParameter) {
                accept('error', 'An event-triggered parameter cannot be optional.', {
                    node: optionalEventParameter,
                    property: 'optional'
                });
            }
            if (eventParameters.length !== 1 || method.parameters.length !== 1) {
                accept('error', 'An event-triggered method must have exactly one event-typed parameter.', {
                    node: method,
                    property: 'parameters'
                });
            }
            const event = this.getEventParameterType(eventParameters[0]);
            if (event && isDomainEvent(event) && getOwningContextName(event) !== getOwningContextName(method)) {
                accept('error', 'A domain event can be handled only in its own bounded context.', {
                    node: eventParameters[0],
                    property: 'type'
                });
            }
            if (event && isIntegrationEvent(event) && isCrossContextOwned(method, event) &&
                !this.referencePolicy.hasAuthorizedEventRelationship(method, event)) {
                accept('error', this.referencePolicy.isIntegrationEventExposed(event)
                    ? 'Consuming this integration event requires an imported context map with an authorized relationship to its producer.'
                    : 'An integration event in a module must be explicitly exposed before another bounded context can consume it.', {
                    node: eventParameters[0],
                    property: 'type'
                });
            }
        }
        if (method.returnType || method.returnCollection) {
            const returnTypes = getTypeReferences(method.returnType, method.returnCollection);
            this.checkCrossContextTypeUse(method, returnTypes, accept, 'returnType');
            this.checkEntityBoundaryUse(method, returnTypes, accept, 'returnType', applicationService !== undefined || queryService !== undefined);
            this.checkReadModelTypeUse(method, returnTypes, accept, 'returnType', queryService !== undefined);
            if (isDomainService(method.$container) && returnTypes.some(reference => isEntity(reference.ref))) {
                accept('error', 'Domain-service methods must return domain values, not aggregate entities.', {
                    node: method,
                    property: 'returnType'
                });
            }
        }
        validateMethodInvocations(method, applicationService, queryService, eventParameters, accept, {
            isSyntacticallyComplete,
            getOwningSharedKernel,
            hasVisibleSharedKernel: (source, sharedKernel) => this.referencePolicy.hasVisibleSharedKernel(source, sharedKernel),
            hasSharedKernelRelationship: (source, sharedKernel) => this.referencePolicy.hasSharedKernelRelationship(source, sharedKernel),
            isCrossContextOwned,
            isEventParameter: parameter => this.isEventParameter(parameter),
            getOwningAggregate,
            isAggregateRootMethod: (target, aggregate) => this.isAggregateRootMethod(target, aggregate)
        });
        if (applicationService && eventParameters.length === 0) {
            this.checkExposedCommandContract(method, accept);
        }
        if (queryService) {
            this.readDependencyValidator.checkQueryServiceMethod(method, queryService, accept);
        }
        if (applicationService) {
            this.readDependencyValidator.checkApplicationServiceReads(method, accept);
        }
        if (domainService) {
            this.readDependencyValidator.checkDomainServiceReads(method, accept);
        }
        if (projectorService) {
            this.readDependencyValidator.checkProjectorMethod(method, projectorService, accept);
        }
        for (const emission of method.emissions) {
            if (queryService) {
                accept('error', 'A query cannot emit events.', {
                    node: emission,
                    keyword: 'emits'
                });
                continue;
            }
            if (emissionMode === undefined) {
                accept('error', 'Only aggregate-root behavior may emit domain events, and only a domain-event handler may emit integration events.', {
                    node: emission,
                    keyword: 'emits'
                });
                continue;
            }
            if (!isSyntacticallyComplete(emission)) {
                continue;
            }
            const emittedEvents = new Set<AstNode>();
            for (const emitted of emission.events) {
                const emittedEvent = emitted?.target?.ref;
                if (!emittedEvent) {
                    continue;
                }
                if (emittedEvents.has(emittedEvent)) {
                    accept('error', `Event '${emittedEvent.name}' is emitted more than once in the same clause.`, {
                        node: emitted,
                        property: 'target'
                    });
                }
                emittedEvents.add(emittedEvent);
                if (isCrossContextOwned(method, emittedEvent)) {
                    accept('error', 'A method may emit only events owned by its bounded context.', {
                        node: emitted,
                        property: 'target'
                    });
                }
                if (emissionMode === 'domain') {
                    if (!isDomainEvent(emittedEvent)) {
                        accept('error', 'Aggregate-root behavior may emit only domain events.', {
                            node: emitted,
                            property: 'target'
                        });
                    }
                } else if (emissionMode === 'integration') {
                    if (!isIntegrationEvent(emittedEvent)) {
                        accept('error', 'A domain-event handler may emit only integration events.', {
                            node: emitted,
                            property: 'target'
                        });
                    }
                }
            }
        }
    }

    private checkExposedCommandContract(method: Method, accept: ValidationAcceptor): void {
        const module = getOwningModule(method);
        if (!module || !isExposedByModule(module, method)) {
            return;
        }
        const contracts = getCommandContractTypes(method);
        const contractTypes = new Set<AstNode>();
        for (const node of [...contracts.inputs, ...contracts.outputs]) {
            if (isValueObject(node) || isDataObject(node) || isEnumType(node)) {
                contractTypes.add(node);
                continue;
            }
            if (isField(node)) {
                const owner = node.$container;
                if (isValueObject(owner) || isDataObject(owner) || isEnumType(owner)) {
                    contractTypes.add(owner);
                }
            }
        }
        const privateTypes = [...contractTypes].filter(type => {
            if (getOwningAggregate(type) !== undefined) {
                return true;
            }
            const typeModule = getOwningModule(type);
            return typeModule !== undefined && !isExposedByModule(typeModule, type);
        });
        const names = [...new Set(privateTypes.map(type => (type as AstNode & { name: string }).name))];
        if (names.length === 0) {
            return;
        }
        accept('warning', `Exposed command '${method.name}' publishes private contract type${names.length === 1 ? '' : 's'}: ${names.join(', ')}. Use public or shared contract types if this is not intended.`, {
            node: method,
            property: 'name',
            code: 'exposed-command-private-contract'
        });
    }

    checkApplicationService(service: ApplicationService, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(service, accept);
    }

    checkQueryService(service: QueryService, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(service, accept);
    }

    checkReadModel(readModel: ReadModel, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(readModel, accept);
        this.checkDuplicateFieldNames(readModel.fields, accept);
    }

    checkDataObject(dataObject: DataObject, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(dataObject, accept);
        this.checkDuplicateFieldNames(dataObject.fields, accept);
    }

    checkProjector(projector: Projector, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(projector, accept);
    }

    checkReadDependency(read: ReadDependency, accept: ValidationAcceptor): void {
        this.readDependencyValidator.checkReadDependency(read, accept);
    }

    checkTransition(transition: Transition, accept: ValidationAcceptor): void {
        const aggregate = getOwningAggregate(transition);
        const method = transition.$container;
        const entity = method.$container;
        if (!aggregate || !canDeclareTransition(method) || !isEntity(entity)) {
            accept('error', 'A state transition must be declared in an entity method inside an aggregate.', {
                node: transition,
                keyword: 'transition'
            });
            return;
        }
        if (!isSyntacticallyComplete(transition)) {
            return;
        }
        const changedFields = new Set<Field>();
        for (const change of transition.changes) {
            const field = change.field?.ref;
            const stateType = field?.type?.ref;
            if (!field || field.$container !== entity || !stateType || !isEnumType(stateType)) {
                accept('error', 'A transition must target an enum field declared on the owning entity.', {
                    node: change,
                    property: 'field'
                });
                continue;
            }
            if (changedFields.has(field)) {
                accept('error', `A transition may change field '${field.name}' only once per statement.`, {
                    node: change,
                    property: 'field'
                });
            }
            changedFields.add(field);
            const from = change.from?.ref;
            const to = change.to?.ref;
            const states = new Set(stateType.values);
            if (from && from === to) {
                accept('error', 'A transition must move to a different state.', {
                    node: change,
                    property: 'to'
                });
            }
            if (!from || !to || !states.has(from) || !states.has(to)) {
                accept('error', `Transition states must be values of ${stateType.name}.`, {
                    node: change,
                    property: !from || !states.has(from) ? 'from' : 'to'
                });
            }
        }
    }

    checkActor(actor: Actor, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(actor, accept);
    }

    checkJourney(journey: Journey, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(journey, accept);
        if (journey.actors.length === 0 && isSyntacticallyComplete(journey)) {
            accept('error', 'A journey must contain at least one actor block.', {
                node: journey,
                property: 'actors'
            });
        }
        const seenActors = new Set<Actor>();
        const seenCommands = new Set<Method>();
        for (const actorBlock of journey.actors) {
            const actor = actorBlock.actor?.ref;
            if (actor) {
                if (seenActors.has(actor)) {
                    accept('error', `Journey actor '${actor.name}' has more than one block in this journey.`, {
                        node: actorBlock,
                        property: 'actor'
                    });
                }
                seenActors.add(actor);
            }
            if (actorBlock.steps.length === 0 && isSyntacticallyComplete(actorBlock)) {
                accept('error', 'An actor block in a journey must contain at least one command step.', {
                    node: actorBlock,
                    property: 'steps'
                });
            }
            for (const step of actorBlock.steps) {
                const target = step.targets.at(-1)?.ref;
                if (isMethod(target) && isJourneyCommand(target)) {
                    if (seenCommands.has(target)) {
                        accept('warning', `Command '${target.name}' is invoked more than once in this journey; references resolve to the nearest prior invocation.`, {
                            node: step,
                            property: 'targets',
                            code: 'duplicate-journey-command'
                        });
                    } else {
                        seenCommands.add(target);
                    }
                }
                if (isSyntacticallyComplete(step)) {
                    this.checkJourneyStep(step, accept);
                }
            }
        }
    }

    private checkJourneyStep(step: JourneyStep, accept: ValidationAcceptor): void {
            const target = step.targets.at(-1)?.ref;
            if (!isMethod(target)) {
                accept('error', 'A journey command path must end at a method.', {
                    node: step,
                    property: 'targets'
                });
                return;
            }
            const method = target;
            if (!isJourneyCommand(method)) {
                accept('error', 'A journey may invoke only user-facing application-service commands, not event handlers or query methods.', {
                    node: step,
                    property: 'targets'
                });
            }
    }

    checkConstructor(constructor: Constructor, accept: ValidationAcceptor): void {
        this.checkUniqueParameterNames(constructor.parameters, accept);
        const sourceAggregate = getOwningAggregate(constructor);
        for (const parameter of constructor.parameters) {
            if (this.isEventParameter(parameter)) {
                accept('error', 'Constructors must not accept events; handle events in application-service methods or projectors.', {
                    node: parameter,
                    property: 'type'
                });
                continue;
            }
            const typeReferences = getTypeReferences(parameter.type as Reference<TypeDeclaration> | undefined, parameter.collection);
            if (typeReferences.some(reference => isDataObject(reference.ref))) {
                accept('error', 'Constructors must accept domain values, not DataObjects; map DataObjects at the application boundary.', {
                    node: parameter,
                    property: 'type'
                });
            }
            const foreignRoot = typeReferences.find(reference => {
                const target = reference.ref;
                return isEntity(target) && target.root && getOwningAggregate(target) !== sourceAggregate;
            });
            if (foreignRoot) {
                accept('error', 'A constructor must reference another aggregate through its identifier, not its root entity.', {
                    node: parameter,
                    property: 'type'
                });
            }
        }
    }

    private checkUniqueParameterNames(parameters: Parameter[], accept: ValidationAcceptor): void {
        const names = new Set<string>();
        for (const parameter of parameters) {
            if (names.has(parameter.name)) {
                accept('error', `Duplicate parameter '${parameter.name}'.`, {
                    node: parameter,
                    property: 'name'
                });
            }
            names.add(parameter.name);
        }
    }

    checkParameter(parameter: Parameter, accept: ValidationAcceptor): void {
        if (this.isEventParameter(parameter)) {
            return;
        }
        const typeReferences = getTypeReferences(parameter.type as Reference<TypeDeclaration> | undefined, parameter.collection);
        this.checkCrossContextTypeUse(parameter, typeReferences, accept, 'type');
        this.checkEntityBoundaryUse(parameter, typeReferences, accept, 'type',
            isApplicationService(parameter.$container.$container) || isQueryService(parameter.$container.$container));
        this.checkReadModelTypeUse(parameter, typeReferences, accept, 'type', false);
    }

    private checkReadModelTypeUse(
        node: AstNode,
        references: Reference<TypeDeclaration>[],
        accept: ValidationAcceptor,
        property: string,
        allowReadModel: boolean
    ): void {
        for (const reference of references) {
            const target = reference.ref;
            if (!target || !isReadModel(target)) {
                continue;
            }
            if (!allowReadModel) {
                accept('error', 'Read models may be returned by query services or composed into another read model only.', {
                    node,
                    property
                });
                return;
            }
            if (getOwningContextName(node) !== getOwningContextName(target)) {
                accept('error', 'A read model can be used only within its owning bounded context.', {
                    node,
                    property
                });
                return;
            }
        }
    }

    private checkEntityBoundaryUse(
        node: AstNode,
        references: Reference<TypeDeclaration>[],
        accept: ValidationAcceptor,
        property: string,
        applicationServiceSignature: boolean
    ): void {
            const sourceAggregate = getOwningAggregate(node);
        for (const reference of references) {
            const target = reference.ref;
            if (!target || !isEntity(target)) {
                continue;
            }
            const targetAggregate = getOwningAggregate(target);
            const constructorRootParameter = isParameter(node) && node.$container.$type === 'Constructor' && target.root;
            const factoryRootReturn = isMethod(node) && isFactory(node.$container) &&
                property === 'returnType' && target.root;
            const crossesAggregate = sourceAggregate !== undefined && sourceAggregate !== targetAggregate;
            if (applicationServiceSignature ||
                crossesAggregate && !constructorRootParameter && !factoryRootReturn) {
                accept('error', applicationServiceSignature
                    ? 'Application-service signatures must use identifiers or data values, not entity instances.'
                    : 'Reference another aggregate by its identifier, not by passing its entity instance.', {
                    node,
                    property
                });
                return;
            }
        }
    }

    checkValueObject(valueObject: ValueObject, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(valueObject, accept);
        this.checkFieldMethodNameConflicts(valueObject.fields, valueObject.methods, accept);
        this.checkDuplicateFieldNames(valueObject.fields, accept);
        this.checkDuplicateConstructorSignatures(valueObject.constructors, accept);
        if (valueObject.mirrors?.ref) {
            const source = valueObject.mirrors.ref;
            if (!isIdentifierValueObject(source)) {
                accept('error', 'A mirrored value object must target a value object used as an aggregate-root identifier.', {
                    node: valueObject,
                    property: 'mirrors'
                });
            }
            if (getOwningContextName(source) === getOwningContextName(valueObject)) {
                accept('error', 'A mirrored identifier must originate in another bounded context.', {
                    node: valueObject,
                    property: 'mirrors'
                });
            }
        }
    }

    checkModule(module: Module, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(module, accept);
        const seenDependencies = new Set<AstNode>();
        for (const dependency of module.dependencies) {
            const target = dependency.target.ref;
            if (target) {
                if (seenDependencies.has(target)) {
                    accept('error', `Module dependency '${target.name}' is listed more than once.`, {
                        node: dependency,
                        property: 'target'
                    });
                }
                seenDependencies.add(target);
            }
            if (dependency.target.ref === module) {
                accept('error', 'A module cannot depend on itself.', {
                    node: module,
                    property: 'dependencies'
                });
            }
            if (dependency.target.ref && getOwningContextName(dependency.target.ref) !== getOwningContextName(module)) {
                accept('error', 'A module can depend only on another module in the same bounded context.', {
                    node: module,
                    property: 'dependencies'
                });
            }
            if (dependency.target.ref && dependency.target.ref !== module &&
                moduleDependsTransitivelyOn(dependency.target.ref, module)) {
                accept('error', 'Module dependencies cannot contain a cycle.', {
                    node: module,
                    property: 'dependencies'
                });
                break;
            }
        }
        const seenExposures = new Set<AstNode>();
        for (const exposure of module.exposures) {
            for (const declaration of exposure.declarations) {
                const target = declaration.target.ref;
                if (target) {
                    if (seenExposures.has(target)) {
                        accept('error', `Declaration '${target.name}' is exposed more than once.`, {
                            node: declaration,
                            property: 'target'
                        });
                    }
                    seenExposures.add(target);
                }
                if (target && getOwningModule(target) !== module) {
                    accept('error', 'A module may expose only declarations that it owns.', {
                        node: exposure,
                        property: 'declarations'
                    });
                }
            }
        }
    }

    checkSharedKernel(sharedKernel: SharedKernel, accept: ValidationAcceptor): void {
        this.modelValidator.checkSharedKernel(sharedKernel, accept);
    }

    checkReferences(node: import('langium').AstNode, accept: ValidationAcceptor): void {
        AstUtils.streamReferences(node).forEach(referenceInfo => {
            if (!isReference(referenceInfo.reference)) {
                return;
            }
            const target = referenceInfo.reference.ref;
            if (!target) {
                return;
            }
            if (isField(target) && !isEntity(target.$container) && !isValueObject(target.$container) &&
                !isDomainEvent(target.$container) && !isIntegrationEvent(target.$container) && !isReadModel(target.$container) &&
                !isDataObject(target.$container)) {
                accept('error', 'Specification text can reference only declared domain, event, data-object, or read-model fields.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property
                });
                return;
            }
            const isTerminalSpecificationSegment = isSpecificationTextPart(referenceInfo.container) && (
                referenceInfo.property === 'target'
                    ? referenceInfo.container.targets.length === 0
                    : referenceInfo.property === 'targets' &&
                        referenceInfo.index === referenceInfo.container.targets.length - 1
            );
            const journeyStep = AstUtils.getContainerOfType(referenceInfo.container, isJourneyStep);
            if (isSpecificationTextPart(referenceInfo.container) && journeyStep) {
                const kind = getJourneySpecificationKind(referenceInfo.container) ?? 'when';
                if (isTerminalSpecificationSegment &&
                    !this.referencePolicy.isJourneyVisibleTarget(journeyStep, target, kind)) {
                    accept('error', 'Journey specifications may reference current inputs, prior command results, visible read/query values, and public contracts, but not private aggregate internals, later command results, or private domain events.', {
                        node: referenceInfo.container as AstNode,
                        property: referenceInfo.property
                    });
                }
                return;
            }
            const sourceModule = getOwningModule(referenceInfo.container);
            const targetModule = getOwningModule(target);
            const crossesContext = isCrossContextOwned(referenceInfo.container, target);
            const isSpecificationReference = isSpecificationTextPart(referenceInfo.container);
            const isEventContractTarget = isSpecificationReference &&
                this.referencePolicy.isEventContractTargetVisible(referenceInfo.container, target);
            if (isSpecificationReference && crossesContext && isInSharedKernel(target)) {
                const sharedKernel = getOwningSharedKernel(target);
                const sourceSharedKernel = getOwningSharedKernel(referenceInfo.container);
                if (sharedKernel && sourceSharedKernel !== sharedKernel &&
                    !this.referencePolicy.hasSharedKernelRelationship(referenceInfo.container, sharedKernel)) {
                    accept('error', 'Using a shared-kernel declaration in specification text requires an imported context map that declares a shared-kernel relationship for this context.', {
                        node: referenceInfo.container as AstNode,
                        property: referenceInfo.property
                    });
                    return;
                }
                if (sharedKernel && sourceSharedKernel !== sharedKernel && targetModule &&
                    !isExposedByModule(targetModule, target)) {
                    accept('error', 'Using a module declaration from a shared kernel requires the module to expose that declaration.', {
                        node: referenceInfo.container as AstNode,
                        property: referenceInfo.property
                    });
                    return;
                }
            }
            if (isField(target) && crossesContext && !isInSharedKernel(target) && !isEventContractTarget) {
                const event = isIntegrationEvent(target.$container) ? target.$container : undefined;
                const authorizedPublicField = event !== undefined && this.referencePolicy.isIntegrationEventExposed(event) &&
                    this.referencePolicy.hasAuthorizedEventRelationship(referenceInfo.container, event);
                const publishedReadField = (isDataObject(target.$container) || isValueObject(target.$container)) &&
                    this.referencePolicy.isPublishedReadResponseType(referenceInfo.container, target.$container);
                if (!authorizedPublicField && !publishedReadField) {
                    accept('error', isDomainEvent(target.$container)
                        ? 'Specification text cannot reference a private DomainEvent field from another bounded context.'
                        : 'Specification text cannot reference a private field from another bounded context.', {
                        node: referenceInfo.container,
                        property: referenceInfo.property
                    });
                    return;
                }
            }
            if (isSpecificationTextPart(referenceInfo.container) && target.$type === 'Method' &&
                crossesContext && !isInSharedKernel(target)) {
                accept('error', 'Specification text cannot reference a private method from another bounded context.', {
                    node: referenceInfo.container as AstNode,
                    property: referenceInfo.property
                });
                return;
            }
            if (isSpecificationReference && crossesContext && !isInSharedKernel(target) &&
                (isAggregate(target) || isEntity(target) || isValueObject(target) || isEnumType(target) || isEnumValue(target) ||
                    isRepository(target) || isQueryRepository(target) || isParameter(target) || isDataObject(target) || isReadModel(target) ||
                    isTerminalSpecificationSegment && (
                        isApplicationService(target) || isDomainService(target) || isQueryService(target) ||
                        isProjector(target) || isFactory(target) || isModule(target)
                    )) &&
                !isEventContractTarget &&
                !this.referencePolicy.isPublishedReadResponseType(referenceInfo.container, target)) {
                accept('error', 'Specification text cannot reference private operation, data, or query types from another bounded context.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property
                });
                return;
            }
            if (isSpecificationReference && isDomainEvent(target) && crossesContext) {
                accept('error', 'Specification text cannot reference a private DomainEvent from another bounded context.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property
                });
                return;
            }
            if (isSpecificationReference && isIntegrationEvent(target) && crossesContext &&
                (!this.referencePolicy.isIntegrationEventExposed(target) ||
                    !this.referencePolicy.hasAuthorizedEventRelationship(referenceInfo.container, target))) {
                accept('error', 'Cross-context IntegrationEvent references require an exposed contract and an authorized context-map relationship.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property
                });
                return;
            }
            if (!sourceModule && targetModule && !isModule(target) &&
                getOwningContextName(referenceInfo.container) === getOwningContextName(targetModule)) {
                if (!isExposedByModule(targetModule, target)) {
                    accept('error', 'A declaration outside a module may reference a module declaration only when its module exposes it.', {
                        node: referenceInfo.container,
                        property: referenceInfo.property
                    });
                    return;
                }
            }
            if (!sourceModule || !targetModule || sourceModule === targetModule || isModule(target)) {
                return;
            }
            if (getOwningContextName(sourceModule) !== getOwningContextName(targetModule)) {
                return;
            }
            const dependsOn = sourceModule.dependencies.some(dependency => dependency.target.ref === targetModule);
            if (!dependsOn || !isExposedByModule(targetModule, target)) {
                accept('error', 'This module reference requires a dependency on a module that exposes the target declaration.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property
                });
            }
        });
    }

    checkRepository(repository: Repository, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(repository, accept);
        const root = repository.root?.ref;
        const aggregate = root ? getOwningAggregate(root) : undefined;
        if (!isEntity(root) || !root.root || !aggregate) {
            if (!isSyntacticallyComplete(repository)) {
                return;
            }
            accept('error', 'A repository must manage an aggregate-root entity.', {
                node: repository,
                property: 'root'
            });
            return;
        }
        if (isCrossContextOwned(repository, root)) {
            accept('error', 'A repository and its aggregate root must belong to the same bounded context.', {
                node: repository,
                property: 'root'
            });
        }
        const writeRepositories = this.getWriteRepositoriesByAggregate().get(aggregate) ?? [];
        if (writeRepositories.length > 1) {
            const otherRepository = writeRepositories.find(candidate => candidate !== repository);
            accept('error', `Aggregate '${aggregate.name}' already has write repository '${otherRepository?.name ?? 'another repository'}'; '${repository.name}' is a second write repository.`, {
                node: repository,
                property: 'name',
                code: 'duplicate-write-repository'
            });
        }
    }

    checkQueryRepository(repository: QueryRepository, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(repository, accept);
        if (repository.readModel?.ref && getOwningContextName(repository.readModel.ref) !== getOwningContextName(repository)) {
            accept('error', 'A query repository and its read model must belong to the same bounded context.', {
                node: repository,
                property: 'readModel'
            });
        }
        const seen = new Set<Aggregate>();
        for (const source of repository.sources) {
            const aggregate = source.target.ref;
            if (!aggregate) {
                continue;
            }
            if (getOwningContextName(aggregate) !== getOwningContextName(repository)) {
                accept('error', 'A query repository may read aggregate table data only from its own bounded context.', {
                    node: source,
                    property: 'target'
                });
            }
            if (seen.has(aggregate)) {
                accept('error', `Aggregate '${aggregate.name}' is listed more than once as a query-repository source.`, {
                    node: source,
                    property: 'target'
                });
            }
            seen.add(aggregate);
        }
    }

    private isAggregateRootMethod(method: Method, aggregate: Aggregate): boolean {
        const root = aggregate.members.find(member => isEntity(member) && member.root);
        return isEntity(root) && method.$container === root;
    }

    checkFactory(factory: Factory, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(factory, accept);
        for (const method of factory.methods) {
            const result = method.returnType?.ref;
            if (isSyntacticallyComplete(method) &&
                (!isEntity(result) || !result.root || !getOwningAggregate(result) || isCrossContextOwned(factory, result))) {
                accept('error', 'A factory method must return an aggregate-root entity in its own bounded context.', {
                    node: method,
                    property: 'returnType'
                });
            }
        }
    }

    checkContextRelationship(relationship: ContextRelationship, accept: ValidationAcceptor): void {
        this.modelValidator.checkContextRelationship(relationship, accept);
    }

    checkDomainEvent(event: DomainEvent, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(event, accept);
        this.checkDuplicateFieldNames(event.fields, accept);
    }

    checkIntegrationEvent(event: IntegrationEvent, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(event, accept);
        this.checkDuplicateFieldNames(event.fields, accept);
    }

    checkNamedDeclaration(
        node: Aggregate | ApplicationService | BoundedContext | ContextMap | DomainEvent | DomainService | Entity | EnumType |
        Actor | DataObject | Factory | IntegrationEvent | Journey | Module | Projector | QueryRepository | QueryService | ReadModel | Repository | SharedKernel | Subdomain | ValueObject,
        accept: ValidationAcceptor
    ): void {
        this.checkDuplicateDeclaration(node, accept);
    }

    private checkDuplicateDeclaration(
        node: Aggregate | ApplicationService | BoundedContext | ContextMap | DomainEvent | DomainService | Entity | EnumType |
        Actor | DataObject | Factory | IntegrationEvent | Journey | Method | Module | Projector | QueryRepository | QueryService | ReadModel | Repository | SharedKernel | Subdomain | ValueObject,
        accept: ValidationAcceptor
    ): void {
        const name = getExportedName(node);
        if ((this.getDuplicateNameCounts().get(name) ?? 0) < 2) {
            return;
        }

        accept('error', `Duplicate declaration '${name}'.`, {
            node,
            property: 'name'
        });
    }

    private getDuplicateNameCounts(): Map<string, number> {
        if (!this.duplicateNameCounts) {
            const counts = new Map<string, number>();
            for (const description of this.services.shared.workspace.IndexManager.allElements()) {
                counts.set(description.name, (counts.get(description.name) ?? 0) + 1);
            }
            this.duplicateNameCounts = counts;
        }
        return this.duplicateNameCounts;
    }

    private getWriteRepositoriesByAggregate(): Map<Aggregate, Repository[]> {
        if (!this.writeRepositoriesByAggregate) {
            const repositories = new Map<Aggregate, Repository[]>();
            for (const document of this.services.shared.workspace.LangiumDocuments.all) {
                const root = document.parseResult.value;
                if (!root) {
                    continue;
                }
                for (const repository of AstUtils.streamAst(root).filter(isRepository)) {
                    const aggregate = repository.root.ref ? getOwningAggregate(repository.root.ref) : undefined;
                    if (!aggregate) {
                        continue;
                    }
                    const existing = repositories.get(aggregate) ?? [];
                    existing.push(repository);
                    repositories.set(aggregate, existing);
                }
            }
            this.writeRepositoriesByAggregate = repositories;
        }
        return this.writeRepositoriesByAggregate;
    }

    private checkCrossContextTypeUse(
        node: AstNode,
        references: Reference<TypeDeclaration>[],
        accept: ValidationAcceptor,
        property = 'type'
    ): void {
        const sourceContext = getOwningContextName(node);
        for (const reference of references) {
            const target = reference.ref;
            if (!target) {
                continue;
            }
            if (isInSharedKernel(target)) {
                const sharedKernel = getOwningSharedKernel(target);
                const sourceSharedKernel = getOwningSharedKernel(node);
                if (sourceContext && sourceSharedKernel !== sharedKernel &&
                    (!sharedKernel || !this.referencePolicy.hasSharedKernelRelationship(node, sharedKernel))) {
                    accept('error', 'Using a shared-kernel type requires an imported context map that declares a shared-kernel relationship for this context.', {
                        node,
                        property
                    });
                    return;
                }
                const targetModule = getOwningModule(target);
                if (sourceSharedKernel !== sharedKernel && targetModule && !isExposedByModule(targetModule, target)) {
                    accept('error', 'Using a module declaration from a shared kernel requires the module to expose that declaration.', {
                        node,
                        property
                    });
                    return;
                }
                continue;
            }
            const targetContext = getOwningContextName(target);
            if (sourceContext && targetContext && sourceContext !== targetContext) {
                const message = isValueObject(target)
                    ? 'A bounded context cannot directly use a private value object from another bounded context; create a local mirror.'
                    : 'A bounded context cannot directly use a private type from another bounded context.';
                accept('error', message, {
                    node,
                    property
                });
                return;
            }
        }
    }

}
