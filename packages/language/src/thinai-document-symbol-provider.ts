import type { AstNode, LangiumDocument } from 'langium';
import { DefaultDocumentSymbolProvider } from 'langium/lsp';
import { SymbolKind, type DocumentSymbol } from 'vscode-languageserver';
import { isBoundedContextPart } from './generated/ast.js';

export class ThinaiDocumentSymbolProvider extends DefaultDocumentSymbolProvider {
    protected override getSymbol(document: LangiumDocument, astNode: AstNode): DocumentSymbol[] {
        if (isBoundedContextPart(astNode) && astNode.$cstNode) {
            const nameNode = astNode.context?.$refNode;
            const name = astNode.context?.ref?.name ?? astNode.context?.$refText;
            if (nameNode && name) {
                return [{
                    kind: SymbolKind.Namespace,
                    name,
                    range: astNode.$cstNode.range,
                    selectionRange: nameNode.range,
                    children: this.getChildSymbols(document, astNode)
                }];
            }
        }
        return super.getSymbol(document, astNode);
    }
}
