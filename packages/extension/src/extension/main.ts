import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { EmptyFileSystem, URI } from 'langium';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import {
    applyConfiguredIndentationToCompletions,
    createThinaiServices,
    createThinaiSelectionRange,
    getSpecificationLinkAutoDeleteRange,
    isQueryRepositoryReadCompletionPosition
} from 'thinai-language';

let client: LanguageClient;

// This function is called when the extension is activated.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const thinaiServices = createThinaiServices(EmptyFileSystem);
    registerThinaiSelectionRanges(context, thinaiServices.shared);
    registerSpecificationLinkAutoDelete(context);
    client = await startLanguageClient(context);
    registerQueryRepositoryReadCompletionTrigger(context, thinaiServices.Thinai);
}

// This function is called when the extension is deactivated.
export function deactivate(): Thenable<void> | undefined {
    if (client) {
        return client.stop();
    }
    return undefined;
}

function registerThinaiSelectionRanges(
    context: vscode.ExtensionContext,
    shared: ReturnType<typeof createThinaiServices>['shared']
): void {
    context.subscriptions.push(vscode.languages.registerSelectionRangeProvider('thinai', {
        provideSelectionRanges(document, positions) {
            const langiumDocument = shared.workspace.LangiumDocumentFactory.fromString(
                document.getText(),
                URI.parse(document.uri.toString())
            );
            return positions.map(position => {
                const range = createThinaiSelectionRange(langiumDocument, position);
                if (range) {
                    return toVscodeSelectionRange(range);
                }
                // Whitespace positions have no CST leaf. Return the line so one
                // such position does not disable selection ranges for the whole
                // request.
                return new vscode.SelectionRange(document.lineAt(position.line).range);
            });
        }
    }));
}

function registerSpecificationLinkAutoDelete(context: vscode.ExtensionContext): void {
    const previousTexts = new Map<string, string>();
    const applying = new Set<string>();
    const remember = (document: vscode.TextDocument): void => {
        previousTexts.set(document.uri.toString(), document.getText());
    };
    for (const document of vscode.workspace.textDocuments) {
        remember(document);
    }
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(remember),
        vscode.workspace.onDidCloseTextDocument(document => previousTexts.delete(document.uri.toString())),
        vscode.workspace.onDidChangeTextDocument(event => {
            const uri = event.document.uri.toString();
            const previous = previousTexts.get(uri);
            const current = event.document.getText();
            previousTexts.set(uri, current);
            if (!previous || applying.has(uri) || event.document.languageId !== 'thinai' ||
                event.contentChanges.length !== 1) {
                return;
            }
            const change = event.contentChanges[0]!;
            const closer = getSpecificationLinkAutoDeleteRange(
                previous,
                current,
                change.rangeOffset,
                change.rangeLength,
                change.text
            );
            if (!closer) {
                return;
            }
            const editor = vscode.window.visibleTextEditors.find(candidate =>
                candidate.document.uri.toString() === uri
            );
            if (!editor) {
                return;
            }
            applying.add(uri);
            void editor.edit(builder => {
                builder.delete(new vscode.Range(
                    editor.document.positionAt(closer.start),
                    editor.document.positionAt(closer.end)
                ));
            }).then(() => {
                previousTexts.set(uri, editor.document.getText());
                applying.delete(uri);
            }, () => {
                applying.delete(uri);
            });
        })
    );
}

function registerQueryRepositoryReadCompletionTrigger(
    context: vscode.ExtensionContext,
    services: ReturnType<typeof createThinaiServices>['Thinai']
): void {
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId !== 'thinai' ||
            !event.contentChanges.some(change => /^(?:\r\n|\r|\n)[\t ]*$/u.test(change.text))) {
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.toString() !== event.document.uri.toString() || !editor.selection.isEmpty) {
            return;
        }
        const position = editor.selection.active;
        if (event.document.lineAt(position.line).text.trim().length > 0) {
            return;
        }
        const langiumDocument = services.shared.workspace.LangiumDocumentFactory.fromString(
            event.document.getText(),
            URI.parse(event.document.uri.toString())
        );
        const offset = langiumDocument.textDocument.offsetAt({ line: position.line, character: position.character });
        if (!isQueryRepositoryReadCompletionPosition(langiumDocument, offset)) {
            return;
        }

        // Let the language client process the document change before requesting completions.
        setTimeout(() => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor.document.uri.toString() !== event.document.uri.toString() ||
                !activeEditor.selection.isEmpty || event.document.lineAt(activeEditor.selection.active.line).text.trim().length > 0) {
                return;
            }
            const activeDocument = services.shared.workspace.LangiumDocumentFactory.fromString(
                event.document.getText(),
                URI.parse(event.document.uri.toString())
            );
            const activeOffset = activeDocument.textDocument.offsetAt({
                line: activeEditor.selection.active.line,
                character: activeEditor.selection.active.character
            });
            if (!isQueryRepositoryReadCompletionPosition(activeDocument, activeOffset)) {
                return;
            }
            void vscode.commands.executeCommand('editor.action.triggerSuggest');
        }, 0);
    }));
}

