import {
    AstUtils,
    type AstNode,
    type ValidationAcceptor,
    URI,
    UriUtils
} from 'langium';
import {
    isCustomerSupplierRelationship,
    isModel,
    isPartnershipRelationship,
    isSeparateWaysRelationship,
    isSharedKernelRelationship,
    type BoundedContext,
    type BoundedContextPart,
    type ContextMap,
    type ContextMapEndpoint,
    type ContextRelationship,
    type Import,
    type ImportComponent,
    type Model,
    type SharedKernel
} from './generated/ast.js';
import { isSyntacticallyComplete } from './thinai-ast-utils.js';
import { areRelationshipPairDefinitionsCompatible, getRelationshipPairSemantics, type ContextRelationshipPairSemantics } from './thinai-context-map-utils.js';
import type { ThinaiServices } from './thinai-module.js';
import { findCstTokenOffset, isLineSeparatedSibling } from './thinai-layout.js';
import { resolveImportUri } from './thinai-scope-utils.js';
import { INTEGRATION_PATTERNS } from './thinai-constants.js';
import { ThinaiReferencePolicy } from './thinai-reference-policy.js';

type DuplicateDeclarationCallback = (
    node: BoundedContext | SharedKernel,
    accept: ValidationAcceptor
) => void;

/** Validates top-level model structure, imports, context maps, and shared kernels. */
export class ThinaiModelValidator {
    constructor(
        private readonly services: ThinaiServices,
        private readonly referencePolicy: ThinaiReferencePolicy,
        private readonly checkDuplicateDeclaration: DuplicateDeclarationCallback
    ) {}

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
            ? model.imports.some(importDeclaration => {
                const uri = resolveImportUri(currentDocument, importDeclaration);
                return uri !== undefined && UriUtils.equals(uri, targetDocument.uri);
            })
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
        if (typeof path !== 'string' || path.length === 0) {
            return;
        }
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
        if (!uri) {
            return;
        }
        if (UriUtils.equals(document.uri, uri)) {
            accept('error', 'A file cannot import itself.', {
                node: importDeclaration,
                property: 'path'
            });
        }

