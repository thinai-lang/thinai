import {
    type AstNode,
    type Reference,
    AstUtils,
    type ValidationAcceptor,
    type ValidationChecks,
    URI,
    UriUtils,
    isReference
} from 'langium';
import type {
    Aggregate,
    ApplicationService,
    BoundedContext,
    BoundedContextPart,
    Capability,
    ContextMap,
    ContextMapEndpoint,
    ContextRelationship,
    CollectionType,
    Constructor,
    DataObject,
    DomainEvent,
    DomainService,
    Entity,
    EnumType,
    EnumValue,
    Factory,
    Import,
    ImportComponent,
    IntegrationEvent,
    Field,
    Flow,
    Method,
    Model,
    Module,
    Parameter,
    Projector,
    QueryRepository,
    QueryService,
    ReadModel,
    Repository,
    Subdomain,
    ThinaiAstType,
    TypeDeclaration,
    ValueObject,
    SharedKernel
} from './generated/ast.js';
import {
    isAggregate,
    isApplicationService,
    isDomainEvent,
    isEntity,
    isField,
    isIntegrationEvent,
    isImportableComponent,
    isContextMap,
    isCustomerSupplierRelationship,
    isEnumType,
    isFactory,
    isModel,
    isModule,
    isPartnershipRelationship,
    isProjector,
    isDataObject,
    isQueryRepository,
    isParameter,
    isRepository,
    isQueryService,
    isReadModel,
    isSeparateWaysRelationship,
    isSharedKernel,
    isSharedKernelRelationship,
    isValueObject
} from './generated/ast.js';
import type { ThinaiServices } from './thinai-module.js';
import { getExportedName, getOwningContextName, getOwningModule, isInSharedKernel, resolveImportUri } from './thinai-scope.js';

const INTEGRATION_PATTERNS = new Set([
    'Conformist',
    'AntiCorruptionLayer',
    'OpenHostService',
    'PublishedLanguage'
]);

