import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
import type { Model } from 'thinai-language';
import { createThinaiServices, isModel } from 'thinai-language';
import type { Diagnostic } from 'vscode-languageserver-types';

let services: ReturnType<typeof createThinaiServices>;
let parse: ReturnType<typeof parseHelper<Model>>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
    const doParse = parseHelper<Model>(services.Thinai);
    parse = (input: string) => doParse(input, { validation: true });
});

afterEach(async () => {
    await clearDocuments(services.shared, services.shared.workspace.LangiumDocuments.all.toArray());
    documents = [];
});

describe('Validating', () => {
    test('accepts a valid aggregate command and event model', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order root OrderRoot {
                    entity OrderRoot;
                }
                command PlaceOrder targets Order emits OrderPlaced;
                event OrderPlaced for Order;
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('requires commands to target an aggregate', async () => {
        const document = await parse(`
            bounded context Ordering {
                command PlaceOrder;
            }
        `);

        expect(
            checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')
        ).toEqual(expect.stringContaining('A command must target an aggregate.'));
    });

    test('rejects duplicate canonical context declarations', async () => {
        const first = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-one.tni'),
            'bounded context Ordering {}'
        );
        const second = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-two.tni'),
            'bounded context Ordering {}'
        );
        documents = [first, second];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(first.diagnostics?.some(diagnostic => diagnostic.message === "Duplicate declaration 'Ordering'.")).toBe(true);
    });
});

function checkDocumentValid(document: LangiumDocument): string | undefined {
    return document.parseResult.parserErrors.length && `Parser errors: ${document.parseResult.parserErrors.map(error => error.message).join('; ')}`
        || document.parseResult.value === undefined && `ParseResult is 'undefined'.`
        || !isModel(document.parseResult.value) && `Root AST object is a ${document.parseResult.value.$type}, expected a 'Model'.`
        || undefined;
}

function diagnosticToString(diagnostic: Diagnostic): string {
    return `[${diagnostic.range.start.line}:${diagnostic.range.start.character}..${diagnostic.range.end.line}:${diagnostic.range.end.character}]: ${diagnostic.message}`;
}
