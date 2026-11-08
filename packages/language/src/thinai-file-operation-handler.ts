import {
    GrammarUtils,
    URI,
    UriUtils
} from 'langium';
import type { FileOperationHandler, LangiumSharedServices } from 'langium/lsp';
import type {
    FileOperationOptions,
    RenameFilesParams,
    TextEdit,
    WorkspaceEdit
} from 'vscode-languageserver';
import { isModel } from './generated/ast.js';
import { importPathRange } from './thinai-document-link-provider.js';
import { resolveImportUri, toImportPath } from './thinai-scope-utils.js';

interface RenameMapping {
    oldUri: URI;
    newUri: URI;
}

const thinaiFileFilter = [{ scheme: 'file', pattern: { glob: '**/*' } }];

/** Updates relative Thinai import paths when files or folders are renamed. */
export class ThinaiFileOperationHandler implements FileOperationHandler {
    readonly fileOperationOptions: FileOperationOptions = {
        willRename: { filters: thinaiFileFilter }
    };

    constructor(private readonly services: LangiumSharedServices) {}

    async willRenameFiles(params: RenameFilesParams): Promise<WorkspaceEdit | null> {
        const mappings: RenameMapping[] = params.files.map((file: RenameFilesParams['files'][number]) => ({
            oldUri: URI.parse(file.oldUri),
            newUri: URI.parse(file.newUri)
        }));
        if (mappings.length === 0) {
            return null;
        }

        const documents = this.services.workspace.LangiumDocuments;
        const changes: Record<string, TextEdit[]> = {};
        for (const document of documents.all.toArray()) {
            const root = document.parseResult.value;
            if (!isModel(root)) {
                continue;
            }
            for (const declaration of root.imports) {
                if (typeof declaration.path !== 'string' || declaration.path.length === 0) {
                    continue;
                }
                const resolved = resolveImportUri(document, declaration);
                if (!resolved) {
                    continue;
                }
                const renamed = renameTarget(resolved, mappings);
                if (!renamed) {
                    continue;
                }
                const newPath = toImportPath(UriUtils.dirname(document.uri), renamed);
                if (newPath === declaration.path) {
                    continue;
                }
                const pathNode = GrammarUtils.findNodeForProperty(declaration.$cstNode, 'path');
                if (!pathNode) {
                    continue;
                }
                const uri = document.uri.toString();
                const edit = {
                    range: importPathRange(document, pathNode),
                    newText: newPath
                };
                (changes[uri] ??= []).push(edit);
            }
        }

        return Object.keys(changes).length > 0 ? { changes } : null;
    }
}

function renameTarget(uri: URI, mappings: RenameMapping[]): URI | undefined {
    const source = uri.toString();
    for (const { oldUri, newUri } of mappings) {
        const old = oldUri.toString();
        if (source === old) {
            return newUri;
        }
        const prefix = `${old}/`;
        if (source.startsWith(prefix)) {
            return URI.parse(`${newUri.toString()}${source.slice(old.length)}`);
        }
    }
    return undefined;
}
