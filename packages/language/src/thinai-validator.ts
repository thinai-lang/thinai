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
    isIntegrationEvent,
    isImportableComponent,
    isContextMap,
    isCustomerSupplierRelationship,
    isEnumType,
    isModel,
    isModule,
    isPartnershipRelationship,
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
        DomainEvent: validator.checkDomainEvent,
        DomainService: validator.checkNamedDeclaration,
        Entity: validator.checkEntity,
        EnumType: validator.checkNamedDeclaration,
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
        const ancestors = new Set<Entity>([entity]);
        let base = entity.base?.ref;
        while (base) {
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
            const aggregate = entity.$container;
            if (!isAggregate(aggregate)) {
                accept('error', 'A root entity must be declared directly inside an aggregate.', {
                    node: entity,
                    keyword: 'root'
                });
            } else if (!entity.fields.some(field => field.identifier)) {
                accept('error', 'A root entity must declare an identifier field.', {
                    node: entity,
                    property: 'name'
                });
            }
        }
    }

    checkField(field: Field, accept: ValidationAcceptor): void {
        this.checkCrossContextTypeUse(field, this.collectTypeReferences(field.type, field.collection), accept);
        if (!field.identifier) {
            return;
        }
        const identifierType = field.type?.ref;
        if (!identifierType || !isValueObject(identifierType) || !identifierType.identifier) {
            accept('error', 'An identifier field must reference an identifier value object.', {
                node: field,
                property: 'type'
            });
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
        if (eventParameters.length > 0) {
            if (!applicationService) {
                accept('error', 'Event-typed method parameters are allowed only on application-service methods.', {
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
                accept('error', 'Consuming this integration event requires an imported context map with an authorized relationship to its producer.', {
                    node: eventParameters[0],
                    property: 'eventType'
                });
            }
        }
        if (method.returnType || method.returnCollection) {
            this.checkCrossContextTypeUse(method,
                this.collectTypeReferences(method.returnType, method.returnCollection), accept, 'returnType');
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
            if (applicationService && this.getOwningAggregate(target) && this.getOwningAggregate(target) !== applicationService.aggregate.ref) {
                accept('error', 'An application service may invoke domain behavior only on its associated aggregate.', {
                    node: method,
                    property: 'invocations'
                });
            }
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
            if (isAggregate(method.$container) || owningAggregate) {
                if (!isDomainEvent(emitted.ref)) {
                    accept('error', 'Aggregate behavior may emit only domain events.', {
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
                }
            } else if (applicationService && method.events.length > 0) {
                accept('error', 'Application-service command methods do not emit domain events directly; invoke aggregate behavior.', {
                    node: method,
                    property: 'events'
                });
            }
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

    checkTransition(transition: import('./generated/ast.js').Transition, accept: ValidationAcceptor): void {
        const aggregate = this.getOwningAggregate(transition);
        const root = aggregate?.members.find(member => isEntity(member) && member.root);
        const field = root && isEntity(root) ? root.fields.find(candidate => candidate.name === transition.field) : undefined;
        const stateType = field?.type?.ref;
        if (!field || !stateType || !isEnumType(stateType)) {
            accept('error', 'A transition must target an enum field on the aggregate root.', {
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
            if (!isApplicationService(method.$container) || method.parameters.some(parameter => parameter.eventType)) {
                accept('error', 'A flow may invoke only ordinary application-service command methods.', {
                    node: element,
                    property: 'method'
                });
            }
            if (this.isCrossContextOwned(flow, method)) {
                accept('error', 'A flow may invoke only application-service methods in its own bounded context.', {
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
        this.checkCrossContextTypeUse(parameter,
            this.collectTypeReferences(parameter.type, parameter.collection), accept, 'type');
    }

    checkValueObject(valueObject: ValueObject, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(valueObject, accept);
        if (valueObject.identifier && !valueObject.identifierOf && !valueObject.mirrors) {
            accept('error', 'An identifier value object must identify an entity or mirror another identifier.', {
                node: valueObject,
                property: 'name'
            });
        }
        if (valueObject.identifierOf?.ref) {
            const entity = valueObject.identifierOf.ref;
            if (!entity.root) {
                accept('error', 'An identifier value object must identify an aggregate root entity.', {
                    node: valueObject,
                    property: 'identifierOf'
                });
            }
            if (entity.$container !== valueObject.$container) {
                accept('error', 'An identifier value object must be declared in the same aggregate as its entity.', {
                    node: valueObject,
                    property: 'identifierOf'
                });
            }
        }
        if (valueObject.mirrors?.ref) {
            const source = valueObject.mirrors.ref;
            if (!source.identifier) {
                accept('error', 'A mirrored value object must target an identifier value object.', {
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
            if (!valueObject.identifier) {
                accept('error', 'A mirrored identifier must be declared as an identifier value object.', {
                    node: valueObject,
                    property: 'mirrors'
                });
            }
        }
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
            'Factory', 'Flow', 'IntegrationEvent', 'Repository', 'Subdomain'
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
            const sourceModule = getOwningModule(referenceInfo.container);
            const targetModule = getOwningModule(target);
            if (target.$type === 'Method' && this.isCrossContextOwned(referenceInfo.container, target) && !isInSharedKernel(target)) {
                accept('error', 'A behavior specification cannot reference a private method from another bounded context.', {
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
            const exposed = targetModule.exposures.some(exposure =>
                exposure.declarations.some(declaration => declaration.ref === target)
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
    }

    checkFactory(factory: Factory, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(factory, accept);
        if (factory.aggregate.ref && this.isCrossContextOwned(factory, factory.aggregate.ref)) {
            accept('error', 'A factory must belong to an aggregate in its own bounded context.', {
                node: factory,
                property: 'aggregate'
            });
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
    }

    checkIntegrationEvent(event: IntegrationEvent, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(event, accept);
    }

    checkNamedDeclaration(
        node: Aggregate | ApplicationService | BoundedContext | Capability | ContextMap | DomainEvent | DomainService | Entity | EnumType |
        Factory | Flow | IntegrationEvent | Module | Repository | SharedKernel | Subdomain | ValueObject,
        accept: ValidationAcceptor
    ): void {
        this.checkDuplicateDeclaration(node, accept);
    }

    private checkDuplicateDeclaration(
        node: Aggregate | ApplicationService | BoundedContext | Capability | ContextMap | DomainEvent | DomainService | Entity | EnumType |
        Factory | Flow | IntegrationEvent | Method | Module | Repository | SharedKernel | Subdomain | ValueObject,
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
