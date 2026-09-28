# Thinai Language

Thinai models strategic DDD, tactical DDD, aggregate behavior, application
services, domain and integration events, and user-started flows.

## File Model

Declare a bounded context once, then extend it from explicitly imported files:

```thinai
// ordering.tni
subdomain OrderManagement kind core;

bounded context Ordering realizes OrderManagement {
    aggregate Order {
        root entity OrderRoot operations {
            method place() emits OrderPlaced {
                transition status from Draft to Placed;
            }
        } {
            identifier id: OrderId;
            status: OrderStatus;
        }
        identifier value object OrderId for OrderRoot { raw: string; }
        enum OrderStatus { Draft, Placed }
    }
    event OrderPlaced;
}
```

```thinai
// ordering-events.tni
import "./ordering.tni";

part of bounded context Ordering {
    application service OrderApplication for Order {
        method placeOrder(items: List<OrderLine>) invokes Order.OrderRoot.place {
            behavior "Place the order through its aggregate root.";
        }

        method publishOrderPlaced(source: event OrderPlaced) emits OrderPlacedV1 {
            behavior "Map the internal event to the public contract.";
        }
    }

    integration event OrderPlacedV1 data { orderId: OrderId; }

    flow PlaceOrder {
        actor Customer;
        invoke OrderApplication.placeOrder;
    }
}
```

Aggregate methods own state transitions and emit domain events. Ordinary
application-service methods are command operations; methods with an
event-typed parameter are event-triggered. Integration-event declarations
define public schemas; the application-service method maps the source event to
that contract. Field mapping is described in `behavior` text, not expressions.

An incoming integration event can invoke a local command method:

```thinai
application service ShipmentApplication for Shipment {
    method createShipment(orderId: OrderId) {}

    method onOrderPlaced(source: event Ordering.OrderPlacedV1)
        invokes createShipment {
        behavior "Map the incoming event to the local command input.";
    }
}
```

## Imports and Context Maps

Imports are direct and relative. An explicit bounded-context import makes its
declarations visible. A context map must also be imported for an authorized
cross-context integration-event relationship. Only IntegrationEvents cross
bounded-context boundaries; DomainEvents remain private. The consumer must be
the customer in a `customer supplier` relation, the consumer in a conformist or
anti-corruption-layer relation, or the target of a producer's `published
language` relation.

For an IntegrationEvent nested in a module, import its owning bounded context
and use the qualified module path. Modules organize one bounded context;
their names are part of the public path for nested contracts.

When a file declares multiple components, select them explicitly:

```thinai
import "./contexts.tni" { Ordering as Orders, Shipping };
```

Shared value objects belong in an explicit `shared kernel`. Context maps record
which bounded contexts share that kernel. Modules are optional internal
organization within a bounded context or shared kernel.

## Behavior and Flows

Use `invariant`, `precondition`, `postcondition`, and `behavior` for descriptive
domain meaning. Structured `invokes`, `emits`, and `transition` clauses are
navigable semantic relationships. A method may emit multiple events; their
declaration order is significant.

Flows are ordered, user-started sequences of ordinary application-service
methods. Event-triggered reactions are represented by event-typed methods, not
flows. EventStorming boards are optional reference-oriented visualizations and
do not define execution order.

Thinai supports modules, aggregates, root entities, identifier and mirrored
value objects, entities, value objects, typed methods and constructors, domain
services, repositories, factories, events, read models, actors, external
systems, context maps, and EventStorming boards. Built-in collections are
`List<T>`, `Set<T>`, and `Map<K, V>`.

The language server provides keyword and cross-reference completion,
navigation, diagnostics, import-path completion, and quick fixes for unresolved
declarations that can be imported.

## What's in the folder?

- [src/thinai.langium](src/thinai.langium) — grammar definition.
- [src/thinai-validator.ts](src/thinai-validator.ts) — semantic validation.
- [src/thinai-scope.ts](src/thinai-scope.ts) — import and reference scoping.
- [test](test) — parsing, linking, validation, and LSP tests.
