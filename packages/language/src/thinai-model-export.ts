import { AstUtils, type AstNode, type LangiumDocument } from 'langium';
import type { Range } from 'vscode-languageserver-types';
import { isEnumValue, isField, isModel, isParameter } from './generated/ast.js';
import { isInSharedKernel, isPublicApiDeclaration, resolveImportUri } from './thinai-scope-utils.js';

export const THINAI_MODEL_SCHEMA_VERSION = 'thinai-model-v1';
export const THINAI_CONTEXT_SCHEMA_VERSION = 'thinai-context-v1';
export const THINAI_IMPACT_SCHEMA_VERSION = 'thinai-impact-v1';

export type ThinaiElementVisibility = 'context' | 'module-exposed' | 'module-private';

export interface ThinaiSource {
    uri: string;
    range: Range;
}

export interface ThinaiModelDocument {
    uri: string;
    root: boolean;
    imports: Array<{ path: string; uri?: string }>;
}

export interface ThinaiModelElement {
    id: string;
    kind: string;
    name: string;
    qualifiedName: string;
    parentId?: string;
    contextId?: string;
    moduleId?: string;
    modulePath: string[];
    visibility: ThinaiElementVisibility;
    publicApi: boolean;
    exposedBy: string[];
    source: ThinaiSource;
    properties: Record<string, unknown>;
}

export interface ThinaiModelEdge {
    fromId: string;
    toId: string;
    role: string;
    kind: 'reference' | 'qualifier';
    source: ThinaiSource;
}

export interface ThinaiModelDiagnostic {
    uri: string;
    severity: number;
    message: string;
    range: Range;
    code?: string | number;
}

export interface ThinaiModelExport {
    schemaVersion: typeof THINAI_MODEL_SCHEMA_VERSION;
    documents: ThinaiModelDocument[];
    elements: ThinaiModelElement[];
    edges: ThinaiModelEdge[];
    diagnostics: ThinaiModelDiagnostic[];
}

export interface ThinaiContextSlice {
    schemaVersion: typeof THINAI_CONTEXT_SCHEMA_VERSION;
    rootId: string;
    contextId?: string;
    elements: ThinaiModelElement[];
    edges: ThinaiModelEdge[];
}

export interface ThinaiImpact {
    schemaVersion: typeof THINAI_IMPACT_SCHEMA_VERSION;
    rootId: string;
    depth: number;
    changedIds: string[];
    incoming: ThinaiModelEdge[];
    affectedIds: string[];
    totalAffected: number;
    returned: number;
    truncated: boolean;
}

export interface ThinaiContextOptions {
    depth?: number;
}

export interface ThinaiImpactOptions {
    depth?: number;
    limit?: number;
}

const EXPORTABLE_TYPES = new Set([
    'BoundedContext', 'SharedKernel', 'ContextMap', 'Subdomain', 'Actor', 'Journey',
    'Module', 'Aggregate', 'Entity', 'ValueObject', 'EnumType', 'EnumValue',
    'DataObject', 'ReadModel', 'DomainEvent', 'IntegrationEvent',
    'Repository', 'QueryRepository', 'Factory', 'DomainService',
    'ApplicationService', 'QueryService', 'Projector',
    'Method', 'Constructor', 'Field', 'Parameter'
]);

const PATH_TYPES = new Set([
    'BoundedContext', 'SharedKernel', 'ContextMap', 'Subdomain', 'Actor', 'Journey',
    'Module', 'Aggregate', 'Entity', 'ValueObject', 'EnumType', 'EnumValue',
    'DataObject', 'ReadModel', 'DomainEvent', 'IntegrationEvent',
    'Repository', 'QueryRepository', 'Factory', 'DomainService',
    'ApplicationService', 'QueryService', 'Projector',
    'Method', 'Field', 'Parameter'
]);

interface InternalElement {
    node: AstNode;
    id: string;
    qualifiedName: string;
}

