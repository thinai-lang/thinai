# Thinai Language

Thinai is a domain-specific modeling language for expressing DDD structures,
relationships, and behavioral intent in a shared, navigable model. It models
strategic and tactical DDD, aggregates, application services, events, and flows.

## File Model

Declare a bounded context once, then extend it from explicitly imported files:

```thinai
// ordering.tni
subdomain OrderManagement kind core;

bounded context Ordering realizes OrderManagement {
    aggregate Order {
        root entity Order {
            method place() {
                emits OrderPlaced;
                transition status from Draft to Placed;
            }
            identifier id: OrderId;
            status: OrderStatus;
        }
        value object OrderId { raw: string; }
        enum OrderStatus { Draft, Placed }
        repository OrderRepository for Order;
    }
    event OrderPlaced;
}
```

```thinai
// ordering-events.tni
import "./ordering.tni";

part of bounded context Ordering {
    data object PlaceOrderInput {
        orderId: OrderId;
        items: List<OrderLine>;
    }
    data object PlaceOrderResult {
        orderId: OrderId;
        status: OrderStatus;
    }

    application service OrderApplication for Order {
        method placeOrder(input: PlaceOrderInput) returns PlaceOrderResult {
            invokes Order.Order.place;
            behavior "Place the order identified by [[input.orderId]] through the aggregate root and return [[result.status]].";
        }

        method publishOrderPlaced(source: event OrderPlaced) {
            emits OrderPlacedV1;
            behavior "Map the internal event to the public contract.";
        }
    }

    integration event OrderPlacedV1 data { orderId: string; }

    flow PlaceOrder {
        actor Customer;
        invoke OrderApplication.placeOrder with "orderId from the selected order and items from the order form";
    }
}
```

An entity method may transition its own enum state; the aggregate root
coordinates child-entity changes and protects invariants. Only aggregate-root
behavior emits domain events. Ordinary application-service
methods are aggregate-scoped commands; methods with an event-typed parameter are
event-triggered. Bounded-context-scoped query services model read-only
operations. Commands
that methods are aggregate-scoped and may link to aggregate-root or factory
methods with `invokes`. Repository loading/saving and transaction mechanics are
implementation details. Integration-event declarations define public schemas;
the application-service method can `emits` a contract in response to a local
domain event. Payload mapping is described in `behavior` text, not expressions.

An aggregate has one write repository. `ReadModel`, `QueryRepository`, and
`Projector` declarations are optional. A read model is a query-result shape, not
necessarily a materialized projection or separate database; a query service may
read through query or aggregate repositories, including from the same physical
tables as the write side. A projector describes an event-driven projection.
Queries may return primitives, data objects, read models, or collections. Data
objects are identity-free input/output shapes; they may nest value objects,
enums, collections, and other data objects, but not entities or read models.
Multiple application services may target the same aggregate. A `flow` can
sequence commands and queries within one bounded context.

An incoming integration event can invoke a local command method:

```thinai
application service ShipmentApplication for Shipment {
    method createShipment(shipmentId: ShipmentId) {
        invokes Shipment.Shipment.start;
    }

    method onOrderPlaced(source: event Ordering.OrderPlacedV1) {
        invokes createShipment;
        behavior "Map the incoming event to the local command input.";
    }
}
```

## Imports and Context Maps

Imports are direct and relative. An explicit bounded-context import makes its
declarations visible. A context map must also be imported for an authorized
cross-context integration-event relationship. Only IntegrationEvents cross
bounded-context boundaries; DomainEvents remain private. Customer-supplier
relationships point from customer/downstream to supplier/upstream, while
`integrationPatterns` are quoted labels from a predefined set, listed on the
endpoint they describe. They are descriptive metadata: they do not assert
implementation conformance and do not affect event authorization. A
customer-supplier relationship authorizes the customer to consume supplier
IntegrationEvents; a partnership authorizes consumption in either direction.

Partnerships use a bidirectional `<->` edge and may list side-specific
integration patterns. `SeparateWays` uses the symmetric `-x-` edge and does not
allow integration patterns or authorize event consumption. A `sharedKernel`
relationship references the declared shared-kernel component and lists its
participating bounded contexts; it does not authorize event consumption.

For an IntegrationEvent nested in a module, expose the event, then import its
owning bounded context and use the qualified module path. Modules organize one
bounded context; their names are part of the public path for nested contracts.
IntegrationEvent payloads cannot expose entities or types owned by aggregates.

When a file declares multiple components, select them explicitly:

```thinai
import { Ordering as Orders, Shipping } from "./contexts.tni";
```

Shared value objects belong in an explicit `shared kernel`. Context maps record
which bounded contexts share that kernel. Modules are optional internal
organization within a bounded context or shared kernel.

## Behavior and Flows

Use `invariant`, `precondition`, `postcondition`, and `behavior` for descriptive
domain meaning. Method bodies may also contain structured `invokes`, `emits`,
and `transition` relationships. Interpolated specifications can link to
methods, parameters, repositories, entities, value objects, enum types and
values, read models, events, and fields. A dotted reference such as
`[[input.address.street]]` makes each segment independently navigable. Links
are descriptive references, not expressions or executable calls. Factory
creation methods are ordinary methods that return their aggregate root. A
method may emit multiple events; their declaration order is significant.

Flows are ordered, user-started sequences of application-service commands and
read-only query-service methods. Steps may include optional descriptive
`with "..."` input mapping and `when "..."` guard text with linked references;
the DSL does not evaluate them, so commands must enforce their own invariants.
Event-triggered reactions are represented by event-typed methods, not flows.
Declare actors inline with
`actor Customer;`; capabilities are declared at context or module scope.

Thinai supports modules, aggregates, root and child entities, identifiers and
mirrored value objects, data objects, read models, projectors, query services and repositories,
typed methods and constructors, domain services, write repositories, factories,
events, flow-local actors, flows, and context maps.
Built-in collections are
`List<T>`, `Set<T>`, and `Map<K, V>`.

The language server provides keyword and cross-reference completion,
navigation, diagnostics, import-path completion, and quick fixes for unresolved
declarations that can be imported.

## What's in the folder?

- [src/thinai.langium](src/thinai.langium) — grammar definition.
- [src/thinai-validator.ts](src/thinai-validator.ts) — semantic validation.
- [src/thinai-scope.ts](src/thinai-scope.ts) — import and reference scoping.
- [test](test) — parsing, linking, validation, and LSP tests.
