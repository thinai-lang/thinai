import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type AstNode, type LangiumDocument, URI } from 'langium';
import { expandToString as s } from 'langium/generate';
import { clearDocuments } from 'langium/test';
import type { Model } from 'thinai-language';
import {
    createThinaiServices,
    isAggregate,
    isBoundedContext,
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
                        root entity Order {
                            method place() emits OrderPlaced {}
                            identifier id: OrderId;
                            status: OrderStatus;
                        }
                        value object OrderId {
                            raw: string;
                        }
                        enum OrderStatus { Draft, Placed }
                        repository OrderRepository for Order;
                    }
                    application service OrderApplication for Order {
                        transactional method placeOrder(id: OrderId) loads OrderRepository by id invokes Order.Order.place saves OrderRepository {}
                        method publishOrderPlaced(source: event OrderPlaced) emits OrderPlacedV1 after commit {}
                    }
                    event OrderPlaced;
                    integration event OrderPlacedV1 data { orderId: string; }
                }
            `
        );
        const part = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/order-events.tni'),
            s`
                import "./ordering.tni";

                part of bounded context Ordering {
                    event OrderConfirmed;
                    integration event OrderConfirmedV1;
                }
            `
        );
        const shippingContext = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            `bounded context Shipping {
                aggregate Shipment {
                    root entity Shipment { method start(); identifier id: ShipmentId; }
                    value object ShipmentId { raw: string; }
                    repository ShipmentRepository for Shipment;
                    factory ShipmentFactory for Shipment operations {
                        method createShipment() returns Shipment;
                    }
                }
                application service ShipmentApplication for Shipment {
                    transactional method createShipment() creates Shipment.ShipmentFactory.createShipment saves ShipmentRepository;
                }
            }`
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map.tni'),
            `import "./ordering.tni"; import "./shipping.tni"; context map Fulfillment {
                customer Shipping -> supplier Ordering;
            }`
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping-flow.tni'),
            `import "./ordering.tni"; import "./order-events.tni"; import "./shipping.tni"; import "./context-map.tni" { Fulfillment };
             part of bounded context Shipping {
                  application service ShipmentEventHandler for Shipment {
                       method onOrderPlaced(source: event Ordering.OrderPlacedV1) invokes ShipmentApplication.createShipment {
                           behavior "Use the public order identifier [[Ordering.OrderPlacedV1.orderId]] from the event.";
                       }
                  }
              }`
        );
        documents = [context, part, shippingContext, contextMap, consumer];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(checkDocumentValid(context) || checkDocumentValid(part) || checkDocumentValid(consumer)).toBeUndefined();
        expect(consumer.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toHaveLength(0);
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
        const shippingMembers = (shipping as Model['declarations'][number] & { members: Array<{ $type: string; methods?: Array<{ parameters: Array<{ eventType?: { ref?: unknown } }>; invocations?: Array<{ ref?: unknown }> }> }> }).members;
        const shippingService = shippingMembers.find(member => member.$type === 'ApplicationService' && member.methods?.some(method => method.parameters.some(parameter => parameter.eventType)));
        expect(shippingService?.methods?.[0].parameters[0].eventType?.ref).toBeDefined();
        expect(shippingService?.methods?.[0].invocations?.[0].ref).toBeDefined();

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
            'bounded context Shipping { application service ShipmentApplication for Shipment { method onOrderPlaced(source: event OrderPlaced) {} } }'
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
                        root entity Shipment {
                            identifier id: ShipmentId;
                        }
                        value object ShipmentId {
                            raw: string;
                        }
                    }
                    application service ShipmentApplication for Shipment {
                        method createShipment() {}
                        method onOrderPlaced(source: event Ordering.OrderPlaced) invokes createShipment {}
                    }
                }
            `
        );
        documents = [ordering, shipping];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(shipping.diagnostics?.some(diagnostic => String(diagnostic.message).includes('domain event can be handled only in its own bounded context'))).toBe(true);
    });

    test('requires an authorized imported context map to consume an integration event', async () => {
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering { module Contracts { exposes OrderPlacedV1; integration event OrderPlacedV1; } }'
        );
        const shipping = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            `import "./ordering.tni";
             bounded context Shipping {
                 aggregate Shipment { root entity Shipment { identifier id: ShipmentId; } value object ShipmentId { raw: string; } }
                 application service ShipmentApplication for Shipment {
                     method onOrderPlaced(source: event Ordering.Contracts.OrderPlacedV1) {}
                 }
             }`
        );
        documents = [ordering, shipping];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(shipping.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'requires an imported context map with an authorized relationship'
        ))).toBe(true);
    });

    test('authorizes event consumption across a partnership without pattern labels', async () => {
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/contexts.tni'),
            'bounded context Ordering { integration event OrderPlacedV1; } bounded context Shipping {}'
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map.tni'),
            `import "./contexts.tni";
             context map Fulfillment {
                 partner Shipping <-> partner Ordering
             }`
        );
        const shippingPart = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            `import "./contexts.tni"; import "./context-map.tni" { Fulfillment };
             part of bounded context Shipping {
                 application service ShipmentApplication for Shipment {
                     method onOrderPlaced(source: event Ordering.OrderPlacedV1) {}
                 }
             }`
        );
        documents = [contexts, contextMap, shippingPart];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(shippingPart.parseResult.parserErrors).toHaveLength(0);
        expect(shippingPart.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'requires an imported context map with an authorized relationship'
        ))).toBe(false);
    });

    test('pattern labels do not control event authorization', async () => {
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/contexts.tni'),
            'bounded context Ordering { integration event OrderPlacedV1; } bounded context Shipping {}'
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map.tni'),
            `import "./contexts.tni";
             context map Fulfillment {
                 partner Shipping <-> partner Ordering { integrationPatterns: ["OpenHostService"]; }
             }`
        );
        const shippingPart = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            `import "./contexts.tni"; import "./context-map.tni" { Fulfillment };
             part of bounded context Shipping {
                 application service ShipmentApplication for Shipment {
                     method onOrderPlaced(source: event Ordering.OrderPlacedV1) {}
                 }
             }`
        );
        documents = [contexts, contextMap, shippingPart];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(shippingPart.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'requires an imported context map with an authorized relationship'
        ))).toBe(false);
    });

    test('customer-supplier authorization does not permit supplier consumption of customer events', async () => {
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/contexts.tni'),
            'bounded context Ordering { integration event OrderPlacedV1; } bounded context Shipping { integration event ShipmentSentV1; }'
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map.tni'),
            `import "./contexts.tni";
             context map Fulfillment {
                 customer Shipping -> supplier Ordering;
             }`
        );
        const orderingPart = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            `import "./contexts.tni"; import "./context-map.tni" { Fulfillment };
             part of bounded context Ordering {
                 application service OrderApplication for Order {
                     method onShipmentSent(source: event Shipping.ShipmentSentV1) {}
                 }
             }`
        );
        documents = [contexts, contextMap, orderingPart];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(orderingPart.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'requires an imported context map with an authorized relationship'
        ))).toBe(true);
    });

    test('authorizes partnership event consumption in the reverse direction too', async () => {
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/contexts.tni'),
            'bounded context Ordering {} bounded context Shipping { integration event ShipmentSentV1; }'
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map.tni'),
            `import "./contexts.tni";
             context map Fulfillment {
                 partner Shipping <-> partner Ordering;
             }`
        );
        const orderingPart = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            `import "./contexts.tni"; import "./context-map.tni" { Fulfillment };
             part of bounded context Ordering {
                 application service OrderApplication for Order {
                     method onShipmentSent(source: event Shipping.ShipmentSentV1) {}
                 }
             }`
        );
        documents = [contexts, contextMap, orderingPart];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(orderingPart.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'requires an imported context map with an authorized relationship'
        ))).toBe(false);
    });

    test('separate-ways relationships do not authorize event consumption', async () => {
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/contexts.tni'),
            'bounded context Ordering {} bounded context Shipping { integration event ShipmentSentV1; }'
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map.tni'),
            `import "./contexts.tni";
             context map Fulfillment {
                 separateWays Ordering -x- Shipping;
             }`
        );
        const orderingPart = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            `import "./contexts.tni"; import "./context-map.tni" { Fulfillment };
             part of bounded context Ordering {
                 application service OrderApplication for Order {
                     method onShipmentSent(source: event Shipping.ShipmentSentV1) {}
                 }
             }`
        );
        documents = [contexts, contextMap, orderingPart];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(orderingPart.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'requires an imported context map with an authorized relationship'
        ))).toBe(true);
    });

    test('links shared values, identifier mirrors, and module exposures', async () => {
        const common = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/common.tni'),
            'shared kernel CommonTypes { value object Currency { code: string; } }'
        );
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            s`
                import "./common.tni" { CommonTypes };

                bounded context Ordering {
                    aggregate Order {
                        root entity Order {
                            identifier id: OrderId;
                            currency: CommonTypes.Currency;
                        }
                        value object OrderId {
                            raw: string;
                        }
                    }
                }
                bounded context Peer {}
                context map SharedTypes {
                    sharedKernel CommonTypes { participants: [Ordering, Peer]; }
                }
            `
        );
        const shipping = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            s`
                import "./ordering.tni";

                bounded context Shipping {
                    value object OrderId mirrors Ordering.Order.OrderId {
                        raw: string;
                    };

                    aggregate Shipment {
                        root entity Shipment {
                            identifier id: ShipmentId;
                            orderId: OrderId;
                        }
                        value object ShipmentId {
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
        const orderRoot = orderAggregate?.members?.find(member => member.name === 'Order');
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
                    root entity Order {
                        method ensureOwner();
                        identifier id: OrderId;
                    }
                    value object OrderId {
                        raw: string;
                    }
                    repository OrderRepository for Order;
                }
                application service OrderApplication for Order {
                    transactional method placeOrder(id: OrderId) loads OrderRepository by id invokes Order.Order.ensureOwner saves OrderRepository {
                        behavior "Check [[Order.Order.ensureOwner]] before placing.";
                    }
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
        const applicationService = context.members.find(member => member.$type === 'ApplicationService') as {
            methods: Array<{ behaviors: Array<{ description: { parts: Array<{ target?: { ref?: unknown } }> } }> }>;
        } | undefined;
        const commandMethod = applicationService?.methods[0];
        const part = commandMethod?.behaviors[0].description.parts.find(part => part.target);

        expect(method).toBeDefined();
        expect(part?.target?.ref).toBe(method);
        expect(ordering.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toHaveLength(0);

        const methodOffset = ordering.textDocument.getText().indexOf('Order.Order.ensureOwner') + 'Order.Order.'.length;
        const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(ordering, {
            textDocument: { uri: ordering.uri.toString() },
            position: ordering.textDocument.positionAt(methodOffset)
        });
        expect(definitions?.some(definition => definition.targetUri === ordering.uri.toString())).toBe(true);
    });

    test('links entity fields and factory creation methods in behavior specifications', async () => {
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/factory-links.tni'),
            `bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId;
                        status: string;
                    }
                    value object OrderId { raw: string; }
                    factory OrderFactory for Order operations {
                        method createOrder(id: OrderId) returns Order;
                    }
                    repository OrderRepository for Order;
                }
                application service OrderApplication for Order {
                    transactional method placeOrder() creates Order.OrderFactory.createOrder saves OrderRepository {
                        behavior "Create through [[Order.OrderFactory.createOrder]] using [[Order.Order.status]] and [[Order.OrderId.raw]].";
                    }
                }
            }`
        );
        documents = [ordering];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(ordering.parseResult.parserErrors).toHaveLength(0);
        expect(ordering.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toHaveLength(0);
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
        const factory = aggregate?.members.find(member => member.$type === 'Factory') as { methods: Array<{ name: string }> } | undefined;
        const service = context.members.find(member => member.$type === 'ApplicationService') as {
            methods: Array<{ behaviors: Array<{ description: { parts: Array<{ target?: { ref?: AstNode } }> } }> }>;
        } | undefined;
        const targets = service?.methods[0].behaviors[0].description.parts
            .map(part => part.target?.ref).filter((target): target is AstNode => target !== undefined) ?? [];

        expect(factory?.methods[0].name).toBe('createOrder');
        expect(targets.map(target => target.$type)).toEqual(['Method', 'Field', 'Field']);
        expect(targets[0]).toBe(factory?.methods[0]);
        expect(targets[1]).toBe(root?.fields.find(field => field.name === 'status'));
        const identifier = aggregate?.members.find(member => member.$type === 'ValueObject') as { fields: Array<AstNode & { name: string }> } | undefined;
        expect(targets[2]).toBe(identifier?.fields.find(field => field.name === 'raw'));
    });

    test('requires factory methods to return their aggregate root', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/invalid-factory.tni'),
            `bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    value object Other { value: string; }
                    factory OrderFactory for Order operations {
                        method createOrder() returns Other;
                    }
                }
            }`
        );
        documents = [document];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('A factory method must return the root entity of its associated aggregate.')
        )).toBe(true);
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
                 partner Orders <-> partner Shipping;
                 partner Billing <-> partner Shipping;
                 separateWays Orders -x- Billing;
             }`
        );
        documents = [catalog, consumer];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const diagnostics = consumer.diagnostics ?? [];
        expect(consumer.parseResult.parserErrors).toHaveLength(0);
        expect(diagnostics.some(diagnostic => String(diagnostic.message).includes("Could not resolve reference to BoundedContext named 'Billing'"))).toBe(true);
        const model = consumer.parseResult.value as Model;
        const map = model?.declarations[0] as Model['declarations'][number] & {
            relationships: Array<{ left: { context: { ref?: { name: string } } }; right: { context: { ref?: { name: string } } } }>;
        };
        expect(map.relationships[0].left.context.ref?.name).toBe('Ordering');
        expect(map.relationships[0].right.context.ref?.name).toBe('Shipping');
    });

    test('reports unresolved method references in behavior specifications', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/unresolved-behavior.tni'),
            `bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId;
                    }
                    value object OrderId {
                        raw: string;
                    }
                }
                application service OrderApplication for Order {
                    method placeOrder() {
                        behavior "Check [[Order.Order.missingMethod]] before placing.";
                    }
                }
            }`
        );
        documents = [document];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes("Could not resolve reference to BehaviorSpecificationTarget named 'Order.Order.missingMethod'"))
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