export function exportThinaiModel(
    documents: LangiumDocument[],
    options: { rootUri?: string } = {}
): ThinaiModelExport {
    const internal: InternalElement[] = [];
    const nodeToId = new WeakMap<AstNode, string>();
    const usedIds = new Map<string, AstNode>();

    for (const document of documents) {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            continue;
        }
        for (const node of AstUtils.streamAst(model)) {
            if (!EXPORTABLE_TYPES.has(node.$type) ||
                node.$type !== 'Constructor' && !hasName(node)) {
                continue;
            }
            const qualifiedName = getQualifiedName(node);
            const id = `${node.$type}:${qualifiedName}`;
            const existing = usedIds.get(id);
            if (existing !== undefined && existing !== node) {
                // Validation reports duplicate declarations. Keep the first
                // occurrence so exported references remain deterministic.
                continue;
            }
            usedIds.set(id, node);
            nodeToId.set(node, id);
            internal.push({ node, id, qualifiedName });
        }
    }

    const directExposures = collectDirectExposures(documents, nodeToId);
    const elements = internal.map(({ node, id, qualifiedName }) => {
        const parent = findElementAncestor(node, nodeToId);
        const context = findContextElement(node);
        const modulePath = findModulePath(node).map(module => nodeToId.get(module)).filter(isString);
        const exposedBy = getExposedBy(node, nodeToId, directExposures);
        const topLevelModule = node.$type === 'Module' && modulePath.length === 1;
        return {
            id,
            kind: node.$type,
            name: getNodeName(node) ?? (node.$type === 'Constructor' ? 'constructor' : node.$type),
            qualifiedName,
            parentId: parent ? nodeToId.get(parent) : undefined,
            contextId: context ? nodeToId.get(context) : undefined,
            moduleId: modulePath.at(-1),
            modulePath,
            visibility: modulePath.length === 0 || topLevelModule
                ? 'context' as const
                : exposedBy.length > 0
                    ? 'module-exposed' as const
                    : 'module-private' as const,
            publicApi: isPublicApiDeclaration(node),
            exposedBy,
            source: sourceOf(node),
            properties: buildProperties(node, nodeToId)
        } satisfies ThinaiModelElement;
    });

    const edges = collectEdges(documents, nodeToId);
    const modelDocuments = documents
        .map(document => ({
            uri: document.uri.toString(),
            root: options.rootUri !== undefined && document.uri.toString() === options.rootUri,
            imports: isModel(document.parseResult.value)
                ? document.parseResult.value.imports.map(importDeclaration => ({
                    path: typeof importDeclaration.path === 'string' ? importDeclaration.path : '',
                    uri: resolveImportUri(document, importDeclaration)?.toString()
                }))
                : []
        }))
        .sort((left, right) => Number(right.root) - Number(left.root) || left.uri.localeCompare(right.uri));

    const diagnostics = documents
        .flatMap(document => (document.diagnostics ?? []).map(diagnostic => ({
            uri: document.uri.toString(),
            severity: diagnostic.severity ?? 1,
            message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
            range: diagnostic.range,
            code: typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number'
                ? diagnostic.code
                : undefined
        })))
        .sort((left, right) =>
            left.uri.localeCompare(right.uri) ||
            left.range.start.line - right.range.start.line ||
            left.range.start.character - right.range.start.character ||
            left.message.localeCompare(right.message)
        );

    elements.sort((left, right) => left.id.localeCompare(right.id));
    edges.sort((left, right) =>
        left.fromId.localeCompare(right.fromId) ||
        left.toId.localeCompare(right.toId) ||
        left.role.localeCompare(right.role) ||
        left.source.uri.localeCompare(right.source.uri) ||
        left.source.range.start.line - right.source.range.start.line ||
        left.source.range.start.character - right.source.range.start.character
    );

    return {
        schemaVersion: THINAI_MODEL_SCHEMA_VERSION,
        documents: modelDocuments,
        elements,
        edges,
        diagnostics
    };
}

