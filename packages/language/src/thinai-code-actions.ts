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
    isBoundedContext,
    isImportableComponent,
    isModel,
    isSharedKernel,
    type Import,
    type ImportableComponent
} from './generated/ast.js';
import {
    formatIdentifier,
    getOwningContextName,
    resolveAstNodeDescription,
    resolveImportUri,
    toImportPath
} from './thinai-scope-utils.js';
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
                    newText = component
                        ? `import { ${formatIdentifier(component.name)} } from "${importPath}"${newline}`
                        : `import "${importPath}"${newline}`;
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
                !reflection.isSubtype(description.type, targetType)) {
                continue;
            }
            const targetNode = resolveAstNodeDescription(description, this.services);
            const visibleAfterImport = scopeProvider
                .filterCompletionCandidates(unresolved.info, [description])
                .toArray().length > 0;
            // Cross-context types remain private without an authorized
            // relationship, so do not offer an import that the language would
            // reject. Unowned strategic declarations (actors, subdomains) and
            // similar non-type targets are importable.
            if (!visibleAfterImport && reflection.isSubtype(description.type, 'TypeDeclaration')) {
                continue;
            }

            const uriKey = description.documentUri.toString();
            const existingImport = importsByUri.get(uriKey)?.find(importDeclaration => importDeclaration.components.length > 0);
            const importPath = toImportPath(UriUtils.dirname(document.uri), description.documentUri);
            const component = this.getImportableComponent(targetNode);
            if (importsByUri.has(uriKey)) {
                if (!existingImport) {
                    continue;
                }
                if (!component) {
                    // Unowned strategic declarations (actors, subdomains,
                    // journeys) and members whose owning component cannot be
                    // inferred are still visible through a bare import. A bare
                    // import is valid alongside selective imports.
                    candidates.set(uriKey, { importPath });
                    continue;
                }
                if (existingImport.components.some(selection => selection.component.ref === component)) {
                    continue;
                }
                const key = `${uriKey}#${component.$cstNode?.offset ?? component.name}`;
                candidates.set(key, { importPath, existingImport, component });
            } else if (component && this.countImportableComponents(description.documentUri) > 1) {
                // Files that declare several components must be imported
                // selectively; a bare import would expose every sibling.
                const key = `${uriKey}#${component.$cstNode?.offset ?? component.name}`;
                candidates.set(key, { importPath, component });
            } else {
                candidates.set(uriKey, { importPath });
            }
        }
        return [...candidates.values()];
    }

    private countImportableComponents(uri: import('langium').URI): number {
        const document = this.services.shared.workspace.LangiumDocuments.getDocument(uri);
        const model = document?.parseResult.value;
        return isModel(model)
            ? model.declarations.filter(isImportableComponent).length
            : 0;
    }

    private getImportableComponent(node: import('langium').AstNode | undefined): ImportableComponent | undefined {
        if (!node) {
            return undefined;
        }
        const ancestor = AstUtils.getContainerOfType(node, isImportableComponent);
        if (ancestor) {
            return ancestor;
        }
        // Members of a contribution block have no canonical `BoundedContext`
        // ancestor. Infer the component from the owning context name and the
        // target document's declarations instead.
        const contextName = getOwningContextName(node);
        if (!contextName) {
            return undefined;
        }
        const model = AstUtils.getDocument(node).parseResult.value;
        if (!isModel(model)) {
            return undefined;
        }
        const declaration = model.declarations.find(candidate =>
            (isBoundedContext(candidate) || isSharedKernel(candidate)) && candidate.name === contextName
        );
        return isBoundedContext(declaration) || isSharedKernel(declaration) ? declaration : undefined;
    }
}
