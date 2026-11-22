import {
    DocumentState,
    type AstNodeDescription,
    type LangiumCoreServices,
    type LangiumDocument
} from 'langium';
import type { BoundedContext, Model } from './generated/ast.js';
import { isBoundedContext, isBoundedContextPart, isModel } from './generated/ast.js';
import { resolveImportUri } from './thinai-scope-utils.js';

/**
 * Resolves which documents form one bounded-context model unit.
 *
 * A root document declares canonical bounded contexts and directly imports the
 * part documents that contribute to them. Parts never import the root or each
 * other. An imported root expands the unit for external consumers, but a
 * part's own external imports stay local to that part.
 */
export class ThinaiModelUnitIndex {
    private roots = new Map<string, LangiumDocument>();
    private rootContexts = new Map<string, Map<string, BoundedContext>>();
    private partContextNames = new Map<string, string[]>();
    private rootsByPart = new Map<string, Map<string, LangiumDocument[]>>();
    private partsByRoot = new Map<string, Map<string, LangiumDocument[]>>();
    private unitSymbolsCache = new Map<string, AstNodeDescription[]>();
    private built = false;

    constructor(private readonly services: LangiumCoreServices) {
        const clear = () => this.clearCache();
        services.shared.workspace.DocumentBuilder.onUpdate(clear);
        services.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.IndexedContent, clear);
        services.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Validated, clear);
    }

    clearCache(): void {
        this.built = false;
        this.roots.clear();
        this.rootContexts.clear();
        this.partContextNames.clear();
        this.rootsByPart.clear();
        this.partsByRoot.clear();
        this.unitSymbolsCache.clear();
    }

    getPartContextNames(document: LangiumDocument): string[] {
        this.ensureBuilt();
        return this.partContextNames.get(document.uri.toString()) ?? [];
    }

    isRootDocument(document: LangiumDocument): boolean {
        this.ensureBuilt();
        return this.roots.has(document.uri.toString());
    }

    isPartDocument(document: LangiumDocument): boolean {
        this.ensureBuilt();
        return this.partContextNames.has(document.uri.toString());
    }

    /** Roots that directly import this document and declare the given context. */
    getRootsForPart(document: LangiumDocument, contextName: string): LangiumDocument[] {
        this.ensureBuilt();
        return this.rootsByPart.get(document.uri.toString())?.get(contextName) ?? [];
    }

    /** Every context declared by the root that owns this document's unit. */
    getUnitContexts(document: LangiumDocument): BoundedContext[] {
        this.ensureBuilt();
        const root = this.getRootForDocument(document);
        return root ? [...(this.rootContexts.get(root.uri.toString())?.values() ?? [])] : [];
    }

    /** The unique root of this document's unit, or undefined when it is ambiguous. */
    getRootForDocument(document: LangiumDocument): LangiumDocument | undefined {
        this.ensureBuilt();
        if (this.roots.has(document.uri.toString())) {
            return document;
        }
        const roots = new Set<LangiumDocument>();
        for (const contextName of this.getPartContextNames(document)) {
            for (const root of this.getRootsForPart(document, contextName)) {
                roots.add(root);
            }
        }
        return roots.size === 1 ? roots.values().next().value : undefined;
    }

    /** Root plus directly imported parts. External imports are not included. */
    getUnitDocuments(document: LangiumDocument): LangiumDocument[] {
        this.ensureBuilt();
        const root = this.getRootForDocument(document);
        if (!root) {
            return [document];
        }
        const documents = new Map<string, LangiumDocument>();
        documents.set(root.uri.toString(), root);
        for (const parts of this.partsByRoot.get(root.uri.toString())?.values() ?? []) {
            for (const part of parts) {
                documents.set(part.uri.toString(), part);
            }
        }
        return [...documents.values()];
    }

    getUnitSymbols(document: LangiumDocument, referenceType: string): AstNodeDescription[] {
        this.ensureBuilt();
        const uris = this.getUnitDocuments(document).map(candidate => candidate.uri.toString()).sort();
        const key = JSON.stringify([uris, referenceType]);
        const cached = this.unitSymbolsCache.get(key);
        if (cached) {
            return cached;
        }
        const descriptions = this.services.shared.workspace.IndexManager
            .allElements(referenceType, new Set(uris))
            .toArray();
        this.unitSymbolsCache.set(key, descriptions);
        return descriptions;
    }

    private ensureBuilt(): void {
        if (this.built) {
            return;
        }
        this.built = true;
        this.roots.clear();
        this.rootContexts.clear();
        this.partContextNames.clear();
        this.rootsByPart.clear();
        this.partsByRoot.clear();
        this.unitSymbolsCache.clear();

        const documents = this.services.shared.workspace.LangiumDocuments.all.toArray();
        for (const document of documents) {
            const model = document.parseResult.value;
            if (!isModel(model)) {
                continue;
            }
            const contexts = new Map<string, BoundedContext>();
            for (const declaration of model.declarations) {
                if (isBoundedContext(declaration)) {
                    contexts.set(declaration.name, declaration);
                }
            }
            if (contexts.size > 0) {
                this.roots.set(document.uri.toString(), document);
                this.rootContexts.set(document.uri.toString(), contexts);
            }
            const names = new Set<string>();
            for (const declaration of model.declarations) {
                if (isBoundedContextPart(declaration)) {
                    // Only the syntactic name is available while linking the
                    // context reference itself; resolving it here would recurse.
                    const name = declaration.context?.$refText ?? '';
                    if (name.length > 0) {
                        names.add(name);
                    }
                }
            }
            if (names.size > 0) {
                this.partContextNames.set(document.uri.toString(), [...names]);
            }
        }

        for (const root of this.roots.values()) {
            const rootModel = root.parseResult.value as Model;
            const rootUri = root.uri.toString();
            for (const importDeclaration of rootModel.imports) {
                const uri = resolveImportUri(root, importDeclaration);
                const part = uri ? this.services.shared.workspace.LangiumDocuments.getDocument(uri) : undefined;
                if (!part) {
                    continue;
                }
                const partUri = part.uri.toString();
                for (const contextName of this.partContextNames.get(partUri) ?? []) {
                    if (!this.rootContexts.get(rootUri)?.has(contextName)) {
                        continue;
                    }
                    this.addToMap(this.rootsByPart, partUri, contextName, root);
                    this.addToMap(this.partsByRoot, rootUri, contextName, part);
                }
            }
        }
    }

    private addToMap(
        map: Map<string, Map<string, LangiumDocument[]>>,
        key: string,
        contextName: string,
        document: LangiumDocument
    ): void {
        const byContext = map.get(key) ?? new Map<string, LangiumDocument[]>();
        const documents = byContext.get(contextName) ?? [];
        if (!documents.includes(document)) {
            documents.push(document);
        }
        byContext.set(contextName, documents);
        map.set(key, byContext);
    }
}
