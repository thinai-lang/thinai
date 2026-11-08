import { GrammarUtils, type CstNode, type LangiumDocument } from 'langium';
import type {
    CancellationToken,
    DocumentLink,
    DocumentLinkParams,
    Range
} from 'vscode-languageserver';
import type { DocumentLinkProvider } from 'langium/lsp';
import { isModel } from './generated/ast.js';
import { resolveImportUri } from './thinai-scope-utils.js';

/** Makes import paths clickable in editors that support document links. */
export class ThinaiDocumentLinkProvider implements DocumentLinkProvider {
    getDocumentLinks(
        document: LangiumDocument,
        _params: DocumentLinkParams,
        _cancelToken?: CancellationToken
    ): DocumentLink[] {
        const root = document.parseResult.value;
        if (!isModel(root)) {
            return [];
        }
        const links: DocumentLink[] = [];
        for (const declaration of root.imports) {
            const pathNode = GrammarUtils.findNodeForProperty(declaration.$cstNode, 'path');
            if (!pathNode) {
                continue;
            }
            const target = resolveImportUri(document, declaration);
            links.push({
                range: importPathRange(document, pathNode),
                target: target?.toString(),
                tooltip: typeof declaration.path === 'string' && declaration.path.length > 0
                    ? `Open ${declaration.path}`
                    : undefined
            });
        }
        return links;
    }
}

/** The link covers the path text, not its quote delimiters. */
export function importPathRange(document: LangiumDocument, node: CstNode): Range {
    const text = node.text;
    const delimiter = text.startsWith('"""')
        ? '"""'
        : text.startsWith('"') || text.startsWith("'")
            ? text[0]!
            : '';
    const start = node.offset + delimiter.length;
    const end = Math.max(start, node.end - (text.endsWith(delimiter) ? delimiter.length : 0));
    return {
        start: document.textDocument.positionAt(start),
        end: document.textDocument.positionAt(end)
    };
}
