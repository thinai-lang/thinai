import { AstUtils, type AstNode, type LangiumDocument, UriUtils } from 'langium';
import {
    isBoundedContext,
    isBoundedContextPart,
    isAggregate,
    isModule,
    isSharedKernel,
    isDataObject,
    isDomainEvent,
    isEntity,
    isField,
    isIntegrationEvent,
    isReadModel,
    isValueObject,
    type Aggregate,
    type Import,
    type Module
} from './generated/ast.js';

const exportedTypes = new Set([
    'Aggregate', 'ApplicationService', 'BoundedContext', 'ContextMap', 'DomainEvent', 'DomainService',
    'DataObject', 'Entity', 'EnumType', 'EnumValue', 'Actor', 'Journey', 'Factory', 'Field',
    'IntegrationEvent', 'Method', 'Module', 'Projector', 'QueryRepository', 'QueryService',
    'ReadModel', 'Repository', 'SharedKernel', 'Subdomain', 'ValueObject'
]);

type NamedNode = AstNode & { name: string };

export function isNamedExport(node: AstNode): node is NamedNode {
    if (isField(node) && !isEntity(node.$container) && !isValueObject(node.$container) &&
        !isDomainEvent(node.$container) && !isIntegrationEvent(node.$container) && !isReadModel(node.$container) &&
        !isDataObject(node.$container)) {
        return false;
    }
    return exportedTypes.has(node.$type) && typeof (node as Partial<NamedNode>).name === 'string';
}

export function getDeclarationPath(node: NamedNode): string[] {
    const path: string[] = [];
    let current: AstNode | undefined = node;
    while (current && !isBoundedContext(current) && !isBoundedContextPart(current) && !isSharedKernel(current)) {
        if (isNamedExport(current)) {
            path.unshift(current.name);
        }
        current = current.$container;
    }
    return path;
}

/** Shared containment and URI helpers used by scoping, validation, and tooling. */
export function getOwningContextName(node: AstNode): string | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        if (isBoundedContext(current)) {
            return current.name;
        }
        if (isBoundedContextPart(current)) {
            return current.context.ref?.name ?? current.context.$refText;
        }
        if (isSharedKernel(current)) {
            return current.name;
        }
        current = current.$container;
    }
    return undefined;
}

export function getOwningAggregate(node: AstNode): Aggregate | undefined {
    return AstUtils.getContainerOfType(node, isAggregate);
}

export function getExportedName(node: NamedNode): string {
    const contextName = getOwningContextName(node);
    const path = getDeclarationPath(node);
    return contextName ? [contextName, ...path].join('.') : path.join('.');
}

export function getOwningModule(node: AstNode): Module | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        if (isModule(current)) {
            return current;
        }
        current = current.$container;
    }
    return undefined;
}

export function isInSharedKernel(node: AstNode): boolean {
    let current: AstNode | undefined = node;
    while (current) {
        if (isSharedKernel(current)) {
            return true;
        }
        current = current.$container;
    }
    return false;
}

export function resolveImportUri(document: LangiumDocument, importDeclaration: Import) {
    const path = importDeclaration.path;
    return typeof path === 'string' && path.length > 0
        ? UriUtils.resolvePath(UriUtils.dirname(document.uri), path)
        : undefined;
}
