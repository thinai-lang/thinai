import {
    AstUtils,
    CstUtils,
    GrammarUtils,
    type AstNode,
    type LangiumDocument,
    isReference
} from 'langium';
import { DefaultRenameProvider } from 'langium/lsp';
import type { CancellationToken } from 'vscode-jsonrpc';
import {
    ErrorCodes,
    ResponseError,
    type Position,
    type Range,
    type RenameParams,
    type TextEdit,
    type WorkspaceEdit
} from 'vscode-languageserver';
import { formatIdentifier } from './thinai-scope-utils.js';
import { unquoteIdentifier } from './thinai-identifiers.js';
import { isModel, type ImportComponent } from './generated/ast.js';

/**
 * Rename uses Langium's reference index for the actual workspace edit and adds
 * Thinai-specific name validation, quoting, and sibling-collision checks.
 */
export class ThinaiRenameProvider extends DefaultRenameProvider {
    override async prepareRename(
        document: LangiumDocument,
        params: import('vscode-languageserver').TextDocumentPositionParams,
        cancelToken?: CancellationToken
    ): Promise<Range | undefined> {
        const alias = this.findAlias(document, params.position);
        if (alias) {
            return alias.range;
        }
        return super.prepareRename(document, params, cancelToken);
    }

    override async rename(
        document: LangiumDocument,
        params: RenameParams,
        cancelToken?: CancellationToken
    ): Promise<WorkspaceEdit | undefined> {
        const alias = this.findAlias(document, params.position);
        if (alias) {
            return this.renameAlias(document, alias, params.newName);
        }
        const target = this.findRenameTarget(document, params.position);
        if (!target) {
            return undefined;
        }
        const newName = this.validateNewName(params.newName);
        if (this.hasNamedSibling(target, newName)) {
            throw new ResponseError(
                ErrorCodes.InvalidParams,
                `A declaration named '${newName}' already exists in this container.`
            );
        }
        return super.rename(document, {
            ...params,
            // Reserved words, spaces, and hyphens need backticks in Thinai.
            newName: formatIdentifier(newName)
        }, cancelToken);
    }

    private findAlias(document: LangiumDocument, position: Position): {
        component: ImportComponent;
        name: string;
        range: Range;
    } | undefined {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(position);
        for (const importDeclaration of model.imports) {
            for (const component of importDeclaration.components) {
                const aliasNode = GrammarUtils.findNodeForProperty(component.$cstNode, 'alias');
                if (aliasNode && aliasNode.offset <= offset && offset <= aliasNode.end) {
                    return { component, name: component.alias ?? '', range: aliasNode.range };
                }
            }
        }
        for (const node of AstUtils.streamAst(model)) {
            for (const info of AstUtils.streamReferences(node)) {
                const reference = info.reference;
                const referenceNode = reference.$refNode;
                if (!isReference(reference) || !referenceNode ||
                    !(referenceNode.offset <= offset && offset <= referenceNode.end) ||
                    reference.$refText.length === 0) {
                    continue;
                }
                const component = model.imports.flatMap(declaration => declaration.components)
                    .find(candidate => candidate.alias === reference.$refText &&
                        candidate.component.ref === reference.ref);
                if (component) {
                    return { component, name: reference.$refText, range: referenceNode.range };
                }
            }
        }
        return undefined;
    }

    private renameAlias(
        document: LangiumDocument,
        alias: { component: ImportComponent; name: string },
        input: string
    ): WorkspaceEdit | undefined {
        const name = this.validateNewName(input);
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return undefined;
        }
        const collision = model.imports.flatMap(declaration => declaration.components)
            .some(component => component !== alias.component &&
                (component.alias ?? component.component.$refText) === name) ||
            AstUtils.streamAst(model).some(node => isNamedNode(node) && node.name === name);
        if (collision) {
            throw new ResponseError(
                ErrorCodes.InvalidParams,
                `A declaration or alias named '${name}' already exists in this document.`
            );
        }

        const edits = new Map<string, TextEdit>();
        const addEdit = (range: Range): void => {
            const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
            edits.set(key, { range, newText: formatIdentifier(name) });
        };
        const aliasNode = GrammarUtils.findNodeForProperty(alias.component.$cstNode, 'alias');
        if (aliasNode) {
            addEdit(aliasNode.range);
        }
        for (const node of AstUtils.streamAst(model)) {
            for (const info of AstUtils.streamReferences(node)) {
                const reference = info.reference;
                const referenceNode = reference.$refNode;
                if (isReference(reference) && referenceNode &&
                    reference.$refText === alias.name &&
                    reference.ref === alias.component.component.ref) {
                    addEdit(referenceNode.range);
                }
            }
        }
        return edits.size > 0
            ? { changes: { [document.uri.toString()]: [...edits.values()] } }
            : undefined;
    }

    private findRenameTarget(document: LangiumDocument, position: Position): AstNode | undefined {
        const root = document.parseResult.value.$cstNode;
        if (!root) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(position);
        const leaf = CstUtils.findDeclarationNodeAtOffset(root, offset, this.grammarConfig.nameRegexp);
        if (!leaf) {
            return undefined;
        }
        return this.references.findDeclarations(leaf)[0];
    }

    private validateNewName(input: string): string {
        // Accept names entered with backticks and normalize them before quoting.
        const name = unquoteIdentifier(input.trim()).trim();
        if (name.length === 0) {
            throw new ResponseError(ErrorCodes.InvalidParams, 'The new name must not be empty.');
        }
        const plainIdentifier = /^[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(name);
        const quotedIdentifier = /^[\p{ID_Continue} _-]+$/u.test(name);
        if (!plainIdentifier && !quotedIdentifier) {
            throw new ResponseError(
                ErrorCodes.InvalidParams,
                `'${name}' is not a valid Thinai identifier.`
            );
        }
        return name;
    }

    private hasNamedSibling(target: AstNode, name: string): boolean {
        const container = target.$container as (AstNode & Record<string, unknown>) | undefined;
        if (!container) {
            return false;
        }
        for (const [property, value] of Object.entries(container)) {
            if (property.startsWith('$')) {
                continue;
            }
            if (Array.isArray(value)) {
                if (value.some(item => item !== target && isNamedNode(item) && item.name === name)) {
                    return true;
                }
            } else if (value !== target && isNamedNode(value) && value.name === name) {
                return true;
            }
        }
        return false;
    }
}

function isNamedNode(value: unknown): value is AstNode & { name: string } {
    return typeof value === 'object' && value !== null &&
        'name' in value && typeof (value as { name?: unknown }).name === 'string';
}
