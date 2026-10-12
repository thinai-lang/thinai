import type { AstNode, ValidationAcceptor } from 'langium';
import type { Aggregate, ApplicationService, Method, Parameter, QueryService, SharedKernel } from './generated/ast.js';
import { isApplicationService, isDomainService, isEntity, isFactory } from './generated/ast.js';
import { getInvokedMethod, getReachableMethods, hasBehaviorSideEffects } from './thinai-operation-utils.js';

export interface MethodInvocationValidationContext {
    isSyntacticallyComplete(node: AstNode): boolean;
    getOwningSharedKernel(node: AstNode): SharedKernel | undefined;
    hasVisibleSharedKernel(source: AstNode, sharedKernel: SharedKernel): boolean;
    hasSharedKernelRelationship(source: AstNode, sharedKernel: SharedKernel): boolean;
    isCrossContextOwned(source: AstNode, target: AstNode): boolean;
    isEventParameter(parameter: Parameter): boolean;
    getOwningAggregate(node: AstNode): Aggregate | undefined;
    isAggregateRootMethod(method: Method, aggregate: Aggregate): boolean;
}

/** Validates invocation direction and aggregate boundaries for method bodies. */
export function validateMethodInvocations(
    method: Method,
    applicationService: ApplicationService | undefined,
    queryService: QueryService | undefined,
    eventParameters: Parameter[],
    accept: ValidationAcceptor,
    context: MethodInvocationValidationContext
): void {
    for (const invocation of method.invocations) {
        if (method.$container?.$type === 'Projector') {
            accept('error', 'Projector methods cannot invoke other methods.', {
                node: invocation,
                keyword: 'invokes'
            });
            continue;
        }
        if (!context.isSyntacticallyComplete(invocation)) {
            continue;
        }
        const target = getInvokedMethod(invocation);
        if (!target) {
            accept('error', 'An invokes path must end at a method.', {
                node: invocation,
                property: 'targets'
            });
            continue;
        }
        const targetSharedKernel = context.getOwningSharedKernel(target);
        const allowedSharedKernelService = targetSharedKernel !== undefined && isDomainService(target.$container) &&
            (applicationService !== undefined || isDomainService(method.$container)) &&
            context.hasVisibleSharedKernel(method, targetSharedKernel) &&
            context.hasSharedKernelRelationship(method, targetSharedKernel);
        if (context.isCrossContextOwned(method, target) && !allowedSharedKernelService) {
            accept('error', 'A method may invoke across bounded-context boundaries only through an authorized shared-kernel domain service.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (target.parameters.some(context.isEventParameter)) {
            accept('error', 'An event-triggered method cannot be invoked directly; invoke an ordinary command method instead.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (isApplicationService(target.$container) && !applicationService) {
            accept('error', 'Domain behavior cannot invoke an application-service method.', {
                node: invocation,
                property: 'targets'
            });
        }
        const reachable = getReachableMethods(target);
        if (!applicationService && !isApplicationService(target.$container) &&
            reachable.some(candidate => isApplicationService(candidate.$container))) {
            accept('error', 'Domain behavior cannot transitively invoke an application-service method.', {
                node: invocation,
                property: 'targets'
            });
        }
        const targetAggregate = context.getOwningAggregate(target);
        const targetIsAggregateRoot = targetAggregate !== undefined && context.isAggregateRootMethod(target, targetAggregate);
        const sourceAggregate = context.getOwningAggregate(method);
        if (isDomainService(method.$container) && (targetAggregate !== undefined || reachable.some(candidate =>
            context.getOwningAggregate(candidate) !== undefined
        ))) {
            accept('error', 'A domain service must not invoke aggregate-owned methods; application services should invoke aggregate roots directly.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (isDomainService(method.$container) && !isDomainService(target.$container) &&
            !isApplicationService(target.$container) && targetAggregate === undefined &&
            !reachable.some(candidate => context.getOwningAggregate(candidate) !== undefined) &&
            !target.parameters.some(context.isEventParameter)) {
            accept('error', 'A domain service may invoke only another domain service.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (sourceAggregate && (isDomainService(target.$container) || reachable.some(candidate =>
            isDomainService(candidate.$container)
        ))) {
            accept('error', 'Aggregate-owned methods must not invoke domain services, directly or transitively; application services coordinate both.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (applicationService && !isApplicationService(target.$container) &&
            (reachable.some(candidate => isApplicationService(candidate.$container)) ||
                (!targetIsAggregateRoot && reachable.some(candidate => context.getOwningAggregate(candidate) !== undefined)))) {
            accept('error', 'Application services must invoke aggregate-root behavior directly, not through another method call chain.', {
                node: invocation,
                property: 'targets'
            });
        }
        const targetFactory = isFactory(target.$container) ? target.$container : undefined;
        const factoryReturnType = target.returnType?.ref;
        const isAssociatedFactoryMethod = applicationService !== undefined && targetFactory !== undefined &&
            isEntity(factoryReturnType) && factoryReturnType.root && context.getOwningAggregate(factoryReturnType) !== undefined;
        if (targetAggregate && !context.isAggregateRootMethod(target, targetAggregate) &&
            !isEntity(method.$container) && !isAssociatedFactoryMethod) {
            accept('error', 'Only entity behavior may invoke child-entity methods; aggregate-root behavior must coordinate aggregate changes.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (sourceAggregate && targetAggregate && targetAggregate !== sourceAggregate) {
            accept('error', 'Domain behavior must not invoke another aggregate directly.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (!applicationService && sourceAggregate && reachable.some(candidate => {
            const candidateAggregate = context.getOwningAggregate(candidate);
            return candidateAggregate !== undefined && candidateAggregate !== sourceAggregate;
        })) {
            accept('error', 'Domain behavior must not transitively invoke another aggregate.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (applicationService && isApplicationService(target.$container) && target.$container !== applicationService &&
            (eventParameters.length !== 1 || target.parameters.some(context.isEventParameter))) {
            accept('error', 'Only an event handler may dispatch to a command in another application service.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (queryService && (target.$container !== queryService || hasBehaviorSideEffects(target))) {
            accept('error', 'A query service may invoke only read-only query helpers in the same query service.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (queryService && context.getOwningAggregate(target)) {
            accept('error', 'A query service must not invoke aggregate methods.', {
                node: invocation,
                property: 'targets'
            });
        }
        if (applicationService && targetAggregate && !context.isAggregateRootMethod(target, targetAggregate) && !isAssociatedFactoryMethod) {
            accept('error', 'An application service may invoke only aggregate-root behavior or a factory method that creates an aggregate root.', {
                node: invocation,
                property: 'targets'
            });
        }
    }
}
