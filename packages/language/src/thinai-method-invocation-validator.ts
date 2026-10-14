import type { ValidationAcceptor } from 'langium';
import type { ApplicationService, Method, Parameter, QueryService } from './generated/ast.js';
import { getInvokedMethod } from './thinai-operation-utils.js';
import { getMethodInvocationViolations, type MethodInvocationValidationContext } from './thinai-method-invocation-policy.js';

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
        for (const message of getMethodInvocationViolations(
            method,
            target,
            applicationService,
            queryService,
            eventParameters,
            context
        )) {
            accept('error', message, { node: invocation, property: 'targets' });
        }
    }
}
