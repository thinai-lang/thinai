import {
    type AstNode,
    type AstNodeDescription,
    AstUtils,
    DefaultScopeComputation,
    DefaultScopeProvider,
    type LangiumDocument,
    type ReferenceInfo,
    type Scope,
    type Stream,
    UriUtils
} from 'langium';
import type { CancellationToken } from 'vscode-jsonrpc';
import {
    type Import,
    isBoundedContext,
    isBoundedContextPart,
    isEntity,
    isField,
    isModel,
    isModule,
    isSharedKernel,
    isImportComponent,
    isValueObject,
    type Module
} from './generated/ast.js';

const exportedTypes = new Set([
    'Aggregate',
    'ApplicationService',
    'BoundedContext',
    'ContextMap',
    'Capability',
    'DomainEvent',
    'DomainService',
    'Entity',
    'EnumType',
    'Flow',
    'Factory',
    'Field',
    'IntegrationEvent',
    'Method',
    'Module',
    'Repository',
    'SharedKernel',
    'Subdomain',
    'ValueObject'
]);

type NamedNode = AstNode & { name: string };

function isNamedExport(node: AstNode): node is NamedNode {
    if (isField(node) && !isEntity(node.$container) && !isValueObject(node.$container)) {
        return false;
    }
    return exportedTypes.has(node.$type) && typeof (node as Partial<NamedNode>).name === 'string';
}

export function getOwningContextName(node: AstNode): string | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        if (isBoundedContext(current)) {
            return current.name;
        }
        if (isBoundedContextPart(current)) {
            return current.context.ref?.name ?? current.context.$refText;
        }
        if (isSharedKernel(current)) {
            return current.name;
        }
        current = current.$container;
    }
    return undefined;
}

function getDeclarationPath(node: NamedNode): string[] {
    const path: string[] = [];
    let current: AstNode | undefined = node;
    while (current && !isBoundedContext(current) && !isBoundedContextPart(current) && !isSharedKernel(current)) {
        if (isNamedExport(current)) {
            path.unshift(current.name);
        }
        current = current.$container;
    }
    return path;
}

export function getOwningModule(node: AstNode): Module | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        if (isModule(current)) {
            return current;
        }
        current = current.$container;
    }
    return undefined;
}

export function isInSharedKernel(node: AstNode): boolean {
    let current: AstNode | undefined = node;
    while (current) {
        if (isSharedKernel(current)) {
            return true;
        }
        current = current.$container;
    }
    return false;
}

export function getExportedName(node: NamedNode): string {
    const contextName = getOwningContextName(node);
    const path = getDeclarationPath(node);
    return contextName ? [contextName, ...path].join('.') : path.join('.');
}

export function resolveImportUri(document: LangiumDocument, importDeclaration: Import) {
    return UriUtils.resolvePath(UriUtils.dirname(document.uri), importDeclaration.path);
}

export class ThinaiScopeComputation extends DefaultScopeComputation {
    override async collectExportedSymbols(
        document: LangiumDocument,
        _cancelToken?: CancellationToken
    ): Promise<AstNodeDescription[]> {
        const root = document.parseResult.value;
        if (!root) {
            return [];
        }

        const exports: AstNodeDescription[] = [];
        for (const node of AstUtils.streamAst(root)) {
            if (!isNamedExport(node)) {
                continue;
            }
            const name = getExportedName(node);
            if (name) {
                exports.push(this.descriptions.createDescription(node, name, document));
            }
        }
        return exports;
    }
}

export class ThinaiScopeProvider extends DefaultScopeProvider {
    override getScope(context: ReferenceInfo): Scope {
        const referenceType = this.reflection.getReferenceType(context);
        const document = AstUtils.getDocument(context.container);
        if (context.property === 'component' && isImportComponent(context.container)) {
            return this.createScope(this.getImportableComponents(context.container, referenceType));
        }
        const localScopes: Stream<AstNodeDescription>[] = [];

        if (document.localSymbols) {
            let current: AstNode | undefined = context.container;
            while (current) {
                if (document.localSymbols.has(current)) {
                    localScopes.push(document.localSymbols.getStream(current).filter(description =>
                        this.reflection.isSubtype(description.type, referenceType)
                    ));
                }
                current = current.$container;
            }
        }

        let result = this.createScope(this.getImportedSymbols(document, referenceType));
        result = this.createScope(this.getDocumentSymbols(document, referenceType), result);
        const moduleSymbols = context.property === 'dependencies'
            ? []
            : this.getModuleSymbols(context, referenceType);
        result = this.createScope(moduleSymbols, result);
        for (let index = localScopes.length - 1; index >= 0; index--) {
            result = this.createScope(localScopes[index], result);
        }
        return result;
    }

