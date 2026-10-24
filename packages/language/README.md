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

    value object OrderLine {
      sku: string
      quantity: number
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
behavior emits domain events. Aggregate-root behavior is declared on the root
entity; domain services, repositories, and factories are bounded-context or
module peers of aggregates. Application services orchestrate use cases and may coordinate
multiple aggregates; methods with an event-typed parameter are event-triggered.
Bounded-context-scoped query services model read-only operations. Application
service methods may link to aggregate-root, factory, or domain-service methods with `invokes`; they must not invoke value-object methods directly.
Repository loading/saving and transaction mechanics are implementation details.
Factories and context-level value objects use identifiers and domain values
rather than entity instances. Entity references are rejected recursively,
including entities nested inside value-object shapes, unless both belong to the
same aggregate. A factory that needs another aggregate uses its
identifier or a value-object snapshot; if its input comes from a DataObject, an
application service maps that DataObject into domain values first. Domain
services may accept aggregate-root or entity parameters because they model domain
operations, but their signatures use domain values rather than DataObjects.
Method and constructor signatures follow this table:

| Method / constructor | Inputs | Outputs |
|---|---|---|
| Entity constructor | Domain values; same-aggregate entity references; no DataObjects, events, read models, or foreign entities | No return |
| Context-level value-object constructor | Domain values; no entities, DataObjects, events, or read models | No return |
| Aggregate-owned value-object constructor | Domain values; same-aggregate entity references; no DataObjects, events, read models, or foreign entities | No return |
| Entity method | Domain values; same-aggregate entity references; no DataObjects, events, read models, or foreign entities | Domain values; same-aggregate entity references |
| Aggregate-owned value-object method | Domain values; same-aggregate entity references; no DataObjects, events, read models, or foreign entities | Domain values; same-aggregate entity references |
| Context-level value-object method | Domain values; no entities, DataObjects, events, or read models | Domain values |
| Factory method | Identifiers, value objects, primitives, enums, and collections of those; no entities, DataObjects, events, or read models | Its own aggregate root only |
| Domain-service method | Entity or aggregate-root entity parameters and domain values; no DataObjects, events, or read models | Domain values; no entities, DataObjects, or read models |
| Application-service method | Domain values and DataObjects; no entities or read models; event handlers have exactly one event parameter and no other parameters | Domain values and DataObjects; no entities or read models |
| Query-service method | Domain values and DataObjects; no entities, read models, or events | Domain values, DataObjects, and read models; no entities |
| Projector method | Exactly one domain or integration event | No return; only `projects` targets |

“Domain values” means primitives, enums, value objects, identifiers, and
collections of those values. DataObjects remain application-service and
query-service boundary shapes. Aggregate-owned value objects retain the
existing allowance for same-aggregate entity references.
Integration-event declarations define public schemas;
the application-service method can `emits` a contract in response to a local
domain event. Payload mapping is described in `behavior` text, not expressions.
Application-service methods may invoke other methods in the same application
service; the invoked method must itself obey the aggregate-boundary rules. Only
an event handler may dispatch to a command in a different application service.
Application services must not invoke value-object methods directly; model a
calculation as domain-service behavior or aggregate behavior instead.

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
services may read domain repositories when a business rule requires it. An
external query API must be published and authorized by an imported context map.
Application services, query services, projectors, and domain services may use
such a published query API; prefer event data or a domain-facing port or
anti-corruption layer when replay or domain isolation matters.
Method-level `behavior` describes how returned data is used—there are no result
aliases or per-read behavior clauses. A projector behavior may link the
aggregate repository it declares in `reads from`; other repository references
still describe query-repository output. A read model remains a query-result shape,
not necessarily a materialized projection or separate database.
Local query methods may return primitives, data objects, read models, domain
values such as value objects and enums, or collections of those results.
Published cross-context query APIs expose primitives or public data-object
contracts (context-level DataObjects or DataObjects exposed by their module).
In non-journey method prose, link the published result
type or field rather than the query operation itself; journeys may link
visible application and query operations as timeline entries. Data objects are
identity-free input/output shapes; they may nest value objects,
enums, collections, and other data objects, but not entities or read models.
Read-model fields may use primitives, value objects, enums, or other read
models, but not DataObjects. Read models are projection shapes rather than
application-service boundary shapes.
Use value objects or identifiers inside entity, value-object, factory, and
domain-service methods and constructors; DataObjects belong at application and
query boundaries.
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

    method onOrderPlaced(source: Ordering.Contracts.OrderPlacedV1) {
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
A context-level event and its context-level payload types are public; when the
event or a payload type is nested in a module, expose it. IntegrationEvent
payloads cannot expose entities or types owned by aggregates.
A payload value object or enum may come from an exposed sibling module when the
event's module depends on that module; the normal dependency and exposure rules
apply.

When a file declares multiple components, select them explicitly:

```thinai
import { Ordering as Orders, Shipping } from "./contexts.tni"
```

An alias applies to every visible declaration of the selected component,
including members contributed from other imported files. For example, if
`Ordering` is aliased as `Orders`, contributed declarations are available as
`Orders.Member` as well as under their canonical path. Aliases do not import
files on their own: import the contribution file that declares the members you
use. Declarations in the current document can also be referenced through a
local context alias.

Shared value objects belong in an explicit `shared kernel`. Context maps record
which bounded contexts share that kernel. Modules are optional internal
organization within a bounded context or shared kernel. `exposes` names
declarations such as value objects, enums, events, services, modules, and
methods; fields and enum values inherit visibility from their declaration.
Only the terminal declaration in a qualified path must be exposed; structural
containers such as an aggregate, entity, or service used as path segments do not
need separate exposures. An identifier value object referenced by a `mirrors`
declaration is an explicit exception: the mirror may name an identifier that is
private to its module, because the local mirror is the sanctioned cross-context
use. Exposing a nested module re-exports that module's
public API through the enclosing module, recursively through explicit exposure
edges. A client that depends on the outer module can use the nested module's
exposed declarations without a separate dependency. `depends on` is not a
re-export. Direct dependencies on nested modules remain valid. A module may use
its own exposed nested module's public API without a redundant dependency; use
`depends on` when the nested module itself is not exposed by its parent, while
still exposing every declaration you reference. A module may expose only
its direct child modules and declarations, so deep re-export requires each level
to expose the next; terminal declarations must still be exposed by their owning
module. Exposing a query service publishes the operations whose result is a
primitive or a public DataObject (context-level or exposed by its module); operations returning read models,
value objects, enums, or unexposed module-nested data objects remain local. Cross-context
consumers require a module-exposed query service with a primitive or public
DataObject result; a context-level query service is local and journey-visible
only. Direct module-to-module method references still require the method itself
to be exposed. Published query DataObjects expose their nested DataObject, value
object, and enum shape, including enum values; aggregate-owned contract types
produce a warning. Journeys are model-level timelines and do not require either
form of module exposure merely to invoke an application-service command.

## Behavior and Journeys

Use `invariant`, `precondition`, `postcondition`, and `behavior` for descriptive
domain meaning. Method bodies may also contain structured `invokes`, `emits`,
and `transition` relationships. Interpolated specifications can link to
methods, parameters, repositories, entities, value objects, enum types and
values, read models, events, and fields. A dotted reference such as
`[[input.address.street]]` makes each segment independently navigable. A
qualified path may also continue through a field's declared type, for example
`[[Shop.Dto.address.city]]`. Links are descriptive references, not expressions
or executable calls. A specification
inside an entity or value object may refer to that enclosing object's fields and
methods by their bare names; fields or methods on other objects require an
owner-qualified path, such as `[[Order.Order.customerId]]` or
`[[Order.Order.ensureOwner]]`. Operation inputs and results use their named
roots, such as `[[input.orderId]]` and `[[result.status]]`; the canonical form is
required for the current result binding. Where a method's result shape is
visible, a method path may also continue through it directly, such as
`[[Command.status]]`, as a compatibility convenience. The name `result` is reserved for the operation result on methods
that declare a result or are application-service commands; it cannot be used as
a parameter there, but remains available on constructors and on other
non-returning methods. Factory
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
scope, then reference it in a `by Actor { ... }` block. Each actor may have at
most one `by` block per journey. A journey does not
represent background event handoffs, a synchronous remote call, or a shared
transaction; event-triggered reactions remain in their contexts. Steps may
include optional descriptive `with "..."` input text and `when "..."` guard
text with linked references; commands enforce their own invariants.

A journey is a model-level command timeline, not a module or a bounded context.
Steps are ordered in source order across actor blocks. A later step's `with` or
`when` prose may refer to inputs or results of earlier command invocations.
The current command's result becomes visible only to later steps. A command
operation invoked later in the same journey is not visible from an earlier step;
public operations not scheduled later remain linkable. References to
a command result name the nearest earlier invocation of that command; a journey
that invokes the same command more than once produces a warning because those
references are inherently ambiguous. The language deliberately has no step
variables, step labels, result aliases, or executable condition blocks.

Journey command targets are application-service commands and do not require
module exposure merely because a journey invokes them. The invoked command's
declared input/output contract is visible to the journey, including nested
fields, collections, field types, and enum values, even when those types live in
nested modules or aggregates. Aggregate-owned value objects and enums are
therefore reusable in command contracts without creating duplicate DTOs.
Visibility is based on the command contract and timeline, not on blanket module
exposure. Private aggregate internals that are not reachable through a command
contract and private DomainEvent internals remain off-limits. An exposed
command whose contract publishes aggregate-owned or otherwise private contract
types produces a warning, because the command is effectively publishing those
types; use public or shared contract types if that is not intended. Journey prose is
cross-context by design and does not require a context-map authorization;
context maps remain relevant to actual event and query consumption.

Application-service event handlers, query repositories, repositories, domain
services, projectors, factories, entity fields, and DomainEvents are not
journey-visible. Query services are visible when they are context-level or
exposed by their module; the result shape of a visible query operation is
visible as part of that operation's contract. Read models, data objects, value
objects, and enums are visible when they are context-level or exposed by their
module; aggregate-owned declarations remain visible only through command or
query contract closure. Shared-kernel declarations do not require a context-map
relationship in journey prose, but module-nested shared-kernel declarations
still require module exposure. Integration events follow their usual rule:
context-level events are public, and module-nested events require exposure.
Journey prose may also link visible read models, query results, data
objects, value objects, enums, public integration events, and user-facing
operations from imported contexts. Links follow the journey timeline: a command
operation invoked later in the same journey is not visible from an earlier
step. `with` describes the inputs of the step;
`when` describes the conditions under which the command is invoked. Both are
descriptive prose, not executable expressions.

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

When a domain term is also a Thinai keyword, quote the identifier with
backticks in declarations and references:

```thinai
data object Request {
  `value`: string
}

behavior "Use [[Request.`value`]]."
```

The same quoted form is available for field, parameter, method, type, and enum
value names. Completion inserts the quoted form automatically for such names.

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
