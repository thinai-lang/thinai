import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { EmptyFileSystem, URI } from 'langium';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import { createThinaiServices, createThinaiSelectionRange, applyConfiguredIndentationToCompletions } from 'thinai-language';

let client: LanguageClient;

// This function is called when the extension is activated.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    registerThinaiSelectionRanges(context);
    client = await startLanguageClient(context);
}

// This function is called when the extension is deactivated.
export function deactivate(): Thenable<void> | undefined {
    if (client) {
        return client.stop();
    }
    return undefined;
}

function registerThinaiSelectionRanges(context: vscode.ExtensionContext): void {
    const { shared } = createThinaiServices(EmptyFileSystem);
    context.subscriptions.push(vscode.languages.registerSelectionRangeProvider('thinai', {
        provideSelectionRanges(document, positions) {
            const langiumDocument = shared.workspace.LangiumDocumentFactory.fromString(
                document.getText(),
                URI.parse(document.uri.toString())
            );
            const ranges = positions.map(position => createThinaiSelectionRange(langiumDocument, position));
            if (ranges.some(range => !range)) {
                return undefined;
            }
            return ranges.map(range => toVscodeSelectionRange(range!));
        }
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
                const editor = vscode.workspace.getConfiguration('editor', document.uri);
                const textEditor = vscode.window.visibleTextEditors.find(candidate =>
                    candidate.document.uri.toString() === document.uri.toString()
                );
                const configuredTabSize = textEditor?.options.tabSize ?? editor.get<unknown>('tabSize', 2);
                const tabSize = typeof configuredTabSize === 'number' && configuredTabSize > 0
                    ? configuredTabSize
                    : 2;
                const configuredInsertSpaces = editor.get<unknown>('insertSpaces', true);
                const editorInsertSpaces = textEditor?.options.insertSpaces;
                const insertSpaces = typeof editorInsertSpaces === 'boolean'
                    ? editorInsertSpaces
                    : typeof configuredInsertSpaces === 'boolean' ? configuredInsertSpaces : true;
                const items = Array.isArray(completion) ? completion : completion.items;
                const adjustedItems = applyConfiguredIndentationToCompletions(items, tabSize, insertSpaces);
                return Array.isArray(completion)
                    ? adjustedItems
                    : { ...completion, items: adjustedItems };
            }
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
