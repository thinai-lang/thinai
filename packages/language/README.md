# Thinai Language

<p><img src="../extension/icons/thinai-light.svg" alt="Thinai logo" width="80"></p>

Thinai is a domain-specific modeling language for expressing DDD structures,
relationships, and behavioral intent in a shared, navigable model. It models
strategic and tactical DDD, aggregates, application services, events, and journeys.
Thinai uses braces for blocks and does not use semicolon terminators.

For topic-based introductions, see the [Thinai language guides](https://thinai-lang.github.io/)
and the [complete Order Fulfillment example](../../examples/order-fulfillment/README.md).

## File Model

Declare a bounded context once, without braces. Put members in one or more
`in bounded context Name { ... }` blocks; contributions in other files import
the file containing the canonical declaration:

```thinai
// ordering.tni
subdomain OrderManagement kind core

bounded context Ordering realizes OrderManagement
in bounded context Ordering {
  aggregate Order {
    root entity Order {
      method place() {
        emits OrderPlaced
        transition status from Draft to Placed
      }

      identifier id: OrderId
      status: OrderStatus
    }

    value object OrderId {
      raw: string
    }

    enum OrderStatus {
      Draft,
      Placed
    }
  }

  repository OrderRepository {
      manages Order.Order
  }

  event OrderPlaced
}
```

```thinai
// ordering-events.tni
import "./ordering.tni"

actor Customer

in bounded context Ordering {
  data object PlaceOrderInput {
    orderId: OrderId
    items: List<OrderLine>
  }

  data object PlaceOrderResult {
    orderId: OrderId
    status: OrderStatus
  }

  application service OrderApplication {
    method placeOrder(input: PlaceOrderInput) returns PlaceOrderResult {
      reads from OrderRepository
      invokes Order.Order.place
      behavior "Place the order identified by [[input.orderId]] through the aggregate root and return [[result.status]]."
    }

    method publishOrderPlaced(source: OrderPlaced) {
      emits OrderPlacedV1
      behavior "Map the internal event to the public contract."
    }
  }

  integration event OrderPlacedV1 {
    orderId: string
  }
}

journey PlaceOrder {
  by Customer {
    invoke Ordering.OrderApplication.placeOrder
      with "orderId from the selected order and items from the order form"
  }
}
```

An entity method may transition its own enum state; the aggregate root
coordinates child-entity changes and protects invariants. Only aggregate-root
behavior emits domain events. Aggregate behavior is declared on the root entity;
domain services, repositories, and factories are bounded-context or module peers
of aggregates. Application services orchestrate use cases and may coordinate
multiple aggregates; methods with an event-typed parameter are event-triggered.
Bounded-context-scoped query services model read-only operations. Application
service methods may link to aggregate-root or factory methods with `invokes`.
Repository loading/saving and transaction mechanics are implementation details.
Integration-event declarations define public schemas;
the application-service method can `emits` a contract in response to a local
domain event. Payload mapping is described in `behavior` text, not expressions.

An aggregate may declare at most one write repository; repository declarations
are optional and use blocks:

```thinai
repository OrderRepository {
  manages Order.Order
}

query repository OrderSummaryRepository {
  serves OrderSummary
  reads from Order, Customer
}
```

`reads from` on a query repository records aggregate-owned table data queried
directly; it does not mean the query repository calls a command-side repository.

Method-level `reads from` documents optional data dependencies and may have a
descriptive `when` guard. Application services read aggregate repositories;
query services read query repositories; projectors use events and write their
declared `projects` targets. CQRS projectors do not read query repositories.
Aggregate-repository and external query-API reads are explicit projector
exceptions, since current-state lookups can make replay results differ. Domain
services may read domain repositories when a business rule requires it; external
query dependencies should be behind a domain-facing port/anti-corruption layer.
An external query API must be published and authorized by a context map.
Method-level `behavior` describes how returned data is used—there are no result
aliases or per-read behavior clauses. A read model remains a query-result shape,
not necessarily a materialized projection or separate database.
Queries may return primitives, data objects, read models, or collections. Data
objects are identity-free input/output shapes; they may nest value objects,
enums, collections, and other data objects, but not entities or read models.
Multiple application services may invoke the same aggregate. A top-level
`journey` sequences user-invoked application-service commands across bounded
contexts. Its order is descriptive; background event handoffs stay with the
contexts' event declarations and handlers.

An incoming integration event can invoke a local command method:

```thinai
bounded context Shipping
in bounded context Shipping {
  application service ShipmentApplication {
    method createShipment(shipmentId: ShipmentId) {
      invokes Shipment.Shipment.start
    }

    method onOrderPlaced(source: Ordering.OrderPlacedV1) {
      invokes createShipment
      behavior "Map the incoming event to the local command input."
    }
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
import { Ordering as Orders, Shipping } from "./contexts.tni"
```

Shared value objects belong in an explicit `shared kernel`. Context maps record
which bounded contexts share that kernel. Modules are optional internal
organization within a bounded context or shared kernel.

## Behavior and Journeys

Use `invariant`, `precondition`, `postcondition`, and `behavior` for descriptive
domain meaning. Method bodies may also contain structured `invokes`, `emits`,
and `transition` relationships. Interpolated specifications can link to
methods, parameters, repositories, entities, value objects, enum types and
values, read models, events, and fields. A dotted reference such as
`[[input.address.street]]` makes each segment independently navigable. Links
are descriptive references, not expressions or executable calls. Factory
creation methods are ordinary methods that return their aggregate root. A
method may emit multiple events; their declaration order is significant.
Use triple double quotes for multiline specifications; keep single or double
quotes for single-line text. Put the opening and closing `"""` delimiters on
their own lines for block-style text. Common line indentation is layout, while
relative indentation, line breaks, and linked references are preserved. The
formatter indents continuation text and aligns the closing delimiter with its
specification clause. Existing multiline single- and double-quoted strings
remain accepted for compatibility.

Journeys are top-level, actor-led timelines of user-invoked application-service
commands that may cross bounded contexts. Declare each `actor` once at model
scope, then reference it in a `by Actor { ... }` block. A journey does not
represent background event handoffs, a synchronous remote call, or a shared
transaction; event-triggered reactions remain in their contexts. Steps may
include optional descriptive `with "..."` input text and `when "..."` guard
text with linked references; commands enforce their own invariants.

Thinai supports modules, aggregates, root and child entities, identifiers and
mirrored value objects, data objects, read models, projectors, query services and repositories,
typed methods and constructors, domain services, write repositories, factories,
events, reusable actors, journeys, and context maps.
Built-in collections are
`List<T>`, `Set<T>`, and `Map<K, V>`.
Primitive types include `string`, `number`, `boolean`, `date`, `time`, and
`instant`. Use `date` for a calendar date, `time` for a wall-clock time without
a date or time zone, and `instant` for an exact point on the global timeline.
`time` does not represent an elapsed duration; model richer temporal concepts,
such as a time-zone-aware appointment, with a value object.
Use `initial State` only on a non-optional enum field of an entity; it marks the
starting point of that entity's state graph, not a default for arbitrary data.
Describe other creation-time defaults as constructor postconditions or behavior.

The language server provides keyword and cross-reference completion,
navigation, diagnostics, import-path completion, document formatting, and quick
fixes for unresolved declarations that can be imported. Formatting uses the
editor's indentation options; the VS Code extension defaults Thinai files to two
spaces.

## What's in the folder?

- [src/thinai.langium](src/thinai.langium) — grammar definition.
- [src/thinai-formatter.ts](src/thinai-formatter.ts) — document formatting.
- [src/thinai-validator.ts](src/thinai-validator.ts) — semantic validation.
- [src/thinai-scope.ts](src/thinai-scope.ts) — import and reference scoping.
- [test](test) — parsing, linking, validation, and LSP tests.
