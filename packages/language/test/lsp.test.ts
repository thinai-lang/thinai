import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { SemanticTokensDecoder } from 'langium/lsp';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from 'thinai-language';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

describe('LSP services', () => {
    test('highlights linked behavior references as methods and fields', async () => {
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/behavior-highlighting.tni'),
            `bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place();
                        identifier id: OrderId;
                        status: string;
                    }
                    value object OrderId { raw: string; }
                }
                application service OrderApplication for Order {
                    method placeOrder() {
                        behavior "Place with [[Order.Order.place]] while status is [[Order.Order.status]]";
                    }
                }
            }`
        );
        documents = [source];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const provider = services.Thinai.lsp.SemanticTokenProvider;
        expect(provider).toBeDefined();
        const tokens = await provider!.semanticHighlight(source, {
            textDocument: { uri: source.uri.toString() }
        });
        const decoded = SemanticTokensDecoder.decode(tokens, provider!.tokenTypes, source);

        expect(decoded.filter(token => token.text.startsWith('Order.')).map(token => [token.text, token.tokenType])).toEqual([
            ['Order.Order.place', 'method'],
            ['Order.Order.status', 'property']
        ]);
    });

    test('suggests workspace files inside import paths', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering {}'
        );
        const sourceText = 'import "./';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/consumer.tni'),
            sourceText
        );
        documents = [target, source];

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(sourceText.length)
        });

        expect(completion?.items.some(item => item.label === './ordering.tni')).toBe(true);
    });

    test('offers an import code action for an unresolved indexed declaration', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering { event OrderPlaced; }'
        );
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/consumer.tni'),
            'bounded context Shipping { application service ShipmentApplication for Shipment { method onOrderPlaced(source: event OrderPlaced) {} } }'
        );
        documents = [target, source];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const actions = await services.Thinai.lsp.CodeActionProvider?.getCodeActions(source, {
            textDocument: { uri: source.uri.toString() },
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: source.textDocument.getText().length }
            },
            context: { diagnostics: source.diagnostics ?? [] }
        });

        expect(actions?.some(action => 'title' in action && action.title === "Import 'OrderPlaced' from './ordering.tni'")).toBe(true);
    });
});
