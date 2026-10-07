import type { AstNode } from 'langium';

const lineSeparatedProperties: Record<string, ReadonlySet<string>> = {
    Model: new Set(['imports', 'declarations']),
    ContextMap: new Set(['relationships']),
    BoundedContextPart: new Set(['members']),
    SharedKernel: new Set(['members']),
    Module: new Set(['exposures', 'members']),
    Aggregate: new Set(['members', 'invariants']),
    Entity: new Set(['constructors', 'methods', 'fields']),
    ValueObject: new Set(['constructors', 'methods', 'fields']),
    DomainEvent: new Set(['fields']),
    IntegrationEvent: new Set(['fields']),
    DataObject: new Set(['fields']),
    ReadModel: new Set(['fields']),
    ApplicationService: new Set(['methods']),
    DomainService: new Set(['methods']),
    QueryService: new Set(['methods']),
    Projector: new Set(['methods']),
    Factory: new Set(['methods']),
    Method: new Set(['invariants', 'preconditions', 'postconditions', 'behaviors', 'transitions', 'emissions', 'invocations', 'projects']),
    Constructor: new Set(['invariants', 'preconditions', 'postconditions', 'behaviors']),
    Journey: new Set(['actors']),
    JourneyActor: new Set(['steps'])
};

export function isLineSeparatedSibling(node: AstNode): boolean {
    const container = node.$container;
    const property = node.$containerProperty;
    return container !== undefined && property !== undefined &&
        lineSeparatedProperties[container.$type]?.has(property) === true;
}
