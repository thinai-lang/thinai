import {
    type LangiumDocument,
    URI,
    UriUtils
} from 'langium';
import { DefaultCompletionProvider } from 'langium/lsp';
import {
    CompletionItemKind,
    type CompletionList,
    type CompletionParams,
    type Position,
    type TextEdit
} from 'vscode-languageserver';
import type { CancellationToken } from 'vscode-jsonrpc';
import type { ThinaiServices } from './thinai-module.js';

export class ThinaiCompletionProvider extends DefaultCompletionProvider {
    override readonly completionOptions = {
        triggerCharacters: ['"', '/', '.']
    };

    private readonly thinaiServices: ThinaiServices;

    constructor(services: ThinaiServices) {
        super(services);
        this.thinaiServices = services;
    }

    override async getCompletion(
        document: LangiumDocument,
        params: CompletionParams,
        cancelToken?: CancellationToken
    ): Promise<CompletionList | undefined> {
        const defaultCompletion = await super.getCompletion(document, params, cancelToken);
        const importContext = this.getImportPathContext(document, params.position);
        if (!importContext) {
            return defaultCompletion;
        }

        const importItems = await this.getImportPathCompletions(document, importContext.path, importContext.pathStart);
        return {
            isIncomplete: defaultCompletion?.isIncomplete ?? false,
            items: [...(defaultCompletion?.items ?? []), ...importItems]
        };
    }

    private getImportPathContext(document: LangiumDocument, position: Position): {
        path: string;
        pathStart: number;
    } | undefined {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const prefix = text.slice(lineStart, offset);
        const match = /^\s*import\s+(["'])([^"']*)$/.exec(prefix);
        if (!match) {
            return undefined;
        }

        return {
            path: match[2],
            pathStart: offset - match[2].length
        };
    }

    private async getImportPathCompletions(
        document: LangiumDocument,
        typedPath: string,
        pathStart: number
    ): Promise<Array<{ label: string; kind: CompletionItemKind; textEdit: TextEdit; detail: string }>> {
        const files = new Map<string, URI>();
        for (const knownDocument of this.thinaiServices.shared.workspace.LangiumDocuments.all) {
            if (UriUtils.extname(knownDocument.uri) === '.tni') {
                files.set(knownDocument.uri.toString(), knownDocument.uri);
            }
        }

        for (const folder of this.thinaiServices.shared.workspace.WorkspaceManager.workspaceFolders ?? []) {
            const folderUri = URI.parse(folder.uri);
            for (const uri of await this.thinaiServices.shared.workspace.WorkspaceManager.searchFolder(folderUri)) {
                if (UriUtils.extname(uri) === '.tni') {
                    files.set(uri.toString(), uri);
                }
            }
        }

        const currentDirectory = UriUtils.dirname(document.uri);
        const items = [] as Array<{ label: string; kind: CompletionItemKind; textEdit: TextEdit; detail: string }>;
        for (const uri of files.values()) {
            if (UriUtils.equals(uri, document.uri)) {
                continue;
            }

            const relativePath = this.toImportPath(currentDirectory, uri);
            if (!relativePath.startsWith(typedPath)) {
                continue;
            }

            items.push({
                label: relativePath,
                kind: CompletionItemKind.File,
                textEdit: {
                    range: {
                        start: document.textDocument.positionAt(pathStart),
                        end: document.textDocument.positionAt(pathStart + typedPath.length)
                    },
                    newText: relativePath
                },
                detail: 'Thinai import'
            });
        }
        return items;
    }

    private toImportPath(currentDirectory: URI, target: URI): string {
        const relativePath = UriUtils.relative(currentDirectory, target);
        return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
    }
}
