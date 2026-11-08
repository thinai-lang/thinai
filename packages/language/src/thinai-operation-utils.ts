import { AstUtils } from 'langium';
import type { Method, MethodInvocation } from './generated/ast.js';
import {
    isAggregate,
    isApplicationService,
    isDomainEvent,
    isEntity,
    isIntegrationEvent,
    isMethod,
    isProjector,
    isQueryService
} from './generated/ast.js';

export function getInvokedMethod(invocation: MethodInvocation): Method | undefined {
    const target = invocation.target?.ref;
    return isMethod(target) ? target : undefined;
}

export function getReachableMethods(method: Method, visited = new Set<Method>()): Method[] {
    if (visited.has(method)) {
        return [];
    }
    visited.add(method);
    const reachable: Method[] = [];
    for (const invocation of method.invocations) {
        const target = getInvokedMethod(invocation);
        if (target) {
            reachable.push(target, ...getReachableMethods(target, visited));
        }
    }
    return reachable;
}

export function hasBehaviorSideEffects(method: Method, visited = new Set<Method>()): boolean {
    if (visited.has(method)) {
        return false;
    }
    visited.add(method);
    if (method.transitions.length > 0 || method.emissions.length > 0) {
        return true;
    }
    return method.invocations.some(invocation => {
        const target = getInvokedMethod(invocation);
        return target !== undefined && hasBehaviorSideEffects(target, visited);
    });
}

export function canDeclareTransition(method: Method): boolean {
    return isEntity(method.$container) && AstUtils.getContainerOfType(method, isAggregate) !== undefined;
}

export function canDeclareProjects(method: Method): boolean {
    return isProjector(method.$container);
}

export function isJourneyCommand(method: Method): boolean {
    return isApplicationService(method.$container) && !method.parameters.some(parameter =>
        isDomainEvent(parameter.type?.ref) || isIntegrationEvent(parameter.type?.ref)
    );
}

/**
 * Query-service methods are read steps in a command-led journey. Event-typed
 * parameters are rejected by validation globally, but exclude them here too so
 * the predicate mirrors `isJourneyCommand`.
 */
export function isJourneyQuery(method: Method): boolean {
    return isQueryService(method.$container) && !method.parameters.some(parameter =>
        isDomainEvent(parameter.type?.ref) || isIntegrationEvent(parameter.type?.ref)
    );
}

export function isJourneyStepOperation(method: Method): boolean {
    return isJourneyCommand(method) || isJourneyQuery(method);
}

/**
 * The implicit result binding reserves the parameter name `result` for methods
 * with a result and for application-service commands. Event handlers and other
 * non-returning operations may use it.
 */
export function isReservedResultParameterName(method: Method, name: string): boolean {
    if (name !== 'result') {
        return false;
    }
    const hasResult = method.returnPrimitive !== undefined ||
        method.returnType !== undefined ||
        method.returnCollection !== undefined;
    return hasResult || isJourneyCommand(method);
}

export type EventEmissionMode = 'domain' | 'integration' | undefined;

export function getEventEmissionMode(method: Method): EventEmissionMode {
    const owner = method.$container;
    if (isEntity(owner) && owner.root && AstUtils.getContainerOfType(method, isAggregate)) {
        return 'domain';
    }
    if (isApplicationService(owner) && method.parameters.length === 1 &&
        isDomainEvent(method.parameters[0]?.type?.ref)) {
        return 'integration';
    }
    return undefined;
}
