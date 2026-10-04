import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { AstUtils, EmptyFileSystem, type AstNode, type LangiumDocument, URI } from 'langium';
import { expandToString as s } from 'langium/generate';
import { clearDocuments } from 'langium/test';
import type { Model } from 'thinai-language';
import {
    createThinaiServices,
    isAggregate,
    isApplicationService,
    isBoundedContext,
    isDataObject,
    isEntity,
    isModule,
    isModel,
    isValueObject
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
                            method place() { emits OrderPlaced; }
                            identifier id: OrderId;
                            status: OrderStatus;
                        }
                        value object OrderId {
                            raw: string;
                        }
                        enum OrderStatus { Draft, Placed }
                }
                    repository OrderRepository for Order;
                application service OrderApplication {
                    method placeOrder(id: OrderId) {
                        invokes Order.Order.place;
                    }
                    method publishOrderPlaced(source: event OrderPlaced) {
                        emits OrderPlacedV1;
                    }
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
                }
                repository ShipmentRepository for Shipment;
                factory ShipmentFactory {
                    method createShipment() returns Shipment.Shipment;
                    }
                application service ShipmentApplication {
                    method createShipment() {
                        invokes ShipmentFactory.createShipment;
                    }
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
            `import "./ordering.tni"; import "./order-events.tni"; import "./shipping.tni"; import { Fulfillment } from "./context-map.tni";
             part of bounded context Shipping {
                  application service ShipmentEventHandler {
                        method onOrderPlaced(source: event Ordering.OrderPlacedV1) {
                            invokes ShipmentApplication.createShipment;
                           behavior "Use the public order identifier [[Ordering.OrderPlacedV1.orderId]] from the event.";
                       }
                  }
              }`
        );
        documents = [context, part, shippingContext, contextMap, consumer];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(checkDocumentValid(context) || checkDocumentValid(part) || checkDocumentValid(consumer)).toBeUndefined();
        expect(consumer.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
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
        const shippingMembers = (shipping as Model['declarations'][number] & { members: Array<{ $type: string; methods?: Array<{ parameters: Array<{ eventType?: { ref?: unknown } }>; invocations?: Array<{ targets: Array<{ ref?: unknown }> }> }> }> }).members;
        const shippingService = shippingMembers.find(member => member.$type === 'ApplicationService' && member.methods?.some(method => method.parameters.some(parameter => parameter.eventType)));
        expect(shippingService?.methods?.[0].parameters[0].eventType?.ref).toBeDefined();
        expect(shippingService?.methods?.[0].invocations?.[0].targets.at(-1)?.ref).toBeDefined();

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
            'bounded context Shipping { application service ShipmentApplication { method onOrderPlaced(source: event OrderPlaced) {} } }'
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
                    application service ShipmentApplication {
                        method createShipment() {}
                        method onOrderPlaced(source: event Ordering.OrderPlaced) { invokes createShipment; }
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
                 application service ShipmentApplication {
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
            `import "./contexts.tni"; import { Fulfillment } from "./context-map.tni";
             part of bounded context Shipping {
                 application service ShipmentApplication {
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
            `import "./contexts.tni"; import { Fulfillment } from "./context-map.tni";
             part of bounded context Shipping {
                 application service ShipmentApplication {
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
            `import "./contexts.tni"; import { Fulfillment } from "./context-map.tni";
             part of bounded context Ordering {
                 application service OrderApplication {
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
            `import "./contexts.tni"; import { Fulfillment } from "./context-map.tni";
             part of bounded context Ordering {
                 application service OrderApplication {
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
            `import "./contexts.tni"; import { Fulfillment } from "./context-map.tni";
             part of bounded context Ordering {
                 application service OrderApplication {
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
                import { CommonTypes } from "./common.tni";

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

        expect(shipping.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
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

    test('resolves every mirror path segment through an imported bounded-context part', async () => {
        const context = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-context.tni'),
            'bounded context Ordering {}'
        );
        const orderingPart = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-part.tni'),
            `import "./ordering-context.tni";
             part of bounded context Ordering {
                 aggregate Order {
                     root entity Order { identifier id: OrderId; }
                     value object OrderId { raw: string; }
                 }
             }`
        );
        const shipping = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping-mirror.tni'),
            `import "./ordering-part.tni";
             bounded context Shipping {
                 value object OrderId mirrors Ordering.Order.OrderId { raw: string; }
             }`
        );
        documents = [context, orderingPart, shipping];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(shipping.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
        const mirror = AstUtils.streamAst(shipping.parseResult.value).toArray()
            .find(node => node.$type === 'ValueObject' && 'name' in node && node.name === 'OrderId');
        expect(mirror && isValueObject(mirror)).toBe(true);
        if (!mirror || !isValueObject(mirror)) {
            return;
        }
        expect(mirror.mirrorsPath.map(reference =>
            reference.ref && 'name' in reference.ref ? String(reference.ref.name) : undefined
        )).toEqual(['Ordering', 'Order']);
        expect(mirror.mirrors?.ref && 'name' in mirror.mirrors.ref ? String(mirror.mirrors.ref.name) : undefined).toBe('OrderId');

        const pathOffset = shipping.textDocument.getText().indexOf('Ordering.Order.OrderId');
        const expectedDefinitions = [
            { start: pathOffset, document: context, target: context.textDocument.getText().indexOf('Ordering') },
            { start: pathOffset + 'Ordering.'.length, document: orderingPart, target: orderingPart.textDocument.getText().indexOf('aggregate Order') + 'aggregate '.length },
            { start: pathOffset + 'Ordering.Order.'.length, document: orderingPart, target: orderingPart.textDocument.getText().indexOf('OrderId { raw') }
        ];
        for (const expected of expectedDefinitions) {
            const links = await services.Thinai.lsp.DefinitionProvider?.getDefinition(shipping, {
                textDocument: { uri: shipping.uri.toString() },
                position: shipping.textDocument.positionAt(expected.start)
            });
            expect(links).toHaveLength(1);
            expect(links?.[0]?.originSelectionRange).toEqual({
                start: shipping.textDocument.positionAt(expected.start),
                end: shipping.textDocument.positionAt(expected.start + shipping.textDocument.getText().slice(expected.start).match(/^\w+/)![0].length)
            });
            expect(links?.[0]?.targetSelectionRange.start).toEqual(expected.document.textDocument.positionAt(expected.target));
        }
    });

    test('navigates multiple method-level projector targets', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/multi-target-projector.tni'),
            `bounded context Commerce {
                read model OrderSummary { orderId: string; }
                read model CustomerSummary { customerId: string; }
                event EntityChanged;
                projector SearchProjection {
                    method onEntityChanged(source: event EntityChanged) {
                        projects OrderSummary, CustomerSummary;
                    }
                }
            }`
        );
        documents = [document];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(document.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toHaveLength(0);
        const text = document.textDocument.getText();
        for (const name of ['OrderSummary', 'CustomerSummary']) {
            const source = text.indexOf(name, text.indexOf('projects '));
            const target = text.indexOf(`${name} {`);
            const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source)
            });
            expect(definitions).toHaveLength(1);
            expect(definitions?.[0]?.originSelectionRange).toEqual({
                start: document.textDocument.positionAt(source),
                end: document.textDocument.positionAt(source + name.length)
            });
            expect(definitions?.[0]?.targetSelectionRange.start).toEqual(document.textDocument.positionAt(target));
        }
    });

    test('navigates transition fields and enum values', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/transition-navigation.tni'),
            `bounded context Shipping {
                aggregate Shipment {
                    root entity Shipment {
                        method ship() { transition status from Open to Shipped; }
                        identifier id: ShipmentId;
                        status: ShipmentStatus;
                    }
                    value object ShipmentId { raw: string; }
                    enum ShipmentStatus { Open, Shipped }
                }
            }`
        );
        documents = [document];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(document.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
        const text = document.textDocument.getText();
        const transition = text.indexOf('transition status');
        const targets = [
            { source: transition + 'transition '.length, name: 'status', declaration: text.indexOf('status: ShipmentStatus') },
            { source: text.indexOf('Open to Shipped'), name: 'Open', declaration: text.indexOf('Open, Shipped') },
            { source: text.indexOf('Shipped;'), name: 'Shipped', declaration: text.indexOf('Shipped }') }
        ];
        for (const target of targets) {
            const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(target.source)
            });
            expect(definitions).toHaveLength(1);
            expect(definitions?.[0]?.originSelectionRange).toEqual({
                start: document.textDocument.positionAt(target.source),
                end: document.textDocument.positionAt(target.source + target.name.length)
            });
            expect(definitions?.[0]?.targetSelectionRange.start).toEqual(
                document.textDocument.positionAt(target.declaration)
            );
        }
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
                }
                repository OrderRepository for Order;
                application service OrderApplication {
                     method placeOrder(id: OrderId) {
                         invokes Order.Order.ensureOwner;
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
            methods: Array<{ behaviors: Array<{ description: { parts: Array<{ target?: { ref?: unknown }; targets: Array<{ ref?: unknown }> }> } }> }>;
        } | undefined;
        const commandMethod = applicationService?.methods[0];
        const part = commandMethod?.behaviors[0].description.parts.find(part => part.target);
        const finalTarget = part?.targets.at(-1)?.ref ?? part?.target?.ref;

        expect(method).toBeDefined();
        expect(finalTarget).toBe(method);
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
                }
                factory OrderFactory {
                    method createOrder(id: OrderId) returns Order.Order;
                    }
                repository OrderRepository for Order;
                application service OrderApplication {
                    method placeOrder() {
                        invokes OrderFactory.createOrder;
                        behavior "Create through [[OrderFactory.createOrder]] using [[Order.Order.status]] and [[Order.OrderId.raw]].";
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
        const factory = context.members.find(member => member.$type === 'Factory') as { methods: Array<{ name: string }> } | undefined;
        const service = context.members.find(member => member.$type === 'ApplicationService') as {
            methods: Array<{ behaviors: Array<{ description: { parts: Array<{ target?: { ref?: AstNode }; targets: Array<{ ref?: AstNode }> }> } }> }>;
        } | undefined;
        const targets = service?.methods[0].behaviors[0].description.parts
            .map(part => part.targets.at(-1)?.ref ?? part.target?.ref)
            .filter((target): target is AstNode => target !== undefined) ?? [];

        expect(factory?.methods[0].name).toBe('createOrder');
        expect(targets.map(target => target.$type)).toEqual(['Method', 'Field', 'Field']);
        expect(targets[0]).toBe(factory?.methods[0]);
        expect(targets[1]).toBe(root?.fields.find(field => field.name === 'status'));
        const identifier = aggregate?.members.find(member => member.$type === 'ValueObject') as { fields: Array<AstNode & { name: string }> } | undefined;
        expect(targets[2]).toBe(identifier?.fields.find(field => field.name === 'raw'));
    });

    test('navigates each segment of one nested specification reference independently', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/nested-specification-path.tni'),
            `bounded context Ordering {
                data object AddressInput { street: string; }
                data object OrderInput { address: AddressInput; }
                aggregate Order {
                    root entity Order {
                        method place(input: OrderInput) {
                            behavior "Place the order using [[input.address.street]].";
                        }
                        identifier id: OrderId;
                    }
                    value object OrderId { raw: string; }
                }
            }`
        );
        documents = [document];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(document.parseResult.parserErrors).toHaveLength(0);
        expect(document.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
        const model = document.parseResult.value;
        expect(model && isModel(model)).toBe(true);
        if (!model || !isModel(model)) {
            return;
        }
        const context = model.declarations[0];
        expect(isBoundedContext(context)).toBe(true);
        if (!isBoundedContext(context)) {
            return;
        }
        const aggregate = context.members.find(isAggregate);
        const order = aggregate?.members.find(isEntity);
        const method = order?.methods[0];
        const parameter = method?.parameters[0];
        const dataObjects = context.members.filter(isDataObject);
        const input = dataObjects.find(dataObject => dataObject.name === 'OrderInput');
        const address = input?.fields.find(field => field.name === 'address')?.type?.ref;
        const street = isValueObject(address) || isDataObject(address)
            ? address.fields.find(field => field.name === 'street')
            : undefined;
        const parts = method?.behaviors[0].description.parts;
        const linkedPart = parts?.find(part => part.target);

        expect(linkedPart?.target?.ref).toBe(parameter);
        expect(linkedPart?.targets.map(reference => reference.ref)).toEqual([
            input?.fields.find(field => field.name === 'address'),
            street
        ]);

        const text = document.textDocument.getText();
        const pathOffset = text.indexOf('input.address.street');
        const definitionAt = async (offset: number) => {
            const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            return definitions?.[0]?.targetSelectionRange.start;
        };
        expect(await definitionAt(pathOffset)).toEqual(
            document.textDocument.positionAt(text.indexOf('input: OrderInput'))
        );
        expect(await definitionAt(pathOffset + 'input.'.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('address: AddressInput') )
        );
        expect(await definitionAt(pathOffset + 'input.address.'.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('street: string'))
        );
        for (const separatorOffset of [pathOffset + 'input'.length, pathOffset + 'input.address'.length]) {
            const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(separatorOffset)
            });
            const precedingSegment = separatorOffset === pathOffset + 'input'.length ? 'input' : 'address';
            expect(definitions?.[0]?.originSelectionRange).toEqual({
                start: document.textDocument.positionAt(separatorOffset - precedingSegment.length),
                end: document.textDocument.positionAt(separatorOffset)
            });
        }
        const rightToLeftSegments = [
            { offset: pathOffset + 'input.address.'.length, text: 'street' },
            { offset: pathOffset + 'input.'.length, text: 'address' },
            { offset: pathOffset, text: 'input' }
        ];
        for (const segment of rightToLeftSegments) {
            const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(segment.offset)
            });
            expect(definitions?.[0]?.originSelectionRange).toEqual({
                start: document.textDocument.positionAt(segment.offset),
                end: document.textDocument.positionAt(segment.offset + segment.text.length)
            });
        }
    });

    test('resolves same-suffix value objects, fields, and modules in the owning context', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/duplicate-context-symbols.tni'),
            `bounded context Shipping {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    enum OrderStatus { Draft, Placed }
                }
                repository OrderRepository for Order;
                module Contracts {
                    value object DeliveryCode { raw: string; }
                }
            }
            bounded context Ordering {
                aggregate Order {
                    root entity Order { method fulfillItem(); identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    enum OrderStatus { Draft, Placed }
                }
                repository OrderRepository for Order;
                aggregate Invoice {
                    root entity Invoice { method inspect(); identifier id: InvoiceId; orderId: Order.OrderId; }
                    value object InvoiceId { raw: string; }
                }
                repository InvoiceRepository for Invoice;
                module Contracts {
                    exposes DeliveryCode;
                    value object DeliveryCode { raw: string; }
                }
                module Api depends on Contracts {
                    value object ApiCode { code: Contracts.DeliveryCode; }
                }
                application service InvoiceApplication {
                    method inspect(id: InvoiceId, code: Contracts.DeliveryCode) {
                        invokes Invoice.Invoice.inspect;
                        behavior "Use [[Order.OrderId.raw]] and [[Contracts.DeliveryCode.raw]].";
                         behavior "Discuss aggregate [[Ordering.Order]], entity [[Ordering.Order.Order]], state [[Ordering.Order.OrderStatus.Placed]], and repository [[Ordering.OrderRepository]].";
                    }
                }
                application service OrderApplication {
                    method fulfillOrder() {
                        invokes Order.Order.fulfillItem;
                    }
                }
            }`
        );
        documents = [document];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(document.parseResult.parserErrors).toHaveLength(0);
        const model = document.parseResult.value;
        expect(model && isModel(model)).toBe(true);
        if (!model || !isModel(model)) {
            return;
        }
        const ordering = model.declarations.find(declaration =>
            isBoundedContext(declaration) && declaration.name === 'Ordering'
        );
        expect(ordering && isBoundedContext(ordering)).toBe(true);
        if (!ordering || !isBoundedContext(ordering)) {
            return;
        }
        const aggregates = ordering.members.filter(isAggregate);
        const order = aggregates.find(aggregate => aggregate.name === 'Order');
        const invoice = aggregates.find(aggregate => aggregate.name === 'Invoice');
        const orderId = order?.members.find(isValueObject);
        const invoiceRoot = invoice?.members.find(isEntity);
        const orderIdReference = invoiceRoot?.fields.find(field => field.name === 'orderId')?.type?.ref;
        const modules = ordering.members.filter(isModule);
        const localContracts = modules.find(module => module.name === 'Contracts');
        const localDeliveryCode = localContracts?.members.find(isValueObject);
        const api = modules.find(module => module.name === 'Api');
        const application = ordering.members.find(isApplicationService);
        const behaviorTargets = application?.methods[0].behaviors[0].description.parts
            .flatMap(part => {
                const target = part.targets.at(-1)?.ref ?? part.target?.ref;
                return target ? [target] : [];
            }) ?? [];

        expect(orderIdReference).toBe(orderId);
        expect(api?.dependencies[0].ref).toBe(localContracts);
        expect(application?.methods[0].parameters[1].type?.ref).toBe(localDeliveryCode);
        expect(behaviorTargets.map(target => [target.$type, 'name' in target ? target.name : undefined])).toEqual([
            ['Field', 'raw'],
            ['Field', 'raw']
        ]);
        const declarationLinks = application?.methods[0].behaviors[1].description.parts
            .flatMap(part => [part.target?.ref, ...part.targets.map(reference => reference.ref)]
                .filter((target): target is NonNullable<typeof target> => target !== undefined)) ?? [];
        expect(declarationLinks.map(target => target.$type)).toEqual([
            'BoundedContext', 'Aggregate',
            'BoundedContext', 'Aggregate', 'Entity',
            'BoundedContext', 'Aggregate', 'EnumType', 'EnumValue',
            'BoundedContext', 'Repository'
        ]);
        expect(document.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);

        const text = document.textDocument.getText();
        const getDefinitionLinks = async (referenceOffset: number) => services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(referenceOffset)
        });
        const getDefinitionStart = async (referenceOffset: number) => {
            const definitions = await getDefinitionLinks(referenceOffset);
            return definitions?.[0]?.targetSelectionRange.start;
        };
        const orderingOffset = text.indexOf('bounded context Ordering');
        const valueObjectTypePath = text.indexOf('Order.OrderId;');
        expect(await getDefinitionStart(valueObjectTypePath)).toEqual(
            document.textDocument.positionAt(text.indexOf('aggregate Order {', orderingOffset) + 'aggregate '.length)
        );
        expect(await getDefinitionStart(valueObjectTypePath + 'Order.'.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('OrderId { raw: string; }', orderingOffset))
        );
        const typePrefixLink = (await getDefinitionLinks(valueObjectTypePath))?.[0];
        expect(typePrefixLink?.originSelectionRange).toEqual({
            start: document.textDocument.positionAt(valueObjectTypePath),
            end: document.textDocument.positionAt(valueObjectTypePath + 'Order'.length)
        });
        const typeTerminalOffset = valueObjectTypePath + 'Order.'.length;
        const typeTerminalLink = (await getDefinitionLinks(typeTerminalOffset))?.[0];
        expect(typeTerminalLink?.originSelectionRange).toEqual({
            start: document.textDocument.positionAt(typeTerminalOffset),
            end: document.textDocument.positionAt(typeTerminalOffset + 'OrderId'.length)
        });
        const orderFieldPath = text.indexOf('Order.OrderId.raw');
        expect(await getDefinitionStart(orderFieldPath + 'Order.'.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('OrderId { raw: string; }', orderingOffset))
        );
        expect(await getDefinitionStart(orderFieldPath + 'Order.OrderId.'.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('raw: string;', text.indexOf('value object OrderId', orderingOffset)))
        );
        const codePath = text.indexOf('Contracts.DeliveryCode.raw');
        expect(await getDefinitionStart(codePath)).toEqual(
            document.textDocument.positionAt(text.indexOf('module Contracts', orderingOffset) + 'module '.length)
        );
        expect(await getDefinitionStart(codePath + 'Contracts.'.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('value object DeliveryCode', orderingOffset) + 'value object '.length)
        );
        expect(await getDefinitionStart(codePath + 'Contracts.DeliveryCode.'.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('raw: string;', text.indexOf('value object DeliveryCode', orderingOffset)))
        );
        expect(await getDefinitionStart(text.indexOf('depends on Contracts') + 'depends on '.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('Contracts {', orderingOffset))
        );
        const invocationPath = text.indexOf('Order.Order.fulfillItem');
        expect(await getDefinitionStart(invocationPath)).toEqual(
            document.textDocument.positionAt(text.indexOf('aggregate Order {', orderingOffset) + 'aggregate '.length)
        );
        expect(await getDefinitionStart(invocationPath + 'Order.'.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('root entity Order {', orderingOffset) + 'root entity '.length)
        );
        expect(await getDefinitionStart(invocationPath + 'Order.Order.'.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('method fulfillItem()') + 'method '.length)
        );
        const finalMethodOffset = text.indexOf('fulfillItem', invocationPath);
        const finalMethodDefinition = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(finalMethodOffset)
        });
        expect(finalMethodDefinition?.[0]?.originSelectionRange).toEqual({
            start: document.textDocument.positionAt(finalMethodOffset),
            end: document.textDocument.positionAt(finalMethodOffset + 'fulfillItem'.length)
        });
        expect(await getDefinitionStart(finalMethodOffset + 'fulfillItem'.length)).toEqual(
            document.textDocument.positionAt(text.indexOf('method fulfillItem()') + 'method '.length)
        );
        const firstSeparatorOffset = invocationPath + 'Order'.length;
        const firstSeparatorDefinition = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(firstSeparatorOffset)
        });
        expect(firstSeparatorDefinition?.[0]?.originSelectionRange).toEqual({
            start: document.textDocument.positionAt(firstSeparatorOffset - 'Order'.length),
            end: document.textDocument.positionAt(firstSeparatorOffset)
        });
        const secondSeparatorOffset = invocationPath + 'Order.Order'.length;
        const secondSeparatorDefinition = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(secondSeparatorOffset)
        });
        expect(secondSeparatorDefinition?.[0]?.originSelectionRange).toEqual({
            start: document.textDocument.positionAt(secondSeparatorOffset - 'Order'.length),
            end: document.textDocument.positionAt(secondSeparatorOffset)
        });

        const rightToLeftSegments = [
            { offset: invocationPath + 'Order.Order.'.length, text: 'fulfillItem' },
            { offset: invocationPath + 'Order.'.length, text: 'Order' },
            { offset: invocationPath, text: 'Order' }
        ];
        for (const segment of rightToLeftSegments) {
            const links = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(segment.offset)
            });
            expect(links?.[0]?.originSelectionRange).toEqual({
                start: document.textDocument.positionAt(segment.offset),
                end: document.textDocument.positionAt(segment.offset + segment.text.length)
            });
        }
    });

    test('links every segment of a qualified invocation across imported context parts', async () => {
        const canonical = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/order-context.tni'),
            'bounded context Ordering {}'
        );
        const aggregatePart = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/order-aggregate.tni'),
            `import "./order-context.tni";
             part of bounded context Ordering {
                 aggregate Order {
                     root entity Order { method place(); identifier id: OrderId; }
                     value object OrderId { raw: string; }
                 }
             }`
        );
        const applicationPart = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/order-application.tni'),
            `import "./order-context.tni";
             import "./order-aggregate.tni";
             part of bounded context Ordering {
                 application service OrderApplication {
                     method placeOrder(id: OrderId) {
                         invokes Order.Order.place;
                     }
                 }
             }`
        );
        documents = [canonical, aggregatePart, applicationPart];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(applicationPart.parseResult.parserErrors).toHaveLength(0);
        expect(applicationPart.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
        const text = applicationPart.textDocument.getText();
        const pathOffset = text.indexOf('Order.Order.place');
        const getDefinition = async (offset: number) => {
            const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(applicationPart, {
                textDocument: { uri: applicationPart.uri.toString() },
                position: applicationPart.textDocument.positionAt(offset)
            });
            return definitions?.[0]?.targetSelectionRange.start;
        };
        expect(await getDefinition(pathOffset)).toEqual(
            aggregatePart.textDocument.positionAt(aggregatePart.textDocument.getText().indexOf('aggregate Order {') + 'aggregate '.length)
        );
        expect(await getDefinition(pathOffset + 'Order.'.length)).toEqual(
            aggregatePart.textDocument.positionAt(aggregatePart.textDocument.getText().indexOf('root entity Order {') + 'root entity '.length)
        );
        expect(await getDefinition(pathOffset + 'Order.Order.'.length)).toEqual(
            aggregatePart.textDocument.positionAt(aggregatePart.textDocument.getText().indexOf('method place()') + 'method '.length)
        );
    });

    test('requires factory methods to return their aggregate root', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/invalid-factory.tni'),
            `bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    value object Other { raw: string; }
                }
                factory OrderFactory {
                    method createOrder() returns Other;
                    }
            }`
        );
        documents = [document];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('A factory method must return an aggregate-root entity in its own bounded context.')
        )).toBe(true);
    });

    test('selectively imports bounded contexts from a multi-context file', async () => {
        const catalog = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/contexts.tni'),
            'bounded context Ordering {} bounded context Shipping {} bounded context Billing {}'
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/map.tni'),
            `import { Ordering as Orders, Shipping } from "./contexts.tni";
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
        const importComponentOffset = consumer.textDocument.getText().indexOf('Ordering');
        const importDefinition = await services.Thinai.lsp.DefinitionProvider?.getDefinition(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(importComponentOffset)
        });
        expect(importDefinition?.[0]?.targetSelectionRange.start).toEqual(
            catalog.textDocument.positionAt(catalog.textDocument.getText().indexOf('Ordering'))
        );
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
                application service OrderApplication {
                    method placeOrder() {
                        behavior "Check [[Order.Order.missingMethod]] before placing.";
                    }
                }
            }`
        );
        documents = [document];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes("Could not resolve reference") &&
            String(diagnostic.message).includes("missingMethod"))
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
