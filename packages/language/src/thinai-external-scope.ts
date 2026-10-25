import { AstUtils } from 'langium';
import type {
    AstNode,
    AstNodeDescription,
    AstReflection,
    ReferenceInfo
} from 'langium';
import type { AstNodeDescriptionProvider, NameProvider, IndexManager } from 'langium';
import {
    isBoundedContextPart,
    isDataObject,
    isDomainEvent,
    isEntity,
    isEnumType,
    isIntegrationEvent,
    isJourneyStep,
    isModel,
    isModule,
    isReadModel,
    isValueObject,
    type Import,
    type ImportableComponent
} from './generated/ast.js';
import {
    getComponentAliasNames,
    getComponentAliases,
    getExportedName,
    getModulePublicApi,
    getOwningContextName,
    getOwningModule,
    isInSharedKernel,
    resolveImportUri
} from './thinai-scope-utils.js';

/** Builds the imported, module-visible, and document-local symbol scopes. */
export class ThinaiExternalScope {
    private readonly importedSymbolsCache = new Map<string, AstNodeDescription[]>();
    private readonly documentSymbolsCache = new Map<string, AstNodeDescription[]>();

    constructor(
        private readonly reflection: AstReflection,
        private readonly nameProvider: NameProvider,
        private readonly descriptions: AstNodeDescriptionProvider,
        private readonly indexManager: IndexManager
    ) {}

    clearCache(): void {
        this.importedSymbolsCache.clear();
        this.documentSymbolsCache.clear();
    }

    getModuleSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        const module = getOwningModule(context.container);
        if (!module) {
            return [];
        }
        const candidates = new Map<string, Map<string, AstNodeDescription>>();
        // Dependencies contribute their public API, including recursively
        // exposed nested modules.
        const publicApiRoots: AstNode[] = [];
        for (const dependency of module.dependencies) {
            if (dependency.target.ref) {
                publicApiRoots.push(dependency.target.ref);
            }
        }
        const visited = new Set<AstNode>();
        for (const root of publicApiRoots) {
            const targets = isModule(root) ? getModulePublicApi(root) : [];
            for (const target of targets) {
                if (visited.has(target)) {
                    continue;
                }
                visited.add(target);
                this.addPublicApiTarget(candidates, target, referenceType);
            }
        }
        return this.getUniqueScopeCandidates(candidates);
    }

    private addPublicApiTarget(
        candidates: Map<string, Map<string, AstNodeDescription>>,
        target: AstNode,
        referenceType: string
    ): void {
        if (this.reflection.isSubtype(target.$type, referenceType)) {
            const name = this.nameProvider.getName(target);
            if (name) {
                this.addScopeCandidate(candidates, this.descriptions.createDescription(target, name), name);
            }
            const exportedName = getExportedName(target as AstNode & { name: string });
            for (const exportedSpelling of this.getUnaliasedNames(exportedName)) {
                this.addScopeCandidate(
                    candidates,
                    this.descriptions.createDescription(target, exportedSpelling),
                    exportedSpelling
                );
            }
        }
        if ((isEntity(target) || isValueObject(target) || isDomainEvent(target) ||
            isIntegrationEvent(target) || isReadModel(target) || isDataObject(target)) &&
            this.reflection.isSubtype('Field', referenceType)) {
            for (const field of target.fields) {
                const fieldName = getExportedName(field);
                for (const name of this.getUnaliasedNames(fieldName)) {
                    this.addScopeCandidate(candidates, this.descriptions.createDescription(field, name), name);
                }
            }
        }
        if (isEnumType(target) && this.reflection.isSubtype('EnumValue', referenceType)) {
            for (const value of target.values) {
                const valueName = getExportedName(value);
                for (const name of this.getUnaliasedNames(valueName)) {
                    this.addScopeCandidate(candidates, this.descriptions.createDescription(value, name), name);
                }
            }
        }
    }

    getImportedSymbols(
        context: ReferenceInfo,
        document: import('langium').LangiumDocument,
        referenceType: string
    ): AstNodeDescription[] {
        const lexicalContextName = this.getLexicalContextName(context);
        const cacheKey = JSON.stringify([document.uri.toString(), referenceType, lexicalContextName ?? null]);
        const cached = this.importedSymbolsCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const root = document.parseResult.value;
        if (!isModel(root) || root.imports.length === 0) {
            return [];
        }
        const aliases = getComponentAliases(root);
        const importsByUri = new Map<string, Import[]>();
        for (const declaration of root.imports) {
            const uri = resolveImportUri(document, declaration);
            if (uri) {
                const imports = importsByUri.get(uri.toString()) ?? [];
                imports.push(declaration);
                importsByUri.set(uri.toString(), imports);
            }
        }
        const candidates = new Map<string, Map<string, AstNodeDescription>>();
        for (const description of this.indexManager.allElements(referenceType, new Set(importsByUri.keys()))) {
            const declarations = importsByUri.get(description.documentUri.toString()) ?? [];
            let visible = false;
            let unaliased = false;
            for (const declaration of declarations) {
                if (declaration.components.length === 0) {
                    visible = true;
                    unaliased = true;
                    continue;
                }
                for (const component of declaration.components) {
                    const target = component.component.ref;
                    if (!target || !this.isWithinComponent(description, target)) {
                        continue;
                    }
                    visible = true;
                    if (!component.alias) {
                        unaliased = true;
                    }
                }
            }
            if (!visible) {
                continue;
            }
            // Canonical qualified names remain available even when a component
            // import is aliased. Aliases add spellings; they do not hide the
            // declaration's canonical path.
            this.addScopeCandidate(candidates, description, description.name);
            if (unaliased) {
                this.addScopeCandidates(candidates, description, this.getUnaliasedNames(description.name));
            } else if (lexicalContextName !== undefined &&
                description.name.startsWith(`${lexicalContextName}.`)) {
                // Inside a contribution to an aliased bounded context (or shared
                // kernel), declarations of that same context remain addressable
                // with context-relative paths such as `Module.Type` and `Type`.
                // Local contributions already behave this way through document
                // symbol suffixes; imported contributions must match them.
                this.addScopeCandidates(
                    candidates,
                    description,
                    this.getUnaliasedNames(description.name).slice(1)
                );
            }
            // Aliases apply to every visible declaration of the selected
            // component, including members contributed by other imported files.
            for (const name of getComponentAliasNames(description.name, aliases, description.type)) {
                this.addScopeCandidate(candidates, description, name);
            }
        }
        const result = this.getUniqueScopeCandidates(candidates);
        this.importedSymbolsCache.set(cacheKey, result);
        return result;
    }

    getDocumentSymbols(context: ReferenceInfo, document: import('langium').LangiumDocument, referenceType: string): AstNodeDescription[] {
        const journeyReference = AstUtils.getContainerOfType(context.container, isJourneyStep) !== undefined;
        const cacheKey = JSON.stringify([
            document.uri.toString(),
            referenceType,
            this.getLexicalContextName(context) ?? null,
            journeyReference
        ]);
        const cached = this.documentSymbolsCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const root = document.parseResult.value;
        const aliases = isModel(root) ? getComponentAliases(root) : [];
        const descriptions = this.indexManager.allElements(referenceType, new Set([document.uri.toString()]));
        const candidates = new Map<string, Map<string, AstNodeDescription>>();
        const owningContextName = this.getLexicalContextName(context);
        for (const description of descriptions) {
            this.addScopeCandidate(candidates, description, description.name);
            const belongsToContext = owningContextName && description.name.startsWith(`${owningContextName}.`);
            const belongsToSharedKernel = description.node !== undefined && isInSharedKernel(description.node);
            if (belongsToContext || belongsToSharedKernel || journeyReference) {
                for (const name of this.getUnaliasedNames(description.name).slice(1)) {
                    this.addScopeCandidate(candidates, description, name);
                }
            }
            for (const name of getComponentAliasNames(description.name, aliases, description.type)) {
                this.addScopeCandidate(candidates, description, name);
            }
        }
        const result = this.getUniqueScopeCandidates(candidates);
        this.documentSymbolsCache.set(cacheKey, result);
        return result;
    }

    private getLexicalContextName(context: ReferenceInfo): string | undefined {
        if (isBoundedContextPart(context.container) && context.property === 'context') {
            return undefined;
        }
        return getOwningContextName(context.container);
    }

    private isWithinComponent(description: AstNodeDescription, component: ImportableComponent): boolean {
        const componentName = getExportedName(component as AstNode & { name: string });
        if (description.name === componentName) {
            return description.type === component.$type;
        }
        return description.name.startsWith(`${componentName}.`);
    }

    private addScopeCandidates(
        candidates: Map<string, Map<string, AstNodeDescription>>,
        description: AstNodeDescription,
        names: string[]
    ): void {
        for (const name of names) {
            this.addScopeCandidate(candidates, description, name);
        }
    }

    private addScopeCandidate(
        candidates: Map<string, Map<string, AstNodeDescription>>,
        description: AstNodeDescription,
        name: string
    ): void {
        const symbolKey = `${description.documentUri.toString()}#${description.path}`;
        const matches = candidates.get(name) ?? new Map<string, AstNodeDescription>();
        matches.set(symbolKey, description);
        candidates.set(name, matches);
    }

    private getUniqueScopeCandidates(candidates: Map<string, Map<string, AstNodeDescription>>): AstNodeDescription[] {
        const unique: AstNodeDescription[] = [];
        for (const [name, matches] of candidates) {
            if (matches.size === 1) {
                unique.push({ ...matches.values().next().value!, name });
            }
        }
        return unique;
    }

    private getUnaliasedNames(name: string): string[] {
        const parts = name.split('.');
        return parts.map((_part, index) => parts.slice(index).join('.'));
    }
}
