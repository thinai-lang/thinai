import { AstUtils, isReference, type AstNode, type ValidationAcceptor } from 'langium';
import {
    isApplicationService,
    isDomainService,
    isMethod,
    isProjector,
    isQueryRepository,
    isQueryService,
    isRepository,
    isSpecificationTextPart,
    type Method,
    type Parameter,
    type Projector,
    type QueryRepository,
    type QueryService,
    type ReadDependency,
    type Repository
} from './generated/ast.js';
import { findCstTokenOffset } from './thinai-layout.js';
import { isSyntacticallyComplete } from './thinai-ast-utils.js';
import { getOwningContextName } from './thinai-scope-utils.js';
import type { ThinaiReferencePolicy } from './thinai-reference-policy.js';

type IsEventParameter = (parameter: Parameter) => boolean;

/** Validation for CQRS reads and projector projection behavior. */
export class ThinaiReadDependencyValidator {
    constructor(
        private readonly referencePolicy: ThinaiReferencePolicy,
        private readonly isEventParameter: IsEventParameter
    ) {}

    checkQueryServiceMethod(method: Method, service: QueryService, accept: ValidationAcceptor): void {
        const queryContext = getOwningContextName(service);
        for (const read of method.reads) {
            for (const source of read.sources) {
                const target = source.target.ref;
                if (isRepository(target) || isQueryRepository(target) && getOwningContextName(target) !== queryContext) {
                    accept('error', 'A query service may read only query repositories in its own bounded context.', {
                        node: source,
                        property: 'target'
                    });
                }
            }
        }
    }

    checkApplicationServiceReads(method: Method, accept: ValidationAcceptor): void {
        for (const read of method.reads) {
            for (const source of read.sources) {
                if (isQueryRepository(source.target.ref)) {
                    accept('error', 'An application-service method must use command-side repositories, not query repositories.', {
                        node: source,
                        property: 'target'
                    });
                }
            }
        }
    }

    checkDomainServiceReads(method: Method, accept: ValidationAcceptor): void {
        for (const read of method.reads) {
            for (const source of read.sources) {
                if (isQueryRepository(source.target.ref)) {
                    accept('error', 'A domain service must not depend on a query repository; use a domain repository or port.', {
                        node: source,
                        property: 'target'
                    });
                }
            }
        }
    }

    checkReadDependency(read: ReadDependency, accept: ValidationAcceptor): void {
        if (!isSyntacticallyComplete(read)) {
            return;
        }
        let method: AstNode | undefined = read.$container;
        while (method && !isMethod(method)) {
            method = method.$container;
        }
        const owner = isMethod(method) ? method.$container : undefined;
        if (!isMethod(method) || !(isApplicationService(owner) || isQueryService(owner) || isProjector(owner) || isDomainService(owner))) {
            const clauseRange = this.getReadDependencyKeywordRange(read);
            accept('error', 'The reads from clause is allowed only in application-service, query-service, projector, or domain-service methods.', {
                node: read,
                ...(clauseRange ? { range: clauseRange } : { keyword: 'reads' })
            });
            return;
        }

        const seenSources = new Set<AstNode>();
        for (const source of read.sources) {
            const target = source.target.ref;
            if (!target) {
                continue;
            }
            if (seenSources.has(target)) {
                accept('error', `Read source '${source.target.$refText}' is listed more than once.`, {
                    node: source,
                    property: 'target'
                });
            }
            seenSources.add(target);
            if (isRepository(target) || isQueryRepository(target)) {
                if (getOwningContextName(read) !== getOwningContextName(target)) {
                    accept('error', 'A reads from repository dependency must belong to the same bounded context.', {
                        node: source,
                        property: 'target'
                    });
                }
                if (isProjector(owner) && isRepository(target)) {
                    accept('warning', 'A projector reading current aggregate state may produce different results when events are replayed.', {
                        node: source,
                        property: 'target'
                    });
                }
                if (isProjector(owner) && isQueryRepository(target)) {
                    accept('error', 'A projector must not read from a query repository; use event data or an explicit aggregate/reference source.', {
                        node: source,
                        property: 'target'
                    });
                }
                continue;
            }
            if (!isMethod(target) || !isQueryService(target.$container) ||
                getOwningContextName(read) === getOwningContextName(target)) {
                accept('error', 'A reads from method target must be a published query-service method in another bounded context.', {
                    node: source,
                    property: 'target'
                });
                continue;
            }
            if (!this.referencePolicy.isQueryServiceExposed(target.$container) ||
                !this.referencePolicy.hasAuthorizedQueryRelationship(read, target)) {
                accept('error', 'Reading a query service in another bounded context requires an exposed query contract and an imported authorized context map.', {
                    node: source,
                    property: 'target'
                });
            } else if (!this.referencePolicy.isExposedQueryResult(target)) {
                accept('error', 'A published query operation must return primitives or explicitly exposed data-object contracts.', {
                    node: source,
                    property: 'target'
                });
            } else if (isProjector(owner)) {
                accept('warning', 'A projector reading an external query API may make replay results depend on remote data availability or current state.', {
                    node: source,
                    property: 'target'
                });
            }
        }
    }

