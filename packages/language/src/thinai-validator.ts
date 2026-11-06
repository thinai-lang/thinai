import {
    type AstNode,
    type LangiumDocument,
    type Reference,
    type ReferenceInfo,
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
    SharedKernel,
    SpecificationTextPart
} from './generated/ast.js';
import {
    isAggregate,
    isActor,
    isApplicationService,
    isBoundedContext,
    isConstructor,
    isContextMap,
    isDomainEvent,
    isDomainService,
    isEntity,
    isEnumValue,
    isFactory,
    isField,
    isIntegrationEvent,
    isEnumType,
    isJourney,
    isModel,
    isModule,
    isMethod,
    isProjector,
    isDataObject,
    isQueryRepository,
    isParameter,
    isRepository,
    isQueryService,
    isReadModel,
    isSharedKernel,
    isSpecificationTextPart,
    isJourneyStep,
    isSubdomain,
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
    isBareSpecificationMemberAllowed,
    isIdentifierValueObject,
    isPublicApiDeclaration,
    moduleDependsTransitivelyOn,
    isModulePubliclyVisible,
    resolveImportUri
} from './thinai-scope-utils.js';
import { isSyntacticallyComplete } from './thinai-ast-utils.js';
import { getJourneySpecificationKind } from './thinai-journey-utils.js';
import {
    canDeclareProjects,
    canDeclareTransition,
    getEventEmissionMode,
    isJourneyCommand,
    isReservedResultParameterName
} from './thinai-operation-utils.js';
import { getCommandContractTypes } from './thinai-journey-timeline.js';
import { validateMethodInvocations } from './thinai-method-invocation-validator.js';
import { ThinaiReferencePolicy } from './thinai-reference-policy.js';
import { ThinaiModelValidator } from './thinai-model-validator.js';
import { ThinaiReadDependencyValidator } from './thinai-read-dependency-validator.js';
import { formatCollectionType, getTypeReferences } from './thinai-type-utils.js';
import { THINAI_KEYWORDS } from './thinai-constants.js';

export function registerValidationChecks(services: ThinaiServices): void {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.ThinaiValidator;
    const checks: ValidationChecks<ThinaiAstType> = {
        Aggregate: validator.checkAggregate,
        AstNode: [validator.checkReferences, validator.checkIdentifierNormalization],
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
        SpecificationTextPart: validator.checkSpecificationTextPart,
        ValueObject: validator.checkValueObject
    };
    registry.register(checks, validator);
}

type DeclarationNameNamespace = 'actor' | 'journey' | 'subdomain' | 'importable' | 'path';

