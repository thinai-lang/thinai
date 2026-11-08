import { AstUtils, type AstNode } from 'langium';
import {
    isDataObject,
    isDomainEvent,
    isEntity,
    isEnumType,
    isEnumValue,
    isIntegrationEvent,
    isJourney,
    isMethod,
    isReadModel,
    isValueObject,
    type Journey,
    type JourneyStep,
    type Method,
    type TypeDeclaration
} from './generated/ast.js';
import { getNavigableTypeReferences, getTypeReferences } from './thinai-type-utils.js';

export type JourneySpecificationKind = 'with' | 'when';

export interface JourneyStepContracts {
    operation: Method | undefined;
    inputs: Set<AstNode>;
    outputs: Set<AstNode>;
}

/** Returns the journey containing the given step, if any. */
export function getJourneyForStep(step: JourneyStep): Journey | undefined {
    return AstUtils.getContainerOfType(step, isJourney);
}

/** Flattens all actor blocks into the source-order journey timeline. */
export function getJourneySteps(journey: Journey): JourneyStep[] {
    return journey.actors.flatMap(actor => actor.steps);
}

export function getJourneyStepsFor(step: JourneyStep): JourneyStep[] {
    const journey = getJourneyForStep(step);
    return journey ? getJourneySteps(journey) : [];
}

export function getJourneyStepIndex(step: JourneyStep): number {
    return getJourneyStepsFor(step).indexOf(step);
}

export function getPriorJourneySteps(step: JourneyStep): JourneyStep[] {
    const index = getJourneyStepIndex(step);
    return index < 0 ? [] : getJourneyStepsFor(step).slice(0, index);
}

export function getJourneyStepOperation(step: JourneyStep): Method | undefined {
    const target = step.target?.ref;
    return isMethod(target) ? target : undefined;
}

/**
 * Computes the recursively reachable value contract of a journey step
 * operation. Entity and event instances are intentionally not part of this
 * closure: they are not valid application-service contract types and must
 * remain private.
 */
export function getJourneyStepContracts(step: JourneyStep): JourneyStepContracts {
    const operation = getJourneyStepOperation(step);
    const contracts = operation
        ? getOperationContractTypes(operation)
        : { inputs: new Set<AstNode>(), outputs: new Set<AstNode>() };
    return { operation, ...contracts };
}

/** Computes the recursive input and output contract of a method. */
export function getOperationContractTypes(
    operation: Method,
    navigable = true
): { inputs: Set<AstNode>; outputs: Set<AstNode> } {
    const inputs = new Set<AstNode>();
    const outputs = new Set<AstNode>();
    const inputVisited = new Set<AstNode>();
    for (const parameter of operation.parameters) {
        inputs.add(parameter);
        for (const reference of (navigable ? getNavigableTypeReferences : getTypeReferences)(
            parameter.type as import('langium').Reference<TypeDeclaration> | undefined,
            parameter.collection
        )) {
            collectContractType(reference.ref, inputs, inputVisited, navigable);
        }
    }

    const outputVisited = new Set<AstNode>();
    for (const reference of (navigable ? getNavigableTypeReferences : getTypeReferences)(
        operation.returnType,
        operation.returnCollection
    )) {
        collectContractType(reference.ref, outputs, outputVisited, navigable);
    }
    return { inputs, outputs };
}

/**
 * Determines whether a contract target belongs to the current step, a prior
 * step, or a future step. A target can belong to multiple steps when the same
 * type or field is shared by several step contracts.
 */
export function getJourneyContractTargetSteps(
    referenceStep: JourneyStep,
    target: AstNode
): Array<{ step: JourneyStep; index: number; input: boolean; output: boolean }> {
    const steps = getJourneyStepsFor(referenceStep);
    const matches: Array<{ step: JourneyStep; index: number; input: boolean; output: boolean }> = [];
    for (const [index, step] of steps.entries()) {
        const contracts = getJourneyStepContracts(step);
        const input = contracts.inputs.has(target) ||
            (isEnumValue(target) && contracts.inputs.has(target.$container));
        const output = contracts.outputs.has(target) ||
            (isEnumValue(target) && contracts.outputs.has(target.$container));
        if (input || output) {
            matches.push({ step, index, input, output });
        }
    }
    return matches;
}

/**
 * True when the target is visible to the given specification clause with
 * respect to the journey timeline. Current inputs and prior contracts are
 * visible; current outputs and future contracts are not.
 */
export function isJourneyContractTargetVisible(
    referenceStep: JourneyStep,
    target: AstNode,
    _kind: JourneySpecificationKind
): boolean {
    const matches = getJourneyContractTargetSteps(referenceStep, target);
    if (matches.length === 0) {
        return false;
    }
    const referenceIndex = getJourneyStepIndex(referenceStep);
    return matches.some(match => match.index < referenceIndex ||
        match.index === referenceIndex && match.input);
}

function collectContractType(
    type: AstNode | undefined,
    target: Set<AstNode>,
    visited: Set<AstNode>,
    navigable: boolean
): void {
    if (!type || visited.has(type) || isEntity(type) || isDomainEvent(type) || isIntegrationEvent(type)) {
        return;
    }
    if (!isDataObject(type) && !isValueObject(type) && !isReadModel(type) && !isEnumType(type)) {
        return;
    }
    visited.add(type);
    target.add(type);

    if (isEnumType(type)) {
        for (const value of type.values) {
            target.add(value);
        }
        return;
    }

    for (const field of type.fields) {
        target.add(field);
        for (const reference of (navigable ? getNavigableTypeReferences : getTypeReferences)(
            field.type,
            field.collection
        )) {
            collectContractType(reference.ref, target, visited, navigable);
        }
    }
}
