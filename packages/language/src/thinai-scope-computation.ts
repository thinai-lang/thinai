import { AstUtils, DefaultScopeComputation, type AstNode, type AstNodeDescription, type LangiumDocument } from 'langium';
import type { CancellationToken } from 'vscode-jsonrpc';
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
        const referenceText = owner.context.$refText;
        const root = AstUtils.getDocument(owner).parseResult.value;
        if (isModel(root)) {
            const selectedComponent = root.imports
                .flatMap(importDeclaration => importDeclaration.components)
                .find(component => component.alias?.$refText === referenceText);
            if (selectedComponent) {
                return selectedComponent.component.$refText;
            }
        }
        return referenceText;
    }
    return undefined;
}

export class ThinaiScopeComputation extends DefaultScopeComputation {
    override async collectExportedSymbols(
        document: LangiumDocument,
        _cancelToken?: CancellationToken
    ): Promise<AstNodeDescription[]> {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }
        const exports: AstNodeDescription[] = [];
        for (const node of AstUtils.streamAst(root)) {
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
