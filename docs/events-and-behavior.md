# Events and Behavior

Thinai models application-service operations, aggregate behavior, domain and
integration events, and user-started flows. Behavior specifications remain
descriptive; structured clauses such as `invokes`, `emits`, and `transition`
provide navigable semantic relationships.

Quoted specifications can link to methods, parameters, repositories, domain
types, and fields by surrounding a qualified name with `[[` and `]]`. A link
identifies a model element; it does not evaluate an expression or invoke the method. Plain
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
            method place() {
                emits OrderPlaced;
                transition status from Draft to Placed;
            }
            status: OrderStatus;
        }
        enum OrderStatus { Draft, Placed }
    }
    repository OrderRepository for Order;
    factory OrderFactory {
        method createOrder() returns Order.Order;
    }

    event OrderPlaced;

    application service OrderApplication {
        method placeOrder(orderId: OrderId, items: List<OrderLine>) {
            precondition "The order contains at least one item.";
            invokes Order.Order.place;
            behavior "Place the order while its status is [[Order.Order.status]].";
        }
        method createOrder() {
            invokes OrderFactory.createOrder;
        }
    }
}
```

Factories and repositories are declared beside aggregates in the bounded
context. Factory methods create and return the aggregate root; behavior
specifications link to the method rather than to a constructor or the factory
declaration itself.

Aggregate-root methods may emit multiple domain events. Emissions are listed in
order. Application-service methods coordinate aggregate-root behavior, and may
invoke a factory method when creation is part of the use case. Thinai describes
these domain relationships; it does not require a load/save sequence or declare
transaction mechanics.

## Integration Events and Event-Triggered Methods

Domain events are private to their bounded context. To publish a fact across a
context boundary, an application-service method can receive a domain event and
emit one or more integration events. The integration-event declaration defines
the public schema; the method's behavior text describes any payload mapping.
Event payloads carry stable value data rather than entity instances or other
aggregate-owned types. An IntegrationEvent nested in a module must be explicitly
exposed before another bounded context can consume it.

For CQRS reads, a `read model` is an optional query-result shape, not necessarily
a materialized projection or separate database. A `query repository` is an
optional logical read boundary and may query the same physical tables as the
write side. A `projector` is needed only when the model uses an event-driven
projection. Query services may read through query or aggregate repositories and
must return data, not entity instances. Projectors do not call application
services or change aggregates:

```thinai
bounded context Ordering {
    event OrderPlaced data { orderId: string; }
    read model OrderSummary { orderId: string; status: string; }
    query repository OrderSummaryRepository serves OrderSummary;
    projector OrderSummaryProjector {
        method onOrderPlaced(source: event OrderPlaced) {
            projects OrderSummary;
            behavior "Copy [[OrderPlaced.orderId]] into [[OrderSummary.orderId]] via [[OrderSummaryRepository]].";
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

    application service OrderApplication {
        method publishOrderPlaced(source: event OrderPlaced) {
            emits Contracts.OrderPlacedV1;
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
application service ShipmentApplication {
    method createShipment(shipmentId: ShipmentId) {
        invokes Shipment.Shipment.start;
    }

    method onOrderPlaced(source: event Ordering.Contracts.OrderPlacedV1) {
        invokes createShipment;
        behavior "Map the incoming event to the local command input.";
    }
}
```

Keep the imported contract at this boundary; use local types in ordinary
command methods and aggregates. Do not model arbitrary payload transformations
as expressions. Integration-event publication is an application-layer reaction
to a local DomainEvent. Delivery ordering, broker behavior, and outbox mechanics
are outside the DSL.

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
command methods in one bounded context. A flow is descriptive and does not
declare or combine transaction boundaries. A flow may also
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
