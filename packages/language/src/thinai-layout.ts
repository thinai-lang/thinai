import { CstUtils, type AstNode, type CstNode } from 'langium';

export interface SiblingStatementPolicy {
    block?: 'required' | 'optional';
    blockContainer?: boolean;
    bareNameBoundary?: boolean;
    requiredReferences?: readonly string[];
    requiredReferencePaths?: readonly (readonly string[])[];
    referenceLists?: readonly {
        property: string;
        targetProperty?: string;
        nestedReferences?: readonly string[];
    }[];
    incompleteSuffixes?: readonly string[];
}

export interface SiblingContainerPolicy {
    properties?: ReadonlySet<string>;
    completionKeywords?: readonly string[];
    sharedKernelCompletionKeywords?: readonly string[];
    statement?: SiblingStatementPolicy;
}

const topLevelCompletionKeywords = [
    'import', 'shared kernel', 'subdomain', 'bounded context', 'in bounded context', 'context map', 'actor', 'journey'
] as const;

export const siblingContainerPolicies: Record<string, SiblingContainerPolicy> = {
    Model: {
        properties: new Set(['imports', 'declarations']),
        completionKeywords: topLevelCompletionKeywords
    },
    ContextMap: {
        properties: new Set(['relationships']),
        completionKeywords: ['customer', 'partner', 'separateWays', 'sharedKernel'],
        statement: { block: 'required' }
    },
    BoundedContextPart: {
        properties: new Set(['members']),
        completionKeywords: [
            'application service', 'query service', 'projector', 'aggregate', 'domain service', 'repository',
            'query repository', 'factory', 'event', 'integration event', 'module',
            'value object', 'enum', 'read model', 'data object'
        ],
        statement: { block: 'required', requiredReferences: ['context'] }
    },
    SharedKernel: {
        properties: new Set(['members']),
        completionKeywords: ['value object', 'enum', 'domain service', 'module'],
        statement: { block: 'required' }
    },
    Module: {
        properties: new Set(['exposures', 'members']),
        completionKeywords: [
            'exposes', 'application service', 'query service', 'projector', 'aggregate', 'domain service',
            'repository', 'query repository', 'factory', 'event', 'integration event', 'module',
            'value object', 'enum', 'read model', 'data object'
        ],
        sharedKernelCompletionKeywords: ['exposes', 'domain service', 'module', 'value object', 'enum'],
        statement: { block: 'required', incompleteSuffixes: ['depends', 'depends on'] }
    },
    Aggregate: {
        properties: new Set(['members', 'invariants']),
        completionKeywords: ['entity', 'root entity', 'value object', 'enum', 'invariant'],
        statement: { block: 'required' }
    },
    Entity: {
        properties: new Set(['constructors', 'methods', 'fields']),
        completionKeywords: ['constructor', 'method'],
        statement: { block: 'required' }
    },
    EnumType: { statement: { block: 'required' } },
    ValueObject: {
        properties: new Set(['constructors', 'methods', 'fields']),
        completionKeywords: ['constructor', 'method'],
        statement: { block: 'required', incompleteSuffixes: ['mirrors'] }
    },
    DomainEvent: { properties: new Set(['fields']), statement: { block: 'optional', bareNameBoundary: true } },
    IntegrationEvent: { properties: new Set(['fields']), statement: { block: 'optional', bareNameBoundary: true } },
    DataObject: { properties: new Set(['fields']), statement: { block: 'required' } },
    ReadModel: { properties: new Set(['fields']), statement: { block: 'required' } },
    ApplicationService: { properties: new Set(['methods']), completionKeywords: ['method'], statement: { block: 'required' } },
    DomainService: { properties: new Set(['methods']), completionKeywords: ['method'], statement: { block: 'optional', bareNameBoundary: true } },
    QueryService: { properties: new Set(['methods']), completionKeywords: ['method'], statement: { block: 'required' } },
    Projector: { properties: new Set(['methods']), completionKeywords: ['method'], statement: { block: 'required' } },
    Factory: { properties: new Set(['methods']), completionKeywords: ['method'], statement: { block: 'optional', bareNameBoundary: true } },
    Method: {
        properties: new Set(['invariants', 'preconditions', 'postconditions', 'behaviors', 'transitions', 'emissions', 'invocations', 'projects']),
        completionKeywords: ['invariant', 'precondition', 'postcondition', 'behavior', 'invokes'],
        statement: { block: 'optional', incompleteSuffixes: ['returns'] }
    },
    Constructor: {
        properties: new Set(['invariants', 'preconditions', 'postconditions', 'behaviors']),
        completionKeywords: ['invariant', 'precondition', 'postcondition', 'behavior'],
        statement: { block: 'optional' }
    },
    Journey: { properties: new Set(['actors']), completionKeywords: ['by'], statement: { block: 'required' } },
    JourneyActor: {
        properties: new Set(['steps']),
        completionKeywords: ['invoke'],
        statement: { block: 'required', requiredReferences: ['actor'] }
    },
    Actor: { statement: { bareNameBoundary: true } },
    BoundedContext: { statement: { bareNameBoundary: true, incompleteSuffixes: ['realizes'] } },
    CustomerSupplierRelationship: {
        statement: {
            bareNameBoundary: true,
            requiredReferencePaths: [['customer', 'context'], ['supplier', 'context']]
        }
    },
    PartnershipRelationship: {
        statement: {
            bareNameBoundary: true,
            requiredReferencePaths: [['left', 'context'], ['right', 'context']]
        }
    },
    SeparateWaysRelationship: {
        statement: { bareNameBoundary: true, requiredReferences: ['left', 'right'] }
    },
    ContextMapEndpoint: { statement: { blockContainer: true } },
    EventEmission: {
        statement: {
            bareNameBoundary: true,
            referenceLists: [{ property: 'events', targetProperty: 'target' }],
            incompleteSuffixes: ['emits', 'when']
        }
    },
    Exposure: {
        statement: {
            bareNameBoundary: true,
            referenceLists: [{ property: 'declarations', targetProperty: 'target' }],
            incompleteSuffixes: ['exposes']
        }
    },
    Field: { statement: { bareNameBoundary: true, incompleteSuffixes: ['initial'] } },
    JourneyStep: {
        statement: {
            bareNameBoundary: true,
            referenceLists: [{ property: 'targets' }],
            incompleteSuffixes: ['invoke', 'with', 'when']
        }
    },
    MethodInvocation: {
        statement: { referenceLists: [{ property: 'targets' }], incompleteSuffixes: ['invokes', 'when'] }
    },
    QueryRepository: {
        statement: { requiredReferences: ['readModel'], bareNameBoundary: true, incompleteSuffixes: ['serves'] }
    },
    ReadModelReference: { statement: { requiredReferences: ['target'], bareNameBoundary: true } },
    Repository: { statement: { requiredReferences: ['root'], bareNameBoundary: true, incompleteSuffixes: ['manages'] } },
    SharedKernelRelationship: {
        statement: {
            block: 'required',
            requiredReferences: ['sharedKernel'],
            referenceLists: [{ property: 'participants', targetProperty: 'target' }],
            incompleteSuffixes: ['participants']
        }
    },
    Subdomain: { statement: { bareNameBoundary: true, incompleteSuffixes: ['kind'] } },
    Transition: {
        statement: {
            bareNameBoundary: true,
            referenceLists: [{ property: 'changes', nestedReferences: ['field', 'from', 'to'] }],
            incompleteSuffixes: ['transition', 'from', 'to', 'when']
        }
    }
};

