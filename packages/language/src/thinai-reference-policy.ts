import {
    AstUtils,
    type AstNode,
    type LangiumCoreServices,
    type LangiumDocument,
    type URI,
    UriUtils
} from 'langium';
import {
    isContextMap,
    isDataObject,
    isModel,
    isQueryService,
    isSharedKernelRelationship,
    isValueObject,
    type ContextMap,
    type ContextRelationship,
    type IntegrationEvent,
    type Method,
    type Model,
    type QueryService,
    type SharedKernel,
    type TypeDeclaration
} from './generated/ast.js';
import { isSyntacticallyComplete } from './thinai-ast-utils.js';
import { areRelationshipPairDefinitionsCompatible, getRelationshipPairSemantics } from './thinai-context-map-utils.js';
import { getOwningContextName, getOwningModule, isExposedByModule, resolveImportUri } from './thinai-scope-utils.js';
import { getTypeReferences } from './thinai-type-utils.js';

/** Shared visibility and cross-context authorization rules for linking, completion, and validation. */
export class ThinaiReferencePolicy {
    constructor(private readonly services: LangiumCoreServices) {}

    isIntegrationEventExposed(event: IntegrationEvent): boolean {
        const module = getOwningModule(event);
        return module === undefined || isExposedByModule(module, event);
    }

    isQueryServiceExposed(service: QueryService): boolean {
        const module = getOwningModule(service);
        return module !== undefined && isExposedByModule(module, service);
    }

    isExposedQueryResult(method: Method): boolean {
        const resultTypes = getTypeReferences(method.returnType, method.returnCollection)
            .map(reference => reference.ref)
            .filter((type): type is TypeDeclaration => type !== undefined);
        return resultTypes.length === 0 || resultTypes.every(type => {
            if (!isDataObject(type)) {
                return false;
            }
            const module = getOwningModule(type);
            return module !== undefined && module === getOwningModule(method) && isExposedByModule(module, type);
        });
    }

    hasVisibleSharedKernel(source: AstNode, sharedKernel: SharedKernel): boolean {
        const model = AstUtils.getDocument(source).parseResult.value;
        if (!isModel(model)) {
            return false;
        }
        if (model.declarations.includes(sharedKernel)) {
            return true;
        }
        const sharedKernelUri = AstUtils.getDocument(sharedKernel).uri;
        return model.imports.some(declaration => {
            const uri = resolveImportUri(AstUtils.getDocument(source), declaration);
            return uri !== undefined && UriUtils.equals(uri, sharedKernelUri) &&
                (declaration.components.length === 0 || declaration.components.some(component =>
                    component.component.ref === sharedKernel
                ));
        });
    }

    hasSharedKernelRelationship(source: AstNode, sharedKernel: SharedKernel): boolean {
        const contextName = getOwningContextName(source);
        const document = AstUtils.getDocument(source);
        const model = document.parseResult.value;
        if (!contextName || !isModel(model)) {
            return false;
        }
        return this.getVisibleContextMaps(model).some(contextMap => contextMap.relationships.some(relationship =>
            isSyntacticallyComplete(relationship) && isSharedKernelRelationship(relationship) &&
            relationship.sharedKernel?.ref === sharedKernel &&
            relationship.participants.some(participant => participant.target?.ref?.name === contextName)
        ));
    }

    hasAuthorizedEventRelationship(source: AstNode, event: IntegrationEvent): boolean {
        return this.isIntegrationEventExposed(event) && this.hasAuthorizedRelationship(source, event, 'event');
    }

    hasAuthorizedQueryRelationship(source: AstNode, target: Method): boolean {
        return this.hasAuthorizedRelationship(source, target, 'query');
    }

    private hasAuthorizedRelationship(source: AstNode, target: AstNode, purpose: 'event' | 'query'): boolean {
        const consumer = getOwningContextName(source);
        const provider = getOwningContextName(target);
        const document = AstUtils.getDocument(source);
        const targetDocument = AstUtils.getDocument(target);
        const model = document.parseResult.value;
        const sameDocument = UriUtils.equals(document.uri, targetDocument.uri);
        if (!consumer || !provider || !isModel(model) ||
            (!sameDocument && !this.importsDocument(model, document, targetDocument.uri))) {
            return false;
        }
        // Local context maps authorize relationships declared in the same
        // document. Imported maps remain required for external declarations.
        const contextMaps = sameDocument ? this.getVisibleContextMaps(model) : this.getImportedContextMaps(model);
        if (!this.haveCompatibleRelationshipDefinitions(contextMaps, consumer, provider, purpose)) {
            return false;
        }
        return contextMaps.some(contextMap => contextMap.relationships.some(relationship =>
            this.authorizesTeamRelationship(relationship, consumer, provider)
        ));
    }

