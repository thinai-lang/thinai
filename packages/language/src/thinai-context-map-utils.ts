import type { BoundedContext, ContextMapEndpoint, ContextRelationship } from './generated/ast.js';
import {
    isCustomerSupplierRelationship,
    isPartnershipRelationship,
    isSeparateWaysRelationship
} from './generated/ast.js';

export type ContextRelationshipPairKind = 'customerSupplier' | 'partnership' | 'separateWays' | 'sharedKernel';

export interface ContextRelationshipPairSemantics {
    key: string;
    identity: string;
    signature: string;
    kind: ContextRelationshipPairKind;
    name: string;
}

export function areRelationshipPairDefinitionsCompatible(
    left: ContextRelationshipPairSemantics,
    right: ContextRelationshipPairSemantics
): boolean {
    if (left.kind === 'sharedKernel' && right.kind === 'sharedKernel') {
        return true;
    }
    if (left.kind === 'sharedKernel' || right.kind === 'sharedKernel') {
        return left.kind !== 'separateWays' && right.kind !== 'separateWays';
    }
    return left.signature === right.signature;
}

export function getRelationshipPairSemantics(relationship: ContextRelationship): ContextRelationshipPairSemantics[] {
    const createPair = (
        left: BoundedContext,
        right: BoundedContext,
        kind: ContextRelationshipPairKind,
        identity: unknown,
        signature: unknown
    ): ContextRelationshipPairSemantics | undefined => {
        if (left === right) {
            return undefined;
        }
        const contexts = [left.name, right.name].sort();
        return {
            key: JSON.stringify(contexts),
            identity: JSON.stringify(identity),
            signature: JSON.stringify(signature),
            kind,
            name: contexts.map(name => `'${name}'`).join(' and ')
        };
    };
    const patterns = (endpoint: ContextMapEndpoint) => [...endpoint.integrationPatterns].sort();

    if (isCustomerSupplierRelationship(relationship)) {
        const customer = relationship.customer?.context?.ref;
        const supplier = relationship.supplier?.context?.ref;
        if (!customer || !supplier) {
            return [];
        }
        const identity = ['customerSupplier', customer.name, supplier.name];
        const pair = createPair(customer, supplier, 'customerSupplier', identity, [
            'customerSupplier', customer.name, patterns(relationship.customer), supplier.name, patterns(relationship.supplier)
        ]);
        return pair ? [pair] : [];
    }
    if (isPartnershipRelationship(relationship)) {
        const left = relationship.left?.context?.ref;
        const right = relationship.right?.context?.ref;
        if (!left || !right) {
            return [];
        }
        const sides = [
            { context: left, patterns: patterns(relationship.left) },
            { context: right, patterns: patterns(relationship.right) }
        ].sort((a, b) => a.context.name.localeCompare(b.context.name));
        const identity = ['partnership', ...[left.name, right.name].sort()];
        const pair = createPair(left, right, 'partnership', identity, [
            'partnership', ...sides.map(side => [side.context.name, side.patterns])
        ]);
        return pair ? [pair] : [];
    }
    if (isSeparateWaysRelationship(relationship)) {
        const left = relationship.left?.ref;
        const right = relationship.right?.ref;
        if (!left || !right) {
            return [];
        }
        const identity = ['separateWays', ...[left.name, right.name].sort()];
        const pair = createPair(left, right, 'separateWays', identity, identity);
        return pair ? [pair] : [];
    }

    const sharedKernel = relationship.sharedKernel?.ref;
    const participants = [...new Set((relationship.participants ?? [])
        .map(participant => participant?.target?.ref)
        .filter((context): context is BoundedContext => context !== undefined))];
    if (!sharedKernel) {
        return [];
    }
    const pairs: ContextRelationshipPairSemantics[] = [];
    for (let leftIndex = 0; leftIndex < participants.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < participants.length; rightIndex++) {
            const left = participants[leftIndex]!;
            const right = participants[rightIndex]!;
            const identity = ['sharedKernel', sharedKernel.name, ...[left.name, right.name].sort()];
            const pair = createPair(left, right, 'sharedKernel', identity, ['sharedKernel', sharedKernel.name]);
            if (pair) {
                pairs.push(pair);
            }
        }
    }
    return pairs;
}