        const duplicate = isModel(document.parseResult.value)
            ? document.parseResult.value.imports.some(other => {
                const otherUri = resolveImportUri(document, other);
                return other !== importDeclaration && otherUri !== undefined && UriUtils.equals(otherUri, uri);
            })
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
                    accept('error', `Import component name '${declaration.name}' is declared more than once.`, {
                        node: declaration.node,
                        property: declaration.property === 'alias' ? 'alias' : 'component'
                    });
                } else {
                    names.set(declaration.name, declaration.node);
                }
            }
        }
        this.checkImportedContextMapConsistency(model, accept);
    }

    checkContextMapRelationships(contextMap: ContextMap, accept: ValidationAcceptor): void {
        const relationshipsByPair = new Map<string, ContextRelationshipPairSemantics[]>();
        const reported = new Set<ContextRelationship>();
        for (const relationship of contextMap.relationships) {
            if (!isSyntacticallyComplete(relationship)) {
                continue;
            }
            for (const pair of getRelationshipPairSemantics(relationship)) {
                const existing = relationshipsByPair.get(pair.key) ?? [];
                const duplicate = existing.some(previous => previous.identity === pair.identity);
                const conflict = existing.some(previous => !areRelationshipPairDefinitionsCompatible(previous, pair));
                if ((duplicate || conflict) && !reported.has(relationship)) {
                    const message = duplicate
                        ? `A relationship between ${pair.name} may only be declared once in context map '${contextMap.name}'.`
                        : `Conflicting relationships between ${pair.name} in context map '${contextMap.name}'.`;
                    accept('error', message, { node: relationship, property: 'relationships' });
                    reported.add(relationship);
                }
                relationshipsByPair.set(pair.key, [...existing, pair]);
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
        for (const [parent, children] of siblings) {
            children.sort((left, right) => left.$cstNode!.offset - right.$cstNode!.offset);
            const first = children[0];
            const parentCst = parent.$cstNode;
            const openingBrace = parentCst ? findCstTokenOffset(parentCst, '{') : undefined;
            if (first?.$cstNode && openingBrace !== undefined && openingBrace < first.$cstNode.offset &&
                textDocument.positionAt(openingBrace).line === first.$cstNode.range.start.line) {
                accept('error', 'Start the first statement on a new line after the opening brace.', {
                    node: first,
                    range: first.$cstNode.range,
                    code: 'line-break-required-after-open-brace'
                });
            }
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

    checkContextRelationship(relationship: ContextRelationship, accept: ValidationAcceptor): void {
        if (!isSyntacticallyComplete(relationship)) {
            return;
        }
        const endpoints = this.getContextMapEndpoints(relationship);
        const sharedKernelRelationship = isSharedKernelRelationship(relationship);
        const contexts = sharedKernelRelationship
            ? relationship.participants
            : isSeparateWaysRelationship(relationship)
                ? [relationship.left, relationship.right]
                : endpoints.map(endpoint => endpoint.context);
        const resolvedContexts = contexts
            .filter((context): context is NonNullable<typeof context> => context !== undefined)
            .map(context => 'target' in context ? context.target?.ref : context?.ref)
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

    private checkImportedContextMapConsistency(model: Model, accept: ValidationAcceptor): void {
        const relationshipsByPair = new Map<string, Array<{
            map: ContextMap;
            pair: ContextRelationshipPairSemantics;
        }>>();
        const reported = new Set<ContextRelationship>();

        for (const contextMap of this.referencePolicy.getImportedContextMaps(model)) {
            for (const relationship of contextMap.relationships) {
                if (!isSyntacticallyComplete(relationship)) {
                    continue;
                }
                for (const pair of getRelationshipPairSemantics(relationship)) {
                    const existing = relationshipsByPair.get(pair.key) ?? [];
                    for (const previous of existing) {
                        if (previous.map === contextMap || areRelationshipPairDefinitionsCompatible(previous.pair, pair)) {
                            continue;
                        }
                        if (!reported.has(relationship)) {
                            accept('error', `Imported context maps '${previous.map.name}' and '${contextMap.name}' define conflicting relationships between ${pair.name}.`, {
                                node: relationship,
                                property: 'relationships'
                            });
                            reported.add(relationship);
                        }
                        break;
                    }
                    relationshipsByPair.set(pair.key, [...existing, { map: contextMap, pair }]);
                }
            }
        }
    }

    private getContextMapEndpoints(relationship: ContextRelationship): ContextMapEndpoint[] {
        if (isCustomerSupplierRelationship(relationship)) {
            return [relationship.customer, relationship.supplier]
                .filter((endpoint): endpoint is ContextMapEndpoint => endpoint !== undefined);
        }
        if (isPartnershipRelationship(relationship)) {
            return [relationship.left, relationship.right]
                .filter((endpoint): endpoint is ContextMapEndpoint => endpoint !== undefined);
        }
        return [];
    }

    private reachesImportCycle(
        uri: URI,
        activePath: Set<string>,
        completed: Set<string> = new Set()
    ): boolean {
        const key = uri.toString();
        if (activePath.has(key)) {
            return true;
        }
        if (completed.has(key)) {
            return false;
        }
        const document = this.services.shared.workspace.LangiumDocuments.getDocument(uri);
        const model = document?.parseResult.value;
        if (!document || !isModel(model)) {
            completed.add(key);
            return false;
        }

        activePath.add(key);
        for (const importDeclaration of model.imports) {
            const importedUri = resolveImportUri(document, importDeclaration);
            if (importedUri && this.reachesImportCycle(importedUri, activePath, completed)) {
                return true;
            }
        }
        activePath.delete(key);
        completed.add(key);
        return false;
    }
}
