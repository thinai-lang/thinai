import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { SemanticTokensDecoder } from 'langium/lsp';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from 'thinai-language';
import { CompletionItemKind } from 'vscode-languageserver';

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
    test('offers context members and declaration keywords automatically', async () => {
        const text = 'bounded context Sample {\n    \n}\n';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/declaration-completion.tni'), text
        );
        documents = [document];

        const position = text.indexOf('\n    ') + '    '.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(position)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toEqual(expect.arrayContaining([
            'aggregate', 'application', 'domain', 'repository', 'factory', 'projector', 'query', 'module'
        ]));
        expect(labels).not.toContain('capability');
    });

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
                application service OrderApplication {
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

        const highlightedReferences = decoded.filter(token => ['place', 'status'].includes(token.text));
        expect(highlightedReferences.map(token => [token.text, token.tokenType])).toEqual([
            ['place', 'method'],
            ['status', 'property'],
            ['place', 'method'],
            ['status', 'property']
        ]);
        expect(highlightedReferences.slice(0, 2).map(token => token.tokenModifiers)).toEqual([4, 4]);
    });

    test('classifies Thinai declarations with standard semantic token types', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/semantic-declarations.tni'),
            `bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place();
                        identifier id: OrderId;
                        status: OrderStatus;
                    }
                    value object OrderId { raw: string; }
                    enum OrderStatus { Draft, Placed }
                }
                event OrderPlaced;
                domain service Authorization;
            }`
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const provider = services.Thinai.lsp.SemanticTokenProvider;
        const tokens = await provider!.semanticHighlight(document, {
            textDocument: { uri: document.uri.toString() }
        });
        const decoded = SemanticTokensDecoder.decode(tokens, provider!.tokenTypes, document);
        const declarations = decoded.filter(token => token.tokenModifiers === 4);
        const declaredTypes = new Map(declarations.map(token => [token.text, token.tokenType]));
        expect(declaredTypes.get('Ordering')).toBe('namespace');
        expect(declaredTypes.get('Order')).toBe('class');
        expect(declaredTypes.get('OrderId')).toBe('struct');
        expect(declaredTypes.get('OrderStatus')).toBe('enum');
        expect(declaredTypes.get('Draft')).toBe('enumMember');
        expect(declaredTypes.get('Authorization')).toBe('class');
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

    test('navigates from import paths to the start of target documents', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/common-types.tni'),
            'shared kernel CommonTypes {}'
        );
        const importText = 'import "./common-types.tni";';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-link.tni'), importText
        );
        documents = [target, source];

        const pathOffset = importText.indexOf('./common-types.tni');
        const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(pathOffset)
        });
        expect(definitions).toHaveLength(1);
        expect(definitions?.[0]?.targetUri).toBe(target.uri.toString());
        expect(definitions?.[0]?.originSelectionRange).toEqual({
            start: source.textDocument.positionAt(pathOffset),
            end: source.textDocument.positionAt(pathOffset + './common-types.tni'.length)
        });
        expect(definitions?.[0]?.targetSelectionRange.start).toEqual({ line: 0, character: 0 });
    });

    test('completes invocation path segments with Thinai symbol kinds', async () => {
        const template = `bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method place();
                    method submit() { invokes  ; }
                    identifier id: OrderId;
                }
                value object OrderId { raw: string; }
            }
        }`;
        documents = [];
        for (const prefix of ['', 'O', 'Or', 'Order']) {
            const typedText = template.replace('invokes  ;', `invokes ${prefix} ;`);
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/invocation-completion-${prefix || 'empty'}.tni`), typedText
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
            const source = typedText.indexOf(`invokes ${prefix} ;`) + 'invokes '.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source + prefix.length)
            });
            expect(completion?.items.some(item => item.label === 'Order' && item.detail?.includes('Aggregate') === true)).toBe(true);
        }

        const withPrefix = template.replace('invokes  ;', 'invokes Order. ;');
        const prefixedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/invocation-completion-prefix.tni'), withPrefix
        );
        documents.push(prefixedDocument);
        await services.shared.workspace.DocumentBuilder.build([prefixedDocument], { validation: true });
        const childSegmentOffset = withPrefix.indexOf('invokes Order.') + 'invokes Order.'.length;
        const childItems = await services.Thinai.lsp.CompletionProvider?.getCompletion(prefixedDocument, {
            textDocument: { uri: prefixedDocument.uri.toString() },
            position: prefixedDocument.textDocument.positionAt(childSegmentOffset)
        });
        expect(childItems?.items.find(item => item.label === 'place')).toMatchObject({
            kind: CompletionItemKind.Method,
            detail: expect.stringContaining('place(')
        });
        expect(childItems?.items.find(item => item.label === 'Order')).toMatchObject({
            kind: CompletionItemKind.Class,
            detail: expect.stringContaining('Entity Order')
        });
    });

    test('keeps nested behavior references available while typing', async () => {
        for (const prefix of ['o', 'or', 'order']) {
            const text = `bounded context Ordering {
                data object Request { orderId: string; }
                application service OrderApplication {
                    method place(request: Request) { behavior "Use [[request.${prefix}]]"; }
                }
            }`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/specification-completion-${prefix}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

            const referenceStart = text.indexOf('[[request.') + '[[request.'.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(referenceStart + prefix.length)
            });
            expect(completion?.items.some(item => item.label === 'orderId' && item.kind === CompletionItemKind.Field)).toBe(true);
        }
    });

    test('triggers completion when an inline specification reference opens', async () => {
        const text = `bounded context Ordering {
            data object Request { orderId: string; }
            application service OrderApplication {
                method place(request: Request) { behavior "Use [[request.orderId]]"; }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/specification-open-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(services.Thinai.lsp.CompletionProvider?.completionOptions?.triggerCharacters).toContain('[');
        const openingOffset = text.indexOf('[[request.orderId]]') + '[['.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(openingOffset)
        });
        expect(completion?.items.some(item => item.label === 'request' && item.kind === CompletionItemKind.Variable)).toBe(true);
    });

    test('offers read models for projector targets with read-model icons', async () => {
        const text = `bounded context Ordering {
            read model OrderSummary { status: string; }
            event OrderPlaced;
            projector OrderProjector {
                method onOrderPlaced(source: OrderPlaced) { projects  ; }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('projects  ;') + 'projects '.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        expect(completion?.items.find(item => item.label === 'OrderSummary')).toMatchObject({
            kind: CompletionItemKind.Struct,
            detail: expect.stringContaining('OrderSummary')
        });
    });

    test('offers entity fields and enum members in transition clauses', async () => {
        const text = `bounded context Shipping {
            aggregate Shipment {
                root entity Shipment {
                    method ship() { transition status from  to Shipped; }
                    identifier id: ShipmentId;
                    status: ShipmentStatus;
                }
                value object ShipmentId { raw: string; }
                enum ShipmentStatus { Open, Shipped }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/transition-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const transition = text.indexOf('transition status');
        const fieldItems = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(transition + 'transition '.length)
        });
        expect(fieldItems?.items.find(item => item.label === 'status')).toMatchObject({
            kind: CompletionItemKind.Field,
            detail: expect.stringContaining('.status:')
        });

        const enumValueOffset = text.indexOf('from  to') + 'from '.length;
        const valueItems = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(enumValueOffset)
        });
        expect(valueItems?.items.find(item => item.label === 'Open')).toMatchObject({
            kind: CompletionItemKind.EnumMember,
            detail: expect.stringContaining('.Open')
        });
    });

    test('offers an import code action for an unresolved indexed declaration', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering { event OrderPlaced; }'
        );
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/consumer.tni'),
            'bounded context Shipping { application service ShipmentApplication { method onOrderPlaced(source: OrderPlaced) {} } }'
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
