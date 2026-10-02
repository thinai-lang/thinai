# Events and Behavior

Thinai models application-service operations, aggregate behavior, domain and
integration events, and user-started flows. Behavior specifications remain
descriptive; structured clauses such as `invokes`, `emits`, and `transition`
provide navigable semantic relationships.

Quoted specifications can link to methods and to fields on entities or value
objects by surrounding a qualified name with `[[` and `]]`. A link identifies a
model element; it does not evaluate an expression or invoke the method. Plain
quoted specifications remain unlinked text. Multiline quoted specifications
dedent their content when a newline follows the opening quote.

## Aggregate Effects and Application Services

An ordinary application-service method is a command operation. It coordinates
aggregate-root behavior; root and child entity methods own their respective
state changes, and the aggregate root protects invariants across the aggregate.
Domain events are emitted by aggregate-root behavior:

```thinai
bounded context Ordering {
    aggregate Order {
        root entity Order {
            method place() emits OrderPlaced {
                transition status from Draft to Placed;
            }
            status: OrderStatus;
        }
        enum OrderStatus { Draft, Placed }
        repository OrderRepository for Order;
        factory OrderFactory for Order operations {
            method createOrder() returns Order;
        }
    }

    event OrderPlaced;

    application service OrderApplication for Order {
        transactional method placeOrder(orderId: OrderId, items: List<OrderLine>) loads OrderRepository by orderId invokes Order.Order.place saves OrderRepository {
            precondition "The order contains at least one item.";
            behavior "Place the loaded order while its status is [[Order.Order.status]].";
        }
        transactional method createOrder() creates Order.OrderFactory.createOrder saves OrderRepository;
    }
}
```

Factory operations are methods that create the aggregate root. A factory method
returns that root entity, and behavior specifications link to the method rather
than to a constructor or the factory declaration itself.

Aggregate-root methods may emit multiple domain events. Emissions are listed in
order. Transactional application-service commands model persistence explicitly: load an
existing aggregate, invoke aggregate-root behavior, then save through the same
repository. Creation uses a factory and saves the new aggregate through its
repository. `transactional` declares the intended atomic boundary. Behavior
text remains descriptive; these workflow clauses are the enforceable structure,
not proof of runtime transaction behavior.

## Integration Events and Event-Triggered Methods

Domain events are private to their bounded context. To publish a fact across a
context boundary, an application-service method can receive a domain event and
emit one or more integration events. The integration-event declaration defines
the public schema; the method's behavior text describes any payload mapping.
Event payloads carry stable value data rather than entity instances or other
aggregate-owned types. An IntegrationEvent nested in a module must be explicitly
exposed before another bounded context can consume it.

For CQRS reads, declare a separate `read model` projection and a
`query repository` for it. A `projector` handles committed domain or authorized
integration events and updates that repository. Query services read one or more
projections; these are query data structures, not DDD entities. Projector
handlers are descriptive projections and do not change aggregates:

```thinai
bounded context Ordering {
    event OrderPlaced data { orderId: string; }
    read model OrderSummary { orderId: string; status: string; }
    query repository OrderSummaryRepository for OrderSummary;
    projector OrderSummaryProjector for OrderSummary {
        method onOrderPlaced(source: event OrderPlaced) updates OrderSummaryRepository after commit {
            behavior "Copy [[OrderPlaced.orderId]] into [[OrderSummary.orderId]].";
        }
    }
}
```

```thinai
bounded context Ordering {
    event OrderPlaced data {
        orderId: OrderId;
    }

    module Contracts {
        exposes OrderPlacedV1;
        integration event OrderPlacedV1 data {
            orderId: string;
        }
    }

    application service OrderApplication for Order {
        method publishOrderPlaced(source: event OrderPlaced) emits Contracts.OrderPlacedV1 after commit {
            behavior "Map the internal event to the public contract.";
        }
    }
}
```

A method with an event-typed parameter is event-triggered. The `event` marker
in the parameter's type makes that event reference unambiguous. A consumer's
method can receive an imported integration event and invoke a local command
method:

```thinai
application service ShipmentApplication for Shipment {
    transactional method createShipment(shipmentId: ShipmentId) loads Shipment.ShipmentRepository by shipmentId invokes Shipment.Shipment.start saves Shipment.ShipmentRepository;

    method onOrderPlaced(source: event Ordering.Contracts.OrderPlacedV1)
        invokes createShipment {
        behavior "Map the incoming event to the local command input.";
    }
}
```

Keep the imported contract at this boundary; use local types in ordinary
command methods and aggregates. Do not model arbitrary payload transformations
as expressions. Integration-event publication is an application-layer reaction
to a committed domain event; `after commit` declares that ordering. Broker and
outbox mechanics are outside the DSL.

Cross-context integration-event use requires an explicit bounded-context
import and an imported context map with an authorized, correctly directed
relationship. The customer-to-supplier arrow points from the downstream
consumer to the upstream producer. This relationship authorizes the customer to
consume the supplier's IntegrationEvents; a partnership authorizes consumption
in either direction. `integrationPatterns` are descriptive labels and do not
affect authorization or assert implementation conformance. Separate-ways and
shared-kernel relationships do not authorize event handling. Context maps do
not make domain events public.

## Flows

A flow describes an ordered user-started sequence of application-service
command methods in one bounded context. Each command keeps its own
single-aggregate transaction; a flow
does not combine its steps into a multi-aggregate transaction. A flow may also
include read-only query-service methods and descriptive `with` input mappings
and `when` guards. They are linked prose, not executable data flow or
conditions; the command must still enforce its own invariant. Event-triggered
methods are not flow steps:

```thinai
flow PlaceOrder {
    actor Customer;
    invoke Ordering.OrderQueries.canPlaceOrder
        with "orderId from [[OrderSummary.orderId]]"
        when "The customer requests an eligibility check for the selected order.";
    invoke Ordering.OrderApplication.placeOrder
        with "orderId from [[OrderSummary.orderId]] and items from the selected order lines"
        when "The eligibility check [[Ordering.OrderQueries.canPlaceOrder]] allows this order.";
}
```

Declare the initiating actor inline in the flow with `actor Customer;`. Flow
order is significant. A query result is not bound to a command argument or
evaluated by the DSL; the `when` text documents intended user-flow behavior.
Emitted events are derived from the invoked methods and need not be repeated in
the flow.

See the [Order Fulfillment example](../examples/order-fulfillment/README.md)
for a multi-file model with an integration-event consumer.
