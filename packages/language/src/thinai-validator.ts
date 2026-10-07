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
    Actor,
    ApplicationService,
    BoundedContext,
    BoundedContextPart,
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
    Factory,
    Import,
    ImportComponent,
    IntegrationEvent,
    Field,
    Journey,
    JourneyStep,
    MethodInvocation,
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
    isDomainService,
    isEntity,
    isEnumValue,
    isField,
    isIntegrationEvent,
    isContextMap,
    isCustomerSupplierRelationship,
    isEnumType,
    isFactory,
    isModel,
    isModule,
    isMethod,
    isPartnershipRelationship,
    isProjector,
    isDataObject,
    isQueryRepository,
    isParameter,
    isRepository,
    isQueryService,
    isReadModel,
    isSeparateWaysRelationship,
    isSpecificationTextPart,
    isSharedKernel,
    isSharedKernelRelationship,
    isValueObject
} from './generated/ast.js';
import type { ThinaiServices } from './thinai-module.js';
import { getExportedName, getOwningContextName, getOwningModule, isInSharedKernel, resolveImportUri } from './thinai-scope.js';
import { INTEGRATION_PATTERNS } from './thinai-constants.js';
import { isLineSeparatedSibling } from './thinai-layout.js';

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
        Actor: validator.checkActor,
        Journey: validator.checkJourney,
        ApplicationService: validator.checkApplicationService,
        Method: validator.checkMethod,
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
            accept('error', 'A bounded-context contribution must directly import its canonical declaration.', {
                node: part,
                keyword: 'in'
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
            const declarations: Array<{ name: string; node: ImportComponent; property: string }> = [];
            for (const component of importDeclaration.components) {
                declarations.push({
                    name: component.alias?.$refText ?? component.component.$refText,
                    node: component,
                    property: component.alias ? 'alias' : 'component'
                });
            }
            for (const declaration of declarations) {
                if (names.has(declaration.name)) {
                    const message = `Import component name '${declaration.name}' is declared more than once.`;
                    accept('error', message, {
                        node: declaration.node,
                        property: declaration.property === 'alias' ? 'alias' : 'component'
                    });
                } else {
                    names.set(declaration.name, declaration.node);
                }
            }
        }
    }

    checkModelLineBreaks(model: Model, accept: ValidationAcceptor): void {
        const siblings = new Map<AstNode, AstNode[]>();
        for (const node of AstUtils.streamAst(model)) {
            if (!node.$cstNode || !isLineSeparatedSibling(node) || !node.$container) {
                continue;
            }
            const children = siblings.get(node.$container) ?? [];
            children.push(node);
            siblings.set(node.$container, children);
        }

        const textDocument = AstUtils.getDocument(model).textDocument;
        const text = textDocument.getText();
        for (const children of siblings.values()) {
            children.sort((left, right) => left.$cstNode!.offset - right.$cstNode!.offset);
            for (let index = 1; index < children.length; index++) {
                const previous = children[index - 1]!;
                const current = children[index]!;
                const previousCst = previous.$cstNode!;
                const currentCst = current.$cstNode!;
                if (previous.$containerProperty === 'projects' && current.$containerProperty === 'projects' &&
                    text.slice(previousCst.end, currentCst.offset).includes(',')) {
                    continue;
                }
                if (previousCst.range.end.line < currentCst.range.start.line) {
                    continue;
                }
                accept('error', 'Start each sibling declaration or statement on a new line.', {
                    node: current,
                    range: currentCst.range,
                    code: 'line-break-required'
                });
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
                        !contractModule.exposures.some(exposure => exposure.declarations.some(declaration => declaration.target.ref === target));
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
        const eventType = this.getEventParameterType(parameter);
        if (eventType) {
            return `event:${getExportedName(eventType as AstNode & { name: string })}`;
        }
        if (parameter.primitive) {
            return parameter.primitive;
        }
        if (parameter.type?.ref) {
            return getExportedName(parameter.type.ref as AstNode & { name: string });
        }
        return this.getCollectionTypeSignature(parameter.collection);
    }

    private getEventParameterType(parameter: Parameter): DomainEvent | IntegrationEvent | undefined {
        const target = parameter.type?.ref;
        return isDomainEvent(target) || isIntegrationEvent(target) ? target : undefined;
    }

    private isEventParameter(parameter: Parameter): boolean {
        return this.getEventParameterType(parameter) !== undefined;
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

            if (field.initialState === undefined) {
                continue;
            }
            const reachable = new Set<string>([field.initialState]);
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
        const eventParameters = method.parameters.filter(parameter => this.isEventParameter(parameter));
        const applicationService = isApplicationService(method.$container) ? method.$container : undefined;
        const queryService = isQueryService(method.$container) ? method.$container : undefined;
        const projectorService = isProjector(method.$container) ? method.$container : undefined;
        const projector = projectorService !== undefined;
        if (method.projects.length > 0 && !projector) {
            accept('error', 'The projects clause is allowed only in projector methods.', {
                node: method,
                property: 'projects'
            });
        }
        if (queryService) {
            if (!method.returnPrimitive && !method.returnType && !method.returnCollection) {
                accept('error', 'A query must declare a result type.', {
                    node: method,
                    property: 'returnType'
                });
            }
            if (eventParameters.length > 0 || method.emissions.length > 0) {
                accept('error', 'A query cannot handle events or emit events.', {
                    node: method,
                    property: 'returnType'
                });
            }
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
            const event = this.getEventParameterType(eventParameters[0]);
            if (event && isDomainEvent(event) && getOwningContextName(event) !== getOwningContextName(method)) {
                accept('error', 'A domain event can be handled only in its own bounded context.', {
                    node: eventParameters[0],
                    property: 'type'
                });
            }
            if (event && isIntegrationEvent(event) && this.isCrossContextOwned(method, event) && !this.hasAuthorizedEventRelationship(method, event)) {
                accept('error', this.isIntegrationEventExposed(event)
                    ? 'Consuming this integration event requires an imported context map with an authorized relationship to its producer.'
                    : 'An integration event in a module must be explicitly exposed before another bounded context can consume it.', {
                    node: eventParameters[0],
                    property: 'type'
                });
            }
        }
        if (method.returnType || method.returnCollection) {
            const returnTypes = this.collectTypeReferences(method.returnType, method.returnCollection);
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
        for (const invocation of method.invocations) {
            const target = this.getInvokedMethod(invocation);
            if (!target) {
                accept('error', 'An invokes path must end at a method.', {
                    node: method,
                    property: 'invocations'
                });
                continue;
            }
            const targetSharedKernel = this.getOwningSharedKernel(target);
            const allowedSharedKernelService = targetSharedKernel !== undefined && isDomainService(target.$container) &&
                (applicationService !== undefined || isDomainService(method.$container)) &&
                this.hasVisibleSharedKernel(method, targetSharedKernel) &&
                this.hasSharedKernelRelationship(method, targetSharedKernel);
            if (this.isCrossContextOwned(method, target) && !allowedSharedKernelService) {
                accept('error', 'A method may invoke across bounded-context boundaries only through an authorized shared-kernel domain service.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (target.parameters.some(parameter => this.isEventParameter(parameter))) {
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
            const targetAggregate = this.getOwningAggregate(target);
            const targetIsAggregateRoot = targetAggregate !== undefined && this.isAggregateRootMethod(target, targetAggregate);
            const sourceAggregate = this.getOwningAggregate(method);
            if (isDomainService(method.$container) && (targetAggregate !== undefined || reachable.some(candidate =>
                this.getOwningAggregate(candidate) !== undefined
            ))) {
                accept('error', 'A domain service must not invoke aggregate-owned methods; application services should invoke aggregate roots directly.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (sourceAggregate && (isDomainService(target.$container) || reachable.some(candidate =>
                isDomainService(candidate.$container)
            ))) {
                accept('error', 'Aggregate-owned methods must not invoke domain services, directly or transitively; application services coordinate both.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (applicationService && !isApplicationService(target.$container) &&
                (reachable.some(candidate => isApplicationService(candidate.$container)) ||
                    (!targetIsAggregateRoot && reachable.some(candidate => this.getOwningAggregate(candidate) !== undefined)))) {
                accept('error', 'Application services must invoke aggregate-root behavior directly, not through another method call chain.', {
                    node: method,
                    property: 'invocations'
                });
            }
            const targetFactory = isFactory(target.$container) ? target.$container : undefined;
            const factoryReturnType = target.returnType?.ref;
            const isAssociatedFactoryMethod = applicationService !== undefined && targetFactory !== undefined &&
                isEntity(factoryReturnType) && factoryReturnType.root && this.getOwningAggregate(factoryReturnType) !== undefined;
            if (targetAggregate && !this.isAggregateRootMethod(target, targetAggregate) &&
                !isEntity(method.$container) && !isAssociatedFactoryMethod) {
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
                (eventParameters.length !== 1 || target.parameters.some(parameter => this.isEventParameter(parameter)))) {
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
                accept('error', 'A query service must not invoke aggregate methods.', {
                    node: method,
                    property: 'invocations'
                });
            }
            if (applicationService && targetAggregate && !this.isAggregateRootMethod(target, targetAggregate) && !isAssociatedFactoryMethod) {
                accept('error', 'An application service may invoke only aggregate-root behavior or a factory method that creates an aggregate root.', {
                    node: method,
                    property: 'invocations'
                });
            }
        }
        if (queryService) {
            this.checkQueryServiceMethod(method, queryService, accept);
        }
        if (projector) {
            this.checkProjectorMethod(method, projectorService!, accept);
        }
        const owningAggregate = this.getOwningAggregate(method);
        for (const emission of method.emissions) {
            for (const emitted of emission.events) {
                const emittedEvent = emitted.target.ref;
                if (!emittedEvent) {
                    continue;
                }
                if (this.isCrossContextOwned(method, emittedEvent)) {
                    accept('error', 'A method may emit only events owned by its bounded context.', {
                        node: emission,
                        property: 'events'
                    });
                }
                if (queryService) {
                    accept('error', 'A query cannot emit events.', { node: emission, property: 'events' });
                    continue;
                }
                if (owningAggregate && this.isAggregateRootMethod(method, owningAggregate)) {
                    if (!isDomainEvent(emittedEvent)) {
                        accept('error', 'Aggregate-root behavior may emit only domain events.', {
                            node: emission,
                            property: 'events'
                        });
                    }
                } else if (applicationService && eventParameters.length === 1 && isDomainEvent(this.getEventParameterType(eventParameters[0]))) {
                    if (!isIntegrationEvent(emittedEvent)) {
                        accept('error', 'A domain-event handler may emit only integration events.', {
                            node: emission,
                            property: 'events'
                        });
                    }
                } else {
                    accept('error', 'Only aggregate-root behavior may emit domain events, and only a domain-event handler may emit integration events.', {
                        node: emission,
                        property: 'events'
                    });
                }
            }
        }
    }

    private getInvokedMethod(invocation: MethodInvocation): Method | undefined {
        const target = invocation.targets.at(-1)?.ref;
        return isMethod(target) ? target : undefined;
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

    private checkQueryServiceMethod(method: Method, service: QueryService, accept: ValidationAcceptor): void {
        const repositories = this.getReadRepositoryReferences(method);
        const queryContext = getOwningContextName(service);
        for (const repository of repositories) {
            if (getOwningContextName(repository) !== queryContext) {
                accept('error', 'A query service may read only repositories in its own bounded context.', {
                    node: method,
                    property: 'behaviors'
                });
            }
        }
    }

    private checkProjectorMethod(method: Method, projector: Projector, accept: ValidationAcceptor): void {
        if (method.projects.length === 0) {
            accept('error', 'A projector method must declare at least one read model with projects.', {
                node: method,
                property: 'projects'
            });
        }
        for (const project of method.projects) {
            if (project.target.ref && getOwningContextName(project.target.ref) !== getOwningContextName(projector)) {
                accept('error', 'A projector and its read models must belong to the same bounded context.', {
                    node: method,
                    property: 'projects'
                });
            }
        }
        const eventParameters = method.parameters.filter(parameter => this.isEventParameter(parameter));
        if (eventParameters.length !== 1 || method.parameters.length !== 1) {
            accept('error', 'A projector method must handle exactly one domain or integration event.', {
                node: method,
                property: 'parameters'
            });
        }
        if (method.returnPrimitive || method.returnType || method.returnCollection) {
            accept('error', 'A projector handler does not return a value.', {
                node: method,
                property: 'returnType'
            });
        }
        if (method.invocations.length > 0 || method.emissions.length > 0 || method.transitions.length > 0) {
            accept('error', 'A projector describes a read-model projection and cannot invoke domain/application methods, emit events, or transition aggregate state.', {
                node: method,
                property: 'invocations'
            });
        }
        for (const repository of this.getReadRepositoryReferences(method)) {
            if (isRepository(repository)) {
                accept('error', 'A projector may describe query-repository output, not writes to an aggregate repository.', {
                    node: method,
                    property: 'behaviors'
                });
            } else if (!method.projects.some(project => project.target.ref === repository.readModel.ref)) {
                accept('error', 'A projector method may reference only query repositories for its declared projection targets.', {
                    node: method,
                    property: 'behaviors'
                });
            }
        }
    }

    private getReadRepositoryReferences(node: AstNode): Array<Repository | QueryRepository> {
        const repositories = new Set<Repository | QueryRepository>();
        AstUtils.streamAst(node).forEach(child => AstUtils.streamReferences(child).forEach(referenceInfo => {
            if (isReference(referenceInfo.reference) &&
                (isQueryRepository(referenceInfo.reference.ref) || isRepository(referenceInfo.reference.ref))) {
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
            const from = change.from?.ref;
            const to = change.to?.ref;
            const states = new Set(stateType.values);
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
        if (journey.actors.length === 0) {
            accept('error', 'A journey must contain at least one actor block.', {
                node: journey,
                property: 'actors'
            });
        }
        for (const actorBlock of journey.actors) {
            if (actorBlock.steps.length === 0) {
                accept('error', 'An actor block in a journey must contain at least one command step.', {
                    node: actorBlock,
                    property: 'steps'
                });
            }
            for (const step of actorBlock.steps) {
                this.checkJourneyStep(step, accept);
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
            const isCommand = isApplicationService(method.$container) && !method.parameters.some(parameter => this.isEventParameter(parameter));
            if (!isCommand) {
                accept('error', 'A journey may invoke only user-facing application-service commands, not event handlers or query methods.', {
                    node: step,
                    property: 'targets'
                });
            }
    }

    checkConstructor(constructor: Constructor, accept: ValidationAcceptor): void {
        this.checkUniqueParameterNames(constructor.parameters, accept);
        const sourceAggregate = this.getOwningAggregate(constructor);
        for (const parameter of constructor.parameters) {
            if (this.isEventParameter(parameter)) {
                accept('error', 'Constructors must not accept events; handle events in application-service methods or projectors.', {
                    node: parameter,
                    property: 'type'
                });
                continue;
            }
            const typeReferences = this.collectTypeReferences(parameter.type as Reference<TypeDeclaration> | undefined, parameter.collection);
            if (typeReferences.some(reference => isDataObject(reference.ref))) {
                accept('error', 'Constructors must accept domain values, not DataObjects; map DataObjects at the application boundary.', {
                    node: parameter,
                    property: 'type'
                });
            }
            const foreignRoot = typeReferences.find(reference => {
                const target = reference.ref;
                return isEntity(target) && target.root && this.getOwningAggregate(target) !== sourceAggregate;
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
        const typeReferences = this.collectTypeReferences(parameter.type as Reference<TypeDeclaration> | undefined, parameter.collection);
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
            if (dependency.target.ref && dependency.target.ref !== module && this.dependsTransitivelyOn(dependency.target.ref, module, new Set())) {
                accept('error', 'Module dependencies cannot contain a cycle.', {
                    node: module,
                    property: 'dependencies'
                });
                break;
            }
        }
        for (const exposure of module.exposures) {
            for (const declaration of exposure.declarations) {
                if (declaration.target.ref && getOwningModule(declaration.target.ref) !== module) {
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
        return current.dependencies.some(dependency => dependency.target.ref && this.dependsTransitivelyOn(dependency.target.ref, target, visited));
    }

    checkSharedKernel(sharedKernel: SharedKernel, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(sharedKernel, accept);
        const disallowed = new Set([
            'Aggregate', 'ApplicationService', 'DomainEvent',
            'DataObject', 'Factory', 'Journey', 'Actor', 'IntegrationEvent', 'Projector', 'QueryRepository', 'QueryService', 'ReadModel', 'Repository', 'Subdomain'
        ]);
        for (const node of AstUtils.streamAst(sharedKernel)) {
            if (disallowed.has(node.$type)) {
                accept('error', 'A shared kernel may contain only reusable value objects, enums, domain services, and modules.', {
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
            const isSpecificationReference = isSpecificationTextPart(referenceInfo.container);
            if (isSpecificationReference && crossesContext && !isInSharedKernel(target) &&
                (isAggregate(target) || isEntity(target) || isValueObject(target) || isEnumType(target) || isEnumValue(target) ||
                    isRepository(target) || isQueryRepository(target) || isParameter(target) || isDataObject(target) || isReadModel(target))) {
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
                (!this.isIntegrationEventExposed(target) || !this.hasAuthorizedEventRelationship(referenceInfo.container, target))) {
                accept('error', 'Cross-context IntegrationEvent references require an exposed contract and an authorized context-map relationship.', {
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
            const dependsOn = sourceModule.dependencies.some(dependency => dependency.target.ref === targetModule);
            const exposureTarget = isField(target) || isParameter(target) || isEnumValue(target) ? target.$container : target;
            const exposed = targetModule.exposures.some(exposure =>
                exposure.declarations.some(declaration => declaration.target.ref === exposureTarget)
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
        const root = repository.root.ref;
        const aggregate = root ? this.getOwningAggregate(root) : undefined;
        if (!isEntity(root) || !root.root || !aggregate) {
            accept('error', 'A repository must manage an aggregate-root entity.', {
                node: repository,
                property: 'root'
            });
            return;
        }
        if (this.isCrossContextOwned(repository, root)) {
            accept('error', 'A repository and its aggregate root must belong to the same bounded context.', {
                node: repository,
                property: 'root'
            });
        }
        const writeRepositories = this.services.shared.workspace.LangiumDocuments.all.toArray()
            .flatMap(document => document.parseResult.value
                ? AstUtils.streamAst(document.parseResult.value).filter(isRepository)
                    .filter(candidate => candidate.root.ref && this.getOwningAggregate(candidate.root.ref) === aggregate).toArray()
                : []);
        const ordered = writeRepositories.sort((left, right) => this.getDeclarationKey(left).localeCompare(this.getDeclarationKey(right)));
        if (ordered.length > 1 && ordered[0] !== repository) {
            accept('error', 'An aggregate may have only one write repository; use query repositories for read models.', {
                node: repository,
                property: 'root'
            });
        }
    }

    private getDeclarationKey(node: AstNode): string {
        const document = AstUtils.getDocument(node);
        return `${document.uri.toString()}#${this.services.workspace.AstNodeLocator.getAstNodePath(node)}`;
    }

    checkQueryRepository(repository: QueryRepository, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(repository, accept);
        if (repository.readModel?.ref && getOwningContextName(repository.readModel.ref) !== getOwningContextName(repository)) {
            accept('error', 'A query repository and its read model must belong to the same bounded context.', {
                node: repository,
                property: 'readModel'
            });
        }
    }

    private hasBehaviorSideEffects(method: Method, visited = new Set<Method>()): boolean {
        if (visited.has(method)) {
            return false;
        }
        visited.add(method);
        if (method.transitions.length > 0 || method.emissions.length > 0) {
            return true;
        }
        return method.invocations.some(invocation => {
            const target = this.getInvokedMethod(invocation);
            return target !== undefined && this.hasBehaviorSideEffects(target, visited);
        });
    }

    private getReachableMethods(method: Method, visited = new Set<Method>()): Method[] {
        if (visited.has(method)) {
            return [];
        }
        visited.add(method);
        const reachable: Method[] = [];
        for (const invocation of method.invocations) {
            const target = this.getInvokedMethod(invocation);
            if (!target) {
                continue;
            }
            reachable.push(target, ...this.getReachableMethods(target, visited));
        }
        return reachable;
    }

    private isAggregateRootMethod(method: Method, aggregate: Aggregate): boolean {
        const root = aggregate.members.find(member => isEntity(member) && member.root);
        return isEntity(root) && method.$container === root;
    }

    checkFactory(factory: Factory, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(factory, accept);
        for (const method of factory.methods) {
            const result = method.returnType?.ref;
            if (!isEntity(result) || !result.root || !this.getOwningAggregate(result) || this.isCrossContextOwned(factory, result)) {
                accept('error', 'A factory method must return an aggregate-root entity in its own bounded context.', {
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
        const resolvedContexts = contexts.map(context => 'target' in context ? context.target.ref : context.ref)
            .filter((context): context is BoundedContext => context !== undefined);

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
            exposure.declarations.some(declaration => declaration.target.ref === event)
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
                const sourceSharedKernel = this.getOwningSharedKernel(node);
                if (sourceContext && sourceSharedKernel !== sharedKernel &&
                    (!sharedKernel || !this.hasSharedKernelRelationship(node, sharedKernel))) {
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
            relationship.participants.some(participant => participant.target.ref?.name === contextName)
        ));
    }

    private hasVisibleSharedKernel(source: AstNode, sharedKernel: SharedKernel): boolean {
        const document = AstUtils.getDocument(source);
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return false;
        }
        if (model.declarations.includes(sharedKernel)) {
            return true;
        }
        const sharedKernelUri = AstUtils.getDocument(sharedKernel).uri;
        return model.imports.some(declaration =>
            UriUtils.equals(resolveImportUri(document, declaration), sharedKernelUri) &&
            (declaration.components.length === 0 || declaration.components.some(component => component.component.ref === sharedKernel))
        );
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