export function createContextSlice(
    model: ThinaiModelExport,
    rootId: string,
    options: ThinaiContextOptions = {}
): ThinaiContextSlice {
    const elementById = new Map(model.elements.map(element => [element.id, element]));
    const root = elementById.get(rootId);
    if (!root) {
        throw new Error(`Unknown model element '${rootId}'.`);
    }

    const included = new Set<string>();
    const add = (element: ThinaiModelElement | undefined): boolean => {
        if (!element || included.has(element.id)) {
            return false;
        }
        included.add(element.id);
        return true;
    };

    add(root);
    addAncestors(root, elementById, add);
    addDescendants(root, model.elements, add);

    if (root.kind === 'BoundedContext' || root.kind === 'SharedKernel') {
        for (const element of model.elements) {
            if (element.contextId === root.id) {
                add(element);
            }
        }
    }

    const depth = Math.max(0, options.depth ?? 1);
    let frontier = new Set(included);
    for (let level = 0; level < depth; level++) {
        const next = new Set<string>();
        for (const edge of model.edges) {
            if (!frontier.has(edge.fromId)) {
                continue;
            }
            if (!included.has(edge.fromId)) {
                continue;
            }
            const target = elementById.get(edge.toId);
            if (!target || !isVisibleFromSlice(root, target)) {
                continue;
            }
            if (add(target)) {
                next.add(target.id);
            }
        }
        frontier = next;
        if (frontier.size === 0) {
            break;
        }
    }

    const elements = model.elements.filter(element => included.has(element.id));
    const edges = model.edges.filter(edge => included.has(edge.fromId) && included.has(edge.toId));
    return {
        schemaVersion: THINAI_CONTEXT_SCHEMA_VERSION,
        rootId,
        contextId: root.contextId,
        elements,
        edges
    };
}

export function renderContextMarkdown(slice: ThinaiContextSlice): string {
    const root = slice.elements.find(element => element.id === slice.rootId);
    const lines = [
        `# ${root?.qualifiedName ?? slice.rootId}`,
        '',
        `- Element: \`${slice.rootId}\``,
        `- Kind: ${root?.kind ?? 'unknown'}`
    ];
    if (slice.contextId) {
        lines.push(`- Context: \`${slice.contextId}\``);
    }
    lines.push('', '## Elements', '');
    for (const element of slice.elements) {
        lines.push(`- \`${element.id}\` (${element.kind})`);
    }
    lines.push('', '## Relationships', '');
    if (slice.edges.length === 0) {
        lines.push('- None');
    } else {
        for (const edge of slice.edges) {
            lines.push(`- \`${edge.fromId}\` --${edge.role}--> \`${edge.toId}\``);
        }
    }
    return `${lines.join('\n')}\n`;
}

export function computeImpact(
    model: ThinaiModelExport,
    rootId: string,
    options: ThinaiImpactOptions = {}
): ThinaiImpact {
    const elementById = new Map(model.elements.map(element => [element.id, element]));
    const root = elementById.get(rootId);
    if (!root) {
        throw new Error(`Unknown model element '${rootId}'.`);
    }
    const changedIds = new Set<string>([rootId]);
    for (const element of model.elements) {
        let parentId = element.parentId;
        while (parentId) {
            if (parentId === rootId) {
                changedIds.add(element.id);
                break;
            }
            parentId = elementById.get(parentId)?.parentId;
        }
    }

    const depth = clampInteger(options.depth ?? 1, 1, 10);
    const limit = clampInteger(options.limit ?? 200, 1, 1000);

    const affected = new Set<string>();
    const incoming: ThinaiModelEdge[] = [];
    const seenEdges = new Set<ThinaiModelEdge>();
    let frontier = new Set(changedIds);
    for (let level = 0; level < depth && frontier.size > 0; level++) {
        const next = new Set<string>();
        for (const edge of model.edges) {
            if (!frontier.has(edge.toId)) {
                continue;
            }
            if (!seenEdges.has(edge)) {
                seenEdges.add(edge);
                incoming.push(edge);
            }
            if (!affected.has(edge.fromId)) {
                affected.add(edge.fromId);
                next.add(edge.fromId);
            }
        }
        frontier = next;
    }

    const allAffectedIds = [...affected].sort();
    const totalAffected = allAffectedIds.length;
    const affectedIds = allAffectedIds.slice(0, limit);
    const returnedSet = new Set(affectedIds);
    return {
        schemaVersion: THINAI_IMPACT_SCHEMA_VERSION,
        rootId,
        depth,
        changedIds: [...changedIds].sort(),
        incoming: incoming.filter(edge => returnedSet.has(edge.fromId)),
        affectedIds,
        totalAffected,
        returned: affectedIds.length,
        truncated: affectedIds.length < totalAffected
    };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) {
        return minimum;
    }
    return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function hasName(node: AstNode): boolean {
    return typeof (node as AstNode & { name?: unknown }).name === 'string';
}

