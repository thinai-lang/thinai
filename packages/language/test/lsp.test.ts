import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
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
    test('formats nested Thinai declarations using the editor indentation options', async () => {
        const source = 'bounded context Ordering { aggregate Order { root entity Order { identifier id:OrderId items:Map<string,number> } } enum OrderStatus { Draft,Placed } } actor Customer';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatting.tni'), source
        );
        documents = [document];

        const formatter = services.Thinai.lsp.Formatter;
        expect(formatter).toBeDefined();
        const edits = await formatter!.formatDocument(document, {
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
            }, source);

        expect(formatted).toBe([
            'bounded context Ordering {',
            '  aggregate Order {',
            '    root entity Order {',
            '      identifier id: OrderId',
            '      items: Map<string, number>',
            '    }',
            '  }',
            '',
            '  enum OrderStatus {',
            '    Draft,',
            '    Placed',
            '  }',
            '}',
            '',
            'actor Customer'
        ].join('\n'));
        const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatted.tni'), formatted
        );
        documents.push(formattedDocument);
        expect(await formatter!.formatDocument(formattedDocument, {
            textDocument: { uri: formattedDocument.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        })).toEqual([]);
    });

    test('separates member groups without splitting adjacent fields and preserves comments and text', async () => {
        const source = 'bounded context Sample{aggregate Thing{root entity Item{\n// Keep this; note\nmethod first(){behavior "Preserve; this text"}method second(){}identifier id:string name:string}}}';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/member-formatting.tni'), source
        );
        documents = [document];
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
            }, source);

        expect(formatted).toBe([
            'bounded context Sample {',
            '  aggregate Thing {',
            '    root entity Item {',
            '      // Keep this; note',
            '      method first() {',
            '        behavior "Preserve; this text"',
            '      }',
            '',
            '      method second() {}',
            '',
            '      identifier id: string',
            '      name: string',
            '    }',
            '  }',
            '}'
        ].join('\n'));
    });

    test('formats the complete order-fulfillment example', async () => {
        const source = await readFile(new URL('../../../examples/order-fulfillment/ordering-events.tni', import.meta.url), 'utf8');
        const misformattedSource = source
            .replace(/^( +)/gm, indentation => '\t'.repeat(indentation.length / 2))
            .replace('emits Contracts.OrderPlacedV1', 'emits\n        Contracts.OrderPlacedV1')
            .replace('projects OrderSummary', 'projects\n        OrderSummary');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-events.tni'), misformattedSource
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
        expect(formatted).toContain('actor Customer\n\npart of bounded context Ordering {');
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

    test('formats existing tabs as two spaces when requested by the editor', async () => {
        const source = 'bounded context Sample {\n\taggregate Order {\n\t\troot entity Order {\n\t\t\tidentifier id:string\n\t\t}\n\t}\n}';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/tab-indented.tni'), source
        );
        documents = [document];
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
            }, source);

        expect(formatted).toBe([
            'bounded context Sample {',
            '  aggregate Order {',
            '    root entity Order {',
            '      identifier id: string',
            '    }',
            '  }',
            '}'
        ].join('\n'));
        expect(formatted).not.toContain('\t');
    });

    test('does not apply document-wide separators to a selected range', async () => {
        const source = 'import "./common.tni"\nactor Customer\nbounded context Sample {}';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/format-selection.tni'), source
        );
        documents = [document];
        const actorOffset = source.indexOf('actor Customer');
        const edits = await services.Thinai.lsp.Formatter!.formatDocumentRange(document, {
            textDocument: { uri: document.uri.toString() },
            range: {
                start: document.textDocument.positionAt(actorOffset),
                end: document.textDocument.positionAt(actorOffset + 'actor Customer'.length)
            },
            options: { tabSize: 2, insertSpaces: true }
        });

        expect(edits).toEqual([]);
    });

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
                        method place()
                        identifier id: OrderId
                        status: string
                    }
                    value object OrderId { raw: string }
                }
                application service OrderApplication {
                    method placeOrder() {
                        behavior "Place with [[Order.Order.place]] while status is [[Order.Order.status]]"
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
                        method place()
                        identifier id: OrderId
                        status: OrderStatus
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                }
                event OrderPlaced
                domain service Authorization
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
        const importText = 'import "./common-types.tni"';
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
                    method place()
                    method submit() { invokes   }
                    identifier id: OrderId
                }
                value object OrderId { raw: string }
            }
        }`;
        documents = [];
        for (const prefix of ['', 'O', 'Or', 'Order']) {
            const typedText = template.replace('invokes  ', `invokes ${prefix} `);
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/invocation-completion-${prefix || 'empty'}.tni`), typedText
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
            const source = typedText.indexOf(`invokes ${prefix} `) + 'invokes '.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source + prefix.length)
            });
            expect(completion?.items.some(item => item.label === 'Order' && item.detail?.includes('Aggregate') === true)).toBe(true);
        }

        const withPrefix = template.replace('invokes  ', 'invokes Order. ');
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
                data object Request { orderId: string }
                application service OrderApplication {
                    method place(request: Request) { behavior "Use [[request.${prefix}]]" }
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
            data object Request { orderId: string }
            application service OrderApplication {
                method place(request: Request) { behavior "Use [[request.orderId]]" }
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
            read model OrderSummary { status: string }
            event OrderPlaced
            projector OrderProjector {
                method onOrderPlaced(source: OrderPlaced) { projects   }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('projects  ') + 'projects '.length;
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
                    method ship() { transition status from  to Shipped }
                    identifier id: ShipmentId
                    status: ShipmentStatus
                }
                value object ShipmentId { raw: string }
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

    test('hides declarations in sibling modules unless exposed through a dependency', async () => {
        const text = `bounded context Ordering {
            module Internal {
                value object PrivateCode { raw: string }
            }
            module Consumer {
                data object Request { code: PrivateC }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/module-private-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('PrivateC') + 'PrivateC'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        expect(completion?.items.some(item => item.label === 'PrivateCode')).toBe(false);

        const allowedText = `bounded context Shipping {
            module Producer {
                exposes ExposedCode
                value object ExposedCode { raw: string }
            }
            module Consumer depends on Producer {
                data object Request { code: ExposedC }
            }
        }`;
        const allowedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/module-exposed-completion.tni'), allowedText
        );
        documents.push(allowedDocument);
        await services.shared.workspace.DocumentBuilder.build([allowedDocument], { validation: true });
        const allowedOffset = allowedText.indexOf('ExposedC') + 'ExposedC'.length;
        const allowedCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(allowedDocument, {
            textDocument: { uri: allowedDocument.uri.toString() },
            position: allowedDocument.textDocument.positionAt(allowedOffset)
        });
        expect(allowedCompletion?.items.some(item => item.label === 'ExposedCode')).toBe(true);
    });

    test('filters private cross-context types and domain events from completion', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-producer.tni'),
            'bounded context Ordering { value object OrderId { raw: string } event OrderPlaced }'
        );
        const text = `import "./completion-producer.tni"
            bounded context Shipping {
                application service ShipmentApplication {
                    method receive(source: Order) {}
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-consumer.tni'), text
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('source: Order') + 'source: Order'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).not.toContain('OrderId');
        expect(labels).not.toContain('OrderPlaced');

        const eventContexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/authorized-event-contexts.tni'),
            'bounded context Ordering { integration event OrderPlacedV1 } bounded context Shipping {}'
        );
        const eventMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/authorized-event-map.tni'),
            'import "./authorized-event-contexts.tni" context map Fulfillment { partner Shipping <-> partner Ordering }'
        );
        const authorizedText = `import "./authorized-event-contexts.tni"
            import "./authorized-event-map.tni"
            part of bounded context Shipping {
                application service ShipmentApplication {
                    method receive(source: OrderPlaced) {}
                }
            }`;
        const authorizedConsumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/authorized-event-completion.tni'), authorizedText
        );
        documents.push(eventContexts, eventMap, authorizedConsumer);
        await services.shared.workspace.DocumentBuilder.build([eventContexts, eventMap, authorizedConsumer], { validation: true });
        const authorizedOffset = authorizedText.indexOf('source: OrderPlaced') + 'source: OrderPlaced'.length;
        const authorizedCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(authorizedConsumer, {
            textDocument: { uri: authorizedConsumer.uri.toString() },
            position: authorizedConsumer.textDocument.positionAt(authorizedOffset)
        });
        expect(authorizedCompletion?.items.some(item => item.label === 'OrderPlacedV1')).toBe(true);
    });

    test('filters private cross-context declarations from inline specification references', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/specification-private-producer.tni'),
            'bounded context Ordering { aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } } }'
        );
        const text = `import "./specification-private-producer.tni"
            bounded context Shipping {
                application service ShipmentApplication {
                    method receive() { behavior "Use [[Ordering.Order]]" }
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/specification-private-consumer.tni'), text
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('Ordering.Order]]') + 'Ordering.Order'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        expect(completion?.items.some(item => item.label === 'OrderId')).toBe(false);
    });

    test('filters foreign read models and events from projector and emit completions', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/foreign-projections.tni'),
            'bounded context Ordering { read model OrderSummary { total: number } integration event OrderPlacedV1 }'
        );
        const text = `import "./foreign-projections.tni"
            bounded context Shipping {
                read model ShipmentSummary { status: string }
                event ShipmentSent
                aggregate Shipment {
                    root entity Shipment {
                        method ship() { emits ShipmentSent }
                        identifier id: ShipmentId
                    }
                    value object ShipmentId { raw: string }
                }
                projector ShipmentProjector {
                    method project(source: ShipmentSent) { projects OrderSummary }
                }
                application service ShipmentApplication {
                    method dispatch() { emits OrderPlacedV1 }
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/foreign-projections-consumer.tni'), text
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const projectionsOffset = text.indexOf('projects OrderSummary') + 'projects OrderSummary'.length;
        const projections = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(projectionsOffset)
        });
        expect(projections?.items.some(item => item.label === 'OrderSummary')).toBe(false);

        const emitsOffset = text.indexOf('emits OrderPlacedV1') + 'emits OrderPlacedV1'.length;
        const emits = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(emitsOffset)
        });
        expect(emits?.items.some(item => item.label === 'OrderPlacedV1')).toBe(false);
        expect(emits?.items.some(item => item.label === 'Ordering')).toBe(false);

        const localEmitsOffset = text.indexOf('emits ShipmentSent') + 'emits ShipmentSent'.length;
        const localEmits = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(localEmitsOffset)
        });
        expect(localEmits?.items.some(item => item.label === 'ShipmentSent')).toBe(true);
    });

    test('filters unqualified child entities from repository-root completion', async () => {
        const text = `bounded context Shipping {
            aggregate Shipment {
                root entity Shipment { identifier id: ShipmentId }
                entity ShipmentLine { identifier id: ShipmentLineId }
                value object ShipmentId { raw: string }
                value object ShipmentLineId { raw: string }
            }
            repository ShipmentRepository manages ShipmentL
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/repository-root-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('ShipmentL') + 'ShipmentL'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        expect(completion?.items.some(item => item.label === 'ShipmentLine')).toBe(false);
    });

    test('filters inaccessible module and query-service invocation targets', async () => {
        const text = `bounded context Ordering {
            module Producer {
                domain service Policy { method check() }
            }
            module Consumer {
                domain service Handler { method run() { invokes Policy.ch } }
            }
            query service FirstQueries { method first() { invokes SecondQueries.other } }
            query service SecondQueries { method other() }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/invocation-scope-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const moduleOffset = text.indexOf('Policy.ch') + 'Policy.ch'.length;
        const moduleCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(moduleOffset)
        });
        expect(moduleCompletion?.items.some(item => item.label === 'check')).toBe(false);

        const queryOffset = text.indexOf('SecondQueries.other') + 'SecondQueries.other'.length;
        const queryCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(queryOffset)
        });
        expect(queryCompletion?.items.some(item => item.label === 'other')).toBe(false);
    });

    test('does not suggest cross-context invocation targets from an event handler', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/cross-context-invocation-producer.tni'),
            `bounded context Ordering {
                integration event OrderPlacedV1
                application service OrderApplication { method placeOrder() }
            }`
        );
        const text = `import "./cross-context-invocation-producer.tni"
            bounded context Shipping {
                application service ShipmentApplication {
                    method onOrderPlaced(source: Ordering.OrderPlacedV1) {
                        invokes Ordering.OrderApplication.placeOrder
                    }
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/cross-context-invocation-consumer.tni'), text
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('Ordering.OrderApplication.placeOrder') + 'Ordering.OrderApplication.'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        expect(completion?.items.some(item => item.label === 'placeOrder')).toBe(false);
    });

    test('completion reflects application-service invocation direction', async () => {
        const text = `bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method place() { invokes Pricing }
                    identifier id: OrderId
                }
                value object OrderId { raw: string }
            }
            domain service Pricing { method calculate() }
            application service OrderApplication {
                method placeOrder() {
                    invokes Pricing
                    invokes Order
                }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/application-invocation-direction-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const rootServiceOffset = text.indexOf('invokes Pricing') + 'invokes Pricing'.length;
        const rootServiceCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(rootServiceOffset)
        });
        expect(rootServiceCompletion?.items.some(item => item.label === 'Pricing')).toBe(false);

        const applicationServiceOffset = text.lastIndexOf('invokes Pricing') + 'invokes Pricing'.length;
        const applicationServiceCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(applicationServiceOffset)
        });
        expect(applicationServiceCompletion?.items.some(item => item.label === 'Pricing')).toBe(true);

        const applicationAggregateOffset = text.indexOf('invokes Order') + 'invokes Order'.length;
        const applicationAggregateCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(applicationAggregateOffset)
        });
        expect(applicationAggregateCompletion?.items.some(item => item.label === 'Order')).toBe(true);
    });

    test('completes shared-kernel domain services only for participating contexts', async () => {
        const shared = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-kernel.tni'),
            'shared kernel Common { domain service PricingPolicy { method normalize(amount: number) returns number } }'
        );
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-contexts.tni'),
            'bounded context Ordering {} bounded context Shipping {}'
        );
        const map = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-map.tni'),
            'import "./completion-shared-kernel.tni" import "./completion-shared-contexts.tni" context map SharedPolicies { sharedKernel Common { participants: [Ordering, Shipping] } }'
        );
        const text = `import "./completion-shared-contexts.tni"
            import { Common } from "./completion-shared-kernel.tni"
            import { SharedPolicies } from "./completion-shared-map.tni"
            part of bounded context Ordering {
                application service OrderApplication {
                    method normalize(amount: number) returns number { invokes Common.PricingPolicy.norm }
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-consumer.tni'), text
        );
        documents = [shared, contexts, map, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('Common.PricingPolicy.norm') + 'Common.PricingPolicy.norm'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        expect(completion?.items.some(item => item.label === 'normalize')).toBe(true);
    });

    test('journey path completion offers commands but not query methods', async () => {
        const text = `bounded context Ordering {
            application service OrderApplication {
                method placeOrder()
            }
            query service OrderQueries {
                method findOrder() returns string
            }
        }
        actor Customer
        journey PlaceOrder {
            by Customer {
                invoke Ordering.OrderApplication.
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/journey-command-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('Ordering.OrderApplication.') + 'Ordering.OrderApplication.'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('placeOrder');
        expect(labels).not.toContain('findOrder');
    });

    test('offers an import code action for an unresolved indexed declaration', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering { event OrderPlaced }'
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
