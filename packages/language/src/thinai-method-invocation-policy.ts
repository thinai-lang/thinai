import type { AstNode } from 'langium';
import type { Aggregate, ApplicationService, Method, Parameter, QueryService, SharedKernel } from './generated/ast.js';
import { isApplicationService, isDomainService, isEntity, isFactory, isQueryService } from './generated/ast.js';
import { getReachableMethods, hasBehaviorSideEffects } from './thinai-operation-utils.js';
import { getOwningModule, isExposedByModule } from './thinai-scope-utils.js';

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

type MethodInvocationPolicyContext = Omit<MethodInvocationValidationContext, 'isSyntacticallyComplete'>;

/** Shared invocation eligibility rules used by both validation and reference completion. */
export function getMethodInvocationViolations(
    method: Method,
    target: Method,
    applicationService: ApplicationService | undefined,
    queryService: QueryService | undefined,
    eventParameters: Parameter[],
    context: MethodInvocationPolicyContext
): string[] {
    const violations: string[] = [];
    const targetSharedKernel = context.getOwningSharedKernel(target);
    const targetSharedKernelModule = getOwningModule(target);
    const allowedSharedKernelService = targetSharedKernel !== undefined && isDomainService(target.$container) &&
        (targetSharedKernelModule === undefined || isExposedByModule(targetSharedKernelModule, target)) &&
        (applicationService !== undefined || isDomainService(method.$container)) &&
        context.hasVisibleSharedKernel(method, targetSharedKernel) &&
        context.hasSharedKernelRelationship(method, targetSharedKernel);
    if (context.isCrossContextOwned(method, target) && !allowedSharedKernelService) {
        violations.push('A method may invoke across bounded-context boundaries only through an authorized shared-kernel domain service.');
    }
    if (target.parameters.some(context.isEventParameter)) {
        violations.push('An event-triggered method cannot be invoked directly; invoke an ordinary command method instead.');
    }
    if (isApplicationService(target.$container) && !applicationService) {
        violations.push('Domain behavior cannot invoke an application-service method.');
    }
    const reachable = getReachableMethods(target);
    if (!applicationService && !isApplicationService(target.$container) &&
        reachable.some(candidate => isApplicationService(candidate.$container))) {
        violations.push('Domain behavior cannot transitively invoke an application-service method.');
    }
    const targetAggregate = context.getOwningAggregate(target);
    const targetIsAggregateRoot = targetAggregate !== undefined && context.isAggregateRootMethod(target, targetAggregate);
    const sourceAggregate = context.getOwningAggregate(method);
    if (isDomainService(method.$container) && (targetAggregate !== undefined || reachable.some(candidate =>
        context.getOwningAggregate(candidate) !== undefined
    ))) {
        violations.push('A domain service must not invoke aggregate-owned methods; application services should invoke aggregate roots directly.');
    }
    if (isDomainService(method.$container) && !isDomainService(target.$container) &&
        !isApplicationService(target.$container) && targetAggregate === undefined &&
        !reachable.some(candidate => context.getOwningAggregate(candidate) !== undefined) &&
        !target.parameters.some(context.isEventParameter)) {
        violations.push('A domain service may invoke only another domain service.');
    }
    if (sourceAggregate && (isDomainService(target.$container) || reachable.some(candidate =>
        isDomainService(candidate.$container)
    ))) {
        violations.push('Aggregate-owned methods must not invoke domain services, directly or transitively; application services coordinate both.');
    }
    if (applicationService && !isApplicationService(target.$container) &&
        (reachable.some(candidate => isApplicationService(candidate.$container)) ||
            (!targetIsAggregateRoot && reachable.some(candidate => context.getOwningAggregate(candidate) !== undefined)))) {
        violations.push('Application services must invoke aggregate-root behavior directly, not through another method call chain.');
    }
    if (isFactory(target.$container) && !applicationService && !isDomainService(method.$container)) {
        violations.push('Only an application service may invoke a factory method.');
    }
    if (isQueryService(target.$container) && !queryService) {
        violations.push('Only a query service may invoke a query-service method.');
    }
    const targetFactory = isFactory(target.$container) ? target.$container : undefined;
    const factoryReturnType = target.returnType?.ref;
    const isAssociatedFactoryMethod = applicationService !== undefined && targetFactory !== undefined &&
        isEntity(factoryReturnType) && factoryReturnType.root && context.getOwningAggregate(factoryReturnType) !== undefined;
    if (targetAggregate && !context.isAggregateRootMethod(target, targetAggregate) &&
        !isEntity(method.$container) && !isAssociatedFactoryMethod) {
        violations.push('Only entity behavior may invoke child-entity methods; aggregate-root behavior must coordinate aggregate changes.');
    }
    if (sourceAggregate && targetAggregate && targetAggregate !== sourceAggregate) {
        violations.push('Domain behavior must not invoke another aggregate directly.');
    }
    if (!applicationService && sourceAggregate && reachable.some(candidate => {
        const candidateAggregate = context.getOwningAggregate(candidate);
        return candidateAggregate !== undefined && candidateAggregate !== sourceAggregate;
    })) {
        violations.push('Domain behavior must not transitively invoke another aggregate.');
    }
    if (applicationService && isApplicationService(target.$container) && target.$container !== applicationService &&
        (eventParameters.length !== 1 || target.parameters.some(context.isEventParameter))) {
        violations.push('Only an event handler may dispatch to a command in another application service.');
    }
    if (queryService && (target.$container !== queryService || hasBehaviorSideEffects(target))) {
        violations.push('A query service may invoke only read-only query helpers in the same query service.');
    }
    if (queryService && context.getOwningAggregate(target)) {
        violations.push('A query service must not invoke aggregate methods.');
    }
    if (applicationService && targetAggregate && !context.isAggregateRootMethod(target, targetAggregate) && !isAssociatedFactoryMethod) {
        violations.push('An application service may invoke only aggregate-root behavior or a factory method that creates an aggregate root.');
    }
    return violations;
}
