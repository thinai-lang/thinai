import {
    AstUtils,
    GrammarUtils,
    type LangiumDocument,
    type ReferenceInfo,
    UriUtils,
    isReference
} from 'langium';
import {
    CodeActionKind,
    type CodeAction,
    type CodeActionParams
} from 'vscode-languageserver';
import type { CancellationToken } from 'vscode-jsonrpc';
import type { ThinaiServices } from './thinai-module.js';
import {
    isImportableComponent,
    isModel,
    type Import,
    type ImportableComponent
} from './generated/ast.js';
import { formatIdentifier, resolveAstNodeDescription, resolveImportUri, toImportPath } from './thinai-scope-utils.js';
import { ThinaiScopeProvider } from './thinai-scope-provider.js';
import { getNewline } from './thinai-text-utils.js';

interface UnresolvedReference {
    name: string;
    info: ReferenceInfo;
}

interface ImportCandidate {
    importPath: string;
    existingImport?: Import;
    component?: ImportableComponent;
}

export class ThinaiCodeActionProvider {
    constructor(private readonly services: ThinaiServices) {}

    getCodeActions(
        document: LangiumDocument,
        params: CodeActionParams,
        _cancelToken?: CancellationToken
    ): CodeAction[] {
        const actions: CodeAction[] = [];
        for (const diagnostic of params.context.diagnostics) {
            const unresolved = this.getUnresolvedReference(document, diagnostic.range);
            if (!unresolved) {
                continue;
            }

            const candidates = this.findImportCandidates(document, unresolved);
            for (const candidate of candidates) {
                const { importPath, existingImport, component } = candidate;
                const title = `Import '${unresolved.name}' from '${importPath}'`;
                const textDocument = document.textDocument;
                let range;
                let newText: string;
                if (existingImport && component) {
                    const closingBrace = existingImport.$cstNode && GrammarUtils.findNodesForKeyword(existingImport.$cstNode, '}')[0];
                    if (!closingBrace) {
                        continue;
                    }
                    range = {
                        start: textDocument.positionAt(closingBrace.offset),
                        end: textDocument.positionAt(closingBrace.offset)
                    };
                    newText = `, ${formatIdentifier(component.name)}`;
                } else {
                    const newline = getNewline(textDocument.getText());
                    range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
                    newText = `import "${importPath}"${newline}`;
                }
                actions.push({
                    title,
                    kind: CodeActionKind.QuickFix,
                    isPreferred: candidates.length === 1,
                    diagnostics: [diagnostic],
                    edit: {
                        changes: {
                            [document.uri.toString()]: [
                                { range, newText }
                            ]
                        }
                    }
                });
            }
        }
        return actions;
    }

    private getUnresolvedReference(
        document: LangiumDocument,
        range: CodeActionParams['context']['diagnostics'][number]['range']
    ): UnresolvedReference | undefined {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return undefined;
        }
        const start = document.textDocument.offsetAt(range.start);
        const end = document.textDocument.offsetAt(range.end);
        for (const node of AstUtils.streamAst(model)) {
            for (const referenceInfo of AstUtils.streamReferences(node)) {
                const reference = referenceInfo.reference;
                const referenceNode = reference.$refNode;
                if (isReference(reference) && !reference.ref && referenceNode &&
                    referenceNode.offset <= start && end <= referenceNode.end) {
                    return reference.$refText ? { name: reference.$refText, info: referenceInfo } : undefined;
                }
            }
        }
        return undefined;
    }

    private findImportCandidates(document: LangiumDocument, unresolved: UnresolvedReference): ImportCandidate[] {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return [];
        }

        const importsByUri = new Map<string, Import[]>();
        for (const importDeclaration of model.imports) {
            const uri = resolveImportUri(document, importDeclaration);
            if (uri) {
                const imports = importsByUri.get(uri.toString()) ?? [];
                imports.push(importDeclaration);
                importsByUri.set(uri.toString(), imports);
            }
        }
        const scopeProvider = this.services.references.ScopeProvider as ThinaiScopeProvider;
        const reflection = this.services.shared.AstReflection;
        const targetType = reflection.getReferenceType(unresolved.info);
        const candidates = new Map<string, ImportCandidate>();
        for (const description of this.services.shared.workspace.IndexManager.allElements()) {
            if (UriUtils.equals(description.documentUri, document.uri) ||
                description.name !== unresolved.name && !description.name.endsWith(`.${unresolved.name}`) ||
                !reflection.isSubtype(description.type, targetType) ||
                scopeProvider.filterCompletionCandidates(unresolved.info, [description]).toArray().length === 0) {
                continue;
            }

            const uriKey = description.documentUri.toString();
            const existingImport = importsByUri.get(uriKey)?.find(importDeclaration => importDeclaration.components.length > 0);
            const importPath = toImportPath(UriUtils.dirname(document.uri), description.documentUri);
            if (importsByUri.has(uriKey)) {
                if (!existingImport) {
                    continue;
                }
                const component = this.getImportableComponent(resolveAstNodeDescription(description, this.services));
                if (!component || existingImport.components.some(selection => selection.component.ref === component)) {
                    continue;
                }
                const key = `${uriKey}#${component.$cstNode?.offset ?? component.name}`;
                candidates.set(key, { importPath, existingImport, component });
            } else {
                candidates.set(uriKey, { importPath });
            }
        }
        return [...candidates.values()];
    }

    private getImportableComponent(node: import('langium').AstNode | undefined): ImportableComponent | undefined {
        return node ? AstUtils.getContainerOfType(node, isImportableComponent) : undefined;
    }
}
