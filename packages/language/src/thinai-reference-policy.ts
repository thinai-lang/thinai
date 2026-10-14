import {
    AstUtils,
    type AstNode,
    type LangiumCoreServices,
    type LangiumDocument,
    isReference,
    type URI,
    UriUtils
} from 'langium';
import {
    isContextMap,
    isDataObject,
    isModel,
    isQueryService,
    isSharedKernelRelationship,
    type ContextMap,
    type DataObject,
    type IntegrationEvent,
    type Method,
    type Model,
    type QueryService,
    type SharedKernel
} from './generated/ast.js';
import { isSyntacticallyComplete } from './thinai-ast-utils.js';
import { areRelationshipPairDefinitionsCompatible, getRelationshipPairSemantics } from './thinai-context-map-utils.js';
import { getOwningContextName, getOwningModule, resolveImportUri } from './thinai-scope-utils.js';

/** Shared visibility and cross-context authorization rules for linking, completion, and validation. */
export class ThinaiReferencePolicy {
    constructor(private readonly services: LangiumCoreServices) {}

    isIntegrationEventExposed(event: IntegrationEvent): boolean {
        const module = getOwningModule(event);
        return module === undefined || module.exposures.some(exposure =>
            exposure.declarations.some(declaration => declaration.target.ref === event)
        );
    }

    isQueryServiceExposed(service: QueryService): boolean {
        const module = getOwningModule(service);
        return module !== undefined && module.exposures.some(exposure =>
            exposure.declarations.some(declaration => declaration.target.ref === service)
        );
    }

    isExposedQueryResult(method: Method): boolean {
        const resultTypes = [
            ...(method.returnType?.ref ? [method.returnType.ref] : []),
            ...(method.returnCollection
                ? AstUtils.streamReferences(method.returnCollection)
                    .map(referenceInfo => isReference(referenceInfo.reference) ? referenceInfo.reference.ref : undefined)
                    .filter((type): type is AstNode => type !== undefined)
                    .toArray()
                : [])
        ];
        return resultTypes.length === 0 || resultTypes.every(type => {
            if (!isDataObject(type)) {
                return false;
            }
            const module = getOwningModule(type);
            return module !== undefined && module === getOwningModule(method) && module.exposures.some(exposure =>
                exposure.declarations.some(declaration => declaration.target.ref === type)
            );
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
        const model = document.parseResult.value;
        if (!consumer || !provider || !isModel(model) ||
            !this.importsDocument(model, document, AstUtils.getDocument(target).uri)) {
            return false;
        }
        const contextMaps = this.getVisibleContextMaps(model);
        if (!this.haveCompatibleRelationshipDefinitions(contextMaps, consumer, provider, purpose)) {
            return false;
        }
        return contextMaps.some(contextMap => contextMap.relationships.some(relationship =>
            this.authorizesTeamRelationship(relationship, consumer, provider)
        ));
    }

    isPublishedReadResponseType(source: AstNode, type: AstNode): boolean {
        if (!isDataObject(type)) {
            return false;
        }
        const typeModule = getOwningModule(type);
        if (!typeModule || !typeModule.exposures.some(exposure =>
            exposure.declarations.some(declaration => declaration.target.ref === type)
        )) {
            return false;
        }
        const method = AstUtils.getContainerOfType(source, (node): node is Method => node.$type === 'Method');
        return method !== undefined && method.reads.some(read => read.sources.some(reference => {
            const query = reference.target.ref;
            return query?.$type === 'Method' && isQueryService(query.$container) &&
                this.hasQueryResultType(query, type) && getOwningContextName(query) !== getOwningContextName(method) &&
                this.isQueryServiceExposed(query.$container) && this.hasAuthorizedQueryRelationship(method, query);
        }));
    }

    getVisibleContextMaps(model: Model): ContextMap[] {
        const contextMaps = new Set(model.declarations.filter(isContextMap));
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
        relationship: import('./generated/ast.js').ContextRelationship,
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

    private hasQueryResultType(method: Method, type: DataObject): boolean {
        return method.returnType?.ref === type || method.returnCollection !== undefined &&
            AstUtils.streamReferences(method.returnCollection).some(referenceInfo =>
                isReference(referenceInfo.reference) && referenceInfo.reference.ref === type
            );
    }
}
