import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from '../src/index.js';
import type { TextEdit } from 'vscode-languageserver';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

function createDocument(fileName: string, text: string): LangiumDocument {
    const document = services.shared.workspace.LangiumDocuments.createDocument(
        URI.file(`/workspace/file-ops/${fileName}`),
        text
    );
    documents.push(document);
    return document;
}

function applyEdits(document: LangiumDocument, text: string, edits: TextEdit[]): string {
    return [...edits]
        .sort((left, right) =>
            document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start)
        )
        .reduce((source, edit) => {
            const start = document.textDocument.offsetAt(edit.range.start);
            const end = document.textDocument.offsetAt(edit.range.end);
            return source.slice(0, start) + edit.newText + source.slice(end);
        }, text);
}

describe('File operations', () => {
    test('advertises file rename handling', () => {
        const handler = services.shared.lsp.FileOperationHandler;
        expect(handler?.fileOperationOptions.willRename?.filters).toEqual([
            { scheme: 'file', pattern: { glob: '**/*' } }
        ]);
    });

    test('updates relative imports when a file is renamed', async () => {
        const commonText = 'shared kernel Common { value object V { raw: string } }';
        const consumerText = 'import "./common.tni"\nbounded context C';
        const nestedText = 'import { Common } from "../common.tni"\nbounded context D';
        const common = createDocument('common.tni', commonText);
        const consumer = createDocument('consumer.tni', consumerText);
        const nested = createDocument('sub/nested.tni', nestedText);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const edit = await services.shared.lsp.FileOperationHandler!.willRenameFiles!({
            files: [{
                oldUri: common.uri.toString(),
                newUri: URI.file('/workspace/file-ops/renamed.tni').toString()
            }]
        });

        const consumerEdits = edit?.changes?.[consumer.uri.toString()] ?? [];
        const nestedEdits = edit?.changes?.[nested.uri.toString()] ?? [];
        expect(applyEdits(consumer, consumerText, consumerEdits)).toContain('import "./renamed.tni"');
        expect(applyEdits(nested, nestedText, nestedEdits)).toContain('import { Common } from "../renamed.tni"');
    });

    test('updates imports under a renamed directory', async () => {
        const consumerText = 'import "./nested/inner.tni"\nbounded context E';
        const innerText = 'bounded context F';
        const consumer = createDocument('dir/consumer.tni', consumerText);
        createDocument('dir/nested/inner.tni', innerText);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const edit = await services.shared.lsp.FileOperationHandler!.willRenameFiles!({
            files: [{
                oldUri: URI.file('/workspace/file-ops/dir/nested').toString(),
                newUri: URI.file('/workspace/file-ops/dir/renamed').toString()
            }]
        });

        const edits = edit?.changes?.[consumer.uri.toString()] ?? [];
        expect(applyEdits(consumer, consumerText, edits)).toContain('import "./renamed/inner.tni"');
    });
});
