import {
    AstUtils,
    type ValidationAcceptor,
    type ValidationChecks,
    URI,
    UriUtils
} from 'langium';
import type {
    Actor,
    Aggregate,
    BoundedContext,
    BoundedContextPart,
    Capability,
    Command,
    ContextRelationship,
    DomainEvent,
    DomainService,
    Entity,
    EnumType,
    EventStorming,
    ExternalSystem,
    Factory,
    Import,
    Hotspot,
    IntegrationEvent,
    Policy,
    ReadModel,
    Repository,
    Subdomain,
    ThinaiAstType,
    ValueObject
} from './generated/ast.js';
import { isDomainEvent, isModel } from './generated/ast.js';
import type { ThinaiServices } from './thinai-module.js';
import { getExportedName, getOwningContextName, resolveImportUri } from './thinai-scope.js';

export function registerValidationChecks(services: ThinaiServices): void {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.ThinaiValidator;
    const checks: ValidationChecks<ThinaiAstType> = {
        Actor: validator.checkNamedDeclaration,
        Aggregate: validator.checkAggregate,
        BoundedContext: validator.checkBoundedContext,
        BoundedContextPart: validator.checkBoundedContextPart,
        Capability: validator.checkNamedDeclaration,
        Command: validator.checkCommand,
        ContextRelationship: validator.checkContextRelationship,
        DomainEvent: validator.checkDomainEvent,
        DomainService: validator.checkNamedDeclaration,
        Entity: validator.checkNamedDeclaration,
        EnumType: validator.checkNamedDeclaration,
        EventStorming: validator.checkEventStorming,
        ExternalSystem: validator.checkNamedDeclaration,
        Factory: validator.checkNamedDeclaration,
        Hotspot: validator.checkNamedDeclaration,
        Import: validator.checkImport,
        IntegrationEvent: validator.checkIntegrationEvent,
        Policy: validator.checkPolicy,
        ReadModel: validator.checkReadModel,
        Repository: validator.checkNamedDeclaration,
        Subdomain: validator.checkNamedDeclaration,
        ValueObject: validator.checkNamedDeclaration
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

        if (this.reachesImportCycle(uri, new Set([document.uri.toString()]))) {
            accept('error', 'Import cycle detected.', {
                node: importDeclaration,
                property: 'path'
            });
        }
    }

    checkAggregate(aggregate: Aggregate, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(aggregate, accept);
        if (aggregate.root?.ref && aggregate.root.ref.$container !== aggregate) {
            accept('error', 'An aggregate root must be an entity declared inside the aggregate.', {
                node: aggregate,
                property: 'root'
            });
        }
    }

    checkCommand(command: Command, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(command, accept);
        if (!command.aggregate) {
            accept('error', 'A command must target an aggregate.', {
                node: command,
                property: 'name'
            });
        }
        if (command.events.length === 0) {
            accept('warning', 'A command should emit at least one domain or integration event.', {
                node: command,
                property: 'name'
            });
        }
    }

    checkContextRelationship(relationship: ContextRelationship, accept: ValidationAcceptor): void {
        if (relationship.source.ref && relationship.target.ref && relationship.source.ref === relationship.target.ref) {
            accept('error', 'A context relationship must connect two different bounded contexts.', {
                node: relationship,
                property: 'target'
            });
        }
    }

    checkDomainEvent(event: DomainEvent, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(event, accept);
        const commandAggregate = event.command?.ref?.aggregate?.ref;
        if (commandAggregate && event.aggregate?.ref && commandAggregate !== event.aggregate.ref) {
            accept('error', 'The event aggregate must match the command aggregate that caused it.', {
                node: event,
                property: 'aggregate'
            });
        }
        if (event.publishedAs?.ref && getOwningContextName(event.publishedAs.ref) !== getOwningContextName(event)) {
            accept('error', 'An integration event must be published by a domain event in the same bounded context.', {
                node: event,
                property: 'publishedAs'
            });
        }
    }

    checkPolicy(policy: Policy, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(policy, accept);
        for (const trigger of policy.triggers) {
            if (trigger.ref && isDomainEvent(trigger.ref) && this.isCrossContextReference(policy, trigger.ref) && !trigger.ref.publishesIntegration) {
                accept('error', 'A bounded context may consume only an integration event from another bounded context.', {
                    node: policy,
                    property: 'triggers'
                });
            }
        }
    }

    checkIntegrationEvent(event: IntegrationEvent, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(event, accept);
        if (event.source?.ref && getOwningContextName(event.source.ref) !== getOwningContextName(event)) {
            accept('error', 'An integration event must be derived from a domain event in the same bounded context.', {
                node: event,
                property: 'source'
            });
        }
    }

    checkReadModel(readModel: ReadModel, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(readModel, accept);
        for (const event of readModel.events) {
            if (event.ref && isDomainEvent(event.ref) && this.isCrossContextReference(readModel, event.ref) && !event.ref.publishesIntegration) {
                accept('error', 'A bounded context may consume only an integration event from another bounded context.', {
                    node: readModel,
                    property: 'events'
                });
            }
        }
    }

    checkEventStorming(board: EventStorming, accept: ValidationAcceptor): void {
        this.checkDuplicateDeclaration(board, accept);
        for (const element of board.elements) {
            const event = element.event?.ref;
            if (event && isDomainEvent(event) && this.isCrossContextReference(board, event) && !event.publishesIntegration) {
                accept('error', 'An EventStorming board may reference only an integration event from another bounded context.', {
                    node: board,
                    property: 'elements'
                });
            }
        }
    }

    checkNamedDeclaration(
        node: Actor | Aggregate | BoundedContext | Capability | Command | DomainEvent | DomainService | Entity | EnumType |
        ExternalSystem | Factory | EventStorming | Hotspot | IntegrationEvent | Policy | ReadModel | Repository | Subdomain | ValueObject,
        accept: ValidationAcceptor
    ): void {
        this.checkDuplicateDeclaration(node, accept);
    }

    private checkDuplicateDeclaration(
        node: Actor | Aggregate | BoundedContext | Capability | Command | DomainEvent | DomainService | Entity | EnumType |
        ExternalSystem | Factory | EventStorming | Hotspot | IntegrationEvent | Policy | ReadModel | Repository | Subdomain | ValueObject,
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

    private isCrossContextReference(source: EventStorming | Policy | ReadModel, target: DomainEvent): boolean {
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
