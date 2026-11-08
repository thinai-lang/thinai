import { CstUtils, type AstNode, type LangiumDocument } from 'langium';
import { DefaultRenameProvider } from 'langium/lsp';
import type { CancellationToken } from 'vscode-jsonrpc';
import {
    ErrorCodes,
    ResponseError,
    type Position,
    type RenameParams,
    type WorkspaceEdit
} from 'vscode-languageserver';
import { formatIdentifier } from './thinai-scope-utils.js';
import { unquoteIdentifier } from './thinai-identifiers.js';

/**
 * Rename uses Langium's reference index for the actual workspace edit and adds
 * Thinai-specific name validation, quoting, and sibling-collision checks.
 */
export class ThinaiRenameProvider extends DefaultRenameProvider {
    override async rename(
        document: LangiumDocument,
        params: RenameParams,
        cancelToken?: CancellationToken
    ): Promise<WorkspaceEdit | undefined> {
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
