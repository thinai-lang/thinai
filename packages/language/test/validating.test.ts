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
    test('accepts aggregate effects and an application-service command', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() emits OrderPlaced, OrderAudited {
                            transition status from Draft to Placed;
                        }
                        identifier id: OrderId;
                        status: OrderStatus;
                    }
                    value object OrderId {
                        raw: string;
                    }
                    enum OrderStatus { Draft, Placed }
                }
                application service OrderApplication for Order {
                    method placeOrder() invokes Order.Order.place {}
                }
                event OrderPlaced;
                event OrderAudited;
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('requires identifier fields to reference value objects', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: string; }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An identifier field must reference a value object.'
        ))).toBe(true);
    });

    test('requires services to target an aggregate in their own context', async () => {
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering { aggregate Order { root entity Order { identifier id: OrderId; } value object OrderId { raw: string; } } }'
        );
        const shipping = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            'import "./ordering.tni"; bounded context Shipping { application service ShippingApplication for Ordering.Order {} }'
        );
        documents = [ordering, shipping];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(
            checkDocumentValid(shipping) || shipping.diagnostics?.map(diagnosticToString).join('\n')
        ).toEqual(expect.stringContaining('An application service must be associated with an aggregate in its own bounded context.'));
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

    test('requires a shared-kernel relationship to name at least two contexts', async () => {
        const document = await parse(`
            bounded context Ordering {}
            shared kernel CommonTypes {}
            context map SharedTypes {
                sharedKernel CommonTypes { participants: [Ordering]; }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A shared-kernel relationship must include at least two bounded contexts'
        ))).toBe(true);
    });

    test('rejects duplicate integration patterns on a context-map endpoint', async () => {
        const document = await parse(`
            bounded context Ordering {}
            bounded context Shipping {}
            context map Fulfillment {
                customer Shipping { integrationPatterns: ["AntiCorruptionLayer", "AntiCorruptionLayer"]; }
                    -> supplier Ordering;
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An integration pattern may only be listed once per bounded context'
        ))).toBe(true);
    });

    test('rejects unknown integration pattern labels', async () => {
        const document = await parse(`
            bounded context Ordering {}
            bounded context Shipping {}
            context map Fulfillment {
                customer Shipping { integrationPatterns: ["AntiCorruptionLayre"]; }
                    -> supplier Ordering;
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            "Unknown integration pattern 'AntiCorruptionLayre'"
        ))).toBe(true);
    });

    test('requires map collections to declare both key and value types', async () => {
        const document = await parse(`
            bounded context Inventory {
                value object InventoryIndex {
                    entries: Map<string>;
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes('Map type requires both a key and a value type'))).toBe(true);
    });

    test('rejects circular module dependencies', async () => {
        const document = await parse(`
            bounded context Ordering {
                module Orders depends on Pricing {}
                module Pricing depends on Orders {}
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes('Module dependencies cannot contain a cycle'))).toBe(true);
    });

    test('requires a component selector for file aliases that contain multiple bounded contexts', async () => {
        const catalog = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/catalog.tni'),
            'bounded context Ordering {} bounded context Shipping {}'
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/consumer.tni'),
            'import "./catalog.tni" as Contexts; bounded context Billing {}'
        );
        documents = [catalog, consumer];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(consumer.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A file-level alias requires exactly one bounded context, context map, or shared kernel'
        ))).toBe(true);
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
