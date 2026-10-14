import { type LangiumDocument, URI, UriUtils } from 'langium';
import { CompletionItemKind, type CompletionItem } from 'vscode-languageserver';
import type { ThinaiServices } from './thinai-module.js';
import { toImportPath } from './thinai-scope-utils.js';

export interface ImportPathContext {
    path: string;
    pathStart: number;
}

/** Workspace file discovery and text edits for import-path completion. */
export class ThinaiImportCompletion {
    private readonly folderSearchCache = new Map<string, Promise<URI[]>>();
    private readonly cachedFileUris = new Set<string>();
    private workspaceFolderKeys = new Set<string>();

    constructor(private readonly services: ThinaiServices) {
        services.shared.workspace.DocumentBuilder.onUpdate((changed, deleted) => {
            let invalidate = false;
            for (const uri of deleted) {
                const key = uri.toString();
                if (this.cachedFileUris.delete(key)) {
                    invalidate = true;
                }
            }
            for (const uri of changed) {
                if (UriUtils.extname(uri) === '.tni' && !this.cachedFileUris.has(uri.toString())) {
                    this.cachedFileUris.add(uri.toString());
                    invalidate = true;
                }
            }
            if (invalidate) {
                this.folderSearchCache.clear();
            }
        });
    }

    getPathContext(document: LangiumDocument, position: import('vscode-languageserver').Position): ImportPathContext | undefined {
        const offset = document.textDocument.offsetAt(position);
        const text = document.textDocument.getText();
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const prefix = text.slice(lineStart, offset);
        const match = /^\s*import\s+"([^"]*)$/.exec(prefix) ?? /^\s*import\s+'([^']*)$/.exec(prefix);
        if (!match) {
            return undefined;
        }
        const path = match[1]!;
        return { path, pathStart: offset - path.length };
    }

    async getCompletions(
        document: LangiumDocument,
        typedPath: string,
        pathStart: number
    ): Promise<CompletionItem[]> {
        const files = new Map<string, URI>();
        for (const knownDocument of this.services.shared.workspace.LangiumDocuments.all) {
            if (UriUtils.extname(knownDocument.uri) === '.tni') {
                files.set(knownDocument.uri.toString(), knownDocument.uri);
                this.cachedFileUris.add(knownDocument.uri.toString());
            }
        }

        const folders = this.services.shared.workspace.WorkspaceManager.workspaceFolders ?? [];
        const currentFolderKeys = new Set(folders.map(folder => folder.uri));
        if (!this.areSetsEqual(this.workspaceFolderKeys, currentFolderKeys)) {
            this.workspaceFolderKeys = currentFolderKeys;
            this.folderSearchCache.clear();
            this.cachedFileUris.clear();
            for (const knownDocument of this.services.shared.workspace.LangiumDocuments.all) {
                if (UriUtils.extname(knownDocument.uri) === '.tni') {
                    this.cachedFileUris.add(knownDocument.uri.toString());
                }
            }
        }

        for (const folder of folders) {
            const folderUri = URI.parse(folder.uri);
            for (const uri of await this.getFolderFiles(folderUri)) {
                if (UriUtils.extname(uri) === '.tni') {
                    files.set(uri.toString(), uri);
                }
            }
        }

        const currentDirectory = UriUtils.dirname(document.uri);
        const items: CompletionItem[] = [];
        for (const uri of files.values()) {
            if (UriUtils.equals(uri, document.uri)) {
                continue;
            }
            const relativePath = toImportPath(currentDirectory, uri);
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

    private getFolderFiles(folderUri: URI): Promise<URI[]> {
        const key = folderUri.toString();
        const cached = this.folderSearchCache.get(key);
        if (cached) {
            return cached;
        }
        const search = this.services.shared.workspace.WorkspaceManager.searchFolder(folderUri);
        this.folderSearchCache.set(key, search);
        void search.then(uris => {
            if (this.folderSearchCache.get(key) === search) {
                for (const uri of uris) {
                    if (UriUtils.extname(uri) === '.tni') {
                        this.cachedFileUris.add(uri.toString());
                    }
                }
            }
        }, () => {
            if (this.folderSearchCache.get(key) === search) {
                this.folderSearchCache.delete(key);
            }
        });
        return search;
    }

    private areSetsEqual(left: Set<string>, right: Set<string>): boolean {
        return left.size === right.size && [...left].every(value => right.has(value));
    }

}
