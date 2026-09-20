import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { expandToString as s } from 'langium/generate';
import { clearDocuments } from 'langium/test';
import type { Model } from 'thinai-language';
import { createThinaiServices, isModel } from 'thinai-language';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

describe('Linking tests', () => {
    test('links canonical context parts and imported domain concepts', async () => {
        const context = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            s`
                subdomain OrderManagement kind core;

                bounded context Ordering realizes OrderManagement {
                    aggregate Order root OrderRoot {
                        entity OrderRoot;
                    }
                    command PlaceOrder targets Order emits OrderPlaced;
                    event OrderPlaced for Order publishes integration OrderPlacedV1;
                    integration event OrderPlacedV1 from OrderPlaced;
                }
            `
        );
        const part = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/order-events.tni'),
            s`
                import "./ordering.tni";

                part of bounded context Ordering {
                    event OrderConfirmed for Order publishes integration OrderConfirmedV1;
                    integration event OrderConfirmedV1 from OrderConfirmed;
                }
            `
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/order-flow.tni'),
            s`
                import "./ordering.tni";
                import "./order-events.tni";

                bounded context Shipping {
                    aggregate Shipment root ShipmentRoot {
                        entity ShipmentRoot;
                    }
                    command CreateShipment targets Shipment emits ShipmentStarted;
                    event ShipmentStarted for Shipment;
                    policy StartShipment when Ordering.OrderPlacedV1 then CreateShipment;

                    event storming OrderLifecycle {
                        event Ordering.OrderPlacedV1;
                        command CreateShipment;
                        aggregate Shipment;
                    }
                }
            `
        );
        documents = [context, part, consumer];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(checkDocumentValid(context) || checkDocumentValid(part) || checkDocumentValid(consumer)).toBeUndefined();
        const contextModel = context.parseResult.value as Model;
        const partModel = part.parseResult.value as Model;
        const consumerModel = consumer.parseResult.value as Model;
        const contextNode = contextModel.declarations[1];
        const partNode = partModel.declarations[0];
        const shipping = consumerModel.declarations[0];

        expect(isModel(contextModel)).toBe(true);
        expect((contextNode as Model['declarations'][number] & { subdomains: Array<{ ref?: unknown }> }).subdomains[0].ref).toBe(contextModel.declarations[0]);
        expect(partNode.$type).toBe('BoundedContextPart');
        expect((partNode as Model['declarations'][number] & { context: { ref?: unknown } }).context.ref).toBe(contextNode);
        const shippingMembers = (shipping as Model['declarations'][number] & { members: Array<{ $type: string; triggers?: Array<{ ref?: unknown }>; elements?: Array<{ event?: { ref?: unknown } }> }> }).members;
        const policy = shippingMembers.find(member => member.$type === 'Policy');
        const board = shippingMembers.find(member => member.$type === 'EventStorming');
        expect(policy?.triggers?.[0].ref).toBeDefined();
        expect(board?.elements?.[0].event?.ref).toBeDefined();

        const contextPath = services.Thinai.workspace.AstNodeLocator.getAstNodePath(contextNode);
        const contextReferences = services.shared.workspace.IndexManager
            .findAllReferences(contextNode, contextPath)
            .toArray();
        expect(contextReferences.some(reference => reference.sourceUri.toString() === part.uri.toString())).toBe(true);
    });

    test('does not expose workspace-global declarations without an import', async () => {
        const context = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering { event OrderPlaced; }'
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/consumer.tni'),
            'bounded context Shipping { event storming OrderLifecycle { event OrderPlaced; } }'
        );
        documents = [context, consumer];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(consumer.diagnostics?.some(diagnostic => String(diagnostic.message).includes("Could not resolve reference to EventDeclaration named 'OrderPlaced'"))).toBe(true);
    });

    test('rejects direct consumption of a private domain event across contexts', async () => {
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering { event OrderPlaced; }'
        );
        const shipping = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            s`
                import "./ordering.tni";

                bounded context Shipping {
                    aggregate Shipment root ShipmentRoot {
                        entity ShipmentRoot;
                    }
                    command StartShipment targets Shipment;
                    policy StartWhenOrderPlaced when Ordering.OrderPlaced then StartShipment;
                }
            `
        );
        documents = [ordering, shipping];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(shipping.diagnostics?.some(diagnostic => String(diagnostic.message).includes('may consume only an integration event'))).toBe(true);
    });
});

function checkDocumentValid(document: LangiumDocument): string | undefined {
    return document.parseResult.parserErrors.length && s`
        Parser errors:
          ${document.parseResult.parserErrors.map(error => error.message).join('\n  ')}
    `
        || document.parseResult.value === undefined && `ParseResult is 'undefined'.`
        || !isModel(document.parseResult.value) && `Root AST object is a ${document.parseResult.value.$type}, expected a 'Model'.`
        || undefined;
}
