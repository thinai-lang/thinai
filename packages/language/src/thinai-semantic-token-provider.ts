import type { AstNode } from 'langium';
import { AbstractSemanticTokenProvider, type SemanticTokenAcceptor } from 'langium/lsp';
import { SemanticTokenTypes } from 'vscode-languageserver';
import { isSpecificationTextPart, isField, isMethod } from './generated/ast.js';
import type { ThinaiServices } from './thinai-module.js';

export class ThinaiSemanticTokenProvider extends AbstractSemanticTokenProvider {
    constructor(services: ThinaiServices) {
        super(services);
    }

    protected override highlightElement(node: AstNode, acceptor: SemanticTokenAcceptor): void {
        if (!isSpecificationTextPart(node)) {
            return;
        }

        const textDocument = this.currentDocument?.textDocument;
        if (!textDocument) {
            return;
        }

        const references = [node.target, ...node.targets].filter(reference => reference !== undefined);
        for (const reference of references) {
            const target = reference.ref;
            const referenceNode = reference.$refNode;
            if (!referenceNode) {
                continue;
            }
            const referenceRange = {
                start: textDocument.positionAt(referenceNode.offset),
                end: textDocument.positionAt(referenceNode.end)
            };
            if (isMethod(target)) {
                acceptor({ range: referenceRange, type: SemanticTokenTypes.method });
            } else if (isField(target)) {
                acceptor({ range: referenceRange, type: SemanticTokenTypes.property });
            }
        }
    }
}
