import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { expandToString as s } from 'langium/generate';
import { clearDocuments } from 'langium/test';
import type { Model } from 'thinai-language';
import {
    createThinaiServices,
    isAggregate,
    isBoundedContext,
    isCommand,
    isEntity,
    isModel
} from 'thinai-language';

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
                    aggregate Order {
                        root entity OrderRoot {
                            identifier id: OrderId;
                        }
                        identifier value object OrderId for OrderRoot {
                            raw: string;
                        }
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
                    aggregate Shipment {
                        root entity ShipmentRoot {
                            identifier id: ShipmentId;
                        }
                        identifier value object ShipmentId for ShipmentRoot {
                            raw: string;
                        }
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
                    aggregate Shipment {
                        root entity ShipmentRoot {
                            identifier id: ShipmentId;
                        }
                        identifier value object ShipmentId for ShipmentRoot {
                            raw: string;
                        }
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

    test('links shared values, identifier mirrors, and module exposures', async () => {
        const common = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/common.tni'),
            'shared kernel CommonTypes { value object Currency { code: string; } }'
        );
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            s`
                import "./common.tni" as Common;

                bounded context Ordering {
                    aggregate Order {
                        root entity OrderRoot {
                            identifier id: OrderId;
                            currency: Common.Currency;
                        }
                        identifier value object OrderId for OrderRoot {
                            raw: string;
                        }
                    }
                }
            `
        );
        const shipping = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            s`
                import "./ordering.tni";

                bounded context Shipping {
                    identifier value object OrderId mirrors Ordering.Order.OrderId {
                        raw: string;
                    };

                    aggregate Shipment {
                        root entity ShipmentRoot {
                            identifier id: ShipmentId;
                            orderId: OrderId;
                        }
                        identifier value object ShipmentId for ShipmentRoot {
                            raw: string;
                        };
                    };

                    module Public {
                        exposes PublicCode;
                        value object PublicCode {
                            raw: string;
                        };
                    };

                    module Consumer depends on Public {
                        value object LocalCode {
                            publicCode: PublicCode;
                        };
                    };
                }
            `
        );
        documents = [common, ordering, shipping];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(shipping.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toHaveLength(0);
        type TestNode = {
            $type: string;
            name: string;
            fields?: Array<{ type?: { ref?: unknown } }>;
            members?: TestNode[];
            mirrors?: { ref?: unknown };
        };
        const orderingModel = ordering.parseResult.value as Model;
        const shippingModel = shipping.parseResult.value as Model;
        const orderingContext = orderingModel.declarations[0] as Model['declarations'][number] & { members: TestNode[] };
        const orderAggregate = orderingContext.members.find(member => member.$type === 'Aggregate');
        const orderRoot = orderAggregate?.members?.find(member => member.name === 'OrderRoot');
        const shippingPart = shippingModel.declarations[0] as Model['declarations'][number] & { members: TestNode[] };
        const mirroredId = shippingPart.members.find(member => member.$type === 'ValueObject' && member.mirrors);
        const publicModule = shippingPart.members.find(member => member.$type === 'Module' && member.name === 'Public');
        const consumerModule = shippingPart.members.find(member => member.$type === 'Module' && member.name === 'Consumer');
        const localCode = consumerModule?.members?.find(member => member.name === 'LocalCode');

        expect(mirroredId?.mirrors?.ref).toBe(orderAggregate?.members?.find(member => member.name === 'OrderId'));
        expect(localCode?.fields?.[0].type?.ref).toBe(publicModule?.members?.find(member => member.name === 'PublicCode'));
        expect(orderRoot).toBeDefined();
    });

    test('rejects direct use of a private value object across contexts', async () => {
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering { value object InternalCode { raw: string; } }'
        );
        const shipping = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            s`
                import "./ordering.tni";

                bounded context Shipping {
                    value object LocalCode {
                        source: Ordering.InternalCode;
                    }
                }
            `
        );
        documents = [ordering, shipping];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(shipping.diagnostics?.some(diagnostic => String(diagnostic.message).includes('private value object'))).toBe(true);
    });

    test('links inline method references in command behavior specifications', async () => {
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            `bounded context Ordering {
                aggregate Order {
                    root entity OrderRoot operations {
                        method ensureOwner();
                    } {
                        identifier id: OrderId;
                    }
                    identifier value object OrderId for OrderRoot {
                        raw: string;
                    }
                }
                command PlaceOrder targets Order {
                    behavior $"Check ${'${Order.OrderRoot.ensureOwner}'} before placing.";
                }
                event storming PlaceOrderBoard {
                    command PlaceOrder;
                }
            }`
        );
        documents = [ordering];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(ordering.parseResult.parserErrors).toHaveLength(0);
        const model = ordering.parseResult.value;
        expect(model && isModel(model)).toBe(true);
        if (!model || !isModel(model)) {
            return;
        }
        const context = model.declarations[0];
        expect(context && isBoundedContext(context)).toBe(true);
        if (!context || !isBoundedContext(context)) {
            return;
        }
        const aggregate = context.members.find(isAggregate);
        const root = aggregate?.members.find(isEntity);
        const method = root?.methods[0];
        const command = context.members.find(isCommand);
        const part = command?.behaviors[0].description.template?.parts.find(part => part.method);

        expect(method).toBeDefined();
        expect(part?.method?.ref).toBe(method);
        expect(ordering.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toHaveLength(0);

        const methodOffset = ordering.textDocument.getText().indexOf('Order.OrderRoot.ensureOwner') + 'Order.OrderRoot.'.length;
        const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(ordering, {
            textDocument: { uri: ordering.uri.toString() },
            position: ordering.textDocument.positionAt(methodOffset)
        });
        expect(definitions?.some(definition => definition.targetUri === ordering.uri.toString())).toBe(true);
    });

    test('selectively imports bounded contexts from a multi-context file', async () => {
        const catalog = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/contexts.tni'),
            'bounded context Ordering {} bounded context Shipping {} bounded context Billing {}'
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/map.tni'),
            `import "./contexts.tni" { Ordering as Orders, Shipping };
             context map FulfillmentMap {
                 Orders partnership Shipping;
                 Billing partnership Shipping;
             }`
        );
        documents = [catalog, consumer];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const diagnostics = consumer.diagnostics ?? [];
        expect(consumer.parseResult.parserErrors).toHaveLength(0);
        expect(diagnostics.some(diagnostic => String(diagnostic.message).includes("Could not resolve reference to BoundedContext named 'Billing'"))).toBe(true);
        const model = consumer.parseResult.value as Model;
        const map = model?.declarations[0] as Model['declarations'][number] & {
            relationships: Array<{ source: { ref?: { name: string } }; target: { ref?: { name: string } } }>;
        };
        expect(map.relationships[0].source.ref?.name).toBe('Ordering');
        expect(map.relationships[0].target.ref?.name).toBe('Shipping');
    });

    test('reports unresolved method references in behavior specifications', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/unresolved-behavior.tni'),
            `bounded context Ordering {
                aggregate Order {
                    root entity OrderRoot {
                        identifier id: OrderId;
                    }
                    identifier value object OrderId for OrderRoot {
                        raw: string;
                    }
                }
                command PlaceOrder targets Order {
                    behavior $"Check ${'${Order.OrderRoot.missingMethod}'} before placing.";
                }
            }`
        );
        documents = [document];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes("Could not resolve reference to Method named 'Order.OrderRoot.missingMethod'"))
        ).toBe(true);
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
