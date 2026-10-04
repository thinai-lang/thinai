import {
    type AstNode,
    type AstNodeDescription,
    type LangiumDocument,
    type ReferenceInfo,
    URI,
    UriUtils
} from 'langium';
import { DefaultCompletionProvider, type CompletionContext, type CompletionValueItem } from 'langium/lsp';
import {
    CompletionItemKind,
    type CompletionList,
    type CompletionParams,
    type Position,
    type TextEdit
} from 'vscode-languageserver';
import type { CancellationToken } from 'vscode-jsonrpc';
import type { ThinaiServices } from './thinai-module.js';
import {
    isDomainEvent,
    isEnumValue,
    isField,
    isIntegrationEvent,
    isJourneyStep,
    isMethod,
    isMethodInvocation,
    isParameter,
    isSpecificationTextPart
} from './generated/ast.js';
import { getExportedName } from './thinai-scope.js';

export class ThinaiCompletionProvider extends DefaultCompletionProvider {
    override readonly completionOptions = {
        triggerCharacters: ['"', '/', '.', '[']
    };

    private readonly thinaiServices: ThinaiServices;

    constructor(services: ThinaiServices) {
        super(services);
        this.thinaiServices = services;
    }

    protected override getReferenceCandidates(refInfo: ReferenceInfo, context: CompletionContext) {
        const { container, property } = refInfo;
        if ((isJourneyStep(container) || isMethodInvocation(container)) && property === 'targets') {
            const completedSegments = container.targets.filter(reference =>
                reference.$refNode !== undefined && reference.$refNode.end < context.offset
            ).length;
            return this.thinaiServices.references.ScopeProvider
                .getScope({ ...refInfo, index: completedSegments })
                .getAllElements();
        }
        if (isSpecificationTextPart(container) && property === 'targets') {
            const completedSegments = container.targets.filter(reference =>
                reference.$refNode !== undefined && reference.$refNode.end < context.offset
            ).length;
            return this.thinaiServices.references.ScopeProvider
                .getScope({ ...refInfo, index: completedSegments })
                .getAllElements();
        }
        return super.getReferenceCandidates(refInfo, context);
    }

    protected override createReferenceCompletionItem(
        nodeDescription: AstNodeDescription,
        refInfo: ReferenceInfo,
        context: CompletionContext
    ): CompletionValueItem {
        const item = super.createReferenceCompletionItem(nodeDescription, refInfo, context);
        item.detail = this.getCompletionDetail(nodeDescription);
        return item;
    }

    private getCompletionDetail(description: AstNodeDescription): string {
        const node = description.node;
        if (!node) {
            return `${description.type} ${description.name}`;
        }
        const name = this.getCanonicalName(node, description.name);
        if (isMethod(node)) {
            const parameters = node.parameters.map(parameter => this.getParameterDetail(parameter)).join(', ');
            const result = node.returnPrimitive ??
                (node.returnType?.ref ? this.getCanonicalName(node.returnType.ref, node.returnType.$refText) :
                    node.returnCollection ? this.getCollectionDetail(node.returnCollection) : undefined);
            return `Method ${name}(${parameters})${result ? ` returns ${result}` : ''}`;
        }
        if (isField(node)) {
            return `Field ${name}: ${this.getTypeDetail(node)}`;
        }
        if (isParameter(node)) {
            return `Parameter ${name}: ${this.getParameterDetail(node).replace(`${node.name}: `, '')}`;
        }
        if (isEnumValue(node)) {
            const enumName = this.getCanonicalName(node.$container, node.$container.name);
            return `Enum value ${name} (${enumName})`;
        }
        return `${description.type} ${name}`;
    }

    private getCanonicalName(node: AstNode, fallback: string): string {
        if (!('name' in node) || typeof node.name !== 'string') {
            return fallback;
        }
        return getExportedName(node as AstNode & { name: string }) || node.name;
    }

    private getParameterDetail(parameter: import('./generated/ast.js').Parameter): string {
        const optional = parameter.optional ? '?' : '';
        const parameterTarget = parameter.type?.ref;
        const type = parameter.primitive ??
            (isDomainEvent(parameterTarget) || isIntegrationEvent(parameterTarget)
                ? `event ${this.getCanonicalName(parameterTarget, parameter.type!.$refText)}`
                : parameterTarget ? this.getCanonicalName(parameterTarget, parameter.type!.$refText) :
                    parameter.collection ? this.getCollectionDetail(parameter.collection) : 'unknown');
        return `${parameter.name}${optional}: ${type}`;
    }

    private getTypeDetail(field: import('./generated/ast.js').Field): string {
        return field.primitive ??
            (field.type?.ref ? this.getCanonicalName(field.type.ref, field.type.$refText) :
                field.collection ? this.getCollectionDetail(field.collection) : 'unknown');
    }

    private getCollectionDetail(collection: import('./generated/ast.js').CollectionType): string {
        const element = collection.elementPrimitive ??
            (collection.elementType?.ref ? this.getCanonicalName(collection.elementType.ref, collection.elementType.$refText) :
                collection.elementCollection ? this.getCollectionDetail(collection.elementCollection) : 'unknown');
        if (collection.kind !== 'Map') {
            return `${collection.kind}<${element}>`;
        }
        const value = collection.valuePrimitive ??
            (collection.valueType?.ref ? this.getCanonicalName(collection.valueType.ref, collection.valueType.$refText) :
                collection.valueCollection ? this.getCollectionDetail(collection.valueCollection) : 'unknown');
        return `Map<${element}, ${value}>`;
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
