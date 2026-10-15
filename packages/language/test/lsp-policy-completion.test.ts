import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
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

describe('LSP policy completion', () => {
    test('offers the allowed declaration and method-body keywords in each block', async () => {
        const marker = '__completion_position__';
        const cases = [
            {
                name: 'method body',
                expected: ['invariant', 'precondition', 'postcondition', 'behavior', 'invokes'],
                forbidden: ['transition', 'projects', 'emits', 'identifier', 'entity', 'root entity'],
                source: `bounded context Ordering\nin bounded context Ordering { application service App { method execute() { ${marker} } } }`
            },
            {
                name: 'aggregate root method body',
                expected: ['transition', 'emits'],
                forbidden: ['identifier', 'entity', 'root entity'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { method place() { ${marker} } } } }`
            },
            {
                name: 'partially typed emits keyword in aggregate root method',
                expected: ['emits'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { method place() { emi${marker} } } } }`
            },
            {
                name: 'partially typed transition keyword in entity method',
                expected: ['transition'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { method place() { tran${marker} } } } }`
            },
            {
                name: 'partially typed projects keyword in projector method',
                expected: ['projects'],
                source: `bounded context Ordering\nin bounded context Ordering { projector OrderProjector { method project() { pro${marker} } } }`
            },
            {
                name: 'partially typed emits keyword is excluded from application service',
                expected: [],
                forbidden: ['emits'],
                source: `bounded context Ordering\nin bounded context Ordering { application service App { method place() { emi${marker} } } }`
            },
            {
                name: 'projector method body',
                expected: ['projects'],
                forbidden: ['invokes', 'transition', 'emits', 'returns'],
                source: `bounded context Ordering\nin bounded context Ordering { projector OrderProjector { method project() { ${marker} } } }`
            },
            {
                name: 'query-service method body allows read-helper invocation',
                expected: ['invokes'],
                source: `bounded context Ordering\nin bounded context Ordering { query service Queries { method find() returns string { ${marker} } } }`
            },
            {
                name: 'constructor body',
                expected: ['invariant', 'precondition', 'postcondition', 'behavior'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { constructor() { ${marker} }\nidentifier id: OrderId }\nvalue object OrderId { raw: string } } }`
            },
            {
                name: 'aggregate body',
                expected: ['entity', 'value object', 'enum', 'invariant'],
                forbidden: ['transition', 'projects', 'emits'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { ${marker} root entity Order { identifier id: OrderId }\nvalue object OrderId { raw: string } } }`
            },
            {
                name: 'entity fields allow identifier',
                expected: ['identifier'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { ${marker} } } }`
            },
            {
                name: 'value object fields exclude identifier',
                expected: ['method', 'constructor'],
                forbidden: ['identifier', 'entity', 'root entity'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { value object OrderId { ${marker} } } }`
            },
            {
                name: 'module body',
                expected: ['exposes', 'aggregate', 'application service', 'domain service', 'query service'],
                source: `bounded context Ordering\nin bounded context Ordering { module Api { ${marker} } }`
            },
            {
                name: 'unfinished module body on opening-brace line',
                expected: ['aggregate', 'application service', 'domain service', 'query service'],
                source: `bounded context Ordering\nin bounded context Ordering { module Api { ${marker}`
            },
            {
                name: 'journey body',
                expected: ['by'],
                source: `actor Customer\njourney PlaceOrder { ${marker} }`
            },
            {
                name: 'journey actor body',
                expected: ['invoke'],
                source: `actor Customer\njourney PlaceOrder { by Customer { ${marker} } }`
            },
            {
                name: 'context map body',
                expected: ['customer', 'partner', 'separateWays', 'sharedKernel'],
                source: `context map Fulfillment { ${marker} }`
            }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.source.indexOf(marker);
            const text = completionCase.source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/block-completion-${index}.tni`), text
            );
            documents.push(document);
            if (!completionCase.name.startsWith('unfinished') && !completionCase.name.startsWith('partially typed')) {
                expect(document.parseResult.parserErrors, completionCase.name).toHaveLength(0);
            }
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const keyword of completionCase.expected) {
                expect(labels, completionCase.name).toContain(keyword);
            }
            for (const keyword of completionCase.forbidden ?? []) {
                expect(labels, completionCase.name).not.toContain(keyword);
            }
        }
    });

    test('constrains projector and factory method specification completions', async () => {
        const model = `bounded context Ordering in bounded context Ordering {
            aggregate OrderAggregate {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            value object Price { amount: number }
            enum OrderStatus { Draft, Placed }
            event OrderPlaced
            read model OrderSummary { status: OrderStatus }
            domain service Pricing { method calculate() returns number }
            factory OrderFactory { method create() returns Order }
            projector OrderProjector {
                method project(source: OrderPlaced) { projects OrderSummary }
            }
        }`;
        const signaturePosition = model.indexOf(') { projects') + 1;
        const signatureDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-returns-keyword.tni'), model
        );
        documents.push(signatureDocument);
        const signatureCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(signatureDocument, {
            textDocument: { uri: signatureDocument.uri.toString() },
            position: signatureDocument.textDocument.positionAt(signaturePosition)
        });
        expect(signatureCompletion?.items.map(item => item.label)).not.toContain('returns');

        const projectorParameterText = model.replace(
            'method project(source: OrderPlaced)',
            'method project(source: )'
        );
        const projectorParameterDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-event-parameter-type.tni'), projectorParameterText
        );
        documents.push(projectorParameterDocument);
        await services.shared.workspace.DocumentBuilder.build([projectorParameterDocument], { validation: false });
        const parameterOffset = projectorParameterText.indexOf('source: ') + 'source: '.length;
        const parameterCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(projectorParameterDocument, {
            textDocument: { uri: projectorParameterDocument.uri.toString() },
            position: projectorParameterDocument.textDocument.positionAt(parameterOffset)
        });
        const parameterLabels = parameterCompletion?.items.map(item => item.label) ?? [];
        expect(parameterLabels).toContain('OrderPlaced');
        for (const invalid of ['Order', 'OrderId', 'Price', 'string', 'List']) {
            expect(parameterLabels).not.toContain(invalid);
        }

        const projectorReturnText = model.replace(
            'method project(source: OrderPlaced) { projects OrderSummary }',
            'method project(source: OrderPlaced) returns '
        );
        const projectorReturnDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-return-type.tni'), projectorReturnText
        );
        documents.push(projectorReturnDocument);
        await services.shared.workspace.DocumentBuilder.build([projectorReturnDocument], { validation: false });
        const returnOffset = projectorReturnText.indexOf('returns ', projectorReturnText.indexOf('projector OrderProjector')) + 'returns '.length;
        const projectorReturnCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(projectorReturnDocument, {
            textDocument: { uri: projectorReturnDocument.uri.toString() },
            position: projectorReturnDocument.textDocument.positionAt(returnOffset)
        });
        const projectorReturnLabels = projectorReturnCompletion?.items.map(item => item.label) ?? [];
        for (const invalid of ['string', 'List', 'Order', 'OrderId', 'Price', 'OrderStatus']) {
            expect(projectorReturnLabels).not.toContain(invalid);
        }

        const projectorInvocationText = model.replace(
            'projects OrderSummary',
            'invokes OrderFactory.cr'
        );
        const projectorInvocationDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-invocation-target.tni'), projectorInvocationText
        );
        documents.push(projectorInvocationDocument);
        await services.shared.workspace.DocumentBuilder.build([projectorInvocationDocument], { validation: false });
        const invocationOffset = projectorInvocationText.indexOf('OrderFactory.cr') + 'OrderFactory.cr'.length;
        const invocationCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(projectorInvocationDocument, {
            textDocument: { uri: projectorInvocationDocument.uri.toString() },
            position: projectorInvocationDocument.textDocument.positionAt(invocationOffset)
        });
        expect(invocationCompletion?.items.map(item => item.label)).not.toContain('create');

        const factoryText = model.replace('method create() returns Order', 'method create() returns ');
        const factoryDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/factory-return-type.tni'), factoryText
        );
        documents.push(factoryDocument);
        await services.shared.workspace.DocumentBuilder.build([factoryDocument], { validation: false });
        const factoryOffset = factoryText.indexOf('method create() returns ') + 'method create() returns '.length;
        const factoryCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(factoryDocument, {
            textDocument: { uri: factoryDocument.uri.toString() },
            position: factoryDocument.textDocument.positionAt(factoryOffset)
        });
        const factoryLabels = factoryCompletion?.items.map(item => item.label) ?? [];
        expect(factoryLabels).toContain('Order');
        for (const invalid of ['string', 'List', 'Price', 'OrderId', 'OrderStatus', 'OrderSummary']) {
            expect(factoryLabels).not.toContain(invalid);
        }
    });

    test('offers only subdomains, not arbitrary declarations, for bounded-context realization', async () => {
        const marker = '__completion_position__';
        const markedText = `subdomain Commerce
            bounded context Ordering realizes ${marker}
            in bounded context Ordering {
                aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
                application service Pricing {}
            }`;
        const offset = markedText.indexOf(marker);
        const text = markedText.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/realizes-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('Commerce');
        expect(labels).not.toContain('Order');
        expect(labels).not.toContain('Pricing');
    });

    test('completes valid module dependencies and excludes self, foreign, and cyclic modules', async () => {
        const marker = '__completion_position__';
        const markedText = `bounded context Ordering in bounded context Ordering {
            module A depends on ${marker} {}
            module B {}
            module C depends on A {}
        }
        bounded context Shipping in bounded context Shipping { module Foreign {} }`;
        const offset = markedText.indexOf(marker);
        const text = markedText.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/module-dependency-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('B');
        expect(labels).not.toContain('A');
        expect(labels).not.toContain('C');
        expect(labels).not.toContain('Foreign');
    });

    test('filters mirrors to foreign identifier value objects and query repositories to local read models', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reference-producer.tni'),
            `bounded context Ordering in bounded context Ordering {
                aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
                value object NotAnIdentifier { raw: string }
                read model ShipmentSummaryForeign {}
            }`
        );
        const marker = '__completion_position__';
        const markedText = `import "./reference-producer.tni"
            bounded context Shipping in bounded context Shipping {
                aggregate Shipment {
                    root entity Shipment { identifier id: ShipmentId }
                    value object ShipmentId { raw: string }
                    value object LocalMirror mirrors ${marker} {}
                }
                read model ShipmentSummary {}
                query repository ShipmentQueries {
                    serves ShipmentSummary${marker}
                }
            }`;
        const text = markedText.replace(marker, '').replace(marker, '');
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reference-consumer.tni'), text
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const mirrorOffset = markedText.indexOf(marker);
        const mirrorCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(mirrorOffset)
        });
        const mirrorLabels = mirrorCompletion?.items.map(item => item.label) ?? [];
        expect(mirrorLabels).toContain('OrderId');
        expect(mirrorLabels).not.toContain('NotAnIdentifier');
        expect(mirrorLabels).not.toContain('ShipmentId');

        const readModelOffset = text.indexOf('ShipmentSummary', text.indexOf('serves')) + 'ShipmentSummary'.length;
        const readModelCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(readModelOffset)
        });
        expect(readModelCompletion?.items.some(item => item.label === 'ShipmentSummaryForeign')).toBe(false);
        expect(readModelCompletion?.items.map(item => item.label)).toContain('ShipmentSummary');
    });

    test('filters invalid entity, read-model, and data-object method parameter types', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
            read model OrderSummary {}
            data object Request {}
            application service OrderApplication { method submit(input: ) {} }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/method-parameter-type-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        const offset = text.indexOf('input:') + 'input: '.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('Request');
        expect(labels).not.toContain('Order');
        expect(labels).not.toContain('OrderSummary');
    });

    test('offers enum states for initial values and allowed context-map integration patterns', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate Order { root entity Order { identifier id: OrderId status: Status initial Dr } value object OrderId { raw: string } enum Status { Draft, Placed } }
        }
        bounded context Shipping
        context map Fulfillment { customer Shipping { integrationPatterns: ["Anti"] } -> supplier Ordering }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/constrained-value-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const initialOffset = text.indexOf('initial Dr') + 'initial Dr'.length;
        const initialCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(initialOffset)
        });
        expect(initialCompletion?.items.some(item => item.label === 'Draft' && item.kind === CompletionItemKind.EnumMember)).toBe(true);

        const patternOffset = text.indexOf('"Anti') + '"Anti'.length;
        const patternCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(patternOffset)
        });
        expect(patternCompletion?.items.some(item => item.label === 'AntiCorruptionLayer')).toBe(true);
        expect(patternCompletion?.items.some(item => item.label === 'Conformist')).toBe(false);
    });

    test('does not offer initial-state values on optional or non-entity fields', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    identifier id: OrderId
                    optionalStatus?: Status initial Dr
                }
                value object OrderId { raw: string }
                value object StatusHolder { status: Status initial Dr }
                enum Status { Draft, Placed }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/invalid-initial-state-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        for (const marker of ['optionalStatus?: Status initial Dr', 'status: Status initial Dr']) {
            const offset = text.indexOf(marker) + marker.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items.map(item => item.label)).not.toContain('Draft');
            expect(completion?.items.map(item => item.label)).not.toContain('Placed');
        }
    });

    test('excludes the already-selected context from context-map endpoint and participant completions', async () => {
        const marker = '__completion_position__';
        const text = `bounded context Ordering
            bounded context Shipping
            bounded context Billing
            shared kernel Common
            context map Fulfillment {
                customer Ordering -> supplier ${marker}
                partner Ordering <-> partner ${marker}
                separateWays Ordering -x- ${marker}
                sharedKernel Common { participants: [Ordering, ${marker}] }
            }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/distinct-context-map-candidates.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const markers = [...text.matchAll(new RegExp(marker, 'gu'))];
        for (const [index, match] of markers.entries()) {
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(match.index)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            expect(labels, `completion ${index}`).not.toContain('Ordering');
            expect(labels, `completion ${index}`).toEqual(expect.arrayContaining(['Shipping', 'Billing']));
            for (const contextName of ['Shipping', 'Billing']) {
                expect(labels.filter(label => label === contextName), `completion ${index}: ${contextName}`).toHaveLength(1);
            }
        }
    });

    test('hides declarations in sibling modules unless exposed through a dependency', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            module Internal {
                value object PrivateCode { raw: string }
            }
            module Consumer {
                data object Request { code: PrivateC }
            }
            value object RootRequest { code: PrivateC }
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
        const rootOffset = text.lastIndexOf('PrivateC') + 'PrivateC'.length;
        const rootCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(rootOffset)
        });
        expect(rootCompletion?.items.some(item => item.label === 'PrivateCode')).toBe(false);

        const allowedText = `bounded context Shipping in bounded context Shipping {
            value object RootCode { raw: string }
            module Producer {
                exposes ExposedCode
                value object ExposedCode { raw: string }
            }
            module Consumer depends on Producer {
                data object Request {
                    code: ExposedC
                    rootCode: RootC
                }
            }
            value object RootRequest { code: ExposedC }
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
        const rootTypeOffset = allowedText.indexOf('rootCode: RootC') + 'rootCode: RootC'.length;
        const moduleRootTypeCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(allowedDocument, {
            textDocument: { uri: allowedDocument.uri.toString() },
            position: allowedDocument.textDocument.positionAt(rootTypeOffset)
        });
        expect(moduleRootTypeCompletion?.items.some(item => item.label === 'RootCode')).toBe(true);
        const exposedRootOffset = allowedText.lastIndexOf('ExposedC') + 'ExposedC'.length;
        const exposedRootCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(allowedDocument, {
            textDocument: { uri: allowedDocument.uri.toString() },
            position: allowedDocument.textDocument.positionAt(exposedRootOffset)
        });
        expect(exposedRootCompletion?.items.some(item => item.label === 'ExposedCode')).toBe(true);
    });

    test('filters private cross-context types and domain events from completion', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-producer.tni'),
            'bounded context Ordering in bounded context Ordering { value object OrderId { raw: string } event OrderPlaced }'
        );
        const text = `import "./completion-producer.tni"
            bounded context Shipping in bounded context Shipping {
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
            'bounded context Ordering in bounded context Ordering { integration event OrderPlacedV1 } bounded context Shipping'
        );
        const eventMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/authorized-event-map.tni'),
            'import "./authorized-event-contexts.tni" context map Fulfillment { partner Shipping <-> partner Ordering }'
        );
        const authorizedText = `import "./authorized-event-contexts.tni"
            import "./authorized-event-map.tni"
            in bounded context Shipping {
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
            'bounded context Ordering in bounded context Ordering { aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } } }'
        );
        const text = `import "./specification-private-producer.tni"
            bounded context Shipping in bounded context Shipping {
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
            'bounded context Ordering in bounded context Ordering { read model OrderSummary { total: number } integration event OrderPlacedV1 }'
        );
        const text = `import "./foreign-projections.tni"
            bounded context Shipping in bounded context Shipping {
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
        const text = `bounded context Shipping in bounded context Shipping {
            aggregate Shipment {
                root entity Shipment { identifier id: ShipmentId }
                entity ShipmentLine { identifier id: ShipmentLineId }
                value object ShipmentId { raw: string }
                value object ShipmentLineId { raw: string }
            }
            repository ShipmentRepository {
                manages ShipmentL
            }
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
        const text = `bounded context Ordering in bounded context Ordering {
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
            `bounded context Ordering in bounded context Ordering {
                integration event OrderPlacedV1
                application service OrderApplication { method placeOrder() }
            }`
        );
        const text = `import "./cross-context-invocation-producer.tni"
            bounded context Shipping in bounded context Shipping {
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
        const text = `bounded context Ordering in bounded context Ordering {
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

    test('limits domain-service invocation targets to other domain services', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate OrderAggregate {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            domain service Policy { method calculate() returns number }
            query service Queries { method find() returns string }
            factory OrderFactory { method create() returns Order }
            domain service Pricing {
                method calculate() { invokes Policy.ca }
                method read() { invokes Queries.fi }
                method create() { invokes OrderFactory.cr }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/domain-service-invocation-targets.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const cases = [
            { source: 'invokes Policy.ca', expected: 'calculate', forbidden: ['find', 'create'] },
            { source: 'invokes Queries.fi', expected: undefined, forbidden: ['find'] },
            { source: 'invokes OrderFactory.cr', expected: undefined, forbidden: ['create'] }
        ];
        for (const completionCase of cases) {
            const offset = text.indexOf(completionCase.source) + completionCase.source.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            if (completionCase.expected) {
                expect(labels).toContain(completionCase.expected);
            }
            for (const forbidden of completionCase.forbidden) {
                expect(labels).not.toContain(forbidden);
            }
        }
    });

    test('completes shared-kernel domain services only for participating contexts', async () => {
        const shared = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-kernel.tni'),
            'shared kernel Common { domain service PricingPolicy { method normalize(amount: number) returns number } }'
        );
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-contexts.tni'),
            'bounded context Ordering bounded context Shipping'
        );
        const map = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-map.tni'),
            'import "./completion-shared-kernel.tni" import "./completion-shared-contexts.tni" context map SharedPolicies { sharedKernel Common { participants: [Ordering, Shipping] } }'
        );
        const text = `import "./completion-shared-contexts.tni"
            import { Common } from "./completion-shared-kernel.tni"
            import { SharedPolicies } from "./completion-shared-map.tni"
            in bounded context Ordering {
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
        const text = `bounded context Ordering in bounded context Ordering {
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

    test('journey references require exposed module commands', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            module Internal {
                application service PrivateCommands {
                    method run()
                }
            }
            module Public {
                exposes PublicCommands, placeOrder
                application service PublicCommands {
                    method placeOrder()
                }
            }
        }
        actor Customer
        journey PlaceOrder {
            by Customer {
                invoke Ordering.Internal.PrivateCommands.ru
                invoke Ordering.Public.PublicCommands.pla
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/journey-module-visibility.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A journey may reference a module declaration only when its module exposes it.'
        ))).toBe(true);

        const privateOffset = text.indexOf('Ordering.Internal.PrivateCommands.ru') + 'Ordering.Internal.PrivateCommands.ru'.length;
        const privateCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(privateOffset)
        });
        expect(privateCompletion?.items.map(item => item.label)).not.toContain('run');

        const publicOffset = text.indexOf('Ordering.Public.PublicCommands.pla') + 'Ordering.Public.PublicCommands.pla'.length;
        const publicCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(publicOffset)
        });
        expect(publicCompletion?.items.map(item => item.label)).toContain('placeOrder');
    });

    test('offers an import code action for an unresolved indexed declaration', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering in bounded context Ordering { event OrderPlaced }'
        );
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/consumer.tni'),
            'in bounded context Ordering { application service ShipmentApplication { method onOrderPlaced(source: OrderPlaced) {} } }'
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

    test('extends an existing selective import for an unresolved component', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/components.tni'),
            'bounded context Ordering\nbounded context Shipping'
        );
        const sourceText = 'import { Ordering } from "./components.tni"\nin bounded context Shipping {}';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/selective-consumer.tni'), sourceText
        );
        documents = [target, source];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const actions = await services.Thinai.lsp.CodeActionProvider?.getCodeActions(source, {
            textDocument: { uri: source.uri.toString() },
            range: {
                start: { line: 0, character: 0 },
                end: { line: 1, character: sourceText.length - sourceText.indexOf('\n') - 1 }
            },
            context: { diagnostics: source.diagnostics ?? [] }
        });
        const action = actions?.find(candidate => 'title' in candidate && candidate.title === "Import 'Shipping' from './components.tni'");
        expect(action && 'edit' in action ? action.edit?.changes?.[source.uri.toString()]?.[0]?.newText : undefined)
            .toBe(', Shipping');
    });

    test('does not offer import quick fixes for private cross-context types', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/private-types.tni'),
            'bounded context Ordering in bounded context Ordering { value object OrderId { raw: string } }'
        );
        const sourceText = 'bounded context Shipping in bounded context Shipping { data object Request { id: OrderId } }';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/private-type-consumer.tni'), sourceText
        );
        documents = [target, source];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const actions = await services.Thinai.lsp.CodeActionProvider?.getCodeActions(source, {
            textDocument: { uri: source.uri.toString() },
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: sourceText.length }
            },
            context: { diagnostics: source.diagnostics ?? [] }
        });
        expect(actions?.some(candidate => 'title' in candidate && candidate.title.includes("Import 'OrderId'"))).toBe(false);
    });

    test('does not offer import quick fixes for same-named declarations of the wrong type', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/wrong-kind.tni'),
            'actor OrderId'
        );
        const sourceText = 'bounded context Ordering in bounded context Ordering { data object Request { id: OrderId } }';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/wrong-kind-consumer.tni'), sourceText
        );
        documents = [target, source];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const actions = await services.Thinai.lsp.CodeActionProvider?.getCodeActions(source, {
            textDocument: { uri: source.uri.toString() },
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: sourceText.length }
            },
            context: { diagnostics: source.diagnostics ?? [] }
        });
        expect(actions?.some(candidate => 'title' in candidate && candidate.title.includes("Import 'OrderId'"))).toBe(false);
    });
});
