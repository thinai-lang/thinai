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
    isMethod,
    isReadModel,
    isValueObject,
    isEnumValue,
    isParameter,
    type Aggregate,
    type Import,
    type Model,
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

export interface ComponentAlias {
    canonical: string;
    alias: string;
}

const strategicDeclarationTypes = new Set(['Actor', 'Journey', 'Subdomain']);

/** Collects explicit component aliases. Aliases are document-local scope names. */
export function getComponentAliases(model: Model): ComponentAlias[] {
    const aliases = new Map<string, ComponentAlias>();
    for (const declaration of model.imports) {
        for (const component of declaration.components) {
            const target = component.component.ref;
            const alias = component.alias;
            if (!target || !alias) {
                continue;
            }
            const canonical = getExportedName(target as AstNode & { name: string });
            if (canonical) {
                const key = `${canonical}\u0000${alias}`;
                aliases.set(key, { canonical, alias });
            }
        }
    }
    return [...aliases.values()];
}

/**
 * Returns alias spellings for an exported declaration name. This applies to
 * declarations declared in any visible file, not only the file that owns the
 * aliased import.
 *
 * Exact-name aliases are not applied to strategic declarations (actors,
 * journeys, subdomains). Those declarations have their own reference
 * namespaces and may legitimately share a bounded context's name.
 */
export function getComponentAliasNames(
    name: string,
    aliases: readonly ComponentAlias[],
    targetType?: string
): string[] {
    const names: string[] = [];
    for (const { canonical, alias } of aliases) {
        if (name === canonical) {
            if (targetType === undefined || !strategicDeclarationTypes.has(targetType)) {
                names.push(alias);
            }
        } else if (name.startsWith(`${canonical}.`)) {
            names.push(`${alias}.${name.slice(canonical.length + 1)}`);
        }
    }
    return names;
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

/**
 * True when a field or method belongs directly to the enclosing entity or
 * value object. Specification prose may use such members by their bare names;
 * members of other objects must be owner-qualified.
 */
export function isOwnedSpecificationMember(source: AstNode, target: AstNode): boolean {
    const owner = AstUtils.getContainerOfType(source,
        (node): node is AstNode => isEntity(node) || isValueObject(node));
    return owner !== undefined && target.$container === owner;
}

/**
 * Bare field and method references are only valid on the first path segment
 * and only when the member belongs to the enclosing entity or value object.
 * Later segments are interpreted relative to the preceding segment and may be
 * unqualified.
 */
export function isBareSpecificationMemberAllowed(
    source: AstNode,
    target: AstNode,
    isBare: boolean,
    isFirstSegment: boolean
): boolean {
    if (!isFirstSegment || !isBare || (!isField(target) && !isMethod(target))) {
        return true;
    }
    return isOwnedSpecificationMember(source, target);
}

export function isExposedByModule(module: Module, target: AstNode): boolean {
    const declaration = isField(target) || isParameter(target) || isEnumValue(target) ? target.$container : target;
    return module.exposures.some(exposure =>
        exposure.declarations.some(candidate => candidate.target.ref === declaration)
    );
}

/** True when the module is a namespace that can be named from its context boundary. */
export function isModuleAccessibleFromContext(module: Module): boolean {
    let current = module;
    while (true) {
        const parent = getOwningModule(current);
        if (!parent) {
            return true;
        }
        if (!isExposedByModule(parent, current)) {
            return false;
        }
        current = parent;
    }
}

/**
 * True when a declaration is part of the public API of its bounded context or
 * shared kernel: it is exposed by its immediate module and every enclosing
 * module is exposed by its parent. Context-level declarations are public.
 */
export function isPublicApiDeclaration(target: AstNode): boolean {
    if (isModule(target)) {
        return isModuleAccessibleFromContext(target);
    }
    const declaration = isField(target) || isParameter(target) || isEnumValue(target) ? target.$container : target;
    if (isModule(declaration)) {
        return isModuleAccessibleFromContext(declaration);
    }
    const module = getOwningModule(declaration);
    if (!module) {
        return true;
    }
    return isExposedByModule(module, declaration) && isModuleAccessibleFromContext(module);
}

/**
 * Resolves module visibility from a specific source. Sources inside a module
 * may use dependencies and their own public API; sources outside all modules
 * and cross-context sources may only use the public module chain.
 */
export function isModuleAccessibleFrom(source: AstNode, module: Module | undefined): boolean {
    if (!module) {
        return true;
    }
    const sourceModule = getOwningModule(source);
    if (!sourceModule) {
        return isModuleAccessibleFromContext(module);
    }
    if (sourceModule === module) {
        return true;
    }
    if (isModulePubliclyVisible(sourceModule, module)) {
        return true;
    }
    if (getOwningContextName(sourceModule) !== getOwningContextName(module)) {
        return isModuleAccessibleFromContext(module);
    }
    return false;
}

/**
 * Collects a module's public API. Exposing a nested module re-exports that
 * module's public API; dependencies are intentionally not followed here.
 */
export function getModulePublicApi(module: Module, visited = new Set<Module>()): AstNode[] {
    if (visited.has(module)) {
        return [];
    }
    visited.add(module);
    const api: AstNode[] = [];
    for (const exposure of module.exposures) {
        for (const declaration of exposure.declarations) {
            const target = declaration.target.ref;
            if (!target) {
                continue;
            }
            api.push(target);
            if (isModule(target)) {
                api.push(...getModulePublicApi(target, visited));
            }
        }
    }
    return api;
}

/**
 * True when the target module is reachable from the source module either as a
 * direct dependency or through the public API of a direct dependency (or the
 * source module's own explicit re-exports).
 */
export function isModulePubliclyVisible(source: Module, target: Module): boolean {
    if (source === target) {
        return true;
    }
    if (getModulePublicApi(source).includes(target)) {
        return true;
    }
    for (const dependency of source.dependencies) {
        const dependencyModule = dependency.target.ref;
        if (!dependencyModule) {
            continue;
        }
        if (dependencyModule === target || getModulePublicApi(dependencyModule).includes(target)) {
            return true;
        }
    }
    return false;
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
