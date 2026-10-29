import {
    Cancellation,
    DefaultDocumentBuilder,
    DocumentState,
    type LangiumDocument,
    URI,
    UriUtils
} from 'langium';
import { isModel } from './generated/ast.js';
import { resolveImportUri } from './thinai-scope-utils.js';

export class ThinaiDocumentBuilder extends DefaultDocumentBuilder {
    protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
        if (super.shouldRelink(document, changedUris)) {
            return true;
        }

        const model = document.parseResult.value;
        return isModel(model) && model.imports.some(importDeclaration => {
            const uri = resolveImportUri(document, importDeclaration);
            return uri !== undefined && changedUris.has(uri.toString());
        });
    }

    /**
     * Thinai validation is not strictly local to a document: duplicate declaration
     * checks use the whole import-connected model, and shape checks can traverse
     * declarations through several imported files. A change must therefore
     * invalidate the complete undirected import component, not just the
     * documents that directly reference the changed URI.
     *
     * Langium's default invalidation is reference-based, while Thinai's import
     * edges are path literals. We build the import graph with the same
     * `resolveImportUri` helper used by scoping and validation, and use the
     * document builder's own state transitions to rebuild the affected component.
     */
    override async update(
        changed: URI[],
        deleted: URI[],
        cancelToken: Cancellation.CancellationToken = Cancellation.CancellationToken.None
    ): Promise<void> {
        await this.invalidateImportComponents(changed, deleted);
        await super.update(changed, deleted, cancelToken);
    }

    private async invalidateImportComponents(changed: URI[], deleted: URI[]): Promise<void> {
        const expandedChanged = (await Promise.all(changed.map(uri => this.findChangedUris(uri)))).flat();
        const changedKeys = new Set(expandedChanged.map(uri => uri.toString()));
        const deletedKeys = this.collectDeletedKeys(deleted);
        if (changedKeys.size === 0 && deletedKeys.size === 0) {
            return;
        }

        const adjacency = this.createImportAdjacency();
        // Changed documents may have new imports that are not visible in their
        // previous parse result. Add the edges from their new content so that
        // newly imported documents are invalidated as well.
        for (const uri of expandedChanged) {
            const document = await this.getChangedDocument(uri);
            if (document) {
                this.addImportEdges(adjacency, uri.toString(), document);
            }
        }

        const component = new Set<string>();
        const pending = [...changedKeys, ...deletedKeys];
        while (pending.length > 0) {
            const key = pending.pop()!;
            if (component.has(key)) {
                continue;
            }
            component.add(key);
            for (const next of adjacency.get(key) ?? []) {
                if (!component.has(next)) {
                    pending.push(next);
                }
            }
        }

        for (const key of component) {
            const document = this.langiumDocuments.getDocument(URI.parse(key));
            if (document) {
                this.resetToState(document, DocumentState.ComputedScopes);
            }
        }
    }

    private createImportAdjacency(): Map<string, Set<string>> {
        const adjacency = new Map<string, Set<string>>();
        const connect = (left: string, right: string): void => {
            const leftSet = adjacency.get(left) ?? new Set<string>();
            leftSet.add(right);
            adjacency.set(left, leftSet);
            const rightSet = adjacency.get(right) ?? new Set<string>();
            rightSet.add(left);
            adjacency.set(right, rightSet);
        };

        for (const document of this.langiumDocuments.all) {
            const key = document.uri.toString();
            adjacency.set(key, adjacency.get(key) ?? new Set());
            const model = document.parseResult.value;
            if (!isModel(model)) {
                continue;
            }
            for (const importDeclaration of model.imports) {
                const importedUri = resolveImportUri(document, importDeclaration);
                if (importedUri) {
                    connect(key, importedUri.toString());
                }
            }
        }
        return adjacency;
    }

    private addImportEdges(
        adjacency: Map<string, Set<string>>,
        key: string,
        document: LangiumDocument
    ): void {
        adjacency.set(key, adjacency.get(key) ?? new Set());
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return;
        }
        for (const importDeclaration of model.imports) {
            const importedUri = resolveImportUri(document, importDeclaration);
            if (!importedUri) {
                continue;
            }
            const importedKey = importedUri.toString();
            adjacency.get(key)?.add(importedKey);
            const importedSet = adjacency.get(importedKey) ?? new Set<string>();
            importedSet.add(key);
            adjacency.set(importedKey, importedSet);
        }
    }

    private async getChangedDocument(uri: URI): Promise<LangiumDocument | undefined> {
        if (UriUtils.extname(uri) !== '.tni') {
            return undefined;
        }
        try {
            const textDocument = this.textDocuments?.get(uri);
            if (textDocument) {
                return this.langiumDocumentFactory.fromString(textDocument.getText(), uri);
            }
            return await this.langiumDocumentFactory.fromUri(uri);
        } catch {
            // In-memory test file systems and unsaved documents may not expose
            // the new content through a file system. Fall back to the document
            // the workspace already knows about.
            return this.langiumDocuments.getDocument(uri);
        }
    }

    private collectDeletedKeys(deleted: URI[]): Set<string> {
        const keys = new Set<string>();
        for (const uri of deleted) {
            for (const document of this.langiumDocuments.all) {
                if (UriUtils.equals(document.uri, uri) || UriUtils.contains(uri, document.uri)) {
                    keys.add(document.uri.toString());
                }
            }
        }
        return keys;
    }
}