function getNodeName(node: AstNode): string | undefined {
    const name = (node as AstNode & { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
}

function getQualifiedName(node: AstNode): string {
    const parts: string[] = [];
    let current: AstNode | undefined = node;
    while (current && !isModel(current)) {
        if (current.$type === 'BoundedContextPart') {
            const context = (current as AstNode & {
                context?: { ref?: { name?: string }; $refText?: string };
            }).context;
            const contextName = context?.ref?.name ?? context?.$refText;
            if (contextName) {
                parts.unshift(contextName);
            }
        } else if (current.$type === 'Constructor') {
            const owner = current.$container as AstNode & { constructors?: AstNode[] };
            const index = owner?.constructors?.indexOf(current) ?? 0;
            parts.unshift(`constructor#${index}`);
        } else if (PATH_TYPES.has(current.$type)) {
            const name = getNodeName(current);
            if (name) {
                parts.unshift(name);
            }
        }
        current = current.$container;
    }
    return parts.join('.');
}

function findElementAncestor(node: AstNode, nodeToId: WeakMap<AstNode, string>): AstNode | undefined {
    let current: AstNode | undefined = node.$container;
    while (current && !isModel(current)) {
        if (current.$type === 'BoundedContextPart') {
            const context = (current as AstNode & { context?: { ref?: AstNode } }).context?.ref;
            if (context && nodeToId.has(context)) {
                return context;
            }
        }
        if (nodeToId.has(current)) {
            return current;
        }
        current = current.$container;
    }
    return undefined;
}

function findContextElement(node: AstNode): AstNode | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        if (current.$type === 'BoundedContextPart') {
            return (current as AstNode & { context?: { ref?: AstNode } }).context?.ref;
        }
        if (current.$type === 'BoundedContext' || current.$type === 'SharedKernel') {
            return current;
        }
        current = current.$container;
    }
    return undefined;
}

function findModulePath(node: AstNode): AstNode[] {
    const modules: AstNode[] = [];
    let current: AstNode | undefined = node.$type === 'Module' ? node : node.$container;
    while (current && !isModel(current)) {
        if (current.$type === 'Module') {
            modules.unshift(current);
        }
        if (current.$type === 'BoundedContextPart' || current.$type === 'BoundedContext' || current.$type === 'SharedKernel') {
            break;
        }
        current = current.$container;
    }
    return modules;
}

function collectDirectExposures(
    documents: LangiumDocument[],
    nodeToId: WeakMap<AstNode, string>
): Map<string, Set<string>> {
    const exposures = new Map<string, Set<string>>();
    for (const document of documents) {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            continue;
        }
        for (const node of AstUtils.streamAst(model)) {
            if (node.$type !== 'Module') {
                continue;
            }
            const moduleId = nodeToId.get(node);
            if (!moduleId) {
                continue;
            }
            const module = node as AstNode & {
                exposures?: Array<{ declarations?: Array<{ target?: { ref?: AstNode } }> }>;
            };
            for (const exposure of module.exposures ?? []) {
                for (const declaration of exposure.declarations ?? []) {
                    const targetId = declaration.target?.ref ? nodeToId.get(declaration.target.ref) : undefined;
                    if (!targetId) {
                        continue;
                    }
                    let entry = exposures.get(targetId);
                    if (!entry) {
                        entry = new Set();
                        exposures.set(targetId, entry);
                    }
                    entry.add(moduleId);
                }
            }
        }
    }
    return exposures;
}

