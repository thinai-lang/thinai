import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from 'thinai-language';
import { DiagnosticSeverity } from 'vscode-languageserver';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

describe('Order Fulfillment example', () => {
    test('formats the complete ordering-events model', async () => {
        const source = await readFile(new URL('../../../examples/order-fulfillment/ordering-events.tni', import.meta.url), 'utf8');
        const misformattedSource = source
            .replace(/^( +)/gm, indentation => '\t'.repeat(indentation.length / 2))
            .replace('emits Contracts.OrderPlacedV1', 'emits\n        Contracts.OrderPlacedV1')
            .replace('projects OrderSummary', 'projects\n        OrderSummary');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/order-fulfillment/ordering-events.tni'), misformattedSource
        );
        documents = [document];

        expect(document.parseResult.lexerErrors).toHaveLength(0);
        expect(document.parseResult.parserErrors).toHaveLength(0);
        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, misformattedSource);

        expect(edits.length).toBeGreaterThan(0);
        expect(formatted).toContain('actor Customer\n\nactor OrderManager\n\nin bounded context Ordering {');
        expect(formatted).toContain('  application service OrderApplication {');
        expect(formatted).toContain('      emits Contracts.OrderPlacedV1');
        expect(formatted).toContain('      projects OrderSummary');
        expect(formatted).toContain('method findCustomerOrders(customerId: CustomerId) returns List<OrderSummary> {');
        expect(formatted).toContain('      with "input.orderId from [[Ordering.OrderSummary.orderId]]');
        expect(formatted).not.toMatch(/^\t/m);

        const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatted-ordering-events.tni'), formatted
        );
        documents.push(formattedDocument);
        expect(await services.Thinai.lsp.Formatter!.formatDocument(formattedDocument, {
            textDocument: { uri: formattedDocument.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        })).toEqual([]);
    });

    test('validates every Thinai file in the example workspace', async () => {
        const exampleDirectory = new URL('../../../examples/order-fulfillment/', import.meta.url);
        const files = (await readdir(exampleDirectory)).filter(file => file.endsWith('.tni')).sort();
        documents = await Promise.all(files.map(async file => {
            const source = await readFile(new URL(file, exampleDirectory), 'utf8');
            return services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/order-fulfillment/${file}`), source
            );
        }));
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const errors = documents.flatMap(document => (document.diagnostics ?? [])
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
            .map(diagnostic => ({ file: document.uri.fsPath, message: diagnostic.message }))
        );
        expect(errors).toEqual([]);
    });

    test('completes cross-context commands in an example journey', async () => {
        const exampleDirectory = new URL('../../../examples/order-fulfillment/', import.meta.url);
        const importedFiles = ['ordering-events.tni', 'shipping.tni'];
        const importDocuments = await Promise.all(importedFiles.map(async file => {
            const source = await readFile(new URL(file, exampleDirectory), 'utf8');
            return services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/order-fulfillment/${file}`), source
            );
        }));
        const journeyText = await readFile(new URL('cross-context-journey.tni', exampleDirectory), 'utf8');
        const journey = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/order-fulfillment/cross-context-journey.tni'), journeyText
        );
        documents = [...importDocuments, journey];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = journeyText.lastIndexOf('Shipping.ShipmentApplication.createShipment') + 'Shipping.'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(journey, {
            textDocument: { uri: journey.uri.toString() },
            position: journey.textDocument.positionAt(offset)
        });
        expect(completion?.items.map(item => item.label)).toContain('ShipmentApplication');
    });
});
