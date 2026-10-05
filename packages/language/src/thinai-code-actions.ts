import {
    AstNodeDescription,
    type LangiumDocument,
    UriUtils
} from 'langium';
import {
    CodeActionKind,
    type CodeAction,
    type CodeActionParams
} from 'vscode-languageserver';
import type { CancellationToken } from 'vscode-jsonrpc';
import type { ThinaiServices } from './thinai-module.js';
import { isModel } from './generated/ast.js';
import { resolveImportUri } from './thinai-scope.js';

export class ThinaiCodeActionProvider {
    constructor(private readonly services: ThinaiServices) {}

    getCodeActions(
        document: LangiumDocument,
        params: CodeActionParams,
        _cancelToken?: CancellationToken
    ): CodeAction[] {
        const actions: CodeAction[] = [];
        for (const diagnostic of params.context.diagnostics) {
            const referenceName = this.getUnresolvedReferenceName(String(diagnostic.message));
            if (!referenceName) {
                continue;
            }

            for (const candidate of this.findImportCandidates(document, referenceName)) {
                const importPath = this.toImportPath(document, candidate.documentUri);
                actions.push({
                    title: `Import '${referenceName}' from '${importPath}'`,
                    kind: CodeActionKind.QuickFix,
                    isPreferred: true,
                    diagnostics: [diagnostic],
                    edit: {
                        changes: {
                            [document.uri.toString()]: [
                                {
                                    range: {
                                        start: { line: 0, character: 0 },
                                        end: { line: 0, character: 0 }
                                    },
                                    newText: `import "${importPath}"\n`
                                }
                            ]
                        }
                    }
                });
            }
        }
        return actions;
    }

    private getUnresolvedReferenceName(message: string): string | undefined {
        return /Could not resolve reference to .* named '([^']+)'/.exec(message)?.[1];
    }

    private findImportCandidates(document: LangiumDocument, name: string): AstNodeDescription[] {
        const model = document.parseResult.value;
        if (!isModel(model)) {
            return [];
        }

        const importedUris = new Set(model.imports.map(importDeclaration =>
            resolveImportUri(document, importDeclaration).toString()
        ));
        const candidates = new Map<string, AstNodeDescription>();
        for (const description of this.services.shared.workspace.IndexManager.allElements()) {
            if (UriUtils.equals(description.documentUri, document.uri) || importedUris.has(description.documentUri.toString())) {
                continue;
            }
            if (description.name === name || description.name.endsWith(`.${name}`)) {
                candidates.set(description.documentUri.toString(), description);
            }
        }
        return [...candidates.values()];
    }

    private toImportPath(document: LangiumDocument, target: AstNodeDescription['documentUri']): string {
        const relativePath = UriUtils.relative(UriUtils.dirname(document.uri), target);
        return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
    }
}