    isPublishedReadResponseType(source: AstNode, type: AstNode): boolean {
        if (!isDataObject(type) && !isValueObject(type)) {
            return false;
        }
        const method = AstUtils.getContainerOfType(source, (node): node is Method => node.$type === 'Method');
        return method !== undefined && method.reads.some(read => read.sources.some(reference => {
            const query = reference.target.ref;
            return query?.$type === 'Method' && isQueryService(query.$container) &&
                this.isExposedQueryResult(query) && this.hasQueryResultType(query, type) &&
                getOwningContextName(query) !== getOwningContextName(method) &&
                this.isQueryServiceExposed(query.$container) && this.hasAuthorizedQueryRelationship(method, query);
        }));
    }

    getVisibleContextMaps(model: Model): ContextMap[] {
        const contextMaps = new Set(model.declarations.filter(isContextMap));
        for (const contextMap of this.getImportedContextMaps(model)) {
            contextMaps.add(contextMap);
        }
        return [...contextMaps];
    }

    getImportedContextMaps(model: Model): ContextMap[] {
        const contextMaps = new Set<ContextMap>();
        const document = AstUtils.getDocument(model);
        for (const declaration of model.imports) {
            const uri = resolveImportUri(document, declaration);
            if (!uri) {
                continue;
            }
            const importedModel = this.services.shared.workspace.LangiumDocuments.getDocument(uri)?.parseResult.value;
            if (!isModel(importedModel)) {
                continue;
            }
            for (const contextMap of importedModel.declarations.filter(isContextMap)) {
                if (declaration.components.length === 0 || declaration.components.some(component =>
                    component.component.ref === contextMap
                )) {
                    contextMaps.add(contextMap);
                }
            }
        }
        return [...contextMaps];
    }

    private importsDocument(model: Model, document: LangiumDocument, target: URI): boolean {
        return model.imports.some(declaration => {
            const uri = resolveImportUri(document, declaration);
            return uri !== undefined && UriUtils.equals(uri, target);
        });
    }

    private haveCompatibleRelationshipDefinitions(
        contextMaps: ContextMap[],
        left: string,
        right: string,
        purpose: 'event' | 'query'
    ): boolean {
        const pairKey = JSON.stringify([left, right].sort());
        const definitions = contextMaps.flatMap(contextMap => contextMap.relationships.flatMap(relationship =>
            getRelationshipPairSemantics(relationship).filter(pair => pair.key === pairKey)
        ));
        for (let leftIndex = 0; leftIndex < definitions.length; leftIndex++) {
            for (let rightIndex = leftIndex + 1; rightIndex < definitions.length; rightIndex++) {
                if (!areRelationshipPairDefinitionsCompatible(definitions[leftIndex]!, definitions[rightIndex]!)) {
                    return false;
                }
            }
        }
        const teamDefinitions = definitions.filter(pair => pair.kind !== 'sharedKernel');
        if (purpose === 'query' && teamDefinitions.some(pair => pair.kind === 'separateWays')) {
            return false;
        }
        return true;
    }

    private authorizesTeamRelationship(
        relationship: ContextRelationship,
        consumer: string,
        provider: string
    ): boolean {
        if (!isSyntacticallyComplete(relationship)) {
            return false;
        }
        if (relationship.$type === 'CustomerSupplierRelationship') {
            return relationship.customer.context?.ref?.name === consumer &&
                relationship.supplier.context?.ref?.name === provider;
        }
        if (relationship.$type === 'PartnershipRelationship') {
            const left = relationship.left.context?.ref?.name;
            const right = relationship.right.context?.ref?.name;
            return (left === consumer && right === provider) || (right === consumer && left === provider);
        }
        return false;
    }

    private hasQueryResultType(method: Method, type: AstNode): boolean {
        const visited = new Set<AstNode>();
        const includesType = (candidate: AstNode | undefined): boolean => {
            if (candidate === type) {
                return true;
            }
            if ((!isDataObject(candidate) && !isValueObject(candidate)) || visited.has(candidate)) {
                return false;
            }
            visited.add(candidate);
            return candidate.fields.some(field =>
                getTypeReferences(field.type, field.collection).some(reference => includesType(reference.ref))
            );
        };
        return getTypeReferences(method.returnType, method.returnCollection)
            .some(reference => includesType(reference.ref));
    }
}