    private getModuleSymbols(context: ReferenceInfo, referenceType: string): AstNodeDescription[] {
        const module = getOwningModule(context.container);
        if (!module) {
            return [];
        }

        const descriptions: AstNodeDescription[] = [];
        for (const dependency of module.dependencies) {
            const targetModule = dependency.ref;
            if (!targetModule) {
                continue;
            }
            for (const exposure of targetModule.exposures) {
                for (const declaration of exposure.declarations) {
                    const target = declaration.ref;
                    if (!target) {
                        continue;
                    }
                    if (this.reflection.isSubtype(target.$type, referenceType)) {
                        const name = this.nameProvider.getName(target);
                        if (name) {
                            descriptions.push(this.descriptions.createDescription(target, name));
                        }
                        descriptions.push(this.descriptions.createDescription(target, getExportedName(target as AstNode & { name: string })));
                    }
                    if ((isEntity(target) || isValueObject(target)) && this.reflection.isSubtype('Field', referenceType)) {
                        for (const field of target.fields) {
                            const fieldName = getExportedName(field);
                            for (const name of this.getUnaliasedNames(fieldName)) {
                                descriptions.push(this.descriptions.createDescription(field, name));
                            }
                        }
                    }
                }
            }
        }
        return descriptions;
    }

    private getImportedSymbols(document: LangiumDocument, referenceType: string): AstNodeDescription[] {
        const root = document.parseResult.value;
        if (!isModel(root) || root.imports.length === 0) {
            return [];
        }

        const importsByUri = new Map<string, Import[]>();
        for (const importDeclaration of root.imports) {
            const uri = resolveImportUri(document, importDeclaration).toString();
            const imports = importsByUri.get(uri) ?? [];
            imports.push(importDeclaration);
            importsByUri.set(uri, imports);
        }

        const descriptions: AstNodeDescription[] = [];
        const seen = new Set<string>();
        for (const description of this.indexManager.allElements(referenceType, new Set(importsByUri.keys()))) {
            const imports = importsByUri.get(description.documentUri.toString()) ?? [];
            for (const importDeclaration of imports) {
                if (importDeclaration.components.length > 0) {
                    for (const component of importDeclaration.components) {
                        const target = component.component.ref;
                        if (!target || !this.isWithinComponent(description.name, target)) {
                            continue;
                        }
                        const names = component.alias
                            ? this.getComponentAliasNames(description.name, getExportedName(target), component.alias)
                            : this.getUnaliasedNames(description.name);
                        this.addNames(descriptions, seen, description, names);
                    }
                } else if (importDeclaration.alias) {
                    const targetName = this.getSingleImportableComponentName(document, importDeclaration);
                    if (targetName && this.isWithinComponentName(description.name, targetName)) {
                        this.addNames(descriptions, seen, description,
                            this.getComponentAliasNames(description.name, targetName, importDeclaration.alias));
                    }
                } else {
                    this.addNames(descriptions, seen, description, this.getUnaliasedNames(description.name));
                }
            }
        }
        return descriptions;
    }

    private getDocumentSymbols(document: LangiumDocument, referenceType: string): AstNodeDescription[] {
        const descriptions = this.indexManager.allElements(referenceType, new Set([document.uri.toString()]));
        const result: AstNodeDescription[] = [];
        const seen = new Set<string>();
        for (const description of descriptions) {
            this.addNames(result, seen, description, this.getUnaliasedNames(description.name));
        }
        return result;
    }

    private getImportableComponents(component: import('./generated/ast.js').ImportComponent, referenceType: string): AstNodeDescription[] {
        const importDeclaration = component.$container;
        const document = AstUtils.getDocument(importDeclaration);
        const uri = resolveImportUri(document, importDeclaration).toString();
        return this.indexManager.allElements(referenceType, new Set([uri]))
            .filter(description => ['BoundedContext', 'ContextMap', 'SharedKernel'].includes(description.type))
            .toArray();
    }

    private getSingleImportableComponentName(document: LangiumDocument, importDeclaration: Import): string | undefined {
        const uri = resolveImportUri(document, importDeclaration).toString();
        const candidates = this.indexManager.allElements(undefined, new Set([uri]))
            .filter(description => ['BoundedContext', 'ContextMap', 'SharedKernel'].includes(description.type))
            .toArray();
        return candidates.length === 1 ? candidates[0].name : undefined;
    }

    private isWithinComponent(name: string, component: import('./generated/ast.js').ImportableComponent): boolean {
        const componentName = getExportedName(component as AstNode & { name: string });
        return this.isWithinComponentName(name, componentName);
    }

    private isWithinComponentName(name: string, componentName: string): boolean {
        return name === componentName || name.startsWith(`${componentName}.`);
    }

    private getComponentAliasNames(name: string, componentName: string, alias: string): string[] {
        if (name === componentName) {
            return [alias];
        }
        return [`${alias}.${name.slice(componentName.length + 1)}`];
    }

    private addNames(
        descriptions: AstNodeDescription[],
        seen: Set<string>,
        description: AstNodeDescription,
        names: string[]
    ): void {
        for (const name of names) {
            this.addDescription(descriptions, seen, description, name);
        }
    }

    private getUnaliasedNames(name: string): string[] {
        const parts = name.split('.');
        return parts.map((_part, index) => parts.slice(index).join('.'));
    }

    private addDescription(
        descriptions: AstNodeDescription[],
        seen: Set<string>,
        description: AstNodeDescription,
        name: string
    ): void {
        const key = `${description.documentUri.toString()}#${description.path}#${name}`;
        if (!seen.has(key)) {
            seen.add(key);
            descriptions.push({ ...description, name });
        }
    }
}
