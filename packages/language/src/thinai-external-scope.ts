import type {
    AstNode,
    AstNodeDescription,
    AstReflection,
    ReferenceInfo
} from 'langium';
import type { AstNodeDescriptionProvider, NameProvider, IndexManager } from 'langium';
import {
    isBoundedContext,
    isBoundedContextPart,
    isDataObject,
    isDomainEvent,
    isEntity,
    isIntegrationEvent,
    isModel,
    isReadModel,
    isValueObject,
    type Import,
    type ImportableComponent
} from './generated/ast.js';
import { getExportedName, getOwningModule, isInSharedKernel, resolveImportUri } from './thinai-scope-utils.js';

/** Builds the imported, module-visible, and document-local symbol scopes. */
export class ThinaiExternalScope {
    constructor(
        private readonly reflection: AstReflection,
        private readonly nameProvider: NameProvider,
        private readonly descriptions: AstNodeDescriptionProvider,
        private readonly indexManager: IndexManager
    ) {}

    getModuleSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        const module = getOwningModule(context.container);
        if (!module) {
            return [];
        }
        const candidates = new Map<string, Map<string, AstNodeDescription>>();
        for (const dependency of module.dependencies) {
            const targetModule = dependency.target.ref;
            if (!targetModule) {
                continue;
            }
            for (const exposure of targetModule.exposures) {
                for (const declaration of exposure.declarations) {
                    const target = declaration.target.ref;
                    if (!target) {
                        continue;
                    }
                    if (this.reflection.isSubtype(target.$type, referenceType)) {
                        const name = this.nameProvider.getName(target);
                        if (name) {
                            this.addScopeCandidate(candidates, this.descriptions.createDescription(target, name), name);
                        }
                        const exportedName = getExportedName(target as AstNode & { name: string });
                        this.addScopeCandidate(candidates, this.descriptions.createDescription(target, exportedName), exportedName);
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
                }
            }
        }
        return this.getUniqueScopeCandidates(candidates);
    }

    getImportedSymbols(document: import('langium').LangiumDocument, referenceType: string): AstNodeDescription[] {
        const root = document.parseResult.value;
        if (!isModel(root) || root.imports.length === 0) {
            return [];
        }
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
            for (const declaration of importsByUri.get(description.documentUri.toString()) ?? []) {
                if (declaration.components.length === 0) {
                    this.addScopeCandidates(candidates, description, this.getUnaliasedNames(description.name));
                    continue;
                }
                for (const component of declaration.components) {
                    const target = component.component.ref;
                    if (!target || !this.isWithinComponent(description.name, target)) {
                        continue;
                    }
                    const names = component.alias?.$refText
                        ? this.getComponentAliasNames(description.name, getExportedName(target as AstNode & { name: string }), component.alias.$refText)
                        : this.getUnaliasedNames(description.name);
                    this.addScopeCandidates(candidates, description, names);
                }
            }
        }
        return this.getUniqueScopeCandidates(candidates);
    }

    getDocumentSymbols(context: ReferenceInfo, document: import('langium').LangiumDocument, referenceType: string): AstNodeDescription[] {
        const descriptions = this.indexManager.allElements(referenceType, new Set([document.uri.toString()]));
        const candidates = new Map<string, Map<string, AstNodeDescription>>();
        const owningContextName = this.getLexicalContextName(context);
        for (const description of descriptions) {
            this.addScopeCandidate(candidates, description, description.name);
            const belongsToContext = owningContextName && description.name.startsWith(`${owningContextName}.`);
            const belongsToSharedKernel = description.node !== undefined && isInSharedKernel(description.node);
            if (belongsToContext || belongsToSharedKernel) {
                for (const name of this.getUnaliasedNames(description.name).slice(1)) {
                    this.addScopeCandidate(candidates, description, name);
                }
            }
        }
        return this.getUniqueScopeCandidates(candidates);
    }

    private getLexicalContextName(context: ReferenceInfo): string | undefined {
        let current: AstNode | undefined = context.container;
        while (current) {
            if (isBoundedContext(current)) {
                return current.name;
            }
            if (isBoundedContextPart(current)) {
                if (context.container === current && context.property === 'context') {
                    return undefined;
                }
                return current.context.ref?.name ?? current.context.$refText;
            }
            current = current.$container;
        }
        return undefined;
    }

    private isWithinComponent(name: string, component: ImportableComponent): boolean {
        const componentName = getExportedName(component as AstNode & { name: string });
        return name === componentName || name.startsWith(`${componentName}.`);
    }

    private getComponentAliasNames(name: string, componentName: string, alias: string): string[] {
        return name === componentName ? [alias] : [`${alias}.${name.slice(componentName.length + 1)}`];
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
