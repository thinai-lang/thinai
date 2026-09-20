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
    BoundedContext,
    type Import,
    isBoundedContext,
    isBoundedContextPart,
    isModel
} from './generated/ast.js';

const exportedTypes = new Set([
    'Actor',
    'Aggregate',
    'BoundedContext',
    'Capability',
    'Command',
    'DomainEvent',
    'DomainService',
    'Entity',
    'EnumType',
    'EventStorming',
    'ExternalSystem',
    'Factory',
    'Hotspot',
    'IntegrationEvent',
    'Policy',
    'ReadModel',
    'Repository',
    'Subdomain',
    'ValueObject'
]);

type NamedNode = AstNode & { name: string };

function isNamedExport(node: AstNode): node is NamedNode {
    return exportedTypes.has(node.$type) && typeof (node as Partial<NamedNode>).name === 'string';
}

export function getOwningContextName(node: AstNode): string | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        if (isBoundedContext(current)) {
            return current.name;
        }
        if (isBoundedContextPart(current)) {
            return current.context.$refText;
        }
        current = current.$container;
    }
    return undefined;
}

function getDeclarationPath(node: NamedNode): string[] {
    const path: string[] = [];
    let current: AstNode | undefined = node;
    while (current && !isBoundedContext(current) && !isBoundedContextPart(current)) {
        if (isNamedExport(current)) {
            path.unshift(current.name);
        }
        current = current.$container;
    }
    return path;
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
        for (let index = localScopes.length - 1; index >= 0; index--) {
            result = this.createScope(localScopes[index], result);
        }
        return result;
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
            this.addDescription(descriptions, seen, description, description.name);

            for (const importDeclaration of imports) {
                const names = importDeclaration.alias
                    ? this.getAliasedNames(description.name, importDeclaration.alias, description.type)
                    : this.getUnaliasedNames(description.name);
                for (const name of names) {
                    this.addDescription(descriptions, seen, description, name);
                }
            }
        }
        return descriptions;
    }

    private getUnaliasedNames(name: string): string[] {
        const parts = name.split('.');
        return parts.map((_part, index) => parts.slice(index).join('.'));
    }

    private getAliasedNames(name: string, alias: string, type: string): string[] {
        const parts = name.split('.');
        const names = [alias];
        if (type !== BoundedContext.$type && parts.length > 1) {
            names.push(`${alias}.${parts.slice(1).join('.')}`);
        }
        return names;
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
