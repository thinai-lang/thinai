import { AstUtils } from 'langium';
import type { Method, MethodInvocation } from './generated/ast.js';
import {
    isAggregate,
    isApplicationService,
    isDomainEvent,
    isEntity,
    isIntegrationEvent,
    isMethod,
    isProjector
} from './generated/ast.js';

export function getInvokedMethod(invocation: MethodInvocation): Method | undefined {
    const target = invocation.targets.at(-1)?.ref;
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
