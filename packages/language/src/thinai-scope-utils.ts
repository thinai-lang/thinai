import {
    AstUtils,
    type AstNode,
    type AstNodeDescription,
    type LangiumCoreServices,
    type LangiumDocument,
    type URI,
    UriUtils
} from 'langium';
import { THINAI_KEYWORDS } from './thinai-constants.js';
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
    isEnumValue,
    isParameter,
    type Aggregate,
    type Import,
    type Module,
    type SharedKernel,
    type ValueObject
} from './generated/ast.js';

const exportedTypes = new Set([
    'Aggregate', 'ApplicationService', 'BoundedContext', 'ContextMap', 'DomainEvent', 'DomainService',
    'DataObject', 'Entity', 'EnumType', 'EnumValue', 'Actor', 'Journey', 'Factory', 'Field',
    'IntegrationEvent', 'Method', 'Module', 'Projector', 'QueryRepository', 'QueryService',
    'ReadModel', 'Repository', 'SharedKernel', 'Subdomain', 'ValueObject'
]);

type NamedNode = AstNode & { name: string };

const plainIdentifier = /^[_a-zA-Z][\w_]*$/u;

/** Formats a declaration or reference name for insertion into Thinai source. */
export function formatIdentifier(name: string): string {
    if (plainIdentifier.test(name) && !THINAI_KEYWORDS.has(name)) {
        return name;
    }
    return `\`${name.replace(/`/gu, '')}\``;
}

/** Formats a dotted reference or declaration name for source insertion. */
export function formatQualifiedName(name: string): string {
    return name.split('.').map(formatIdentifier).join('.');
}

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
    return isBoundedContextPart(owner)
        ? owner.context?.ref?.name ?? ((owner.context?.$refText || undefined))
        : undefined;
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
    // A module itself belongs to its containing module, not to itself. This matters
    // for nested module exposure: `module Outer { exposes Inner }` must compare
    // Inner's owning module with Outer, not compare Inner with itself.
    let current: AstNode | undefined = isModule(node) ? node.$container : node;
    while (current) {
        if (isModule(current)) {
            return current;
        }
        current = current.$container;
    }
    return undefined;
}

export function isIdentifierValueObject(valueObject: ValueObject, visited = new Set<ValueObject>()): boolean {
    if (visited.has(valueObject)) {
        return false;
    }
    visited.add(valueObject);
    const aggregate = valueObject.$container;
    const isRootIdentifier = isAggregate(aggregate) && aggregate.members.some(member =>
        isEntity(member) && member.root && member.fields.some(field => field.identifier && field.type?.ref === valueObject)
    );
    return isRootIdentifier || (valueObject.mirrors?.ref !== undefined &&
        isIdentifierValueObject(valueObject.mirrors.ref, visited));
}

export function moduleDependsTransitivelyOn(module: Module, target: Module, visited = new Set<Module>()): boolean {
    if (module === target) {
        return true;
    }
    if (visited.has(module)) {
        return false;
    }
    visited.add(module);
    return module.dependencies.some(dependency => dependency.target.ref !== undefined &&
        moduleDependsTransitivelyOn(dependency.target.ref, target, visited));
}

export function isCrossContextOwned(source: AstNode, target: AstNode): boolean {
    const sourceContext = getOwningContextName(source);
    const targetContext = getOwningContextName(target);
    return sourceContext !== undefined && targetContext !== undefined && sourceContext !== targetContext;
}

export function isExposedByModule(module: Module, target: AstNode): boolean {
    const declaration = isField(target) || isParameter(target) || isEnumValue(target) ? target.$container : target;
    return module.exposures.some(exposure =>
        exposure.declarations.some(candidate => candidate.target.ref === declaration)
    );
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