export class ThinaiValidator {
    private readonly referencePolicy: ThinaiReferencePolicy;
    private readonly modelValidator: ThinaiModelValidator;
    private readonly readDependencyValidator: ThinaiReadDependencyValidator;
    private duplicateNameCounts = new WeakMap<LangiumDocument, Map<DeclarationNameNamespace, Map<string, number>>>();
    private writeRepositoriesByAggregate: Map<Aggregate, Repository[]> | undefined;
    private importComponentsByDocument: Map<string, Set<string>> | undefined;

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
            this.duplicateNameCounts = new WeakMap();
            this.writeRepositoriesByAggregate = undefined;
            this.importComponentsByDocument = undefined;
            this.referencePolicy.clearCache();
        };
        services.shared.workspace.DocumentBuilder.onUpdate(clearWorkspaceCaches);
        services.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Validated, clearWorkspaceCaches);
    }

    checkBoundedContext(context: BoundedContext, accept: ValidationAcceptor): void {
        this.modelValidator.checkBoundedContext(context, accept);
        const seen = new Set<AstNode>();
        for (const reference of context.subdomains) {
            if (reference.path.length > 0) {
                accept('error', 'A realized subdomain cannot be qualified; subdomains are top-level declarations.', {
                    node: reference,
                    property: 'path'
                });
            }
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
        if (optionalIdentifier && isSyntacticallyComplete(entity)) {
            accept('error', 'An entity identifier field cannot be optional.', {
                node: optionalIdentifier,
                property: 'optional'
            });
        }
        const identifierType = identifierFields[0]?.type?.ref;
        if (identifierType && aggregate && identifierType.$container !== aggregate && isSyntacticallyComplete(entity)) {
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
        if (field.initialState !== undefined && isSyntacticallyComplete(field)) {
            const stateType = field.type?.ref;
            const initialState = field.initialState.ref;
            const validInitialField = isEntity(owner) && !field.optional && stateType !== undefined && isEnumType(stateType);
            if (!validInitialField) {
                accept('error', 'An initial state must be a declared value of a non-optional enum field on an entity.', {
                    node: field,
                    keyword: 'initial'
                });
            } else if (initialState !== undefined &&
                (!isEnumValue(initialState) || initialState.$container !== stateType)) {
                accept('error', 'An initial state must be a declared value of a non-optional enum field on an entity.', {
                    node: field,
                    property: 'initialState'
                });
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
                const nestedEntity = this.findNestedEntity(target);
                if (nestedEntity && getOwningAggregate(nestedEntity) !== sourceAggregate) {
                    accept('error', sourceAggregate
                        ? 'An aggregate must reference another aggregate through its identifier, not an entity nested in a value object.'
                        : 'A value object must not reference entity instances, including entities nested in another value object.', {
                        node: field,
                        property: 'type'
                    });
                    break;
                }
            }
        }
        if (!field.identifier || !isEntity(owner) || !isSyntacticallyComplete(field)) {
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
        const optional = parameter.optional ? '?' : '';
        const eventType = this.getEventParameterType(parameter);
        if (eventType) {
            return `event:${getExportedName(eventType as AstNode & { name: string })}${optional}`;
        }
        if (parameter.primitive) {
            return `${parameter.primitive}${optional}`;
        }
        if (parameter.type) {
            return parameter.type.ref
                ? `${getExportedName(parameter.type.ref as AstNode & { name: string })}${optional}`
                : undefined;
        }
        if (parameter.collection && this.isCompleteCollectionType(parameter.collection)) {
            return `${this.getCollectionTypeSignature(parameter.collection)}${optional}`;
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

    private getCollectionTypeSignature(collection?: CollectionType, mapSeparator = ','): string {
        return formatCollectionType(
            collection,
            reference => getExportedName(reference.ref as AstNode & { name: string }),
            { missingType: '?', mapSeparator }
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
            const unreachableSources = new Set<string>();
            for (const { change } of edges) {
                const from = change.from.ref!.name;
                if (!reachable.has(from) && !unreachableSources.has(from)) {
                    unreachableSources.add(from);
                    accept('error', `State '${from}' is unreachable from initial state '${initialState.name}'.`, {
                        node: change,
                        property: 'from'
                    });
                }
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

    checkSpecificationTextPart(part: SpecificationTextPart, accept: ValidationAcceptor): void {
        const checkReference = (
            reference: SpecificationTextPart['target'] | SpecificationTextPart['targets'][number],
            property: 'target' | 'targets',
            index?: number
        ): void => {
            if (!isReference(reference)) {
                return;
            }
            const name = reference.$refText;
            if (!THINAI_KEYWORDS.has(name)) {
                return;
            }
            const referenceNode = reference.$refNode;
            if (referenceNode?.text.trimStart().startsWith('`')) {
                return;
            }
            accept(
                'error',
                `Reserved word '${name}' must be backtick-quoted in a specification reference, for example [[D.\`${name}\`]].`,
                index === undefined
                    ? { node: part, property }
                    : { node: part, property, index }
            );
        };
        checkReference(part.target, 'target');
        part.targets.forEach((reference, index) => checkReference(reference, 'targets', index));
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
        this.checkReservedResultParameter(method, accept);
        const eventParameters = method.parameters.filter(parameter => this.isEventParameter(parameter));
        const applicationService = isApplicationService(method.$container) ? method.$container : undefined;
        const queryService = isQueryService(method.$container) ? method.$container : undefined;
        const projectorService = isProjector(method.$container) ? method.$container : undefined;
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
        if (eventParameters.length > 0 && !queryService) {
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
            if (!projectorService && (eventParameters.length !== 1 || method.parameters.length !== 1)) {
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
                    ? 'Consuming this integration event requires an authorized context-map relationship from an imported map or a map declared in the same document as both endpoints.'
                    : 'An integration event in a module must be exposed by its module and every enclosing module before another bounded context can consume it.', {
                    node: eventParameters[0],
                    property: 'type'
                });
            }
        }
        if (method.returnType || method.returnCollection) {
            const returnTypes = getTypeReferences(method.returnType, method.returnCollection);
            this.checkCrossContextTypeUse(method, returnTypes, accept, 'returnType');
            if (applicationService || queryService) {
                this.checkEntityBoundaryUse(method, returnTypes, accept, 'returnType', 'application');
                if (this.hasNestedEntityInReferences(returnTypes)) {
                    accept('error', 'Application-service signatures must use identifiers or data values, not entity instances.', {
                        node: method,
                        property: 'returnType'
                    });
                }
            } else if (isEntity(method.$container) || isValueObject(method.$container)) {
                this.checkEntityBoundaryUse(method, returnTypes, accept, 'returnType',
                    getOwningAggregate(method) ? 'aggregate' : 'value-object');
                const sourceAggregate = getOwningAggregate(method);
                const nestedEntity = returnTypes
                    .map(reference => this.findNestedEntity(reference.ref))
                    .find((target): target is Entity => target !== undefined);
                if (nestedEntity && getOwningAggregate(nestedEntity) !== sourceAggregate) {
                    accept('error', sourceAggregate
                        ? 'Reference another aggregate by its identifier, not by passing its entity instance.'
                        : 'Value-object signatures must use identifiers or domain values, not entity instances.', {
                        node: method,
                        property: 'returnType'
                    });
                }
            }
            this.checkReadModelTypeUse(method, returnTypes, accept, 'returnType', queryService !== undefined);
            if (isDomainService(method.$container)) {
                this.checkDataObjectBoundaryUse(
                    method,
                    returnTypes,
                    accept,
                    'returnType',
                    'Domain-service methods must return domain values, not DataObjects.'
                );
                if (returnTypes.some(reference => isEntity(reference.ref))) {
                    accept('error', 'Domain-service methods must return domain values, not aggregate entities.', {
                        node: method,
                        property: 'returnType'
                    });
                }
                const nestedEntity = returnTypes
                    .map(reference => this.findNestedEntity(reference.ref))
                    .find((target): target is Entity => target !== undefined);
                if (nestedEntity) {
                    accept('error', 'Domain-service methods must return domain values, not aggregate entities.', {
                        node: method,
                        property: 'returnType'
                    });
                }
            } else if (isEntity(method.$container) || isValueObject(method.$container)) {
                this.checkDataObjectBoundaryUse(
                    method,
                    returnTypes,
                    accept,
                    'returnType',
                    isEntity(method.$container)
                        ? 'Entity method signatures must use domain values, not DataObjects.'
                        : 'Value-object signatures must use domain values, not DataObjects.'
                );
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
            this.checkExposedQueryContract(method, queryService, accept);
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
        if (!module || !isPublicApiDeclaration(method)) {
            return;
        }
        const contracts = getCommandContractTypes(method, false);
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
            return typeModule !== undefined && !isPublicApiDeclaration(type);
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

    private checkExposedQueryContract(method: Method, queryService: QueryService, accept: ValidationAcceptor): void {
        if (!this.referencePolicy.isQueryServiceExposed(queryService) ||
            !this.referencePolicy.isExposedQueryResult(method)) {
            return;
        }
        const contracts = getCommandContractTypes(method, false);
        const aggregateOwnedTypes = new Set<AstNode>();
        for (const node of [...contracts.inputs, ...contracts.outputs]) {
            if (isValueObject(node) || isDataObject(node) || isEnumType(node)) {
                if (getOwningAggregate(node) !== undefined) {
                    aggregateOwnedTypes.add(node);
                }
            } else if (isField(node)) {
                const owner = node.$container;
                if ((isValueObject(owner) || isDataObject(owner) || isEnumType(owner)) &&
                    getOwningAggregate(owner) !== undefined) {
                    aggregateOwnedTypes.add(owner);
                }
            }
        }
        const names = [...new Set([...aggregateOwnedTypes]
            .map(type => (type as AstNode & { name: string }).name))];
        if (names.length === 0) {
            return;
        }
        accept('warning', `Published query '${method.name}' exposes aggregate-owned contract type${names.length === 1 ? '' : 's'}: ${names.join(', ')}. Use contract types that are not owned by an aggregate.`, {
            node: method,
            property: 'name',
            code: 'exposed-query-aggregate-contract'
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
        if (isSyntacticallyComplete(readModel) && this.hasNestedEntityShape(readModel, false)) {
            accept('error', 'Read models must project data rather than reference entity instances.', {
                node: readModel,
                property: 'fields'
            });
        }
    }

    checkDataObject(dataObject: DataObject, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(dataObject, accept);
        this.checkDuplicateFieldNames(dataObject.fields, accept);
        if (isSyntacticallyComplete(dataObject) && this.hasNestedEntityShape(dataObject, false)) {
            accept('error', 'Data objects may contain value data, but not entities or read models.', {
                node: dataObject,
                property: 'fields'
            });
        }
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
                const target = step.target?.ref;
                if (isMethod(target) && isJourneyCommand(target)) {
                    if (seenCommands.has(target)) {
                        accept('warning', `Command '${target.name}' is invoked more than once in this journey; references resolve to the nearest prior invocation.`, {
                            node: step,
                            property: 'target',
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
        const target = step.target?.ref;
        if (!isMethod(target)) {
            accept('error', 'A journey command path must end at a method.', {
                node: step,
                property: 'target'
            });
            return;
        }
        const method = target;
        if (!isJourneyCommand(method)) {
            accept('error', 'A journey may invoke only user-facing application-service commands, not event handlers or query methods.', {
                node: step,
                property: 'target'
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
            const entityTarget = typeReferences
                .map(reference => reference.ref)
                .find(target => isEntity(target) &&
                    (!sourceAggregate || getOwningAggregate(target) !== sourceAggregate));
            if (isEntity(entityTarget)) {
                accept('error', entityTarget.root
                    ? 'A constructor must reference another aggregate through its identifier, not its root entity.'
                    : 'A constructor must reference another aggregate through its identifier, not its entity.', {
                    node: parameter,
                    property: 'type'
                });
            }
            const nestedEntity = typeReferences
                .map(reference => this.findNestedEntity(reference.ref))
                .find((target): target is Entity => target !== undefined);
            if (nestedEntity && getOwningAggregate(nestedEntity) !== sourceAggregate) {
                accept('error', 'A constructor must reference another aggregate through its identifier, not an entity nested in a value object.', {
                    node: parameter,
                    property: 'type'
                });
            }
        }
    }

    private checkReservedResultParameter(method: Method, accept: ValidationAcceptor): void {
        const parameter = method.parameters.find(candidate => isReservedResultParameterName(method, candidate.name));
        if (!parameter) {
            return;
        }
        accept('error', "The name 'result' is reserved for the operation result and cannot be used as a parameter name.", {
            node: parameter,
            property: 'name',
            code: 'reserved-result-name'
        });
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
        if (!isConstructor(parameter.$container)) {
            const owner = parameter.$container.$container;
            if (isApplicationService(owner) || isQueryService(owner)) {
                this.checkEntityBoundaryUse(parameter, typeReferences, accept, 'type', 'application');
                if (this.hasNestedEntityInReferences(typeReferences)) {
                    accept('error', 'Application-service signatures must use identifiers or data values, not entity instances.', {
                        node: parameter,
                        property: 'type'
                    });
                }
            } else if (isFactory(owner)) {
                this.checkEntityBoundaryUse(parameter, typeReferences, accept, 'type', 'factory');
                if (this.hasNestedEntityInReferences(typeReferences)) {
                    accept('error', 'Factory method signatures must use identifiers or domain values, not entity instances.', {
                        node: parameter,
                        property: 'type'
                    });
                }
                this.checkDataObjectBoundaryUse(
                    parameter,
                    typeReferences,
                    accept,
                    'type',
                    'Factory method signatures must use identifiers or domain values, not DataObjects.'
                );
            } else if (isDomainService(owner)) {
                this.checkDataObjectBoundaryUse(
                    parameter,
                    typeReferences,
                    accept,
                    'type',
                    'Domain-service methods must accept domain values or entity/aggregate parameters, not DataObjects.'
                );
                if (parameter.collection && typeReferences.some(reference => isEntity(reference.ref))) {
                    accept('error', 'Domain-service methods must use direct entity parameters, not collections of entities.', {
                        node: parameter,
                        property: 'collection'
                    });
                }
                const hasForbiddenBoundaryType = typeReferences.some(reference =>
                    isDataObject(reference.ref) || isReadModel(reference.ref)
                );
                if (!hasForbiddenBoundaryType && this.hasNestedEntityInReferences(typeReferences)) {
                    accept('error', 'Domain-service methods must use domain values or direct entity parameters, not value objects containing entity instances.', {
                        node: parameter,
                        property: 'type'
                    });
                }
            } else if (isEntity(owner) || isValueObject(owner)) {
                this.checkEntityBoundaryUse(parameter, typeReferences, accept, 'type',
                    getOwningAggregate(owner) ? 'aggregate' : 'value-object');
                this.checkDataObjectBoundaryUse(
                    parameter,
                    typeReferences,
                    accept,
                    'type',
                    isEntity(owner)
                        ? 'Entity method signatures must use domain values, not DataObjects.'
                        : 'Value-object signatures must use domain values, not DataObjects.'
                );
                const sourceAggregate = getOwningAggregate(owner);
                const nestedEntity = typeReferences
                    .map(reference => this.findNestedEntity(reference.ref))
                    .find((target): target is Entity => target !== undefined);
                if (nestedEntity && getOwningAggregate(nestedEntity) !== sourceAggregate) {
                    accept('error', sourceAggregate
                        ? 'Reference another aggregate by its identifier, not by passing its entity instance.'
                        : 'Value-object signatures must use identifiers or domain values, not entity instances.', {
                        node: parameter,
                        property: 'type'
                    });
                }
            }
            // Domain services deliberately allow entity/aggregate parameters (DDD domain services).
            // Projector parameters are constrained to a single event by checkMethod.
        }
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
        boundary: 'aggregate' | 'application' | 'factory' | 'value-object'
    ): void {
        const sourceAggregate = getOwningAggregate(node);
        for (const reference of references) {
            const target = reference.ref;
            if (!target || !isEntity(target)) {
                continue;
            }
            const targetAggregate = getOwningAggregate(target);
            const crossesAggregate = !sourceAggregate || sourceAggregate !== targetAggregate;
            if (boundary === 'application' || boundary === 'factory' || boundary === 'value-object' || crossesAggregate) {
                const message = boundary === 'application'
                    ? 'Application-service signatures must use identifiers or data values, not entity instances.'
                    : boundary === 'factory'
                        ? 'Factory method signatures must use identifiers or domain values, not entity instances.'
                        : boundary === 'value-object'
                            ? 'Value-object signatures must use identifiers or domain values, not entity instances.'
                            : 'Reference another aggregate by its identifier, not by passing its entity instance.';
                accept('error', message, {
                    node,
                    property
                });
                return;
            }
        }
    }

    private checkDataObjectBoundaryUse(
        node: AstNode,
        references: Reference<TypeDeclaration>[],
        accept: ValidationAcceptor,
        property: string,
        message: string
    ): void {
        if (references.some(reference => isDataObject(reference.ref))) {
            accept('error', message, {
                node,
                property
            });
        }
    }

    /**
     * Finds an entity nested inside a value-object shape. The root type itself
     * is not reported; direct entity references are handled separately so the
     * more specific boundary diagnostic wins.
     */
    private findNestedEntity(type: AstNode | undefined, visited = new Set<AstNode>()): Entity | undefined {
        if (!type || visited.has(type) || !isValueObject(type)) {
            return undefined;
        }
        visited.add(type);
        for (const field of type.fields) {
            for (const reference of getTypeReferences(field.type, field.collection)) {
                const target = reference.ref;
                if (isEntity(target)) {
                    return target;
                }
                const nested = this.findNestedEntity(target, visited);
                if (nested) {
                    return nested;
                }
            }
        }
        return undefined;
    }

    /**
     * Finds an entity hidden behind a value object (or nested data object)
     * shape. Direct entity fields are handled by the regular field checks, so
     * they are skipped here to avoid duplicating diagnostics.
     */
    private hasNestedEntityShape(node: AstNode, reportDirect: boolean): boolean {
        return this.hasNestedEntityInShape(node, reportDirect, new Set());
    }

    private hasNestedEntityInReferences(references: Reference<TypeDeclaration>[]): boolean {
        const visited = new Set<AstNode>();
        return references.some(reference => this.hasNestedEntityInShape(reference.ref, false, visited));
    }

    private hasNestedEntityInShape(
        type: AstNode | undefined,
        reportEntity: boolean,
        visited: Set<AstNode>
    ): boolean {
        if (!type || visited.has(type)) {
            return false;
        }
        if (isEntity(type)) {
            return reportEntity;
        }
        visited.add(type);
        if (isValueObject(type)) {
            return type.fields.some(field =>
                getTypeReferences(field.type, field.collection).some(reference =>
                    this.hasNestedEntityInShape(reference.ref, true, visited)
                )
            );
        }
        if (isDataObject(type) || isReadModel(type)) {
            return type.fields.some(field =>
                getTypeReferences(field.type, field.collection).some(reference => {
                    if (isEntity(reference.ref)) {
                        return false;
                    }
                    return this.hasNestedEntityInShape(reference.ref, isValueObject(reference.ref), visited);
                })
            );
        }
        return false;
    }

    checkValueObject(valueObject: ValueObject, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(valueObject, accept);
        this.checkFieldMethodNameConflicts(valueObject.fields, valueObject.methods, accept);
        this.checkDuplicateFieldNames(valueObject.fields, accept);
        this.checkDuplicateConstructorSignatures(valueObject.constructors, accept);
        if (valueObject.mirrors?.ref) {
            const source = valueObject.mirrors.ref;
            if (isInSharedKernel(valueObject)) {
                accept('error', 'A mirrored identifier must be declared in a bounded context, not a shared kernel.', {
                    node: valueObject,
                    property: 'mirrors'
                });
            }
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
            if (isValueObject(source)) {
                this.checkMirrorShape(valueObject, source, accept);
            }
            if (!this.referencePolicy.hasContextRelationship(valueObject, source)) {
                const consumer = getOwningContextName(valueObject);
                const provider = getOwningContextName(source);
                accept('error', `Mirrored identifier '${valueObject.name}' references '${getExportedName(source)}', but no customer-supplier, partnership, or shared-kernel relationship connects '${consumer}' and '${provider}' in an imported context map.`, {
                    node: valueObject,
                    property: 'mirrors',
                    code: 'mirror-without-relationship'
                });
            }
        }
    }

    private checkMirrorShape(mirror: ValueObject, source: ValueObject, accept: ValidationAcceptor): void {
        const sourceFields = new Map(source.fields.map(field => [field.name, field]));
        const mirrorFields = new Map(mirror.fields.map(field => [field.name, field]));
        for (const [name, sourceField] of sourceFields) {
            const mirrorField = mirrorFields.get(name);
            if (!mirrorField) {
                accept('error', `Mirrored identifier '${mirror.name}' must declare field '${name}' from '${getExportedName(source)}'.`, {
                    node: mirror,
                    property: 'fields',
                    code: 'mirror-shape'
                });
                continue;
            }
            if (Boolean(mirrorField.optional) !== Boolean(sourceField.optional) ||
                !this.sameFieldType(mirrorField, sourceField)) {
                accept('error', `Field '${name}' must have type '${this.getFieldTypeSignature(sourceField)}' to match '${getExportedName(source)}'.`, {
                    node: mirrorField,
                    property: 'name',
                    code: 'mirror-shape'
                });
            }
        }
        for (const [name, mirrorField] of mirrorFields) {
            if (!sourceFields.has(name)) {
                accept('error', `Mirrored identifier '${mirror.name}' declares field '${name}' that is not part of '${getExportedName(source)}'.`, {
                    node: mirrorField,
                    property: 'name',
                    code: 'mirror-shape'
                });
            }
        }
    }

    private sameFieldType(left: Field, right: Field): boolean {
        if (left.primitive || right.primitive) {
            return left.primitive === right.primitive;
        }
        if (left.collection || right.collection) {
            return left.collection !== undefined && right.collection !== undefined &&
                this.sameCollectionType(left.collection, right.collection);
        }
        return left.type?.ref !== undefined && left.type.ref === right.type?.ref;
    }

    private sameCollectionType(left: CollectionType, right: CollectionType): boolean {
        if (left.kind !== right.kind ||
            !this.sameTypeMember(
                left.elementPrimitive, left.elementType?.ref, left.elementCollection,
                right.elementPrimitive, right.elementType?.ref, right.elementCollection
            )) {
            return false;
        }
        if (left.kind !== 'Map') {
            return true;
        }
        return this.sameTypeMember(
            left.valuePrimitive, left.valueType?.ref, left.valueCollection,
            right.valuePrimitive, right.valueType?.ref, right.valueCollection
        );
    }

    private sameTypeMember(
        leftPrimitive: Field['primitive'],
        leftType: AstNode | undefined,
        leftCollection: CollectionType | undefined,
        rightPrimitive: Field['primitive'],
        rightType: AstNode | undefined,
        rightCollection: CollectionType | undefined
    ): boolean {
        if (leftPrimitive || rightPrimitive) {
            return leftPrimitive === rightPrimitive;
        }
        if (leftCollection || rightCollection) {
            return leftCollection !== undefined && rightCollection !== undefined &&
                this.sameCollectionType(leftCollection, rightCollection);
        }
        return leftType !== undefined && leftType === rightType;
    }

    private getFieldTypeSignature(field: Field): string {
        const base = field.primitive ??
            (field.type?.ref ? getExportedName(field.type.ref as AstNode & { name: string }) : undefined) ??
            this.getCollectionTypeSignature(field.collection, ', ');
        return `${base}${field.optional ? '?' : ''}`;
    }

    checkModule(module: Module, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(module, accept);
        if (module.dependencyClauses.length > 1) {
            for (const clause of module.dependencyClauses.slice(1)) {
                accept('error', "A module may declare 'depends on' at most once.", {
                    node: clause,
                    property: 'modules'
                });
            }
        }
        const seenDependencies = new Set<AstNode>();
        const dependencies = module.dependencyClauses.flatMap(clause => clause.modules);
        for (const dependency of dependencies) {
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
                    node: dependency,
                    property: 'target'
                });
            }
            if (dependency.target.ref && getOwningContextName(dependency.target.ref) !== getOwningContextName(module)) {
                const sourceSharedKernel = getOwningSharedKernel(module);
                const targetSharedKernel = getOwningSharedKernel(dependency.target.ref);
                const message = sourceSharedKernel === undefined || targetSharedKernel === sourceSharedKernel
                    ? 'A module can depend only on another module in the same bounded context or shared kernel.'
                    : targetSharedKernel === undefined
                        ? "A shared kernel cannot depend on a bounded context's private model."
                        : "A shared kernel cannot depend on another shared kernel's private model.";
                accept('error', message, {
                    node: dependency,
                    property: 'target'
                });
            }
            if (dependency.target.ref && dependency.target.ref !== module &&
                moduleDependsTransitivelyOn(dependency.target.ref, module)) {
                accept('error', 'Module dependencies cannot contain a cycle.', {
                    node: dependency,
                    property: 'target'
                });
                break;
            }
        }
        const seenExposures = new Set<AstNode>();
        for (const [clauseIndex, exposure] of module.exposures.entries()) {
            if (clauseIndex > 0) {
                accept('error', "A module may declare 'exposes' at most once.", {
                    node: exposure,
                    property: 'declarations'
                });
            }
            for (const [index, declaration] of exposure.declarations.entries()) {
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
                        property: 'declarations',
                        index
                    });
                }
            }
        }
    }

    checkSharedKernel(sharedKernel: SharedKernel, accept: ValidationAcceptor): void {
        this.modelValidator.checkSharedKernel(sharedKernel, accept);
    }

    private isNonTerminalPathReference(referenceInfo: ReferenceInfo): boolean {
        const { container, property } = referenceInfo;
        if (property.endsWith('Path') || property === 'path') {
            return true;
        }
        if (isSpecificationTextPart(container)) {
            if (property === 'target') {
                return container.targets.length > 0;
            }
            if (property === 'targets') {
                const index = referenceInfo.index ?? container.targets.length - 1;
                return index < container.targets.length - 1;
            }
        }
        return false;
    }

    checkIdentifierNormalization(node: import('langium').AstNode, accept: ValidationAcceptor): void {
        const name = (node as AstNode & { name?: unknown }).name;
        if (typeof name === 'string') {
            this.reportNonNormalizedIdentifier(name, accept, { node, property: 'name' });
        }
        AstUtils.streamReferences(node).forEach(referenceInfo => {
            const reference = referenceInfo.reference;
            if (!isReference(reference) || reference.$refText.length === 0) {
                return;
            }
            this.reportNonNormalizedIdentifier(reference.$refText, accept, {
                node: referenceInfo.container,
                property: referenceInfo.property,
                index: referenceInfo.index
            });
        });
    }

    private reportNonNormalizedIdentifier(
        text: string,
        accept: ValidationAcceptor,
        location: Parameters<ValidationAcceptor>[2]
    ): void {
        const normalized = text.normalize('NFC');
        if (normalized === text) {
            return;
        }
        accept('warning', `Identifier '${text}' is not in Unicode NFC form. Use '${normalized}'.`, {
            ...location,
            code: 'identifier-not-nfc'
        });
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
                    property: referenceInfo.property, index: referenceInfo.index
                });
                return;
            }
            const terminalReferenceIndex = isSpecificationTextPart(referenceInfo.container) &&
                referenceInfo.property === 'targets'
                ? referenceInfo.index ?? referenceInfo.container.targets.indexOf(referenceInfo.reference as (typeof referenceInfo.container.targets)[number])
                : undefined;
            const isTerminalSpecificationSegment = isSpecificationTextPart(referenceInfo.container) && (
                referenceInfo.property === 'target'
                    ? referenceInfo.container.targets.length === 0
                    : referenceInfo.property === 'targets' &&
                        terminalReferenceIndex === referenceInfo.container.targets.length - 1
            );
            const targetName = 'name' in target && typeof target.name === 'string' ? target.name : undefined;
            if (isSpecificationTextPart(referenceInfo.container) && referenceInfo.property === 'target' &&
                !isBareSpecificationMemberAllowed(
                    referenceInfo.container,
                    target,
                    targetName !== undefined && referenceInfo.reference.$refText === targetName,
                    true
                )) {
                accept('error', 'Bare field and method references are limited to the enclosing entity or value object; use an owner-qualified path.', {
                    node: referenceInfo.container as AstNode,
                    property: referenceInfo.property, index: referenceInfo.index
                });
                return;
            }
            const journeyStep = AstUtils.getContainerOfType(referenceInfo.container, isJourneyStep);
            if (isSpecificationTextPart(referenceInfo.container) && !journeyStep && isTerminalSpecificationSegment &&
                isMethod(target) && isQueryService(target.$container) &&
                getOwningContextName(referenceInfo.container) === getOwningContextName(target) &&
                AstUtils.getContainerOfType(referenceInfo.container, isMethod) !== target) {
                accept('error', 'Non-journey prose must link a query result type or field, not the query operation itself.', {
                    node: referenceInfo.container as AstNode,
                    property: referenceInfo.property, index: referenceInfo.index
                });
                return;
            }
            if (isSpecificationTextPart(referenceInfo.container) && !isTerminalSpecificationSegment &&
                !this.referencePolicy.isVisibleSpecificationPathSegment(referenceInfo.container, target, false)) {
                accept('error', 'This specification path segment is not visible; use a public declaration or an authorized contract path.', {
                    node: referenceInfo.container as AstNode,
                    property: referenceInfo.property, index: referenceInfo.index
                });
                return;
            }
            if (isSpecificationTextPart(referenceInfo.container) && journeyStep) {
                const kind = getJourneySpecificationKind(referenceInfo.container) ?? 'when';
                if (isTerminalSpecificationSegment && this.referencePolicy.isJourneyPathOnlyTarget(target)) {
                    accept('error', 'A journey specification must end at a visible declaration, operation, field, or value, not a module, context, map, kernel, or service container.', {
                        node: referenceInfo.container as AstNode,
                        property: referenceInfo.property, index: referenceInfo.index
                    });
                } else if (isTerminalSpecificationSegment &&
                    !this.referencePolicy.isJourneyVisibleTarget(journeyStep, target, kind)) {
                    accept('error', 'Journey specifications may reference current inputs, prior command results, visible read/query values, and public contracts, but not private aggregate internals, later command operations, private command contract inputs or results, or private domain events.', {
                        node: referenceInfo.container as AstNode,
                        property: referenceInfo.property, index: referenceInfo.index
                    });
                }
                return;
            }
            const sourceModule = getOwningModule(referenceInfo.container);
            const targetModule = getOwningModule(target);
            const crossesContext = isCrossContextOwned(referenceInfo.container, target);
            const isSpecificationReference = isSpecificationTextPart(referenceInfo.container);
            const isEventContractTarget = isSpecificationReference && (
                this.referencePolicy.isEventContractTargetVisible(referenceInfo.container, target) ||
                this.referencePolicy.isIntegrationEventContractTarget(referenceInfo.container, target)
            );
            if (isSpecificationReference && crossesContext && isInSharedKernel(target)) {
                const sharedKernel = getOwningSharedKernel(target);
                const sourceSharedKernel = getOwningSharedKernel(referenceInfo.container);
                if (sharedKernel && sourceSharedKernel !== sharedKernel &&
                    !this.referencePolicy.hasSharedKernelRelationship(referenceInfo.container, sharedKernel)) {
                    accept('error', 'Using a shared-kernel declaration in specification text requires an authorized context-map relationship from an imported map or a map declared in the same document as both endpoints.', {
                        node: referenceInfo.container as AstNode,
                        property: referenceInfo.property, index: referenceInfo.index
                    });
                    return;
                }
                if (sharedKernel && sourceSharedKernel !== sharedKernel && targetModule &&
                    !isPublicApiDeclaration(target)) {
                    accept('error', 'Using a module declaration from a shared kernel requires the module to expose that declaration.', {
                        node: referenceInfo.container as AstNode,
                        property: referenceInfo.property, index: referenceInfo.index
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
                        : 'A field from another bounded context is not part of an authorized event or query contract.', {
                        node: referenceInfo.container,
                        property: referenceInfo.property, index: referenceInfo.index
                    });
                    return;
                }
            }
            if (isSpecificationTextPart(referenceInfo.container) && isMethod(target) &&
                crossesContext && !isInSharedKernel(target)) {
                const publishedQuery = isQueryService(target.$container) &&
                    this.referencePolicy.isQueryServiceExposed(target.$container) &&
                    this.referencePolicy.isExposedQueryResult(target);
                accept('error', publishedQuery
                    ? 'Specification text cannot link a cross-context query operation directly; link its published result type or field instead.'
                    : 'A method from another bounded context is not part of an authorized event or query contract.', {
                    node: referenceInfo.container as AstNode,
                    property: referenceInfo.property, index: referenceInfo.index
                });
                return;
            }
            if (isSpecificationReference && crossesContext && !isInSharedKernel(target) &&
                (isValueObject(target) || isEnumType(target) || isEnumValue(target) ||
                    isRepository(target) || isQueryRepository(target) || isParameter(target) || isDataObject(target) || isReadModel(target) ||
                    isTerminalSpecificationSegment && (
                        isAggregate(target) || isEntity(target) || isApplicationService(target) || isDomainService(target) ||
                        isQueryService(target) || isProjector(target) || isFactory(target) || isModule(target)
                    )) &&
                !isEventContractTarget &&
                !this.referencePolicy.isIntegrationEventContractTarget(referenceInfo.container, target) &&
                !this.referencePolicy.isPublishedReadResponseType(referenceInfo.container, target)) {
                accept('error', 'Specification text can reference another bounded context only through an authorized event or query contract.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property, index: referenceInfo.index
                });
                return;
            }
            if (isSpecificationReference && isDomainEvent(target) && crossesContext) {
                accept('error', 'Specification text cannot reference a private DomainEvent from another bounded context.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property, index: referenceInfo.index
                });
                return;
            }
            if (isSpecificationReference && isIntegrationEvent(target) && crossesContext &&
                (!this.referencePolicy.isIntegrationEventExposed(target) ||
                    !this.referencePolicy.hasAuthorizedEventRelationship(referenceInfo.container, target))) {
                accept('error', 'Cross-context IntegrationEvent references require an exposed contract and an authorized context-map relationship.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property, index: referenceInfo.index
                });
                return;
            }
            // Integration-event payload visibility has a dedicated diagnostic
            // with the event-specific rule. Avoid a second generic module error
            // for the same field reference.
            if (this.isIntegrationEventPayloadTypeReference(referenceInfo)) {
                return;
            }
            // Structural path segments are containers, not the declaration being
            // referenced. Only the terminal declaration must be visible through
            // a module boundary.
            if (this.isNonTerminalPathReference(referenceInfo)) {
                return;
            }
            if (!sourceModule && targetModule && !isModule(target) &&
                getOwningContextName(referenceInfo.container) === getOwningContextName(targetModule)) {
                if (!isPublicApiDeclaration(target)) {
                    accept('error', 'A declaration outside a module may reference a module declaration only when its module and all enclosing modules expose it.', {
                        node: referenceInfo.container,
                        property: referenceInfo.property, index: referenceInfo.index
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
            if (!isModulePubliclyVisible(sourceModule, targetModule) || !isExposedByModule(targetModule, target)) {
                accept('error', 'This module reference requires a dependency on a module that exposes the target declaration.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property, index: referenceInfo.index
                });
            }
        });
    }

    private isIntegrationEventPayloadTypeReference(referenceInfo: ReferenceInfo): boolean {
        // Direct field types and collection element/value types inside an
        // integration event are all payload contract references. The dedicated
        // payload check owns their module diagnostics so the generic module
        // check must not report a second error for collection references.
        const field = AstUtils.getContainerOfType(referenceInfo.container, isField);
        return field !== undefined && isIntegrationEvent(field.$container);
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
        if (writeRepositories.length > 1 && writeRepositories.at(-1) === repository) {
            const names = writeRepositories.map(candidate => `'${candidate.name}'`).join(', ');
            accept('error', `Aggregate '${aggregate.name}' has multiple write repositories: ${names}. An aggregate may declare at most one write repository.`, {
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
        const roots = new Set<Entity>();
        for (const method of factory.methods) {
            const result = method.returnType?.ref;
            const isValidRoot = isEntity(result) && result.root &&
                getOwningAggregate(result) !== undefined && !isCrossContextOwned(factory, result);
            if (isSyntacticallyComplete(method) && !isValidRoot) {
                accept('error', 'A factory method must return an aggregate-root entity in its own bounded context.', {
                    node: method,
                    property: 'returnType'
                });
                continue;
            }
            if (isValidRoot) {
                roots.add(result);
            }
        }
        if (roots.size > 1) {
            const names = [...roots].map(root => root.name).join(', ');
            accept('error', `A factory must create one aggregate root; it creates multiple roots: ${names}. Split creation of different roots into separate factories.`, {
                node: factory,
                property: 'name',
                code: 'multiple-factory-roots'
            });
        }
    }

    checkContextRelationship(relationship: ContextRelationship, accept: ValidationAcceptor): void {
        this.modelValidator.checkContextRelationship(relationship, accept);
    }

    checkDomainEvent(event: DomainEvent, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(event, accept);
        this.checkDuplicateFieldNames(event.fields, accept);
        this.checkEventPayloadShape(event, accept);
    }

    checkIntegrationEvent(event: IntegrationEvent, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(event, accept);
        this.checkDuplicateFieldNames(event.fields, accept);
        this.checkEventPayloadShape(event, accept);
    }

    /**
     * Event payload contracts are recursive: a value object can nest another
     * value object, and that nested shape is still part of the event contract.
     * Validate the whole reachable shape, not only the direct field types.
     */
    private checkEventPayloadShape(event: DomainEvent | IntegrationEvent, accept: ValidationAcceptor): void {
        if (!isSyntacticallyComplete(event)) {
            return;
        }
        const integrationEvent = isIntegrationEvent(event);
        const visited = new Set<AstNode>();
        const checkModuleDependency = (field: Field, type: AstNode): void => {
            if (!integrationEvent) {
                return;
            }
            const eventModule = getOwningModule(event);
            const targetModule = getOwningModule(type);
            if (!eventModule || !targetModule || eventModule === targetModule ||
                getOwningContextName(eventModule) !== getOwningContextName(targetModule)) {
                return;
            }
            // Private payload types already receive the dedicated public
            // contract diagnostic below; do not stack a module error on top.
            if (!isPublicApiDeclaration(type)) {
                return;
            }
            if (!isModulePubliclyVisible(eventModule, targetModule)) {
                accept('error', 'This module reference requires a dependency on a module that exposes the target declaration.', {
                    node: field,
                    property: 'type'
                });
            }
        };
        function visitReferences(field: Field, direct: boolean): void {
            // Collection element/value references live on the CollectionType
            // node, not on the Field itself, so getTypeReferences is required
            // here; AstUtils.streamReferences(field) would miss them entirely.
            for (const reference of getTypeReferences(field.type, field.collection)) {
                const type = reference.ref;
                if (!type) {
                    continue;
                }
                // Only direct payload field types must be visible from the
                // event's own module. Nested shapes follow the outer payload
                // type's dependencies.
                if (direct) {
                    checkModuleDependency(field, type);
                }
                visit(type, field);
            }
        };
        function visit(type: AstNode | undefined, field: Field): void {
            if (!type || visited.has(type)) {
                return;
            }
            visited.add(type);
            if (isEntity(type)) {
                accept('error', 'Event payloads must not expose entity instances; use stable value data instead.', {
                    node: field,
                    property: 'type'
                });
                return;
            }
            // Data objects and read models are already rejected by checkField
            // when they appear anywhere in a domain/event payload shape.
            if (isDataObject(type) || isReadModel(type)) {
                return;
            }
            if (integrationEvent) {
                if (getOwningAggregate(type) !== undefined) {
                    accept('error', 'An integration-event payload must not expose types owned by an aggregate.', {
                        node: field,
                        property: 'type'
                    });
                }
                const targetModule = getOwningModule(type);
                if (targetModule !== undefined && !isPublicApiDeclaration(type)) {
                    accept('error', 'Integration-event payload types must be public contract types exposed by their module and all enclosing modules; context-level types are public.', {
                        node: field,
                        property: 'type'
                    });
                }
            }
            if (isValueObject(type)) {
                for (const nestedField of type.fields) {
                    visitReferences(nestedField, false);
                }
            }
        };
        for (const field of event.fields) {
            visitReferences(field, true);
        }
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
        const namespace = this.getDeclarationNameNamespace(node);
        const counts = this.getDuplicateNameCounts(node);
        if ((counts.get(namespace)?.get(name) ?? 0) < 2) {
            return;
        }

        accept('error', `Duplicate declaration '${name}'.`, {
            node,
            property: 'name'
        });
    }

    private getDeclarationNameNamespace(node: AstNode): DeclarationNameNamespace {
        if (isActor(node)) {
            return 'actor';
        }
        if (isJourney(node)) {
            return 'journey';
        }
        if (isSubdomain(node)) {
            return 'subdomain';
        }
        if (isBoundedContext(node) || isContextMap(node) || isSharedKernel(node)) {
            return 'importable';
        }
        return 'path';
    }

    private getDuplicateNameCounts(node: AstNode): Map<DeclarationNameNamespace, Map<string, number>> {
        const document = AstUtils.getDocument(node);
        const cached = this.duplicateNameCounts.get(document);
        if (cached) {
            return cached;
        }

        const counts = new Map<DeclarationNameNamespace, Map<string, number>>();
        for (const description of this.services.shared.workspace.IndexManager.allElements(
            undefined,
            this.getModelDocumentUris(document)
        )) {
            // Fields and enum values have their own owner-local duplicate
            // checks. Parameters are not indexed. Excluding them here avoids
            // duplicate generic diagnostics for the same name collision.
            if (description.type === 'Field' || description.type === 'EnumValue' || description.type === 'Parameter') {
                continue;
            }
            const namespace = this.getDeclarationNameNamespaceFromType(description.type);
            const namespaceCounts = counts.get(namespace) ?? new Map<string, number>();
            namespaceCounts.set(description.name, (namespaceCounts.get(description.name) ?? 0) + 1);
            counts.set(namespace, namespaceCounts);
        }
        this.duplicateNameCounts.set(document, counts);
        return counts;
    }

    private getDeclarationNameNamespaceFromType(type: string): DeclarationNameNamespace {
        if (type === 'Actor') {
            return 'actor';
        }
        if (type === 'Journey') {
            return 'journey';
        }
        if (type === 'Subdomain') {
            return 'subdomain';
        }
        if (type === 'BoundedContext' || type === 'ContextMap' || type === 'SharedKernel') {
            return 'importable';
        }
        return 'path';
    }

    /**
     * Duplicate names are scoped to the import-connected model containing a
     * document. Both import and importer edges participate so every file in a
     * multi-file model sees the same duplicate diagnostics.
     *
     * The import graph and its connected components are built once per build;
     * rebuilding them per document makes validation quadratic in workspace
     * size.
     */
    private getModelDocumentUris(document: LangiumDocument): Set<string> {
        const components = this.getImportComponentsByDocument();
        return components.get(document.uri.toString()) ?? new Set([document.uri.toString()]);
    }

    private getImportComponentsByDocument(): Map<string, Set<string>> {
        if (this.importComponentsByDocument) {
            return this.importComponentsByDocument;
        }
        const documents = this.services.shared.workspace.LangiumDocuments.all.toArray();
        const byUri = new Map<string, LangiumDocument>();
        const adjacency = new Map<string, Set<string>>();
        for (const current of documents) {
            const uri = current.uri.toString();
            byUri.set(uri, current);
            adjacency.set(uri, new Set());
        }
        for (const current of documents) {
            const uri = current.uri.toString();
            const model = current.parseResult.value;
            if (!isModel(model)) {
                continue;
            }
            for (const importDeclaration of model.imports) {
                const importedUri = resolveImportUri(current, importDeclaration)?.toString();
                if (!importedUri || !byUri.has(importedUri)) {
                    continue;
                }
                adjacency.get(uri)?.add(importedUri);
                adjacency.get(importedUri)?.add(uri);
            }
        }

        const components = new Map<string, Set<string>>();
        const visited = new Set<string>();
        for (const uri of byUri.keys()) {
            if (visited.has(uri)) {
                continue;
            }
            const component = new Set<string>();
            const pending = [uri];
            while (pending.length > 0) {
                const next = pending.pop()!;
                if (visited.has(next) || !byUri.has(next)) {
                    continue;
                }
                visited.add(next);
                component.add(next);
                for (const neighbor of adjacency.get(next) ?? []) {
                    if (!visited.has(neighbor)) {
                        pending.push(neighbor);
                    }
                }
            }
            for (const member of component) {
                components.set(member, component);
            }
        }
        this.importComponentsByDocument = components;
        return components;
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
                    const rootReference = repository.root?.ref;
                    if (!isEntity(rootReference) || !rootReference.root ||
                        getOwningContextName(repository) !== getOwningContextName(rootReference)) {
                        continue;
                    }
                    const aggregate = getOwningAggregate(rootReference);
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
                    accept('error', 'Using a shared-kernel type requires an authorized context-map relationship from an imported map or a map declared in the same document as both endpoints.', {
                        node,
                        property
                    });
                    return;
                }
                const targetModule = getOwningModule(target);
                if (sourceSharedKernel !== sharedKernel && targetModule && !isPublicApiDeclaration(target)) {
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
                    ? 'A bounded context cannot directly use a value object from another bounded context as a field, parameter, or return type; use a local mirror, an IntegrationEvent, or a published query result contract.'
                    : 'A bounded context cannot directly use a type from another bounded context as a field, parameter, or return type; use an IntegrationEvent or a published query result contract.';
                accept('error', message, {
                    node,
                    property
                });
                return;
            }
        }
    }

}
