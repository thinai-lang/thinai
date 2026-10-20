import { AstUtils, type AstNode } from 'langium';
import {
    isJourneyStep,
    isSpecificationText
} from './generated/ast.js';
import type { JourneySpecificationKind } from './thinai-journey-timeline.js';

/** True when a specification part belongs to a journey step's with/when prose. */
export function isJourneySpecificationText(node: AstNode): boolean {
    return AstUtils.getContainerOfType(node, isJourneyStep) !== undefined;
}

/** Returns whether a journey specification is the `with` or `when` clause. */
export function getJourneySpecificationKind(node: AstNode): JourneySpecificationKind | undefined {
    const specification = AstUtils.getContainerOfType(node, isSpecificationText);
    if (!specification) {
        return undefined;
    }
    if (specification.$containerProperty === 'arguments') {
        return 'with';
    }
    if (specification.$containerProperty === 'guard') {
        return 'when';
    }
    return undefined;
}
