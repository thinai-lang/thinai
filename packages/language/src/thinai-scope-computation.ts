import {
    AstUtils,
    Cancellation,
    DefaultScopeComputation,
    interruptAndCheck,
    type AstNode,
    type AstNodeDescription,
    type LangiumDocument
} from 'langium';
import {
    isBoundedContext,
    isBoundedContextPart,
    isModel,
    isSharedKernel,
    type BoundedContext,
    type BoundedContextPart,
    type SharedKernel
} from './generated/ast.js';
import { getDeclarationPath, isNamedExport } from './thinai-scope-utils.js';

function getContextNameForIndexing(node: AstNode): string | undefined {
    const owner = AstUtils.getContainerOfType(node,
        (candidate): candidate is BoundedContext | BoundedContextPart | SharedKernel =>
            isBoundedContext(candidate) || isBoundedContextPart(candidate) || isSharedKernel(candidate)
    );
    if (isBoundedContext(owner) || isSharedKernel(owner)) {
        return owner.name;
    }
    if (isBoundedContextPart(owner)) {
        const referenceText = owner.context?.$refText ?? '';
        const root = AstUtils.getDocument(owner).parseResult.value;
        if (isModel(root)) {
            // Local canonical declarations shadow aliased imports. References
            // are not linked while the index is built, so match by name here.
            if (root.declarations.some(declaration =>
                isBoundedContext(declaration) && declaration.name === referenceText)) {
                return referenceText;
            }
            const selectedComponent = root.imports
                .flatMap(importDeclaration => importDeclaration.components)
                .find(component => component.alias === referenceText);
            if (selectedComponent) {
                return selectedComponent.component.$refText;
            }
        }
        return referenceText || undefined;
    }
    return undefined;
}

export class ThinaiScopeComputation extends DefaultScopeComputation {
    override async collectExportedSymbols(
        document: LangiumDocument,
        cancelToken?: Cancellation.CancellationToken
    ): Promise<AstNodeDescription[]> {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const exports: AstNodeDescription[] = [];
        const token = cancelToken ?? Cancellation.CancellationToken.None;
        for (const node of AstUtils.streamAst(root)) {
            await interruptAndCheck(token);
            if (!isNamedExport(node)) {
                continue;
            }
            const contextName = getContextNameForIndexing(node);
            const path = getDeclarationPath(node);
            const name = contextName ? [contextName, ...path].join('.') : path.join('.');
            if (name) {
                exports.push(this.descriptions.createDescription(node, name, document));
            }
        }
        return exports;
    }
}