function toVscodeSelectionRange(
    range: import('vscode-languageserver-types').SelectionRange
): vscode.SelectionRange {
    const parent = range.parent ? toVscodeSelectionRange(range.parent) : undefined;
    return new vscode.SelectionRange(
        new vscode.Range(
            range.range.start.line,
            range.range.start.character,
            range.range.end.line,
            range.range.end.character
        ),
        parent
    );
}

function getEditorIndentation(document: vscode.TextDocument): {
    tabSize: number;
    insertSpaces: boolean;
} {
    const configuration = vscode.workspace.getConfiguration('editor', document.uri);
    const textEditor = vscode.window.visibleTextEditors.find(candidate =>
        candidate.document.uri.toString() === document.uri.toString()
    );
    const detectIndentation = configuration.get<boolean>('detectIndentation', false);
    const configuredTabSize = configuration.get<number>('tabSize', 2);
    const configuredInsertSpaces = configuration.get<boolean>('insertSpaces', true);
    const tabSize = detectIndentation && typeof textEditor?.options.tabSize === 'number'
        ? textEditor.options.tabSize
        : configuredTabSize;
    const insertSpaces = detectIndentation && typeof textEditor?.options.insertSpaces === 'boolean'
        ? textEditor.options.insertSpaces
        : configuredInsertSpaces;
    return {
        tabSize: typeof tabSize === 'number' && tabSize > 0 ? Math.floor(tabSize) : 2,
        insertSpaces: typeof insertSpaces === 'boolean' ? insertSpaces : true
    };
}

async function startLanguageClient(context: vscode.ExtensionContext): Promise<LanguageClient> {
    const serverModule = context.asAbsolutePath(path.join('out', 'language', 'main.cjs'));
    // The debug options for the server
    // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging.
    // By setting `process.env.DEBUG_BREAK` to a truthy value, the language server will wait until a debugger is attached.
    const debugOptions = { execArgv: ['--nolazy', `--inspect${process.env.DEBUG_BREAK ? '-brk' : ''}=${process.env.DEBUG_SOCKET || '6009'}`] };

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: '*', language: 'thinai' }],
        middleware: {
            provideCompletionItem: async (document, position, completionContext, token, next) => {
                const completion = await next(document, position, completionContext, token);
                if (!completion) {
                    return completion;
                }
                const { tabSize, insertSpaces } = getEditorIndentation(document);
                const items = Array.isArray(completion) ? completion : completion.items;
                const adjustedItems = applyConfiguredIndentationToCompletions(items, tabSize, insertSpaces);
                return Array.isArray(completion)
                    ? adjustedItems
                    : { ...completion, items: adjustedItems };
            },
            provideDocumentFormattingEdits: (document, options, token, next) =>
                next(document, { ...options, ...getEditorIndentation(document) }, token),
            provideDocumentRangeFormattingEdits: (document, range, options, token, next) =>
                next(document, range, { ...options, ...getEditorIndentation(document) }, token),
            provideDocumentRangesFormattingEdits: (document, ranges, options, token, next) =>
                next(document, ranges, { ...options, ...getEditorIndentation(document) }, token),
            provideOnTypeFormattingEdits: (document, position, ch, options, token, next) =>
                next(document, position, ch, { ...options, ...getEditorIndentation(document) }, token)
        }
    };

    // Create the language client and start the client.
    const client = new LanguageClient(
        'thinai',
        'Thinai',
        serverOptions,
        clientOptions
    );

    // Start the client. This will also launch the server
    await client.start();
    return client;
}