export function isLineSeparatedSibling(node: AstNode): boolean {
    const container = node.$container;
    const property = node.$containerProperty;
    return container !== undefined && property !== undefined &&
        siblingContainerPolicies[container.$type]?.properties?.has(property) === true;
}

export function isBlockNodeType(type: string): boolean {
    const policy = siblingContainerPolicies[type]?.statement;
    return policy?.block !== undefined || policy?.blockContainer === true;
}

export function getSiblingCompletionKeywords(containerType: string, inSharedKernelModule = false): readonly string[] {
    const policy = siblingContainerPolicies[containerType];
    return inSharedKernelModule && policy?.sharedKernelCompletionKeywords
        ? policy.sharedKernelCompletionKeywords
        : policy?.completionKeywords ?? [];
}

export function getSiblingKeywordPrefixes(): readonly string[] {
    return [...new Set([
        ...Object.values(siblingContainerPolicies).flatMap(policy => policy.completionKeywords ?? []),
        'transition', 'emits', 'projects'
    ])];
}

export function getSiblingStatementPolicy(nodeType: string): SiblingStatementPolicy {
    return siblingContainerPolicies[nodeType]?.statement ?? {};
}

export function getIncompleteStatementSuffixes(): readonly string[] {
    return [...new Set(Object.values(siblingContainerPolicies).flatMap(policy =>
        policy.statement?.incompleteSuffixes ?? []
    ))];
}

export function getBlockNestingDepth(node: AstNode | undefined): number {
    let depth = 0;
    let current = node;
    while (current) {
        if (isBlockNodeType(current.$type)) {
            depth++;
        }
        current = current.$container;
    }
    return depth;
}

export function findCstTokenOffset(node: CstNode, token: string): number | undefined {
    return CstUtils.flattenCst(node).find(leaf => leaf.text === token)?.offset;
}