function getExposedBy(
    node: AstNode,
    nodeToId: WeakMap<AstNode, string>,
    directExposures: Map<string, Set<string>>
): string[] {
    // Fields, parameters, and enum values inherit direct exposure from their
    // immediate declaring container. Named declarations must be exposed
    // directly; exposing an aggregate or service does not publish every member.
    const declaration = isField(node) || isParameter(node) || isEnumValue(node)
        ? node.$container
        : node;
    const declarationId = nodeToId.get(declaration);
    return declarationId
        ? [...(directExposures.get(declarationId) ?? [])].sort()
        : [];
}

function buildProperties(node: AstNode, nodeToId: WeakMap<AstNode, string>): Record<string, unknown> {
    const value = node as AstNode & Record<string, any>;
    const ids = (references: unknown[] | undefined) => refIds(references, nodeToId);
    switch (node.$type) {
        case 'BoundedContext':
            return { realizes: ids(value.subdomains?.map((reference: any) => reference.target)) };
        case 'Subdomain':
            return { kind: value.kind };
        case 'ContextMap':
            return { relationships: (value.relationships ?? []).map((relationship: any) => describeRelationship(relationship, nodeToId)) };
        case 'Module':
            return {
                dependsOn: ids(value.dependencies?.map((dependency: any) => dependency.target)),
                exposes: ids(value.exposures?.flatMap((exposure: any) => exposure.declarations?.map((declaration: any) => declaration.target) ?? [])),
                sharedKernel: isInSharedKernel(node),
                parentModuleId: parentModuleId(node, nodeToId)
            };
        case 'Aggregate':
            return {
                rootEntityId: value.members?.find((member: any) => member.$type === 'Entity' && member.root)
                    ? nodeToId.get(value.members.find((member: any) => member.$type === 'Entity' && member.root))
                    : undefined,
                members: ids(value.members?.map((member: any) => ({ ref: member }))),
                invariants: clauseTexts(value.invariants)
            };
        case 'Entity':
            return {
                root: value.root,
                identifierFieldId: value.fields?.find((field: any) => field.identifier)
                    ? nodeToId.get(value.fields.find((field: any) => field.identifier))
                    : undefined,
                fields: ids(value.fields?.map((field: any) => ({ ref: field }))),
                methods: ids(value.methods?.map((method: any) => ({ ref: method }))),
                constructors: ids(value.constructors?.map((constructor: any) => ({ ref: constructor })))
            };
        case 'ValueObject':
            return {
                mirrorsId: value.mirrors?.ref ? nodeToId.get(value.mirrors.ref) : undefined,
                fields: ids(value.fields?.map((field: any) => ({ ref: field }))),
                methods: ids(value.methods?.map((method: any) => ({ ref: method }))),
                constructors: ids(value.constructors?.map((constructor: any) => ({ ref: constructor })))
            };
        case 'EnumType':
            return { values: ids(value.values?.map((enumValue: any) => ({ ref: enumValue }))) };
        case 'DataObject':
        case 'ReadModel':
        case 'DomainEvent':
        case 'IntegrationEvent':
            return { fields: ids(value.fields?.map((field: any) => ({ ref: field }))) };
        case 'ApplicationService':
        case 'QueryService':
        case 'Projector':
        case 'DomainService':
        case 'Factory':
            return { methods: ids(value.methods?.map((method: any) => ({ ref: method }))) };
        case 'Repository':
            return { managesId: value.root?.ref ? nodeToId.get(value.root.ref) : undefined };
        case 'QueryRepository':
            return {
                servesId: value.readModel?.ref ? nodeToId.get(value.readModel.ref) : undefined,
                readsFrom: ids(value.sources?.map((source: any) => source.target))
            };
        case 'Method':
            return {
                parameters: ids(value.parameters?.map((parameter: any) => ({ ref: parameter }))),
                returnType: describeTypeFrom(value, nodeToId),
                clauses: clauses(value),
                invokes: (value.invocations ?? []).map((invocation: any) => ({
                    targetId: invocation.target?.ref ? nodeToId.get(invocation.target.ref) : undefined,
                    when: specificationText(invocation.guard)
                })),
                emits: (value.emissions ?? []).map((emission: any) => ({
                    eventIds: ids(emission.events?.map((event: any) => event.target)),
                    when: specificationText(emission.guard)
                })),
                transitions: (value.transitions ?? []).map((transition: any) => ({
                    when: specificationText(transition.guard),
                    changes: (transition.changes ?? []).map((change: any) => ({
                        fieldId: change.field?.ref ? nodeToId.get(change.field.ref) : undefined,
                        fromId: change.from?.ref ? nodeToId.get(change.from.ref) : undefined,
                        toId: change.to?.ref ? nodeToId.get(change.to.ref) : undefined
                    }))
                })),
                readsFrom: (value.reads ?? []).map((read: any) => ({
                    sourceIds: ids(read.sources?.map((source: any) => source.target)),
                    when: specificationText(read.guard)
                })),
                projects: ids(value.projects?.map((project: any) => project.target))
            };
        case 'Constructor':
            return {
                parameters: ids(value.parameters?.map((parameter: any) => ({ ref: parameter }))),
                clauses: clauses(value)
            };
        case 'Field':
            return {
                type: describeTypeFrom(value, nodeToId),
                optional: value.optional,
                identifier: value.identifier,
                initialStateId: value.initialState?.ref ? nodeToId.get(value.initialState.ref) : undefined
            };
        case 'Parameter':
            return {
                type: describeTypeFrom(value, nodeToId),
                optional: value.optional
            };
        case 'Actor':
            return {};
        case 'Journey':
            return {
                actors: (value.actors ?? []).map((actor: any) => ({
                    actorId: actor.actor?.ref ? nodeToId.get(actor.actor.ref) : undefined,
                    steps: (actor.steps ?? []).map((step: any) => ({
                        targetId: step.target?.ref ? nodeToId.get(step.target.ref) : undefined,
                        with: specificationText(step.arguments),
                        when: specificationText(step.guard)
                    }))
                }))
            };
        case 'EnumValue':
            return {};
        default:
            return {};
    }
}

