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
                    repository OrderRepository for Order;
                }
                application service OrderApplication for Order {
                    transactional method placeOrder(id: OrderId) loads OrderRepository by id invokes Order.Order.place saves OrderRepository {
                    }
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

    test('requires references to another aggregate entity to use its identifier', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Customer {
                    root entity Customer {
                        identifier id: CustomerId;
                    }
                    value object CustomerId { raw: string; }
                }
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId;
                        buyer: Customer;
                    }
                    value object OrderId { raw: string; }
                }
            }
        `);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An aggregate must reference another aggregate through its identifier'
        ))).toBe(true);
    });

    test('allows a non-root entity to identify itself and transition its own state', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId;
                    }
                    value object OrderId { raw: string; }
                    entity OrderLine {
                        method ship() { transition status from Open to Shipped; }
                        identifier id: OrderLineId;
                        status: LineStatus;
                    }
                    value object OrderLineId { raw: string; }
                    enum LineStatus { Open, Shipped }
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows the aggregate root to coordinate a child-entity transition', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method shipLine(lineId: OrderLineId) invokes Order.OrderLine.ship;
                        identifier id: OrderId;
                    }
                    value object OrderId { raw: string; }
                    entity OrderLine {
                        method ship() { transition status from Open to Shipped; }
                        identifier id: OrderLineId;
                        status: LineStatus initial Open;
                    }
                    value object OrderLineId { raw: string; }
                    enum LineStatus { Open, Shipped }
                    repository OrderRepository for Order;
                }
                application service OrderApplication for Order {
                        transactional method shipLine(id: OrderId) loads OrderRepository by id invokes Order.Order.shipLine saves OrderRepository;
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('validates a state graph from its declared initial state', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { transition status from Draft to Placed; }
                        method pay() { transition status from Placed to Paid; }
                        identifier id: OrderId;
                        status: OrderStatus initial Draft;
                    }
                    value object OrderId { raw: string; }
                    enum OrderStatus { Draft, Placed, Paid }
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects unreachable states from the declared initial state', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { transition status from Draft to Placed; }
                        identifier id: OrderId;
                        status: OrderStatus initial Draft;
                    }
                    value object OrderId { raw: string; }
                    enum OrderStatus { Draft, Placed, Cancelled }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            "State 'Cancelled' is unreachable from initial state 'Draft'."
        ))).toBe(true);
    });

    test('rejects duplicate fields and enum values', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        constructor(id: OrderId);
                        constructor(otherId: OrderId);
                        identifier id: OrderId;
                        status: string;
                        status: string;
                    }
                    value object OrderId { raw: string; }
                    enum OrderStatus { Draft, Draft }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes("Duplicate field 'status'."))).toBe(true);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes("Duplicate enum value 'Draft'."))).toBe(true);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes('Duplicate constructor signature.'))).toBe(true);
    });

    test('requires each entity to declare an identifier', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    entity OrderLine { quantity: number; }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An entity must declare exactly one identifier field.'
        ))).toBe(true);
    });

    test('requires entities to belong to an aggregate', async () => {
        const document = await parse(`
            bounded context Ordering {
                entity Order {
                    identifier id: OrderId;
                }
                value object OrderId { raw: string; }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An entity must belong to an aggregate.'
        ))).toBe(true);
    });

    test('requires an entity identifier value object to belong to that aggregate', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Customer {
                    root entity Customer { identifier id: CustomerId; }
                    value object CustomerId { raw: string; }
                }
                aggregate Order {
                    root entity Order { identifier id: CustomerId; }
                    value object OrderId { raw: string; }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An entity identifier value object must be declared in the same aggregate.'
        ))).toBe(true);
    });

    test('keeps entity inheritance within an aggregate', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Customer {
                    root entity Customer { identifier id: CustomerId; }
                    value object CustomerId { raw: string; }
                }
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    entity SpecialOrder extends Customer { identifier id: SpecialOrderId; }
                    value object SpecialOrderId { raw: string; }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Entity inheritance must stay within the same aggregate.'
        ))).toBe(true);
    });

    test('requires an entity transition to target a field on that entity', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method placeLine() { transition status from Open to Shipped; }
                        identifier id: OrderId;
                        lineStatus: OrderStatus;
                    }
                    value object OrderId { raw: string; }
                    entity OrderLine {
                        method ship() { transition status from Open to Shipped; }
                        identifier id: OrderLineId;
                        status: OrderStatus;
                    }
                    value object OrderLineId { raw: string; }
                    enum OrderStatus { Open, Shipped }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A transition must target an enum field declared on the owning entity.'
        ))).toBe(true);
    });

    test('requires application services to enter an aggregate through its root', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    entity OrderLine {
                        method ship();
                        identifier id: OrderLineId;
                    }
                    value object OrderLineId { raw: string; }
                    repository OrderRepository for Order;
                }
                application service OrderApplication for Order {
                    transactional method shipLine(id: OrderId) loads OrderRepository by id invokes Order.OrderLine.ship saves OrderRepository;
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An application service may invoke only methods declared on its associated aggregate root.'
        ))).toBe(true);
    });

    test('prevents child entities from crossing into application-service signatures', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    entity OrderLine { identifier id: OrderLineId; }
                    value object OrderLineId { raw: string; }
                }
                application service OrderApplication for Order {
                    method updateLine(line: OrderLine);
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Application-service signatures must use identifiers or data values, not entity instances.'
        ))).toBe(true);
    });

    test('prevents domain behavior from invoking application-service methods', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                }
                domain service Pricing {
                    method calculate() invokes OrderApplication.placeOrder;
                }
                application service OrderApplication for Order {
                    method placeOrder();
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Domain behavior cannot invoke an application-service method.'
        ))).toBe(true);
    });

    test('prevents domain call chains from reaching application services', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order { root entity Order { identifier id: OrderId; } value object OrderId { raw: string; } }
                domain service Pricing {
                    method calculate() invokes OrderApplication.placeOrder;
                }
                domain service Reporting {
                    method report() invokes Pricing.calculate;
                }
                application service OrderApplication for Order { method placeOrder(); }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Domain behavior cannot transitively invoke an application-service method.'
        ))).toBe(true);
    });

    test('prevents application services from reaching aggregate behavior through a domain service', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { method place(); identifier id: OrderId; }
                    value object OrderId { raw: string; }
                }
                domain service OrderPolicy {
                    method apply() invokes Order.Order.place;
                }
                application service OrderApplication for Order {
                    method placeOrder() invokes OrderPolicy.apply;
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An application service must reach aggregate behavior directly through its root'
        ))).toBe(true);
    });

    test('prevents a context-level domain service from invoking a child entity directly', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    entity OrderLine { method ship(); identifier id: OrderLineId; }
                    value object OrderLineId { raw: string; }
                }
                domain service ShippingPolicy {
                    method shipLine() invokes Order.OrderLine.ship;
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Only entity behavior may invoke child-entity methods'
        ))).toBe(true);
    });

    test('allows read-only query steps and descriptive guards in flows', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { method place(); identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    repository OrderRepository for Order;
                }
                read model OrderLookup { eligible: boolean; }
                query service OrderQueries {
                    method lookup() returns boolean reads OrderLookupRepository;
                }
                query repository OrderLookupRepository for OrderLookup;
                application service OrderCommands for Order {
                    transactional method placeOrder(id: OrderId) loads OrderRepository by id invokes Order.Order.place saves OrderRepository;
                }
                flow LookupOrder {
                    actor Customer;
                    invoke OrderQueries.lookup;
                    invoke OrderCommands.placeOrder when "The check [[OrderQueries.lookup]] reports that the order can be placed.";
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('requires repository workflows to load and save through the same repository', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place();
                        identifier id: OrderId;
                    }
                    value object OrderId { raw: string; }
                    repository OrderRepository for Order;
                    repository OtherOrderRepository for Order;
                }
                application service OrderApplication for Order {
                    transactional method placeOrder(id: OrderId) loads OrderRepository by id invokes Order.Order.place saves OtherOrderRepository;
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A repository workflow must load and save through the same repository'
        ))).toBe(true);
    });

    test('allows aggregate-scoped command services and cross-aggregate query reads', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place();
                        identifier id: OrderId;
                    }
                    value object OrderId { raw: string; }
                    repository OrderWriteRepository for Order;
                }
                aggregate Customer {
                    root entity Customer {
                        method activate();
                        identifier id: CustomerId;
                    }
                    value object CustomerId { raw: string; }
                    repository CustomerWriteRepository for Customer;
                }
                read model OrderSearch { orderNumber: string; }
                read model CustomerHistory { customerName: string; }
                query repository OrderSearchRepository for OrderSearch;
                query repository CustomerHistoryRepository for CustomerHistory;
                application service OrderCommands for Order {
                    transactional method placeOrder(id: OrderId) loads OrderWriteRepository by id invokes Order.Order.place saves OrderWriteRepository;
                }
                application service CustomerCommands for Customer {
                    transactional method activateCustomer(id: CustomerId) loads CustomerWriteRepository by id invokes Customer.Customer.activate saves CustomerWriteRepository;
                }
                query service OrderingReports {
                    method findOrders(text: string) returns string reads OrderSearchRepository, CustomerHistoryRepository;
                }
                flow ActivateCustomerAndPlaceOrder {
                    invoke CustomerCommands.activateCustomer;
                    invoke OrderCommands.placeOrder;
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('supports read models, projectors, query flow steps, and descriptive guards', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place();
                        identifier id: OrderId;
                    }
                    value object OrderId { raw: string; }
                    enum OrderStatus { Draft, Placed }
                    repository OrderRepository for Order;
                }
                read model OrderEligibility {
                    orderId: OrderId;
                    status: OrderStatus;
                    eligible: boolean;
                }
                query repository OrderEligibilityRepository for OrderEligibility;
                event OrderPlaced data { orderId: string; }
                projector OrderEligibilityProjector for OrderEligibility {
                    method onOrderPlaced(source: event OrderPlaced) updates OrderEligibilityRepository after commit {
                        behavior "Copy [[OrderPlaced.orderId]] into [[OrderEligibility.orderId]].";
                    }
                }
                query service OrderQueries {
                    method canPlace(id: OrderId) returns OrderEligibility reads OrderEligibilityRepository;
                }
                application service OrderCommands for Order {
                    transactional method place(id: OrderId) loads OrderRepository by id invokes Order.Order.place saves OrderRepository;
                }
                flow PlaceOrder {
                    actor Customer;
                    invoke OrderQueries.canPlace;
                    invoke OrderCommands.place when "The eligibility query [[OrderQueries.canPlace]] reports that placement is allowed.";
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects more than one write repository for an aggregate', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    repository FirstOrderRepository for Order;
                    repository SecondOrderRepository for Order;
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An aggregate may have only one write repository'
        ))).toBe(true);
    });

    test('accepts factory-based creation followed by saving through its repository', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                    repository OrderRepository for Order;
                    factory OrderFactory for Order operations {
                        method createOrder(id: OrderId) returns Order;
                    }
                }
                application service OrderApplication for Order {
                    transactional method createOrder(id: OrderId) creates Order.OrderFactory.createOrder saves OrderRepository;
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('accepts queries without aggregate saves and requires commands to model deletion', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method validateDeletion();
                        identifier id: OrderId;
                    }
                    value object OrderId { raw: string; }
                    repository OrderRepository for Order;
                }
                read model OrderReadModel { status: string; }
                query repository OrderReadModelRepository for OrderReadModel;
                application service OrderApplication for Order {
                    transactional method deleteOrder(id: OrderId) loads OrderRepository by id invokes Order.Order.validateDeletion deletes OrderRepository;
                }
                query service OrderQueries {
                    method getOrder(id: OrderId) returns string reads OrderReadModelRepository;
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('requires aggregate write workflows to declare a transaction', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place();
                        identifier id: OrderId;
                    }
                    value object OrderId { raw: string; }
                    repository OrderRepository for Order;
                }
                application service OrderApplication for Order {
                    method placeOrder(id: OrderId) loads OrderRepository by id invokes Order.Order.place saves OrderRepository;
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Aggregate write workflows must declare a transaction.'
        ))).toBe(true);
    });

    test('requires integration-event publication from a domain event handler to occur after commit', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order { root entity Order { identifier id: OrderId; } value object OrderId { raw: string; } }
                event OrderPlaced;
                integration event OrderPlacedV1;
                application service OrderApplication for Order {
                    method publish(source: event OrderPlaced) emits OrderPlacedV1;
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Integration events mapped from domain events must be emitted after commit.'
        ))).toBe(true);
    });

    test('rejects an integration-event payload that exposes an entity', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId; }
                    value object OrderId { raw: string; }
                }
                value object InternalOrderCode { raw: string; }
                integration event OrderPlaced data {
                    order: Order;
                    orderId: OrderId;
                    code: InternalOrderCode;
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Event payloads must not expose entity instances'
        ))).toBe(true);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An integration-event payload must not expose types owned by an aggregate.'
        ))).toBe(true);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Integration-event payload types must be public contract types'
        ))).toBe(true);
    });

    test('accepts integration-event payload types explicitly exposed by their contract module', async () => {
        const document = await parse(`
            bounded context Shipping {
                module Contracts {
                    exposes OrderPlacedV1, OrderReference;
                    value object OrderReference { raw: string; }
                    integration event OrderPlacedV1 data { order: OrderReference; }
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('requires module-nested integration events to be exposed before cross-context use', async () => {
        const document = await parse(`
            bounded context Ordering {
                module Contracts {
                    integration event OrderPlacedV1;
                }
            }
            bounded context Shipping {
                aggregate Shipment {
                    root entity Shipment { identifier id: ShipmentId; }
                    value object ShipmentId { raw: string; }
                }
                application service ShipmentEvents for Shipment {
                    method onOrderPlaced(source: event Ordering.Contracts.OrderPlacedV1) {}
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An integration event in a module must be explicitly exposed'
        ))).toBe(true);
    });

    test('rejects event publication from a context-level domain service', async () => {
        const document = await parse(`
            bounded context Ordering {
                domain service OrderPolicy {
                    method check() emits OrderPlaced;
                }
                event OrderPlaced;
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Only aggregate-root behavior may emit domain events'
        ))).toBe(true);
    });

    test('rejects integration-event publication from aggregate-root behavior', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() emits OrderPlacedV1;
                        identifier id: OrderId;
                    }
                    value object OrderId { raw: string; }
                }
                integration event OrderPlacedV1;
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Aggregate-root behavior may emit only domain events.'
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
