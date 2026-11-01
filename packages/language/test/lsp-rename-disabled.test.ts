import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import type { InitializeParams } from 'vscode-languageserver';
import { createThinaiServices } from '../src/index.js';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

describe('Rename capability', () => {
    test('is not advertised during the alpha', async () => {
        const result = await services.shared.lsp.LanguageServer.initialize({
            processId: null,
            rootUri: null,
            capabilities: {},
            workspaceFolders: null
        } as InitializeParams);

        expect((result.capabilities as { renameProvider?: unknown }).renameProvider).toBeUndefined();
    });

    test('direct rename requests are disabled', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/rename-disabled.tni'),
            'bounded context Ordering'
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const edit = await services.Thinai.lsp.RenameProvider?.rename(document, {
            textDocument: { uri: document.uri.toString() },
            position: { line: 0, character: 17 },
            newName: 'Renamed'
        });

        expect(edit).toBeUndefined();
    });
});