function parentModuleId(node: AstNode, nodeToId: WeakMap<AstNode, string>): string | undefined {
    let current = node.$container;
    while (current && !isModel(current)) {
        if (current.$type === 'Module') {
            return nodeToId.get(current);
        }
        if (current.$type === 'BoundedContextPart' || current.$type === 'BoundedContext' || current.$type === 'SharedKernel') {
            return undefined;
        }
        current = current.$container;
    }
    return undefined;
}

function describeRelationship(relationship: any, nodeToId: WeakMap<AstNode, string>): Record<string, unknown> {
    const endpoint = (value: any) => ({
        contextId: value?.context?.ref ? nodeToId.get(value.context.ref) : undefined,
        integrationPatterns: value?.integrationPatterns ?? []
    });
    switch (relationship.$type) {
        case 'CustomerSupplierRelationship':
            return {
                kind: 'customerSupplier',
                customer: endpoint(relationship.customer),
                supplier: endpoint(relationship.supplier)
            };
        case 'PartnershipRelationship':
            return {
                kind: 'partnership',
                left: endpoint(relationship.left),
                right: endpoint(relationship.right)
            };
        case 'SeparateWaysRelationship':
            return {
                kind: 'separateWays',
                leftId: relationship.left?.ref ? nodeToId.get(relationship.left.ref) : undefined,
                rightId: relationship.right?.ref ? nodeToId.get(relationship.right.ref) : undefined
            };
        case 'SharedKernelRelationship':
            return {
                kind: 'sharedKernel',
                sharedKernelId: relationship.sharedKernel?.ref ? nodeToId.get(relationship.sharedKernel.ref) : undefined,
                participantIds: refIds(relationship.participants?.map((participant: any) => participant.target), nodeToId)
            };
        default:
            return {};
    }
}

