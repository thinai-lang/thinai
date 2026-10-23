import { AstUtils, GrammarUtils, type AstNode, type LangiumDocument } from 'langium';
import { DefaultDefinitionProvider } from 'langium/lsp';
import { LocationLink, type DefinitionParams } from 'vscode-languageserver';
import { isImport, isModel } from './generated/ast.js';
import type { ThinaiServices } from './thinai-module.js';
import { resolveImportUri } from './thinai-scope-utils.js';

/**
 * Uses Langium's normal reference navigation for AST cross-references and adds
 * a definition link for import path literals.
 */
export class ThinaiDefinitionProvider extends DefaultDefinitionProvider {
    constructor(services: ThinaiServices) {
        super(services);
    }

    override getDefinition(document: LangiumDocument, params: DefinitionParams) {
        const root = document.parseResult.value;
        const offset = document.textDocument.offsetAt(params.position);
        const aliasLink = this.getImportAliasLink(document, root, offset);
        if (aliasLink) {
            return [aliasLink];
        }
        const importPathLink = this.getImportPathLink(document, root, offset);
        return importPathLink ? [importPathLink] : super.getDefinition(document, params);
    }

    private getImportAliasLink(document: LangiumDocument, root: AstNode, offset: number) {
        if (!isModel(root)) {
            return undefined;
        }
        for (const importDeclaration of root.imports) {
            for (const component of importDeclaration.components) {
                const aliasNode = component.$cstNode
                    ? GrammarUtils.findNodeForProperty(component.$cstNode, 'alias')
                    : undefined;
                if (!aliasNode || offset < aliasNode.offset || offset > aliasNode.end) {
                    continue;
                }
                const target = component.component.ref;
                const targetName = target ? this.nameProvider.getNameNode(target) : undefined;
                if (!target || !targetName) {
                    return undefined;
                }
                return LocationLink.create(
                    AstUtils.getDocument(target).uri.toString(),
                    targetName.range,
                    targetName.range,
                    aliasNode.range
                );
            }
        }
        return undefined;
    }

    private getImportPathLink(document: LangiumDocument, root: AstNode, offset: number) {
        if (!isModel(root)) {
            return undefined;
        }
        for (const importDeclaration of root.imports) {
            if (!isImport(importDeclaration) || !importDeclaration.$cstNode) {
                continue;
            }
            const pathNode = GrammarUtils.findNodeForProperty(importDeclaration.$cstNode, 'path');
            if (!pathNode) {
                continue;
            }
            const pathText = document.textDocument.getText(pathNode.range);
            const delimiter = pathText.startsWith('"""') ? '"""' : pathText[0];
            if (delimiter !== '"' && delimiter !== "'" && delimiter !== '"""') {
                continue;
            }
            const delimiterOffset = pathText.indexOf(delimiter);
            const quoteEnd = pathText.lastIndexOf(delimiter);
            if (quoteEnd <= delimiterOffset) {
                continue;
            }
            const startOffset = pathNode.offset + delimiterOffset + delimiter.length;
            const endOffset = pathNode.offset + quoteEnd;
            if (offset < startOffset || offset >= endOffset) {
                continue;
            }
            const sourceRange = {
                start: document.textDocument.positionAt(startOffset),
                end: document.textDocument.positionAt(endOffset)
            };
            const targetUri = resolveImportUri(document, importDeclaration);
            if (!targetUri) {
                return undefined;
            }
            const fileStart = { line: 0, character: 0 };
            return LocationLink.create(
                targetUri.toString(),
                { start: fileStart, end: fileStart },
                { start: fileStart, end: fileStart },
                sourceRange
            );
        }
        return undefined;
    }

}
