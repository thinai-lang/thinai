import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
import type { Model } from 'thinai-language';
import { createThinaiServices, isModel } from 'thinai-language';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver-types';

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
                        method place() {
                            emits OrderPlaced, OrderAudited
                            transition status from Draft to Placed
                        }
                        identifier id: OrderId
                        status: OrderStatus
                    }
                    value object OrderId {
                        raw: string
                    }
                    enum OrderStatus { Draft, Placed }
                }
                repository OrderRepository manages Order.Order
                application service OrderApplication {
                    method placeOrder(id: OrderId) {
                        invokes Order.Order.place
                    }
                }
                event OrderPlaced
                event OrderAudited
            }
        `);
        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('requires identifier fields to reference value objects', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: string }
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
                        identifier id: CustomerId
                    }
                    value object CustomerId { raw: string }
                }
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                        buyer: Customer
                    }
                    value object OrderId { raw: string }
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
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    entity OrderLine {
                        method ship() { transition status from Open to Shipped }
                        identifier id: OrderLineId
                        status: LineStatus
                    }
                    value object OrderLineId { raw: string }
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
                        method shipLine(lineId: OrderLineId) {
                            invokes Order.OrderLine.ship
                        }
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    entity OrderLine {
                        method ship() { transition status from Open to Shipped }
                        identifier id: OrderLineId
                        status: LineStatus initial Open
                    }
                    value object OrderLineId { raw: string }
                    enum LineStatus { Open, Shipped }
                }
                repository OrderRepository manages Order.Order
                application service OrderApplication {
                    method shipLine(id: OrderId) {
                        invokes Order.Order.shipLine
                    }
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
                        method place() { transition status from Draft to Placed }
                        method pay() { transition status from Placed to Paid }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed, Paid }
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows the same transition in different methods', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { transition status from Draft to Placed }
                        method placeFromImport() { transition status from Draft to Placed }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes('Duplicate state transition'))).toBe(false);
    });

    test('warns when a method repeats the same transition', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() {
                            transition status from Draft to Placed
                            transition status from Draft to Placed
                        }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Warning && String(diagnostic.message).includes(
                "Duplicate state transition 'Draft -> Placed' for 'status' in the same method."
            )
        )).toBe(true);
    });

    test('validates guarded emissions and coordinated transitions across fields', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method confirmPayment() {
                            transition status from Draft to Placed,
                                       paymentStatus from Pending to Confirmed
                                when "Payment is accepted for [[status]] and [[paymentStatus]]."
                            emits OrderPlaced, PaymentConfirmed
                                when "The [[paymentStatus]] state change is accepted."
                            emits OrderAudited
                        }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                        paymentStatus: PaymentStatus initial Pending
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                    enum PaymentStatus { Pending, Confirmed }
                }
                event OrderPlaced
                event PaymentConfirmed
                event OrderAudited
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects unreachable states from the declared initial state', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { transition status from Draft to Placed }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                    }
                    value object OrderId { raw: string }
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
                        constructor(id: OrderId)
                        constructor(otherId: OrderId)
                        identifier id: OrderId
                        status: string
                        status: string
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Draft }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes("Duplicate field 'status'."))).toBe(true);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes("Duplicate enum value 'Draft'."))).toBe(true);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes('Duplicate constructor signature.'))).toBe(true);
    });

    test('accepts domain-value constructor inputs and DataObject application-service inputs', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        constructor(id: OrderId, total: Money, owner: string)
                        identifier id: OrderId
                    }
                    value object OrderId {
                        constructor(raw: string)
                        raw: string
                    }
                    value object Money {
                        constructor(amount: number, currency: string)
                        amount: number
                        currency: string
                    }
                }
                data object PlaceOrderInput { orderId: OrderId }
                application service OrderApplication {
                    method placeOrder(input: PlaceOrderInput)
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects DataObject inputs to entity and value-object constructors', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        constructor(input: PlaceOrderInput)
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    value object Money {
                        constructor(input: PlaceOrderInput)
                        amount: number
                    }
                }
                data object PlaceOrderInput { amount: number }
            }
        `);

        expect(document.diagnostics?.filter(diagnostic => String(diagnostic.message).includes(
            'Constructors must accept domain values, not DataObjects'
        ))).toHaveLength(2);
    });

    test('rejects event-typed constructor parameters', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        constructor(source: OrderCreated)
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                event OrderCreated
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Constructors must not accept events'
        ))).toBe(true);
    });

    test('requires constructors to use an identifier instead of another aggregate root', async () => {
        const document = await parse(`
            bounded context Commerce {
                aggregate CustomerRecords {
                    root entity Buyer { identifier id: BuyerId }
                    value object BuyerId { raw: string }
                }
                aggregate Order {
                    root entity Order {
                        constructor(buyer: Buyer)
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A constructor must reference another aggregate through its identifier'
        ))).toBe(true);
    });

    test('requires each entity to declare an identifier', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine { quantity: number }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An entity must declare exactly one identifier field.'
        ))).toBe(true);
    });

    test('rejects optional entity identifiers', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id?: OrderId }
                    value object OrderId { raw: string }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An entity identifier field cannot be optional.'
        ))).toBe(true);
    });

    test('requires entities to belong to an aggregate', async () => {
        const document = await parse(`
            bounded context Ordering {
                entity Order {
                    identifier id: OrderId
                }
                value object OrderId { raw: string }
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
                    root entity Customer { identifier id: CustomerId }
                    value object CustomerId { raw: string }
                }
                aggregate Order {
                    root entity Order { identifier id: CustomerId }
                    value object OrderId { raw: string }
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
                    root entity Customer { identifier id: CustomerId }
                    value object CustomerId { raw: string }
                }
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity SpecialOrder extends Customer { identifier id: SpecialOrderId }
                    value object SpecialOrderId { raw: string }
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
                        method placeLine() { transition status from Open to Shipped }
                        identifier id: OrderId
                        lineStatus: OrderStatus
                    }
                    value object OrderId { raw: string }
                    entity OrderLine {
                        method ship() { transition status from Open to Shipped }
                        identifier id: OrderLineId
                        status: OrderStatus
                    }
                    value object OrderLineId { raw: string }
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
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine {
                        method ship()
                        identifier id: OrderLineId
                    }
                    value object OrderLineId { raw: string }
                }
                repository OrderRepository manages Order.Order
                application service OrderApplication {
                    method shipLine(id: OrderId) {
                        invokes Order.OrderLine.ship
                    }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An application service may invoke only aggregate-root behavior or a factory method that creates an aggregate root.'
        ))).toBe(true);
    });

    test('allows an application service to coordinate multiple aggregate roots', async () => {
        const document = await parse(`
            bounded context Commerce {
                aggregate Order {
                    root entity Order { method place() identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                aggregate Customer {
                    root entity Customer { method register() identifier id: CustomerId }
                    value object CustomerId { raw: string }
                }
                application service Checkout {
                    method completePurchase() {
                        invokes Order.Order.place
                        invokes Customer.Customer.register
                    }
                }
            }
        `);

        expect(document.parseResult.parserErrors).toHaveLength(0);
        expect(document.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toHaveLength(0);
    });

    test('prevents child entities from crossing into application-service signatures', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine { identifier id: OrderLineId }
                    value object OrderLineId { raw: string }
                }
                application service OrderApplication {
                    method updateLine(line: OrderLine)
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
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                domain service Pricing {
                    method calculate() { invokes OrderApplication.placeOrder }
                }
                application service OrderApplication {
                    method placeOrder()
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
                aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
                domain service Pricing {
                    method calculate() { invokes OrderApplication.placeOrder }
                }
                domain service Reporting {
                    method report() { invokes Pricing.calculate }
                }
                application service OrderApplication { method placeOrder() }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Domain behavior cannot transitively invoke an application-service method.'
        ))).toBe(true);
    });

    test('prevents domain services from invoking aggregate-owned methods', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { method place() identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                domain service OrderPolicy {
                    method apply() { invokes Order.Order.place }
                }
                application service OrderApplication {
                    method placeOrder() { invokes OrderPolicy.apply }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A domain service must not invoke aggregate-owned methods'
        ))).toBe(true);
    });

    test('prevents domain-service call chains from reaching aggregate-owned methods', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { method place() identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                domain service OrderPolicy {
                    method apply() { invokes OrderCalculator.calculate }
                }
                domain service OrderCalculator {
                    method calculate() { invokes Order.Order.place }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A domain service must not invoke aggregate-owned methods'
        ))).toBe(true);
    });

    test('prevents aggregate-owned methods from invoking domain services', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { invokes OrderPolicy.calculate }
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                domain service OrderPolicy { method calculate() }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Aggregate-owned methods must not invoke domain services'
        ))).toBe(true);
    });

    test('prevents aggregate-owned call chains from reaching domain services', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { invokes OrderPricing.calculate }
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    value object OrderPricing {
                        method calculate() { invokes PricingPolicy.calculate }
                    }
                }
                domain service PricingPolicy { method calculate() }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Aggregate-owned methods must not invoke domain services'
        ))).toBe(true);
    });

    test('allows application services to invoke a pure domain service and aggregate root directly', async () => {
        const document = await parse(`
            bounded context Ordering {
                data object PriceRequest { subtotal: number }
                data object PriceQuote { total: number }
                aggregate Order {
                    root entity Order {
                        method place(quote: PriceQuote) returns PriceQuote
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                domain service PricingPolicy {
                    method calculate(request: PriceRequest) returns PriceQuote
                    method inspect(order: Order.Order) returns PriceQuote
                }
                application service OrderApplication {
                    method placeOrder(request: PriceRequest) returns PriceQuote {
                        invokes PricingPolicy.calculate
                        invokes Order.Order.place
                    }
                }
            }
        `);

        expect(document.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
    });

    test('prevents domain services from returning aggregate entities', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                domain service OrderPolicy {
                    method findOrder() returns Order.Order
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Domain-service methods must return domain values, not aggregate entities.'
        ))).toBe(true);
    });

    test('allows aggregates to omit an optional write-repository declaration', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
            }
        `);

        expect(document.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
    });

    test('prevents a context-level domain service from invoking a child entity directly', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine { method ship() identifier id: OrderLineId }
                    value object OrderLineId { raw: string }
                }
                domain service ShippingPolicy {
                    method shipLine() { invokes Order.OrderLine.ship }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Only entity behavior may invoke child-entity methods'
        ))).toBe(true);
    });

    test('allows command journeys to describe query results without invoking the query', async () => {
        const document = await parse(`
            actor Customer
            bounded context Ordering {
                aggregate Order {
                    root entity Order { method place() identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                repository OrderRepository manages Order.Order
                read model OrderLookup { eligible: boolean }
                query service OrderQueries {
                    method lookup() returns boolean {
                        behavior "Read [[OrderLookupRepository]] to determine whether the order can be placed."
                    }
                }
                query repository OrderLookupRepository serves OrderLookup
                application service OrderCommands {
                    method placeOrder(id: OrderId) {
                        invokes Order.Order.place
                    }
                }
            }
            journey LookupOrder {
                by Customer {
                    invoke Ordering.OrderCommands.placeOrder with "id from [[id.raw]]" when "The check [[Ordering.OrderQueries.lookup.result]] reports that the order can be placed."
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('does not require repository choreography in application-service methods', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                repository OrderRepository manages Order.Order
                application service OrderApplication {
                    method placeOrder(id: OrderId) {
                        behavior "Place an order using the supplied identifier."
                    }
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows application services to orchestrate commands and cross-aggregate query reads', async () => {
        const document = await parse(`
            actor Customer
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                repository OrderWriteRepository manages Order.Order
                aggregate Customer {
                    root entity Customer {
                        method activate()
                        identifier id: CustomerId
                    }
                    value object CustomerId { raw: string }
                }
                repository CustomerWriteRepository manages Customer.Customer
                read model OrderSearch { orderNumber: string }
                read model CustomerHistory { customerName: string }
                query repository OrderSearchRepository serves OrderSearch
                query repository CustomerHistoryRepository serves CustomerHistory
                application service OrderCommands {
                    method placeOrder(id: OrderId) {
                        invokes Order.Order.place
                    }
                }
                application service CustomerCommands {
                    method activateCustomer(id: CustomerId) {
                        invokes Customer.Customer.activate
                    }
                }
                query service OrderingReports {
                    method findOrders(text: string) returns string {
                        behavior "Combine [[OrderSearchRepository]] with [[CustomerHistoryRepository]] for the report."
                    }
                }
            }
            journey ActivateCustomerAndPlaceOrder {
                by Customer {
                    invoke Ordering.CustomerCommands.activateCustomer with "id from [[id.raw]]"
                    invoke Ordering.OrderCommands.placeOrder with "id from [[id.raw]]"
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('supports read models, projectors, command journeys, and descriptive guards', async () => {
        const document = await parse(`
            actor Customer
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                }
                repository OrderRepository manages Order.Order
                data object PlaceOrderInput {
                    orderId: OrderId
                    requestedStatus: OrderStatus
                }
                data object PlaceOrderResult {
                    orderId: OrderId
                    status: OrderStatus
                }
                read model OrderEligibility {
                    orderId: OrderId
                    status: OrderStatus
                    eligible: boolean
                }
                query repository OrderEligibilityRepository serves OrderEligibility
                event OrderPlaced { orderId: string }
                projector OrderEligibilityProjector {
                    method onOrderPlaced(source: OrderPlaced) {
                        projects OrderEligibility
                        behavior "Copy [[OrderPlaced.orderId]] into [[OrderEligibility.orderId]] via [[OrderEligibilityRepository]], then update [[OrderEligibility.status]]."
                    }
                }
                query service OrderQueries {
                    method canPlace(orderId: OrderId) returns OrderEligibility {
                        behavior "Read [[OrderEligibilityRepository]] and return [[result.eligible]] for [[orderId]]."
                    }
                }
                application service OrderCommands {
                    method place(input: PlaceOrderInput) returns PlaceOrderResult {
                        invokes Order.Order.place
                        behavior "Place the order for [[input.orderId]] and return its [[result.status]]."
                    }
                }
            }
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.OrderCommands.place with "input.orderId from [[input.orderId]] and input.requestedStatus from the customer selection"
                        when "The eligibility query [[Ordering.OrderQueries.canPlace.result.eligible]] reports that placement is allowed."
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows nested data objects but rejects entity and read-model fields', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine { identifier id: OrderLineId }
                    value object OrderLineId { raw: string }
                }
                read model OrderSummary { status: string }
                data object Address { street: string }
                data object ShippingInput {
                    address: Address
                    line: OrderLine
                    summary: OrderSummary
                }
            }
        `);

        expect(document.diagnostics?.filter(diagnostic =>
            String(diagnostic.message).includes('Data objects may contain value data')
        )).toHaveLength(2);
    });

    test('requires projector methods to declare targets and rejects projects on other methods', async () => {
        const document = await parse(`
            bounded context Commerce {
                read model OrderSummary { orderId: string }
                event OrderPlaced
                projector OrderProjection {
                    method onOrderPlaced(source: OrderPlaced) {}
                }
                application service OrderApplication {
                    method publish() { projects OrderSummary }
                }
            }
        `);

        const errors = document.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => String(diagnostic.message)) ?? [];
        expect(errors).toContain('A projector method must declare at least one read model with projects.');
        expect(errors).toContain('The projects clause is allowed only in projector methods.');
    });

    test('rejects more than one write repository for an aggregate', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                repository FirstOrderRepository manages Order.Order
                repository SecondOrderRepository manages Order.Order
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An aggregate may have only one write repository'
        ))).toBe(true);
    });

    test('requires a write repository to manage an aggregate-root entity', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine { identifier id: OrderLineId }
                    value object OrderLineId { raw: string }
                }
                repository OrderLineRepository manages Order.OrderLine
            }
        `);

        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('A repository must manage an aggregate-root entity.')
        )).toBe(true);
    });

    test('allows application services to invoke factory methods without repository choreography', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                repository OrderRepository manages Order.Order
                factory OrderFactory {
                    method createOrder(id: OrderId) returns Order.Order
                    }
                application service OrderApplication {
                    method createOrder(id: OrderId) {
                        invokes OrderFactory.createOrder
                    }
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows a factory to create different aggregate roots with different methods', async () => {
        const document = await parse(`
            bounded context Commerce {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                aggregate Customer {
                    root entity Customer { identifier id: CustomerId }
                    value object CustomerId { raw: string }
                }
                factory CommerceFactory {
                    method createOrder(id: OrderId) returns Order.Order
                    method createCustomer(id: CustomerId) returns Customer.Customer
                }
            }
        `);

        expect(document.parseResult.parserErrors).toHaveLength(0);
        expect(document.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toHaveLength(0);
    });

    test('allows read queries and descriptive delete commands without repository choreography', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method validateDeletion()
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                repository OrderRepository manages Order.Order
                read model OrderReadModel { status: string }
                query repository OrderReadModelRepository serves OrderReadModel
                application service OrderApplication {
                    method deleteOrder(id: OrderId) {
                        invokes Order.Order.validateDeletion
                        behavior "Delete the order when its root confirms deletion is allowed."
                    }
                }
                query service OrderQueries {
                    method getOrder(id: OrderId) returns string {
                        behavior "Read [[OrderReadModelRepository]] for the requested order."
                    }
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows query services to read aggregate repositories without query projections', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                repository OrderRepository manages Order.Order
                query service OrderQueries {
                    method getStatus(id: OrderId) returns string {
                        behavior "Read the status for [[id]] from [[OrderRepository]]."
                    }
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows integration-event handlers without an after-commit clause', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
                event OrderPlaced
                integration event OrderPlacedV1
                application service OrderApplication {
                    method publish(source: OrderPlaced) {
                        emits OrderPlacedV1
                    }
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects an integration-event payload that exposes an entity', async () => {
        const document = await parse(`
            bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                value object InternalOrderCode { raw: string }
                integration event OrderPlaced {
                    order: Order
                    orderId: OrderId
                    code: InternalOrderCode
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
                    exposes OrderPlacedV1, OrderReference
                    value object OrderReference { raw: string }
                    integration event OrderPlacedV1 { order: OrderReference }
                }
            }
        `);

        expect(checkDocumentValid(document) || document.diagnostics?.map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('requires module-nested integration events to be exposed before cross-context use', async () => {
        const document = await parse(`
            bounded context Ordering {
                module Contracts {
                    integration event OrderPlacedV1
                }
            }
            bounded context Shipping {
                aggregate Shipment {
                    root entity Shipment { identifier id: ShipmentId }
                    value object ShipmentId { raw: string }
                }
                application service ShipmentEvents {
                    method onOrderPlaced(source: Ordering.Contracts.OrderPlacedV1) {}
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
                    method check() { emits OrderPlaced }
                }
                event OrderPlaced
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
                        method place() { emits OrderPlacedV1 }
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                integration event OrderPlacedV1
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Aggregate-root behavior may emit only domain events.'
        ))).toBe(true);
    });

    test('prevents application services from invoking cross-context aggregates', async () => {
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering { aggregate Order { root entity Order { method place() identifier id: OrderId } value object OrderId { raw: string } } }'
        );
        const shipping = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            'import "./ordering.tni" bounded context Shipping { application service ShippingApplication { method place() { invokes Ordering.Order.Order.place } } }'
        );
        documents = [ordering, shipping];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(
            checkDocumentValid(shipping) || shipping.diagnostics?.map(diagnosticToString).join('\n')
        ).toEqual(expect.stringContaining('A method may invoke across bounded-context boundaries only through an authorized shared-kernel domain service.'));
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
                sharedKernel CommonTypes { participants: [Ordering] }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A shared-kernel relationship must include at least two bounded contexts'
        ))).toBe(true);
    });

    test('allows shared-kernel domain services but rejects data objects in shared-kernel modules', async () => {
        const valid = await parse(`
            shared kernel Common {
                value object Money { amount: number }
                domain service PricingPolicy {
                    method normalize(money: Money) returns number
                }
                module Policies {
                    domain service TaxPolicy { method rate(amount: number) returns number }
                }
            }
        `);
        expect(valid.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);

        const invalid = await parse(`
            shared kernel Common {
                module Payloads {
                    data object Address { street: string }
                }
            }
        `);
        expect(invalid.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A shared kernel may contain only reusable value objects, enums, domain services, and modules.'
        ))).toBe(true);

        const coLocated = await parse(`
            bounded context Ordering {
                application service OrderApplication {
                    method normalize(amount: number) returns number { invokes Common.PricingPolicy.normalize }
                }
            }
            bounded context Shipping {}
            shared kernel Common {
                domain service PricingPolicy { method normalize(amount: number) returns number }
            }
            context map SharedPolicies {
                sharedKernel Common { participants: [Ordering, Shipping] }
            }
        `);
        expect(coLocated.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
    });

    test('allows application services to invoke an imported shared-kernel service for participating contexts', async () => {
        const shared = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-policy-kernel.tni'),
            'shared kernel Common { domain service PricingPolicy { method normalize(amount: number) returns number } }'
        );
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-policy-contexts.tni'),
            'bounded context Ordering {} bounded context Shipping {}'
        );
        const map = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-policy-map.tni'),
            'import "./shared-policy-kernel.tni" import "./shared-policy-contexts.tni" context map SharedPolicies { sharedKernel Common { participants: [Ordering] } }'
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-policy-consumer.tni'),
            `import "./shared-policy-contexts.tni"
             import { Common } from "./shared-policy-kernel.tni"
             import { SharedPolicies } from "./shared-policy-map.tni"
             part of bounded context Ordering {
                 application service OrderApplication {
                     method normalize(amount: number) returns number { invokes Common.PricingPolicy.normalize }
                 }
             }`
        );
        const nonParticipant = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-policy-nonparticipant.tni'),
            `import "./shared-policy-contexts.tni"
             import { Common } from "./shared-policy-kernel.tni"
             import { SharedPolicies } from "./shared-policy-map.tni"
             part of bounded context Shipping {
                 application service ShippingApplication {
                     method normalize(amount: number) returns number { invokes Common.PricingPolicy.normalize }
                 }
             }`
        );
        documents = [shared, contexts, map, consumer, nonParticipant];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(consumer.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
        expect(nonParticipant.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A method may invoke across bounded-context boundaries only through an authorized shared-kernel domain service.'
        ))).toBe(true);
    });

    test('rejects shared-kernel service calls without an imported relationship', async () => {
        const shared = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/unlinked-shared-policy-kernel.tni'),
            'shared kernel Common { domain service PricingPolicy { method normalize(amount: number) returns number } }'
        );
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/unlinked-shared-policy-contexts.tni'),
            'bounded context Ordering {}'
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/unlinked-shared-policy-consumer.tni'),
            `import "./unlinked-shared-policy-contexts.tni"
             import { Common } from "./unlinked-shared-policy-kernel.tni"
             part of bounded context Ordering {
                 application service OrderApplication {
                     method normalize(amount: number) returns number { invokes Common.PricingPolicy.normalize }
                 }
             }`
        );
        documents = [shared, contexts, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(consumer.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A method may invoke across bounded-context boundaries only through an authorized shared-kernel domain service.'
        ))).toBe(true);
    });

    test('rejects duplicate integration patterns on a context-map endpoint', async () => {
        const document = await parse(`
            bounded context Ordering {}
            bounded context Shipping {}
            context map Fulfillment {
                customer Shipping { integrationPatterns: ["AntiCorruptionLayer", "AntiCorruptionLayer"] }
                    -> supplier Ordering
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
                customer Shipping { integrationPatterns: ["AntiCorruptionLayre"] }
                    -> supplier Ordering
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
                    entries: Map<string>
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
            'import "./catalog.tni" as Contexts bounded context Billing {}'
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