function describeTypeFrom(node: AstNode & Record<string, any>, nodeToId: WeakMap<AstNode, string>): Record<string, unknown> | undefined {
    if (node.primitive !== undefined) {
        return { kind: 'primitive', name: node.primitive };
    }
    if (node.type !== undefined) {
        return describeReference(node.type, nodeToId);
    }
    if (node.collection !== undefined) {
        return describeCollection(node.collection, nodeToId);
    }
    if (node.returnPrimitive !== undefined) {
        return { kind: 'primitive', name: node.returnPrimitive };
    }
    if (node.returnType !== undefined) {
        return describeReference(node.returnType, nodeToId);
    }
    if (node.returnCollection !== undefined) {
        return describeCollection(node.returnCollection, nodeToId);
    }
    return undefined;
}

function describeReference(reference: any, nodeToId: WeakMap<AstNode, string>): Record<string, unknown> {
    return {
        kind: 'reference',
        name: reference?.$refText,
        targetId: reference?.ref ? nodeToId.get(reference.ref) : undefined
    };
}

function describeCollection(collection: any, nodeToId: WeakMap<AstNode, string>): Record<string, unknown> {
    return {
        kind: 'collection',
        collection: collection?.kind,
        element: describeCollectionPart(collection, 'element', nodeToId),
        value: collection?.valuePrimitive !== undefined || collection?.valueType !== undefined || collection?.valueCollection !== undefined
            ? describeCollectionPart(collection, 'value', nodeToId)
            : undefined
    };
}

function describeCollectionPart(collection: any, prefix: 'element' | 'value', nodeToId: WeakMap<AstNode, string>): Record<string, unknown> | undefined {
    const primitive = collection?.[`${prefix}Primitive`];
    if (primitive !== undefined) {
        return { kind: 'primitive', name: primitive };
    }
    const type = collection?.[`${prefix}Type`];
    if (type !== undefined) {
        return describeReference(type, nodeToId);
    }
    const nested = collection?.[`${prefix}Collection`];
    if (nested !== undefined) {
        return describeCollection(nested, nodeToId);
    }
    return undefined;
}

function refIds(references: unknown[] | undefined, nodeToId: WeakMap<AstNode, string>): string[] {
    return (references ?? [])
        .map(reference => {
            const target = (reference as { ref?: AstNode } | undefined)?.ref;
            return target ? nodeToId.get(target) : undefined;
        })
        .filter(isString);
}

function sourceOf(node: AstNode): ThinaiSource {
    const document = AstUtils.getDocument(node);
    const range = node.$cstNode?.range ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
    };
    return { uri: document.uri.toString(), range };
}

function clauseTexts(clauses: unknown[] | undefined): string[] {
    return (clauses ?? [])
        .map(clause => specificationText((clause as { description?: unknown }).description))
        .filter(isString);
}

function clauses(node: AstNode & Record<string, any>): Record<string, string[]> {
    return {
        invariants: clauseTexts(node.invariants),
        preconditions: clauseTexts(node.preconditions),
        postconditions: clauseTexts(node.postconditions),
        behaviors: clauseTexts(node.behaviors)
    };
}

function specificationText(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const text = (value as { $cstNode?: { text?: string } }).$cstNode?.text;
    return typeof text === 'string' ? text : undefined;
}

