import type { AstNode } from 'langium';
import { AbstractSemanticTokenProvider, type SemanticTokenAcceptor } from 'langium/lsp';
import { SemanticTokenTypes } from 'vscode-languageserver';
import { isBehaviorSpecificationTextPart, isField, isMethod } from './generated/ast.js';
import type { ThinaiServices } from './thinai-module.js';

export class ThinaiSemanticTokenProvider extends AbstractSemanticTokenProvider {
    constructor(services: ThinaiServices) {
        super(services);
    }

    protected override highlightElement(node: AstNode, acceptor: SemanticTokenAcceptor): void {
        if (!isBehaviorSpecificationTextPart(node)) {
            return;
        }

        const target = node.target?.ref;
        const referenceNode = node.target?.$refNode;
        const textDocument = this.currentDocument?.textDocument;
        if (!referenceNode || !textDocument) {
            return;
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