    checkProjectorMethod(method: Method, projector: Projector, accept: ValidationAcceptor): void {
        const cstNode = method.$cstNode;
        const hasClosedBody = cstNode !== undefined && findCstTokenOffset(cstNode, '{') !== undefined &&
            cstNode.text.trimEnd().endsWith('}') && isSyntacticallyComplete(method);
        if (method.projects.length === 0 && hasClosedBody) {
            accept('error', 'A projector method must declare at least one read model with projects.', {
                node: method,
                property: 'projects'
            });
        }
        const seenProjects = new Set<AstNode>();
        for (const project of method.projects) {
            const target = project.target?.ref;
            if (target) {
                if (seenProjects.has(target)) {
                    accept('error', `Read model '${target.name}' is referenced more than once in projects.`, {
                        node: project,
                        property: 'target'
                    });
                }
                seenProjects.add(target);
            }
            if (target && getOwningContextName(target) !== getOwningContextName(projector)) {
                accept('error', 'A projector and its read models must belong to the same bounded context.', {
                    node: project,
                    property: 'target'
                });
            }
        }
        const eventParameters = method.parameters.filter(parameter => this.isEventParameter(parameter));
        if ((eventParameters.length !== 1 || method.parameters.length !== 1) && hasClosedBody) {
            accept('error', 'A projector method must handle exactly one domain or integration event.', {
                node: method,
                property: 'parameters'
            });
        }
        const returnsKeyword = cstNode ? findCstTokenOffset(cstNode, 'returns') : undefined;
        const openingBrace = cstNode ? findCstTokenOffset(cstNode, '{') : undefined;
        const hasReturnsClause = method.returnPrimitive !== undefined || method.returnType !== undefined ||
            method.returnCollection !== undefined || returnsKeyword !== undefined &&
            (openingBrace === undefined || returnsKeyword < openingBrace);
        if (hasReturnsClause) {
            accept('error', 'A projector handler does not return a value.', {
                node: method,
                keyword: 'returns'
            });
        }
        for (const repository of this.getReadRepositoryReferences(method)) {
            if (isRepository(repository)) {
                accept('error', 'A projector may describe query-repository output, not writes to an aggregate repository.', {
                    node: method,
                    property: 'behaviors'
                });
            } else if (!method.projects.some(project => project.target.ref === repository.readModel.ref)) {
                accept('error', 'A projector method may reference only query repositories for its declared projection targets.', {
                    node: method,
                    property: 'behaviors'
                });
            }
        }
    }

    private getReadRepositoryReferences(node: AstNode): Array<Repository | QueryRepository> {
        const repositories = new Set<Repository | QueryRepository>();
        AstUtils.streamAst(node).forEach(child => AstUtils.streamReferences(child).forEach(referenceInfo => {
            if (isSpecificationTextPart(referenceInfo.container) && isReference(referenceInfo.reference) &&
                (isQueryRepository(referenceInfo.reference.ref) || isRepository(referenceInfo.reference.ref))) {
                repositories.add(referenceInfo.reference.ref);
            }
        }));
        return [...repositories];
    }

    private getReadDependencyKeywordRange(read: ReadDependency): import('vscode-languageserver').Range | undefined {
        const cstNode = read.$cstNode;
        if (!cstNode) {
            return undefined;
        }
        const readsOffset = findCstTokenOffset(cstNode, 'reads');
        const fromOffset = findCstTokenOffset(cstNode, 'from');
        if (readsOffset === undefined || fromOffset === undefined) {
            return undefined;
        }
        const document = AstUtils.getDocument(read);
        return {
            start: document.textDocument.positionAt(readsOffset),
            end: document.textDocument.positionAt(fromOffset + 'from'.length)
        };
    }
}