export function registerValidationChecks(services: ThinaiServices): void {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.ThinaiValidator;
    const checks: ValidationChecks<ThinaiAstType> = {
        Aggregate: validator.checkAggregate,
        AstNode: validator.checkReferences,
        BoundedContext: validator.checkBoundedContext,
        BoundedContextPart: validator.checkBoundedContextPart,
        Capability: validator.checkNamedDeclaration,
        CollectionType: validator.checkCollectionType,
        Constructor: validator.checkConstructor,
        ContextRelationship: validator.checkContextRelationship,
        ContextMap: validator.checkNamedDeclaration,
        DataObject: validator.checkDataObject,
        DomainEvent: validator.checkDomainEvent,
        DomainService: validator.checkNamedDeclaration,
        Entity: validator.checkEntity,
        EnumType: validator.checkEnumType,
        Factory: validator.checkFactory,
        Field: validator.checkField,
        Import: validator.checkImport,
        IntegrationEvent: validator.checkIntegrationEvent,
        Flow: validator.checkFlow,
        ApplicationService: validator.checkApplicationService,
        Method: validator.checkMethod,
        Transition: validator.checkTransition,
        Model: validator.checkModelImports,
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
    constructor(private readonly services: ThinaiServices) {}

    checkBoundedContext(context: BoundedContext, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(context, accept);
    }

    checkBoundedContextPart(part: BoundedContextPart, accept: ValidationAcceptor): void {
        if (!part.context.ref) {
            return;
        }

        const currentDocument = AstUtils.getDocument(part);
        const targetDocument = AstUtils.getDocument(part.context.ref);
        if (UriUtils.equals(currentDocument.uri, targetDocument.uri)) {
            return;
        }

        const model = currentDocument.parseResult.value;
        const imported = isModel(model)
            ? model.imports.some(importDeclaration => UriUtils.equals(
                resolveImportUri(currentDocument, importDeclaration),
                targetDocument.uri
            ))
            : false;
        if (!imported) {
            accept('error', 'A bounded-context part must directly import its canonical context.', {
                node: part,
                keyword: 'part'
            });
        }
    }

    checkImport(importDeclaration: Import, accept: ValidationAcceptor): void {
        const path = importDeclaration.path;
        if (!path.startsWith('./') && !path.startsWith('../')) {
            accept('error', 'Imports must use a relative path beginning with ./ or ../.', {
                node: importDeclaration,
                property: 'path'
            });
        }
        if (!path.endsWith('.tni')) {
            accept('warning', 'Thinai imports should use the .tni file extension.', {
                node: importDeclaration,
                property: 'path'
            });
        }

        const document = AstUtils.getDocument(importDeclaration);
        const uri = resolveImportUri(document, importDeclaration);
        if (UriUtils.equals(document.uri, uri)) {
            accept('error', 'A file cannot import itself.', {
                node: importDeclaration,
                property: 'path'
            });
        }

        const duplicate = isModel(document.parseResult.value)
            ? document.parseResult.value.imports.some(other =>
                other !== importDeclaration && UriUtils.equals(resolveImportUri(document, other), uri)
            )
            : false;
        if (duplicate) {
            accept('error', 'The same file is imported more than once.', {
                node: importDeclaration,
                property: 'path'
            });
        }

        if (!this.services.shared.workspace.LangiumDocuments.hasDocument(uri)) {
            accept('error', `Imported file '${path}' is not part of the workspace.`, {
                node: importDeclaration,
                property: 'path'
            });
        }

        if (importDeclaration.alias) {
            const importedModel = this.services.shared.workspace.LangiumDocuments.getDocument(uri)?.parseResult.value;
            const components = isModel(importedModel)
                ? importedModel.declarations.filter(isImportableComponent)
                : [];
            if (components.length !== 1) {
                accept('error', 'A file-level alias requires exactly one bounded context, context map, or shared kernel; select components explicitly when importing a file with multiple components.', {
                    node: importDeclaration,
                    property: 'alias'
                });
            }
        }

        if (this.reachesImportCycle(uri, new Set([document.uri.toString()]))) {
            accept('error', 'Import cycle detected.', {
                node: importDeclaration,
                property: 'path'
            });
        }
    }

    checkModelImports(model: Model, accept: ValidationAcceptor): void {
        const names = new Map<string, Import | ImportComponent>();
        for (const importDeclaration of model.imports) {
            const declarations: Array<{ name: string; node: Import | ImportComponent; property: string }> = [];
            if (importDeclaration.alias) {
                declarations.push({ name: importDeclaration.alias, node: importDeclaration, property: 'alias' });
            }
            for (const component of importDeclaration.components) {
                declarations.push({
                    name: component.alias ?? component.component.$refText,
                    node: component,
                    property: component.alias ? 'alias' : 'component'
                });
            }
            for (const declaration of declarations) {
                if (names.has(declaration.name)) {
                    const message = `Import component name '${declaration.name}' is declared more than once.`;
                    if (declaration.node.$type === 'Import') {
                        accept('error', message, { node: declaration.node, property: 'alias' });
                    } else {
                        accept('error', message, {
                            node: declaration.node,
                            property: declaration.property === 'alias' ? 'alias' : 'component'
                        });
                    }
                } else {
                    names.set(declaration.name, declaration.node);
                }
            }
        }
    }

    checkAggregate(aggregate: Aggregate, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(aggregate, accept);
        const roots = aggregate.members.filter(member => isEntity(member) && member.root);
        if (roots.length !== 1) {
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
        this.checkEntityStateGraph(entity, accept);
        const aggregate = this.getOwningAggregate(entity);
        if (!aggregate) {
            accept('error', 'An entity must belong to an aggregate.', {
                node: entity,
                property: 'name'
            });
        }
        const identifierFields = entity.fields.filter(field => field.identifier);
        if (identifierFields.length !== 1) {
            accept('error', 'An entity must declare exactly one identifier field.', {
                node: entity,
                property: 'fields'
            });
        }
        const identifierType = identifierFields[0]?.type?.ref;
        if (identifierType && aggregate && identifierType.$container !== aggregate) {
            accept('error', 'An entity identifier value object must be declared in the same aggregate.', {
                node: identifierFields[0],
                property: 'type'
            });
        }
        const ancestors = new Set<Entity>([entity]);
        let base = entity.base?.ref;
        while (base) {
            if (this.getOwningAggregate(base) !== aggregate) {
                accept('error', 'Entity inheritance must stay within the same aggregate.', {
                    node: entity,
                    property: 'base'
                });
                break;
            }
            if (ancestors.has(base)) {
                accept('error', 'Entity inheritance cannot contain a cycle.', {
                    node: entity,
                    property: 'base'
                });
                break;
            }
            ancestors.add(base);
            base = base.base?.ref;
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
        const typeReferences = this.collectTypeReferences(field.type, field.collection);
        this.checkCrossContextTypeUse(field, typeReferences, accept);
        this.checkReadModelTypeUse(field, typeReferences, accept, 'type', isReadModel(field.$container));
        const isDataObjectField = isDataObject(field.$container);
        if (field.identifier && isDataObjectField) {
            accept('error', 'Data objects have no entity identity.', { node: field, property: 'identifier' });
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
        if (isReadModel(field.$container) && field.identifier) {
            accept('error', 'Read-model fields are projection data, not DDD entity identifiers.', {
                node: field,
                property: 'identifier'
            });
        }
        if (isReadModel(field.$container) && typeReferences.some(reference =>
            isEntity(reference.ref)
        )) {
            accept('error', 'Read models must project data rather than reference entity instances.', {
                node: field,
                property: 'type'
            });
        }
        if (field.initialState !== undefined) {
            const stateType = field.type?.ref;
            if (!isEntity(field.$container) || !stateType || !isEnumType(stateType) || field.optional ||
                !stateType.values.some(value => value.name === field.initialState)) {
                accept('error', 'An initial state must be a declared value of a non-optional enum field on an entity.', {
                    node: field,
                    property: 'initialState'
                });
            }
        }
        if (isDomainEvent(field.$container) || isIntegrationEvent(field.$container)) {
            if (typeReferences.some(reference => isEntity(reference.ref))) {
                accept('error', 'Event payloads must not expose entity instances; use stable value data instead.', {
                    node: field,
                    property: 'type'
                });
            }
            if (isIntegrationEvent(field.$container) && typeReferences.some(reference =>
                reference.ref !== undefined && this.getOwningAggregate(reference.ref) !== undefined
            )) {
                accept('error', 'An integration-event payload must not expose types owned by an aggregate.', {
                    node: field,
                    property: 'type'
                });
            }
            if (isIntegrationEvent(field.$container)) {
                const contractModule = getOwningModule(field.$container);
                const privateContractType = typeReferences.find(reference => {
                    const target = reference.ref;
                    if (!target || isInSharedKernel(target) || (target.$type !== 'ValueObject' && target.$type !== 'EnumType')) {
                        return false;
                    }
                    return !contractModule || getOwningModule(target) !== contractModule ||
                        !contractModule.exposures.some(exposure => exposure.declarations.some(declaration => declaration.ref === target));
                });
                if (privateContractType) {
                    accept('error', 'Integration-event payload types must be public contract types exposed by their module or belong to a shared kernel.', {
                        node: field,
                        property: 'type'
                    });
                }
            }
        }
        const sourceAggregate = this.getOwningAggregate(field);
        for (const reference of typeReferences) {
            const target = reference.ref;
            const targetAggregate = target && isEntity(target) ? this.getOwningAggregate(target) : undefined;
            if (targetAggregate && targetAggregate !== sourceAggregate) {
                accept('error', 'An aggregate must reference another aggregate through its identifier, not its entity.', {
                    node: field,
                    property: 'type'
                });
                break;
            }
        }
        if (!field.identifier) {
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
            const signature = constructor.parameters.map(parameter => this.getParameterTypeSignature(parameter)).join(',');
            if (signatures.has(signature)) {
                accept('error', 'Duplicate constructor signature.', {
                    node: constructor,
                    property: 'parameters'
                });
            }
            signatures.add(signature);
        }
    }

    private getParameterTypeSignature(parameter: Parameter): string {
        if (parameter.eventType) {
            return `event:${parameter.eventType.ref ? getExportedName(parameter.eventType.ref as AstNode & { name: string }) : parameter.eventType.$refText}`;
        }
        if (parameter.primitive) {
            return parameter.primitive;
        }
        if (parameter.type?.ref) {
            return getExportedName(parameter.type.ref as AstNode & { name: string });
        }
        return this.getCollectionTypeSignature(parameter.collection);
    }

    private getCollectionTypeSignature(collection?: CollectionType): string {
        if (!collection) {
            return '?';
        }
        const element = collection.elementPrimitive ??
            (collection.elementType?.ref
                ? getExportedName(collection.elementType.ref as AstNode & { name: string })
                : this.getCollectionTypeSignature(collection.elementCollection));
        const value = collection.valuePrimitive ??
            (collection.valueType?.ref
                ? getExportedName(collection.valueType.ref as AstNode & { name: string })
                : this.getCollectionTypeSignature(collection.valueCollection));
        return collection.kind === 'Map' ? `Map<${element},${value}>` : `${collection.kind}<${element}>`;
    }

    private checkEntityStateGraph(entity: Entity, accept: ValidationAcceptor): void {
        for (const field of entity.fields) {
            const stateType = field.type?.ref;
            if (!stateType || !isEnumType(stateType)) {
                continue;
            }
            const edges = entity.methods.flatMap(method => method.transitions)
                .filter(transition => transition.field === field.name);
            const seenEdges = new Set<string>();
            for (const edge of edges) {
                const key = `${edge.from}->${edge.to}`;
                if (seenEdges.has(key)) {
                    accept('error', `Duplicate state transition '${edge.from} -> ${edge.to}' for '${field.name}'.`, {
                        node: edge,
                        property: 'from'
                    });
                }
                seenEdges.add(key);
            }

            if (field.initialState === undefined) {
                continue;
            }
            const reachable = new Set<string>([field.initialState]);
            let changed = true;
            while (changed) {
                changed = false;
                for (const edge of edges) {
                    if (reachable.has(edge.from) && !reachable.has(edge.to)) {
                        reachable.add(edge.to);
                        changed = true;
                    }
                }
            }
            const unreachable = stateType.values.find(value => !reachable.has(value.name));
            if (unreachable) {
                accept('error', `State '${unreachable.name}' is unreachable from initial state '${field.initialState}'.`, {
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
        const eventParameters = method.parameters.filter(parameter => parameter.eventType);
        const applicationService = isApplicationService(method.$container) ? method.$container : undefined;
        const queryService = isQueryService(method.$container) ? method.$container : undefined;
        const projectorService = isProjector(method.$container) ? method.$container : undefined;
        const projector = projectorService !== undefined;
        if (method.transactional && !applicationService) {
            accept('error', 'Only application-service commands can declare a transaction.', {
                node: method,
                property: 'transactional'
            });
        } else if (method.transactional && !method.loadRepository && !method.creationMethod && !method.deleteRepository) {
            accept('error', 'A transaction marker requires an aggregate write workflow.', {
                node: method,
                property: 'transactional'
            });
        }
        if (queryService) {
            if (!method.returnPrimitive && !method.returnType && !method.returnCollection) {
                accept('error', 'A query must declare a result type.', {
                    node: method,
                    property: 'returnType'
                });
            }
            if (eventParameters.length > 0 || method.events.length > 0 || method.loadRepository || method.creationMethod || method.deleteRepository || method.saveRepository || method.transactional) {
                accept('error', 'A query cannot handle events, emit events, create aggregates, save aggregates, or delete aggregates.', {
                    node: method,
                    property: 'returnType'
                });
            }
        }
        if (method.updatesRepository && !projector) {
            accept('error', 'Only projectors may update query repositories.', {
                node: method,
                property: 'updatesRepository'
            });
        }
        if (eventParameters.length > 0) {
            if (!applicationService && !projector) {
                accept('error', 'Event-typed method parameters are allowed only on application-service handlers and projectors.', {
                    node: method,
                    property: 'parameters'
                });
            }
            if (eventParameters.length !== 1 || method.parameters.length !== 1) {
                accept('error', 'An event-triggered method must have exactly one event-typed parameter.', {
                    node: method,
                    property: 'parameters'
                });
            }
            const event = eventParameters[0].eventType?.ref;
            if (event && isDomainEvent(event) && getOwningContextName(event) !== getOwningContextName(method)) {
                accept('error', 'A domain event can be handled only in its own bounded context.', {
                    node: eventParameters[0],
                    property: 'eventType'
                });
            }
            if (event && isIntegrationEvent(event) && this.isCrossContextOwned(method, event) && !this.hasAuthorizedEventRelationship(method, event)) {
                accept('error', this.isIntegrationEventExposed(event)
                    ? 'Consuming this integration event requires an imported context map with an authorized relationship to its producer.'
                    : 'An integration event in a module must be explicitly exposed before another bounded context can consume it.', {
                    node: eventParameters[0],
                    property: 'eventType'
                });
            }
        }
        if (method.returnType || method.returnCollection) {
            const returnTypes = this.collectTypeReferences(method.returnType, method.returnCollection);
            this.checkCrossContextTypeUse(method, returnTypes, accept, 'returnType');
            this.checkEntityBoundaryUse(method, returnTypes, accept, 'returnType', applicationService !== undefined || queryService !== undefined);
            this.checkReadModelTypeUse(method, returnTypes, accept, 'returnType', queryService !== undefined);
        }
        for (const invocation of method.invocations) {
            const target = invocation.ref;
            if (!target) {
                continue;
            }
            if (this.isCrossContextOwned(method, target)) {
                accept('error', 'An application-service method may invoke only methods in its own bounded context.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (target.parameters.some(parameter => parameter.eventType)) {
                accept('error', 'An event-triggered method cannot be invoked directly; invoke an ordinary command method instead.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (isApplicationService(target.$container) && !applicationService) {
                accept('error', 'Domain behavior cannot invoke an application-service method.', {
                    node: method,
                    property: 'invocations'
                });
            }
            const reachable = this.getReachableMethods(target);
            if (!applicationService && !isApplicationService(target.$container) &&
                reachable.some(candidate => isApplicationService(candidate.$container))) {
                accept('error', 'Domain behavior cannot transitively invoke an application-service method.', {
                    node: method,
                    property: 'invocations'
                });
            }
            const serviceAggregate = applicationService?.aggregate.ref;
            const targetIsAssociatedRoot = serviceAggregate !== undefined &&
                this.getOwningAggregate(target) === serviceAggregate && this.isAggregateRootMethod(target, serviceAggregate);
            if (applicationService && !isApplicationService(target.$container) && (
                reachable.some(candidate => isApplicationService(candidate.$container)) ||
                (!targetIsAssociatedRoot && reachable.some(candidate => this.getOwningAggregate(candidate) !== undefined))
            )) {
                accept('error', 'An application service must reach aggregate behavior directly through its root, not through a domain-service call chain.', {
                    node: method,
                    property: 'invocations'
                });
            }
            const sourceAggregate = this.getOwningAggregate(method);
            const targetAggregate = this.getOwningAggregate(target);
            if (targetAggregate && !this.isAggregateRootMethod(target, targetAggregate) && !isEntity(method.$container)) {
                accept('error', 'Only entity behavior may invoke child-entity methods; aggregate-root behavior must coordinate aggregate changes.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (sourceAggregate && targetAggregate && targetAggregate !== sourceAggregate) {
                accept('error', 'Domain behavior must not invoke another aggregate directly.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (!applicationService && sourceAggregate && reachable.some(candidate => {
                const candidateAggregate = this.getOwningAggregate(candidate);
                return candidateAggregate !== undefined && candidateAggregate !== sourceAggregate;
            })) {
                accept('error', 'Domain behavior must not transitively invoke another aggregate.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (applicationService && isApplicationService(target.$container) && target.$container !== applicationService &&
                (eventParameters.length !== 1 || target.parameters.some(parameter => parameter.eventType))) {
                accept('error', 'Only an event handler may dispatch to a command in another application service.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (queryService && (target.$container !== queryService || this.hasBehaviorSideEffects(target))) {
                accept('error', 'A query service may invoke only read-only query helpers in the same query service.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (queryService && this.getOwningAggregate(target)) {
                accept('error', 'A query service must read through query repositories, not aggregate methods.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (applicationService && this.getOwningAggregate(target) && this.getOwningAggregate(target) !== applicationService.aggregate.ref) {
                accept('error', 'An application service may invoke domain behavior only on its associated aggregate.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (applicationService && this.getOwningAggregate(target) === applicationService.aggregate.ref &&
                !method.loadRepository && !method.creationMethod && !method.deleteRepository) {
                accept('error', 'Aggregate behavior must be invoked in an application-service repository workflow.', {
                    node: method,
                    property: 'invocations'
                });
            }
        }
        if (applicationService) {
            this.checkApplicationServiceWorkflow(method, applicationService, accept);
        }
        if (queryService) {
            this.checkQueryServiceMethod(method, queryService, accept);
        }
        if (projector) {
            this.checkProjectorMethod(method, projectorService!, accept);
        }
        const owningAggregate = this.getOwningAggregate(method);
        for (const emitted of method.events) {
            if (!emitted.ref) {
                continue;
            }
            if (this.isCrossContextOwned(method, emitted.ref)) {
                accept('error', 'A method may emit only events owned by its bounded context.', {
                    node: method,
                    property: 'events'
                });
            }
            if (queryService) {
                accept('error', 'A query cannot emit events.', { node: method, property: 'events' });
                continue;
            }
            if (owningAggregate && this.isAggregateRootMethod(method, owningAggregate)) {
                if (!isDomainEvent(emitted.ref)) {
                    accept('error', 'Aggregate-root behavior may emit only domain events.', {
                        node: method,
                        property: 'events'
                    });
                }
            } else if (applicationService && eventParameters.length === 1 && isDomainEvent(eventParameters[0].eventType?.ref)) {
                if (!isIntegrationEvent(emitted.ref)) {
                    accept('error', 'A domain-event handler may emit only integration events.', {
                        node: method,
                        property: 'events'
                    });
                } else if (!method.afterCommit) {
                    accept('error', 'Integration events mapped from domain events must be emitted after commit.', {
                        node: method,
                        property: 'afterCommit'
                    });
                }
            } else if (method.events.length > 0) {
                accept('error', 'Only aggregate-root behavior may emit domain events, and only a domain-event handler may emit integration events.', {
                    node: method,
                    property: 'events'
                });
            }
        }
        const afterCommitBridge = applicationService && eventParameters.length === 1 &&
            isDomainEvent(eventParameters[0]?.eventType?.ref) && method.events.some(event => isIntegrationEvent(event.ref));
        const afterCommitProjector = projector && eventParameters.length === 1 && method.updatesRepository !== undefined;
        if (method.afterCommit && !afterCommitBridge && !afterCommitProjector) {
            accept('error', 'The after-commit clause is reserved for integration-event handlers and projectors.', {
                node: method,
                property: 'afterCommit'
            });
        }
    }

    checkApplicationService(service: ApplicationService, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(service, accept);
        if (service.aggregate.ref && this.isCrossContextOwned(service, service.aggregate.ref)) {
            accept('error', 'An application service must be associated with an aggregate in its own bounded context.', {
                node: service,
                property: 'aggregate'
            });
        }
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
        if (projector.readModel.ref && getOwningContextName(projector.readModel.ref) !== getOwningContextName(projector)) {
            accept('error', 'A projector and its read model must belong to the same bounded context.', {
                node: projector,
                property: 'readModel'
            });
        }
    }

    private checkQueryServiceMethod(method: Method, service: QueryService, accept: ValidationAcceptor): void {
        if (method.loadRepository || method.creationMethod || method.deleteRepository || method.saveRepository || method.transactional) {
            accept('error', 'A query service cannot load, create, delete, save, or transact on aggregates.', {
                node: method,
                property: 'behaviors'
            });
        }
        const repositories = this.getQueryRepositoryReferences(method);
        if (repositories.length === 0) {
            accept('error', 'A query-service method must read from at least one query repository.', {
                node: method,
                property: 'behaviors'
            });
        }
        const queryContext = getOwningContextName(service);
        for (const repository of repositories) {
            if (getOwningContextName(repository) !== queryContext) {
                accept('error', 'A query service may read only query repositories in its own bounded context.', {
                    node: method,
                    property: 'behaviors'
                });
            }
        }
    }

    private checkProjectorMethod(method: Method, projector: Projector, accept: ValidationAcceptor): void {
        const eventParameters = method.parameters.filter(parameter => parameter.eventType);
        if (eventParameters.length !== 1 || method.parameters.length !== 1) {
            accept('error', 'A projector method must handle exactly one domain or integration event.', {
                node: method,
                property: 'parameters'
            });
        }
        if (!method.updatesRepository || method.updatesRepository.ref?.readModel.ref !== projector.readModel.ref) {
            accept('error', 'A projector must update a query repository for its declared read model.', {
                node: method,
                property: 'updatesRepository'
            });
        }
        if (!method.afterCommit) {
            accept('error', 'A projector must process committed events after commit.', {
                node: method,
                property: 'afterCommit'
            });
        }
        if (method.returnPrimitive || method.returnType || method.returnCollection) {
            accept('error', 'A projector handler does not return a value.', {
                node: method,
                property: 'returnType'
            });
        }
        if (method.invocations.length > 0 || method.loadRepository ||
            method.creationMethod || method.deleteRepository || method.saveRepository || method.transactional || method.events.length > 0) {
            accept('error', 'A projector may update its read model but cannot invoke domain/application methods or write aggregates.', {
                node: method,
                property: 'updatesRepository'
            });
        }
    }

    private getQueryRepositoryReferences(node: AstNode): QueryRepository[] {
        const repositories = new Set<QueryRepository>();
        AstUtils.streamAst(node).forEach(child => AstUtils.streamReferences(child).forEach(referenceInfo => {
            if (isReference(referenceInfo.reference) && isQueryRepository(referenceInfo.reference.ref)) {
                repositories.add(referenceInfo.reference.ref);
            }
        }));
        return [...repositories];
    }

    checkTransition(transition: import('./generated/ast.js').Transition, accept: ValidationAcceptor): void {
        const aggregate = this.getOwningAggregate(transition);
        const method = transition.$container;
        const entity = method.$container;
        if (!aggregate || !isEntity(entity)) {
            accept('error', 'A state transition must be declared in an entity method inside an aggregate.', {
                node: transition,
                keyword: 'transition'
            });
            return;
        }
        const field = entity.fields.find(candidate => candidate.name === transition.field);
        const stateType = field?.type?.ref;
        if (!field || !stateType || !isEnumType(stateType)) {
            accept('error', 'A transition must target an enum field declared on the owning entity.', {
                node: transition,
                property: 'field'
            });
            return;
        }
        const states = new Set(stateType.values.map((value: EnumValue) => value.name));
        if (!states.has(transition.from) || !states.has(transition.to)) {
            accept('error', `Transition states must be values of ${stateType.name}.`, {
                node: transition,
                property: !states.has(transition.from) ? 'from' : 'to'
            });
        }
    }

    checkFlow(flow: Flow, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(flow, accept);
        for (const element of flow.elements) {
            const method = element.method?.ref;
            if (!method) {
                continue;
            }
            const isCommand = isApplicationService(method.$container) && !method.parameters.some(parameter => parameter.eventType);
            const isQuery = isQueryService(method.$container);
            if (!isCommand && !isQuery) {
                accept('error', 'A flow may invoke only application-service commands or query-service methods.', {
                    node: element,
                    property: 'method'
                });
            }
            if (isQuery && this.hasBehaviorSideEffects(method)) {
                accept('error', 'A flow query step must be read-only.', { node: element, property: 'method' });
            }
            if (this.isCrossContextOwned(flow, method)) {
                accept('error', 'A flow may invoke only command and query methods in its own bounded context.', {
                    node: element,
                    property: 'method'
                });
            }
        }
    }

    checkConstructor(constructor: Constructor, accept: ValidationAcceptor): void {
        this.checkUniqueParameterNames(constructor.parameters, accept);
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
        const typeReferences = this.collectTypeReferences(parameter.type, parameter.collection);
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
        const sourceAggregate = this.getOwningAggregate(node);
        for (const reference of references) {
            const target = reference.ref;
            if (!target || !isEntity(target)) {
                continue;
            }
            const targetAggregate = this.getOwningAggregate(target);
            if (applicationServiceSignature ||
                (!target.root && sourceAggregate !== targetAggregate)) {
                accept('error', applicationServiceSignature
                    ? 'Application-service signatures must use identifiers or data values, not entity instances.'
                    : 'A child entity cannot cross its aggregate boundary; pass its identifier instead.', {
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
            if (!this.isIdentifierValueObject(source)) {
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

    private isIdentifierValueObject(valueObject: ValueObject, visited = new Set<ValueObject>()): boolean {
        if (visited.has(valueObject)) {
            return false;
        }
        visited.add(valueObject);

        const aggregate = valueObject.$container;
        const isRootIdentifier = isAggregate(aggregate) && aggregate.members.some(member =>
            isEntity(member) && member.root && member.fields.some(field =>
                field.identifier && field.type?.ref === valueObject
            )
        );
        return isRootIdentifier || (valueObject.mirrors?.ref !== undefined &&
            this.isIdentifierValueObject(valueObject.mirrors.ref, visited));
    }

    checkModule(module: Module, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(module, accept);
        for (const dependency of module.dependencies) {
            if (dependency.ref === module) {
                accept('error', 'A module cannot depend on itself.', {
                    node: module,
                    property: 'dependencies'
                });
            }
            if (dependency.ref && getOwningContextName(dependency.ref) !== getOwningContextName(module)) {
                accept('error', 'A module can depend only on another module in the same bounded context.', {
                    node: module,
                    property: 'dependencies'
                });
            }
            if (dependency.ref && dependency.ref !== module && this.dependsTransitivelyOn(dependency.ref, module, new Set())) {
                accept('error', 'Module dependencies cannot contain a cycle.', {
                    node: module,
                    property: 'dependencies'
                });
                break;
            }
        }
        for (const exposure of module.exposures) {
            for (const declaration of exposure.declarations) {
                if (declaration.ref && getOwningModule(declaration.ref) !== module) {
                    accept('error', 'A module may expose only declarations that it owns.', {
                        node: exposure,
                        property: 'declarations'
                    });
                }
            }
        }
    }

    private dependsTransitivelyOn(current: Module, target: Module, visited: Set<Module>): boolean {
        if (current === target) {
            return true;
        }
        if (visited.has(current)) {
            return false;
        }
        visited.add(current);
        return current.dependencies.some(dependency => dependency.ref && this.dependsTransitivelyOn(dependency.ref, target, visited));
    }

    checkSharedKernel(sharedKernel: SharedKernel, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(sharedKernel, accept);
        const disallowed = new Set([
            'Aggregate', 'ApplicationService', 'Capability', 'DomainEvent', 'DomainService',
            'Factory', 'Flow', 'IntegrationEvent', 'Projector', 'QueryRepository', 'QueryService', 'ReadModel', 'Repository', 'Subdomain'
        ]);
        for (const node of AstUtils.streamAst(sharedKernel)) {
            if (disallowed.has(node.$type)) {
                accept('error', 'A shared kernel may contain only reusable value objects, enums, and modules.', {
                    node: sharedKernel,
                    property: 'members'
                });
                break;
            }
        }
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
            const sourceModule = getOwningModule(referenceInfo.container);
            const targetModule = getOwningModule(target);
            const crossesContext = this.isCrossContextOwned(referenceInfo.container, target);
            if (isField(target) && crossesContext && !isInSharedKernel(target)) {
                const event = isIntegrationEvent(target.$container) ? target.$container : undefined;
                const authorizedPublicField = event !== undefined && this.isIntegrationEventExposed(event) &&
                    this.hasAuthorizedEventRelationship(referenceInfo.container, event);
                if (!authorizedPublicField) {
                    accept('error', isDomainEvent(target.$container)
                        ? 'Specification text cannot reference a private DomainEvent field from another bounded context.'
                        : 'Specification text cannot reference a private field from another bounded context.', {
                        node: referenceInfo.container,
                        property: referenceInfo.property
                    });
                    return;
                }
            }
            if (target.$type === 'Method' && crossesContext && !isInSharedKernel(target)) {
                accept('error', 'Specification text cannot reference a private method from another bounded context.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property
                });
                return;
            }
            if (crossesContext && !isInSharedKernel(target) &&
                (isParameter(target) || isDataObject(target) || isReadModel(target) || isQueryRepository(target))) {
                accept('error', 'Specification text cannot reference private operation, data, or query types from another bounded context.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property
                });
                return;
            }
            if (!sourceModule || !targetModule || sourceModule === targetModule || isModule(target)) {
                return;
            }
            if (getOwningContextName(sourceModule) !== getOwningContextName(targetModule) || isInSharedKernel(target)) {
                return;
            }
            const dependsOn = sourceModule.dependencies.some(dependency => dependency.ref === targetModule);
            const exposureTarget = isField(target) || isParameter(target) ? target.$container : target;
            const exposed = targetModule.exposures.some(exposure =>
                exposure.declarations.some(declaration => declaration.ref === exposureTarget)
            );
            if (!dependsOn || !exposed) {
                accept('error', 'This module reference requires a dependency on a module that exposes the target declaration.', {
                    node: referenceInfo.container,
                    property: referenceInfo.property
                });
            }
        });
    }

    checkRepository(repository: Repository, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(repository, accept);
        if (repository.aggregate.ref && this.isCrossContextOwned(repository, repository.aggregate.ref)) {
            accept('error', 'A repository must belong to an aggregate in its own bounded context.', {
                node: repository,
                property: 'aggregate'
            });
        }
        if (!repository.aggregate.ref) {
            return;
        }
        const writeRepositories = this.services.shared.workspace.LangiumDocuments.all.toArray()
            .flatMap(document => document.parseResult.value
                ? AstUtils.streamAst(document.parseResult.value).filter(isRepository)
                    .filter(candidate => candidate.aggregate.ref === repository.aggregate.ref).toArray()
                : []);
        const ordered = writeRepositories.sort((left, right) => this.getDeclarationKey(left).localeCompare(this.getDeclarationKey(right)));
        if (ordered.length > 1 && ordered[0] !== repository) {
            accept('error', 'An aggregate may have only one write repository; use query repositories for read models.', {
                node: repository,
                property: 'aggregate'
            });
        }
    }

    private getDeclarationKey(node: AstNode): string {
        const document = AstUtils.getDocument(node);
        return `${document.uri.toString()}#${this.services.workspace.AstNodeLocator.getAstNodePath(node)}`;
    }

    checkQueryRepository(repository: QueryRepository, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(repository, accept);
        if (repository.readModel.ref && getOwningContextName(repository.readModel.ref) !== getOwningContextName(repository)) {
            accept('error', 'A query repository and its read model must belong to the same bounded context.', {
                node: repository,
                property: 'readModel'
            });
        }
    }

    private checkApplicationServiceWorkflow(method: Method, service: ApplicationService | undefined, accept: ValidationAcceptor): void {
        const hasWorkflowClause = method.loadRepository !== undefined || method.creationMethod !== undefined ||
            method.deleteRepository !== undefined || method.saveRepository !== undefined;
        if (!service) {
            if (hasWorkflowClause) {
                accept('error', 'Repository workflow clauses are allowed only in application-service methods.', {
                    node: method,
                    property: 'loadRepository'
                });
            }
            return;
        }
        if (!hasWorkflowClause && method.parameters.some(parameter => parameter.eventType)) {
            return;
        }
        const aggregate = service.aggregate.ref;
        if (!aggregate) {
            return;
        }
        if (method.loadRepository) {
            this.validateRepositoryLoadKey(method, service, accept);
        }

        const invocations = method.invocations.map(invocation => invocation.ref)
            .filter((target): target is Method => target !== undefined);
        const aggregateInvocations = invocations
            .filter((target): target is Method => target !== undefined && this.getOwningAggregate(target) === aggregate);

        if (!hasWorkflowClause) {
            accept('error', 'An application-service command must declare a repository workflow for its associated aggregate.', {
                node: method,
                property: 'loadRepository'
            });
            return;
        }

        if (!method.transactional) {
            accept('error', 'Aggregate write workflows must declare a transaction.', {
                node: method,
                property: 'transactional'
            });
        }

        const loadRepository = method.loadRepository?.ref;
        const saveRepository = method.saveRepository?.ref;
        const deleteRepository = method.deleteRepository?.ref;
        const isCreationWorkflow = method.creationMethod !== undefined;
        const isDeletionWorkflow = method.deleteRepository !== undefined;

        if (isCreationWorkflow || isDeletionWorkflow) {
            const validCreation = isCreationWorkflow && !method.loadRepository && !method.deleteRepository && !!method.saveRepository;
            const validDeletion = isDeletionWorkflow && !!method.loadRepository && aggregateInvocations.length > 0 &&
                !method.creationMethod && !method.saveRepository;
            if (!validCreation && !validDeletion) {
                accept('error', 'A command must create and save, load and invoke before deleting, or load, invoke, and save an aggregate.', {
                    node: method,
                    property: 'loadRepository'
                });
                return;
            }
        } else if (!method.loadRepository || !method.saveRepository || aggregateInvocations.length === 0) {
            accept('error', 'A command that invokes an existing aggregate must load and save it through a repository.', {
                node: method,
                property: 'loadRepository'
            });
            return;
        }

        if (isCreationWorkflow && (!saveRepository || saveRepository.aggregate.ref !== aggregate)) {
            accept('error', 'A creation workflow must save through a repository for its application service aggregate.', {
                node: method,
                property: 'saveRepository'
            });
        } else if (isDeletionWorkflow && (!loadRepository || loadRepository !== deleteRepository || deleteRepository?.aggregate.ref !== aggregate)) {
            accept('error', 'A deletion workflow must load and delete through the same repository for its application service aggregate.', {
                node: method,
                property: 'deleteRepository'
            });
        } else if (!isCreationWorkflow && !isDeletionWorkflow &&
            (!loadRepository || loadRepository !== saveRepository || saveRepository?.aggregate.ref !== aggregate)) {
            accept('error', 'A repository workflow must load and save through the same repository for the application service aggregate.', {
                node: method,
                property: 'saveRepository'
            });
        }

        if (isCreationWorkflow) {
            const creationMethod = method.creationMethod;
            const factoryMethod = creationMethod?.ref;
            const factory = factoryMethod?.$container;
            if (!factoryMethod || !isFactory(factory) || factory.aggregate.ref !== aggregate ||
                factoryMethod.returnType?.ref !== aggregate.members.find(member => isEntity(member) && member.root)) {
                accept('error', 'A creation workflow must create the associated aggregate root through one of its factory methods.', {
                    node: method,
                    property: 'creationMethod'
                });
            }
        }

        this.validateAggregateInvocations(method, aggregateInvocations, aggregate, accept);
    }

    private validateAggregateInvocations(
        source: Method,
        targets: Method[],
        aggregate: Aggregate,
        accept: ValidationAcceptor
    ): void {
        for (const target of targets) {
            if (!this.isAggregateRootMethod(target, aggregate)) {
                accept('error', 'An application service may invoke only methods declared on its associated aggregate root.', {
                    node: source,
                    property: 'invocations'
                });
            }
            if (isEntity(target.returnType?.ref) && !target.returnType.ref.root) {
                accept('error', 'An aggregate-root method must not return a child entity across the aggregate boundary.', {
                    node: source,
                    property: 'invocations'
                });
            }
            if (target.parameters.some(parameter => parameter.eventType)) {
                accept('error', 'An event-triggered method cannot be invoked as aggregate behavior.', {
                    node: source,
                    property: 'invocations'
                });
            }
        }
    }

    private hasBehaviorSideEffects(method: Method, visited = new Set<Method>()): boolean {
        if (visited.has(method)) {
            return false;
        }
        visited.add(method);
        if (method.transitions.length > 0 || method.events.length > 0 || method.transactional ||
            method.creationMethod !== undefined || method.deleteRepository !== undefined || method.saveRepository !== undefined) {
            return true;
        }
        return method.invocations.some(invocation => invocation.ref && this.hasBehaviorSideEffects(invocation.ref, visited));
    }

    private getReachableMethods(method: Method, visited = new Set<Method>()): Method[] {
        if (visited.has(method)) {
            return [];
        }
        visited.add(method);
        const reachable: Method[] = [];
        for (const invocation of method.invocations) {
            const target = invocation.ref;
            if (!target) {
                continue;
            }
            reachable.push(target, ...this.getReachableMethods(target, visited));
        }
        return reachable;
    }

    private validateRepositoryLoadKey(method: Method, service: ApplicationService, accept: ValidationAcceptor): void {
        const aggregate = service.aggregate.ref;
        const root = aggregate?.members.find(member => isEntity(member) && member.root);
        const identifierType = isEntity(root)
            ? root.fields.find(field => field.identifier)?.type?.ref
            : undefined;
        const path = (method.loadParameter ?? '').split('.');
        const parameter = method.parameters.find(candidate => candidate.name === path[0]);
        let resolvedType = parameter?.type?.ref;
        let valid = parameter !== undefined && !parameter.optional && identifierType !== undefined;
        for (const segment of path.slice(1)) {
            const fields = resolvedType && 'fields' in resolvedType
                ? (resolvedType as DataObject | ReadModel | ValueObject).fields
                : [];
            const field = fields.find(candidate => candidate.name === segment);
            if (!field || field.optional || field.collection || !field.type?.ref) {
                valid = false;
                break;
            }
            resolvedType = field.type.ref;
        }
        if (!valid || !identifierType || resolvedType !== identifierType) {
            accept('error', 'A repository load must use a method parameter typed as the aggregate root identifier.', {
                node: method,
                property: 'loadParameter'
            });
        }
    }

    private isAggregateRootMethod(method: Method, aggregate: Aggregate): boolean {
        const root = aggregate.members.find(member => isEntity(member) && member.root);
        return isEntity(root) && method.$container === root;
    }

    checkFactory(factory: Factory, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(factory, accept);
        if (factory.aggregate.ref && this.isCrossContextOwned(factory, factory.aggregate.ref)) {
            accept('error', 'A factory must belong to an aggregate in its own bounded context.', {
                node: factory,
                property: 'aggregate'
            });
        }
        const root = factory.aggregate.ref?.members.find(member => isEntity(member) && member.root);
        for (const method of factory.methods) {
            if (!root || method.returnType?.ref !== root) {
                accept('error', 'A factory method must return the root entity of its associated aggregate.', {
                    node: method,
                    property: 'returnType'
                });
            }
        }
    }

    checkContextRelationship(relationship: ContextRelationship, accept: ValidationAcceptor): void {
        const endpoints = this.getContextMapEndpoints(relationship);
        const sharedKernelRelationship = isSharedKernelRelationship(relationship);
        const contexts = sharedKernelRelationship
            ? relationship.participants
            : isSeparateWaysRelationship(relationship)
                ? [relationship.left, relationship.right]
                : endpoints.map(endpoint => endpoint.context);
        const resolvedContexts = contexts.map(context => context.ref).filter((context): context is BoundedContext => context !== undefined);

        if (sharedKernelRelationship && resolvedContexts.length < 2) {
            accept('error', 'A shared-kernel relationship must include at least two bounded contexts.', {
                node: relationship,
                property: 'participants'
            });
        }

        if (new Set(resolvedContexts).size !== resolvedContexts.length) {
            accept('error', 'A context relationship must connect different bounded contexts.', {
                node: relationship,
                property: sharedKernelRelationship ? 'participants' : isCustomerSupplierRelationship(relationship) ? 'supplier' : 'right'
            });
        }

        for (const endpoint of endpoints) {
            if (new Set(endpoint.integrationPatterns).size !== endpoint.integrationPatterns.length) {
                accept('error', 'An integration pattern may only be listed once per bounded context.', {
                    node: endpoint,
                    property: 'integrationPatterns'
                });
            }
            for (const pattern of endpoint.integrationPatterns) {
                if (!INTEGRATION_PATTERNS.has(pattern)) {
                    accept('error', `Unknown integration pattern '${pattern}'. Expected one of: ${[...INTEGRATION_PATTERNS].join(', ')}.`, {
                        node: endpoint,
                        property: 'integrationPatterns'
                    });
                }
            }
        }
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
        node: Aggregate | ApplicationService | BoundedContext | Capability | ContextMap | DomainEvent | DomainService | Entity | EnumType |
        DataObject | Factory | Flow | IntegrationEvent | Module | Projector | QueryRepository | QueryService | ReadModel | Repository | SharedKernel | Subdomain | ValueObject,
        accept: ValidationAcceptor
    ): void {
        this.checkDuplicateDeclaration(node, accept);
    }

    private checkDuplicateDeclaration(
        node: Aggregate | ApplicationService | BoundedContext | Capability | ContextMap | DomainEvent | DomainService | Entity | EnumType |
        DataObject | Factory | Flow | IntegrationEvent | Method | Module | Projector | QueryRepository | QueryService | ReadModel | Repository | SharedKernel | Subdomain | ValueObject,
        accept: ValidationAcceptor
    ): void {
        const name = getExportedName(node);
        const descriptions = this.services.shared.workspace.IndexManager
            .allElements()
            .filter(description => description.name === name)
            .toArray();
        if (descriptions.length < 2) {
            return;
        }

        const document = AstUtils.getDocument(node);
        const path = this.services.workspace.AstNodeLocator.getAstNodePath(node);
        const currentIndex = descriptions.findIndex(description =>
            UriUtils.equals(description.documentUri, document.uri) && description.path === path
        );
        if (currentIndex > 0) {
            return;
        }

        accept('error', `Duplicate declaration '${name}'.`, {
            node,
            property: 'name'
        });
    }

    private hasAuthorizedEventRelationship(source: AstNode, event: IntegrationEvent): boolean {
        if (!this.isIntegrationEventExposed(event)) {
            return false;
        }
        const consumer = getOwningContextName(source);
        const producer = getOwningContextName(event);
        if (!consumer || !producer) {
            return false;
        }
        const document = AstUtils.getDocument(source);
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return false;
        }
        const eventDocument = AstUtils.getDocument(event);
        if (!model.imports.some(declaration => UriUtils.equals(resolveImportUri(document, declaration), eventDocument.uri))) {
            return false;
        }

        for (const declaration of model.imports) {
            const mapDocument = this.services.shared.workspace.LangiumDocuments.getDocument(resolveImportUri(document, declaration));
            const importedModel = mapDocument?.parseResult.value;
            if (!mapDocument || !isModel(importedModel)) {
                continue;
            }
            for (const contextMap of importedModel.declarations.filter(isContextMap)) {
                if (declaration.components.length > 0 && !declaration.components.some(component => component.component.ref === contextMap)) {
                    continue;
                }
                for (const relationship of contextMap.relationships) {
                    if (this.authorizesEventRelationship(relationship, consumer, producer)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private isIntegrationEventExposed(event: IntegrationEvent): boolean {
        const module = getOwningModule(event);
        return module === undefined || module.exposures.some(exposure =>
            exposure.declarations.some(declaration => declaration.ref === event)
        );
    }

    private authorizesEventRelationship(relationship: ContextRelationship, consumer: string, producer: string): boolean {
        if (isCustomerSupplierRelationship(relationship)) {
            return relationship.customer.context.ref?.name === consumer &&
                relationship.supplier.context.ref?.name === producer;
        }
        if (isPartnershipRelationship(relationship)) {
            const left = relationship.left.context.ref?.name;
            const right = relationship.right.context.ref?.name;
            return (left === consumer && right === producer) || (right === consumer && left === producer);
        }
        return false;
    }

    private getContextMapEndpoints(relationship: ContextRelationship): ContextMapEndpoint[] {
        if (isCustomerSupplierRelationship(relationship)) {
            return [relationship.customer, relationship.supplier];
        }
        if (isPartnershipRelationship(relationship)) {
            return [relationship.left, relationship.right];
        }
        return [];
    }

    private getOwningAggregate(node: AstNode): Aggregate | undefined {
        let current: AstNode | undefined = node;
        while (current) {
            if (isAggregate(current)) {
                return current;
            }
            current = current.$container;
        }
        return undefined;
    }

    private collectTypeReferences(
        type?: Reference<TypeDeclaration>,
        collection?: CollectionType
    ): Reference<TypeDeclaration>[] {
        const references = type ? [type] : [];
        if (collection) {
            references.push(
                ...this.collectTypeReferences(collection.elementType, collection.elementCollection),
                ...this.collectTypeReferences(collection.valueType, collection.valueCollection)
            );
        }
        return references;
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
                const sharedKernel = this.getOwningSharedKernel(target);
                if (sourceContext && (!sharedKernel || !this.hasSharedKernelRelationship(node, sharedKernel))) {
                    accept('error', 'Using a shared-kernel type requires an imported context map that declares a shared-kernel relationship for this context.', {
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

    private hasSharedKernelRelationship(source: AstNode, sharedKernel: SharedKernel): boolean {
        const contextName = getOwningContextName(source);
        const document = AstUtils.getDocument(source);
        const model = document.parseResult.value;
        if (!contextName || !isModel(model)) {
            return false;
        }
        const contextMaps = [...model.declarations.filter(isContextMap)];
        for (const declaration of model.imports) {
            const importedDocument = this.services.shared.workspace.LangiumDocuments.getDocument(resolveImportUri(document, declaration));
            const importedModel = importedDocument?.parseResult.value;
            if (!importedDocument || !isModel(importedModel)) {
                continue;
            }
            contextMaps.push(...importedModel.declarations.filter(isContextMap).filter(contextMap =>
                declaration.components.length === 0 || declaration.components.some(component => component.component.ref === contextMap)
            ));
        }
        return contextMaps.some(contextMap => contextMap.relationships.some(relationship =>
            isSharedKernelRelationship(relationship) && relationship.sharedKernel.ref === sharedKernel &&
            relationship.participants.some(participant => participant.ref?.name === contextName)
        ));
    }

    private getOwningSharedKernel(node: AstNode): SharedKernel | undefined {
        let current: AstNode | undefined = node;
        while (current) {
            if (isSharedKernel(current)) {
                return current;
            }
            current = current.$container;
        }
        return undefined;
    }

    private isCrossContextOwned(source: AstNode, target: AstNode): boolean {
        const sourceContext = getOwningContextName(source);
        const targetContext = getOwningContextName(target);
        return sourceContext !== undefined && targetContext !== undefined && sourceContext !== targetContext;
    }

    private reachesImportCycle(uri: URI, visited: Set<string>): boolean {
        const document = this.services.shared.workspace.LangiumDocuments.getDocument(uri);
        const model = document?.parseResult.value;
        if (!document || !isModel(model)) {
            return false;
        }

        for (const importDeclaration of model.imports) {
            const importedUri = resolveImportUri(document, importDeclaration);
            const importedKey = importedUri.toString();
            if (visited.has(importedKey)) {
                return true;
            }
            const nextVisited = new Set(visited);
            nextVisited.add(importedKey);
            if (this.reachesImportCycle(importedUri, nextVisited)) {
                return true;
            }
        }
        return false;
    }
}
