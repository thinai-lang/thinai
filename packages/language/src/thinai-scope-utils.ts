import {
    AstUtils,
    type AstNode,
    type AstNodeDescription,
    type LangiumCoreServices,
    type LangiumDocument,
    type URI,
    UriUtils
} from 'langium';
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
    type Module,
    type SharedKernel
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
    const owner = AstUtils.getContainerOfType(node, (candidate): candidate is AstNode =>
        isBoundedContext(candidate) || isBoundedContextPart(candidate) || isSharedKernel(candidate)
    );
    if (isBoundedContext(owner) || isSharedKernel(owner)) {
        return owner.name;
    }
    return isBoundedContextPart(owner) ? owner.context.ref?.name ?? owner.context.$refText : undefined;
}

export function getOwningAggregate(node: AstNode): Aggregate | undefined {
    return AstUtils.getContainerOfType(node, isAggregate);
}

export function getOwningSharedKernel(node: AstNode): SharedKernel | undefined {
    return AstUtils.getContainerOfType(node, isSharedKernel);
}

export function getExportedName(node: NamedNode): string {
    const contextName = getOwningContextName(node);
    const path = getDeclarationPath(node);
    return contextName ? [contextName, ...path].join('.') : path.join('.');
}

export function getOwningModule(node: AstNode): Module | undefined {
    return AstUtils.getContainerOfType(node, isModule);
}

export function isInSharedKernel(node: AstNode): boolean {
    return getOwningSharedKernel(node) !== undefined;
}

export function resolveAstNodeDescription(
    description: AstNodeDescription,
    services: Pick<LangiumCoreServices, 'shared' | 'workspace'>
): AstNode | undefined {
    if (description.node) {
        return description.node;
    }
    const document = services.shared.workspace.LangiumDocuments.getDocument(description.documentUri);
    return document?.parseResult.value
        ? services.workspace.AstNodeLocator.getAstNode(document.parseResult.value, description.path)
        : undefined;
}

export function toImportPath(currentDirectory: URI, target: URI): string {
    const relativePath = UriUtils.relative(currentDirectory, target);
    return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

export function resolveImportUri(document: LangiumDocument, importDeclaration: Import) {
    const path = importDeclaration.path;
    return typeof path === 'string' && path.length > 0
        ? UriUtils.resolvePath(UriUtils.dirname(document.uri), path)
        : undefined;
}