function describeEdgeRole(referenceInfo: { container: AstNode; property: string }): {
    role: string;
    kind: 'reference' | 'qualifier';
} {
    const { container, property } = referenceInfo;
    // Qualified-name segments are navigation qualifiers, not semantic
    // dependencies. Keep them separate so agents can choose whether to traverse
    // namespaces and modules.
    if (property.endsWith('Path') || property === 'path') {
        return { role: 'qualifier', kind: 'qualifier' };
    }

    switch (container.$type) {
        case 'SpecificationTextPart':
            return { role: 'references', kind: 'reference' };
        case 'EventEmission':
        case 'EventReference':
            return { role: 'emits', kind: 'reference' };
        case 'MethodInvocation':
            return { role: 'invokes', kind: 'reference' };
        case 'ReadDependency':
        case 'ReadSourceReference':
        case 'AggregateReference':
            return { role: 'readsFrom', kind: 'reference' };
        case 'ReadModelReference':
            return { role: 'projects', kind: 'reference' };
        case 'Exposure':
        case 'NamedDeclarationReference':
            return { role: 'exposes', kind: 'reference' };
        case 'ModuleReference':
            return { role: 'dependsOn', kind: 'reference' };
        case 'SubdomainReference':
            return { role: 'realizes', kind: 'reference' };
        case 'JourneyStep':
            return { role: 'invokes', kind: 'reference' };
        case 'JourneyActor':
            return { role: 'actor', kind: 'reference' };
        case 'ContextMapEndpoint':
        case 'SeparateWaysRelationship':
            return { role: 'endpoint', kind: 'reference' };
        case 'BoundedContextReference':
            return { role: 'participant', kind: 'reference' };
        case 'SharedKernelRelationship':
            return { role: property === 'sharedKernel' ? 'sharedKernel' : 'participant', kind: 'reference' };
        case 'Repository':
            return { role: 'manages', kind: 'reference' };
        case 'QueryRepository':
            return { role: property === 'readModel' ? 'serves' : 'readsFrom', kind: 'reference' };
        case 'TransitionChange':
            return {
                role: property === 'field'
                    ? 'transitionField'
                    : property === 'from' ? 'transitionFrom' : 'transitionTo',
                kind: 'reference'
            };
        case 'Field':
            return { role: property === 'initialState' ? 'initialState' : 'type', kind: 'reference' };
        case 'Parameter':
            return { role: 'type', kind: 'reference' };
        case 'Method':
            return { role: 'returnType', kind: 'reference' };
        case 'ValueObject':
            return { role: 'mirrors', kind: 'reference' };
        default:
            return { role: property, kind: 'reference' };
    }
}

function collectEdges(documents: LangiumDocument[], nodeToId: WeakMap<AstNode, string>): ThinaiModelEdge[] {
    const edges: ThinaiModelEdge[] = [];
    const seen = new Set<string>();
    for (const document of documents) {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            continue;
        }
        for (const node of AstUtils.streamAst(model)) {
            const from = nodeToId.has(node) ? node : findElementAncestor(node, nodeToId);
            if (!from) {
                continue;
            }
            const fromId = nodeToId.get(from);
            if (!fromId) {
                continue;
            }
            for (const referenceInfo of AstUtils.streamReferences(node)) {
                const reference = referenceInfo.reference as {
                    ref?: AstNode;
                    $refNode?: { range: Range };
                };
                const target = reference.ref;
                const toId = target ? nodeToId.get(target) : undefined;
                if (!toId || toId === fromId) {
                    continue;
                }
                const range = reference.$refNode?.range ?? node.$cstNode?.range ?? sourceOf(node).range;
                const { role, kind } = describeEdgeRole(referenceInfo);
                const key = `${fromId}\u0000${toId}\u0000${role}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                edges.push({
                    fromId,
                    toId,
                    role,
                    kind,
                    source: { uri: document.uri.toString(), range }
                });
            }
        }
    }
    return edges;
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function addAncestors(
    root: ThinaiModelElement,
    elementById: Map<string, ThinaiModelElement>,
    add: (element: ThinaiModelElement | undefined) => boolean
): void {
    let parentId = root.parentId;
    while (parentId) {
        const parent = elementById.get(parentId);
        add(parent);
        parentId = parent?.parentId;
    }
}

function addDescendants(
    root: ThinaiModelElement,
    elements: ThinaiModelElement[],
    add: (element: ThinaiModelElement | undefined) => boolean
): void {
    const children = new Map<string, ThinaiModelElement[]>();
    for (const element of elements) {
        if (element.parentId) {
            const list = children.get(element.parentId) ?? [];
            list.push(element);
            children.set(element.parentId, list);
        }
    }
    const visit = (id: string) => {
        for (const child of children.get(id) ?? []) {
            if (add(child)) {
                visit(child.id);
            }
        }
    };
    visit(root.id);
}

function isVisibleFromSlice(root: ThinaiModelElement, target: ThinaiModelElement): boolean {
    if (!root.contextId || root.contextId === target.contextId) {
        return true;
    }
    return target.publicApi;
}
