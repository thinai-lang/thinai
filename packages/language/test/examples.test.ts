import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
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

        const normalizedFormatted = formatted.replace(/\r\n/gu, '\n');
        expect(edits.length).toBeGreaterThan(0);
        expect(normalizedFormatted).toContain('actor Customer\n\nactor OrderManager\n\nin bounded context Ordering {');
        expect(normalizedFormatted).toContain('  application service OrderApplication {');
        expect(normalizedFormatted).toContain('      emits Contracts.OrderPlacedV1');
        expect(normalizedFormatted).toContain('      projects OrderSummary');
        expect(normalizedFormatted).toContain('method findCustomerOrders(customerId: CustomerId) returns List<OrderSummary> {');
        expect(normalizedFormatted).toContain('      with "input.orderId from [[Ordering.OrderSummary.orderId]]');
        expect(normalizedFormatted).not.toMatch(/^\t/m);

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

    test('validates every Thinai file in every example directory', async () => {
        const root = fileURLToPath(new URL('../../../examples/', import.meta.url));
        const files = (await readdir(root, { recursive: true }))
            .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.tni'))
            .sort();
        expect(files.length).toBeGreaterThan(0);

        documents = await Promise.all(files.map(async file => {
            const source = await readFile(path.join(root, file), 'utf8');
            return services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/examples/${file.split(path.sep).join('/')}`), source
            );
        }));
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const errors = documents.flatMap(document => (document.diagnostics ?? [])
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
            .map(diagnostic => ({ file: document.uri.fsPath, message: diagnostic.message }))
        );
        expect(errors).toEqual([]);
    });

    test('formats and revalidates every example file', async () => {
        const root = fileURLToPath(new URL('../../../examples/', import.meta.url));
        const files = (await readdir(root, { recursive: true }))
            .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.tni'))
            .sort();
        const sourceDocuments = await Promise.all(files.map(async file => {
            const source = await readFile(path.join(root, file), 'utf8');
            return {
                file,
                document: services.shared.workspace.LangiumDocuments.createDocument(
                    URI.file(`/workspace/examples-format-source/${file.split(path.sep).join('/')}`), source
                )
            };
        }));
        await services.shared.workspace.DocumentBuilder.build(sourceDocuments.map(entry => entry.document), {
            validation: false
        });

        const formattedDocuments: LangiumDocument[] = [];
        for (const { file, document } of sourceDocuments) {
            const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
                textDocument: { uri: document.uri.toString() },
                options: { tabSize: 2, insertSpaces: true }
            });
            const formatted = edits
                .slice()
                .sort((left, right) =>
                    document.textDocument.offsetAt(right.range.start) -
                    document.textDocument.offsetAt(left.range.start)
                )
                .reduce((text, edit) => {
                    const start = document.textDocument.offsetAt(edit.range.start);
                    const end = document.textDocument.offsetAt(edit.range.end);
                    return text.slice(0, start) + edit.newText + text.slice(end);
                }, document.textDocument.getText());
            formattedDocuments.push(services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/examples-formatted/${file.split(path.sep).join('/')}`),
                formatted
            ));
        }
        documents = [...sourceDocuments.map(entry => entry.document), ...formattedDocuments];
        await services.shared.workspace.DocumentBuilder.build(formattedDocuments, { validation: true });

        const errors = formattedDocuments.flatMap(document => (document.diagnostics ?? [])
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
            .map(diagnostic => ({ file: document.uri.fsPath, message: diagnostic.message }))
        );
        expect(errors).toEqual([]);
    });

    test('does not repeat exposure completion items in the shared contracts example', async () => {
        const source = await readFile(new URL('../../../examples/order-fulfillment/common-types.tni', import.meta.url), 'utf8');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/order-fulfillment/common-types-completion.tni'), source
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        for (const marker of ['exposes CorrelationId', 'exposes ExternalId']) {
            const offset = source.indexOf(marker) + marker.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const keys = (completion?.items ?? []).map(item => {
                const editKey = item.textEdit ? JSON.stringify(item.textEdit) : item.insertText ?? '';
                return [item.label, item.kind ?? '', item.detail ?? '', editKey].join('\u0000');
            });
            expect(new Set(keys).size, marker).toBe(keys.length);
        }
    });

    test('completion output has no exact duplicates or invalid text edits across examples', async () => {
        const exampleDirectory = new URL('../../../examples/order-fulfillment/', import.meta.url);
        const files = (await readdir(exampleDirectory)).filter(file => file.endsWith('.tni')).sort();
        documents = await Promise.all(files.map(async file => {
            const source = await readFile(new URL(file, exampleDirectory), 'utf8');
            return services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/order-fulfillment/${file}`), source
            );
        }));
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const duplicates: string[] = [];
        const invalidRanges: string[] = [];
        for (const document of documents) {
            const text = document.textDocument.getText();
            for (let offset = 0; offset <= text.length; offset += 23) {
                const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                    textDocument: { uri: document.uri.toString() },
                    position: document.textDocument.positionAt(offset)
                });
                const seen = new Set<string>();
                for (const item of completion?.items ?? []) {
                    if (typeof item.label !== 'string') {
                        continue;
                    }
                    const editKey = item.textEdit ? JSON.stringify(item.textEdit) : item.insertText ?? '';
                    const key = [item.label, item.kind ?? '', item.detail ?? '', editKey].join('\u0000');
                    if (seen.has(key)) {
                        duplicates.push(`${document.uri.path}@${offset}: ${item.label}`);
                    }
                    seen.add(key);

                    const edit = item.textEdit;
                    if (!edit) {
                        continue;
                    }
                    const ranges = 'range' in edit ? [edit.range] : [edit.insert, edit.replace];
                    for (const range of ranges) {
                        const start = document.textDocument.offsetAt(range.start);
                        const end = document.textDocument.offsetAt(range.end);
                        if (start > end || end > text.length) {
                            invalidRanges.push(`${document.uri.path}@${offset}: ${item.label} ${start}-${end}`);
                        }
                    }
                }
            }
        }
        expect(duplicates).toEqual([]);
        expect(invalidRanges).toEqual([]);
    }, 30_000);

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
