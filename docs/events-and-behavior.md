# Events and Behavior

Thinai models application-service operations, aggregate behavior, domain and
integration events, and user-started flows. Behavior specifications remain
descriptive; structured clauses such as `invokes`, `emits`, and `transition`
provide navigable semantic relationships.

## Aggregate Effects and Application Services

An ordinary application-service method is a command operation. It coordinates
aggregate behavior, while the aggregate method owns state changes and emits
domain events:

```thinai
bounded context Ordering {
    aggregate Order {
        root entity OrderRoot operations {
            method place() emits OrderPlaced {
                transition status from Draft to Placed;
            }
        } {
            status: OrderStatus;
        }
        enum OrderStatus { Draft, Placed }
    }

    event OrderPlaced;

    application service OrderApplication for Order {
        method placeOrder(items: List<OrderLine>)
            invokes Order.OrderRoot.place {
            precondition "The order contains at least one item.";
            behavior "Place the order through its aggregate root.";
        }
    }
}
```

Aggregate methods may emit multiple domain events. Emissions are listed in
order. Application-service command methods invoke aggregate methods rather
than repeating their state transitions or event emissions.

## Integration Events and Event-Triggered Methods

Domain events are private to their bounded context. To publish a fact across a
context boundary, an application-service method can receive a domain event and
emit one or more integration events. The integration-event declaration defines
the public schema; the method's behavior text describes any payload mapping.

```thinai
bounded context Ordering {
    event OrderPlaced data {
        orderId: OrderId;
    }

    module Contracts {
        integration event OrderPlacedV1 data {
            orderId: OrderId;
        }
    }

    application service OrderApplication for Order {
        method publishOrderPlaced(source: event OrderPlaced) emits Contracts.OrderPlacedV1 {
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
    method createShipment(orderId: OrderId) {}

    method onOrderPlaced(source: event Ordering.Contracts.OrderPlacedV1)
        invokes createShipment {
        behavior "Map the incoming event to the local command input.";
    }
}
```

Keep the imported contract at this boundary; use local types in ordinary
command methods and aggregates. Do not model arbitrary payload transformations
as expressions. Integration-event publication is an application-layer reaction
to a committed domain event; broker and outbox mechanics are outside the DSL.

Cross-context integration-event use requires an explicit bounded-context
import and an imported context map with an authorized, correctly directed
relationship. The customer-to-supplier arrow points from the downstream
consumer to the upstream producer. The consumer is authorized by that
relationship, a consumer-side `Conformist` or `AntiCorruptionLayer`, or a
producer-side `PublishedLanguage`. `OpenHostService` alone does not authorize
event handling. Context maps do not make domain events public.

## Flows

A flow describes an ordered user-started sequence of application-service
command methods. Event-triggered methods are not flow steps:

```thinai
flow PlaceOrder {
    actor Customer;
    invoke Ordering.OrderApplication.placeOrder;
}
```

Declare the initiating actor inline in the flow with `actor Customer;`. Flow
order is significant. Emitted events are derived from the invoked methods and
need not be repeated in the flow.

See the [Order Fulfillment example](../examples/order-fulfillment/README.md)
for a multi-file model with an integration-event consumer.
