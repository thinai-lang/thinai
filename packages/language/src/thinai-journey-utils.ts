import { AstUtils, type AstNode } from 'langium';
import {
    isApplicationService,
    isBoundedContext,
    isContextMap,
    isDataObject,
    isEnumType,
    isEnumValue,
    isField,
    isIntegrationEvent,
    isJourneyStep,
    isMethod,
    isModule,
    isParameter,
    isQueryRepository,
    isQueryService,
    isReadModel,
    isSharedKernel,
    isValueObject
} from './generated/ast.js';

/** True when a specification part belongs to a journey step's with/when prose. */
export function isJourneySpecificationText(node: AstNode): boolean {
    return AstUtils.getContainerOfType(node, isJourneyStep) !== undefined;
}

/**
 * Journeys cross bounded contexts by design. Their prose may link read/query
 * values, public contracts, and user-facing operations from imported files, but
 * not private aggregate or domain-event internals.
 */
export function isAllowedJourneySpecificationTarget(target: AstNode): boolean {
    if (isField(target)) {
        const owner = target.$container;
        return isValueObject(owner) || isDataObject(owner) || isReadModel(owner) || isIntegrationEvent(owner);
    }
    if (isEnumValue(target) || isEnumType(target) || isValueObject(target) || isDataObject(target) ||
        isReadModel(target) || isIntegrationEvent(target) || isParameter(target)) {
        return true;
    }
    if (isMethod(target)) {
        return isQueryService(target.$container) || isApplicationService(target.$container);
    }
    return isApplicationService(target) || isBoundedContext(target) || isContextMap(target) ||
        isModule(target) || isQueryRepository(target) || isQueryService(target) || isSharedKernel(target);
}
