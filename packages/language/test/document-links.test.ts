import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
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

describe('Document links', () => {
    test('links bare, component, and quoted import paths', async () => {
        const text = `import "./bare.tni"
import { Common as Shared } from "./common.tni"
import { X } from 'single.tni'
import { Y } from """triple.tni"""`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/links/consumer.tni'),
            text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const links = await services.Thinai.lsp.DocumentLinkProvider!.getDocumentLinks(document, {
            textDocument: { uri: document.uri.toString() }
        });

        expect(links).toHaveLength(4);
        expect(links.map(link => document.textDocument.getText(link.range))).toEqual([
            './bare.tni',
            './common.tni',
            'single.tni',
            'triple.tni'
        ]);
        expect(links.map(link => link.target)).toEqual([
            'file:///workspace/links/bare.tni',
            'file:///workspace/links/common.tni',
            'file:///workspace/links/single.tni',
            'file:///workspace/links/triple.tni'
        ]);
        expect(links.every(link => typeof link.tooltip === 'string' && link.tooltip.startsWith('Open '))).toBe(true);
    });
});
