# Thinai Language

<p><img src="https://raw.githubusercontent.com/thinai-lang/thinai-lang.github.io/main/public/assets/thinai-light.svg" alt="Thinai logo" width="80"></p>

Thinai is a domain-specific modeling language for expressing DDD structures,
relationships, and behavioral intent in a shared, navigable model. It models
strategic and tactical DDD, aggregates, application services, events, and journeys.
Thinai uses braces for blocks and does not use semicolon terminators.

> **Alpha:** Thinai is in alpha. Language rules and tooling may
> change between alpha releases; review the language guides and release notes
> before relying on it in production.

For topic-based introductions, see the [Thinai language guides](https://thinai-lang.dev/)
and the [complete Order Fulfillment example](https://github.com/thinai-lang/thinai-lang.github.io/blob/main/examples/order-fulfillment/README.md).

## File Model

Declare a bounded context once, without braces, in a **root file**. Put members
in one or more `in bounded context Name { ... }` blocks either in the root file
or in **part files** that the root imports. A part never imports its root or a
peer part; importing the root makes the whole context available to other
contexts.

A document's model unit is its root plus the directly imported parts. Duplicate
declaration names are scoped to that unit; independent models may reuse names.
Cross-references still require the target to be reachable through the document's
own direct imports; imports are not implicitly transitive. Actors, journeys, and
subdomains have their own strategic namespaces, so a subdomain may share a name
with its bounded context. Subdomains are referenced through `realizes`; they are
not specification-path targets.

```thinai
// ordering.tni
import "./ordering-events.tni"

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
      quantity: integer
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

Enum values must be separated by commas. Values may share a line or each start
a new line; the formatter expands inline enums to one value per line.

## Model export and agent tooling

The language package exports `exportThinaiModel`, `createContextSlice`, and
`computeImpact` for building model graphs, task-scoped context slices, and
impact reports. The [CLI](../cli/README.md) exposes them through `inspect`,
`context`, `impact`, `validate`, and `mcp` commands. See the
[agent workflow guide](https://thinai-lang.dev/agent-workflow/) for the
model-first coding workflow.

Non-empty blocks start their first statement on the line after `{`. Put child
declarations and statements on separate lines. Comma-separated lists such as
parameters, exposure declarations, `projects` targets, transition changes, and
enum values may stay inline. The formatter wraps `exposes` and `depends on`
lists at 120 characters, one item per continuation line.

```thinai
// ordering-events.tni
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
application service maps that DataObject into domain values first. A factory
creates exactly one aggregate root: all of its valid methods must return the
same root entity, and separate roots require separate factories. Domain
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
| Factory method | Identifiers, value objects, primitives, enums, and collections of those; no entities, DataObjects, events, or read models | The single aggregate root created by this factory; every valid method in one factory returns that same root |
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

<!-- thinai-fragment -->
```thinai
repository OrderRepository {
  manages Order.Order
}

query repository OrderSummaryRepository {
  serves OrderSummary
}

read model OrderLookup {
  orderId: OrderId
  customerId: CustomerId
  status: OrderStatus
}

query repository OrderLookupRepository {
  serves OrderLookup
  reads from Order, Customer
}
```

A query repository has two distinct query-side forms:

- A repository with `reads from` reads aggregate-owned write-model tables
  directly. It may join multiple aggregates and form the served read model
  without a projector. `reads from` does not mean the query repository calls a
  command-side repository.
- A repository without `reads from` serves a read model maintained by a
  projector. The read model is created and updated from domain or integration
  events; the query repository only reads that maintained shape.

A repository may intentionally mix both forms, but separating them makes the
consistency and coupling tradeoffs explicit. `reads from` does not mean the
query repository calls a command-side repository.

Method-level `reads from` documents optional data dependencies and may have a
descriptive `when` guard. Application services read aggregate repositories;
query services read query repositories; projectors use events and write their
declared `projects` targets. A projector method handles exactly one domain or
integration event. A projector in the event's owning bounded context reacts to
the domain event; an integration event is handled only by a consumer context.
CQRS projectors do not read query repositories.
Aggregate-repository and external query-API reads are explicit projector
exceptions, since current-state lookups can make replay results differ. Domain
services may read domain repositories when a business rule requires it. An
external query API must be published and authorized by an imported context map,
or by a context map in the same document when the query service and reader are
declared there. Application services, query services, projectors, and domain
services may use such a published query API; prefer event data or a
domain-facing port or anti-corruption layer when replay or domain isolation
matters.
Method-level `behavior` describes how returned data is used—there are no result
aliases or per-read behavior clauses. A projector behavior may link the
aggregate repository it declares in `reads from`; other repository references
still describe query-repository output. A read model remains a query-result shape,
not necessarily a materialized projection or separate database.
Local query methods may return primitives, data objects, read models, domain
values such as value objects and enums, or collections of those results.
Published cross-context query APIs expose primitives or context-visible or
module-exposed data-object contracts.
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
`journey` sequences non-event application-service commands, with optional
query-service reads, across bounded contexts. Any application-service method
without an event parameter is treated as a command; a method with an event
parameter is an event handler. Journeys remain command-led: each actor block
must contain at least one command, and query steps document supporting reads.
Its order is descriptive; background event handoffs stay with the contexts'
event declarations and handlers.

An incoming integration event can invoke a local command method:

<!-- thinai-fragment -->
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
declarations visible. A file may be imported with multiple component selections;
a bare import of the same file may appear only once. A context map authorizes a
cross-context integration-event relationship when it is imported with the other
endpoint's document, or when it is declared in the same document as both
endpoints. Only IntegrationEvents cross bounded-context boundaries; DomainEvents
remain private. An integration event is handled only outside its owning bounded
context; same-context reactions use the domain event. Customer-supplier
relationships point from customer/downstream to supplier/upstream, while
`integrationPatterns` are quoted labels from a predefined set, listed on the
endpoint they describe. They are descriptive metadata: they do not assert
implementation conformance and do not affect event authorization. The
conventional side mapping is `Conformist` and `AntiCorruptionLayer` on the
customer/downstream endpoint, and `OpenHostService` and `PublishedLanguage` on
the supplier/upstream endpoint. A partnership may use any pattern on either
side. A mismatched customer/supplier pattern is reported as a warning. A
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
A context-level IntegrationEvent and its context-level payload types are
published contracts; when the event or a payload type is nested in a module,
expose it. Consumers still need an authorizing relationship. Any method in an
authorized consumer context may link an exposed integration event's payload
shape, not only the event handler. IntegrationEvent payloads cannot expose
entities or types owned by aggregates.
A payload value object or enum may come from an exposed sibling module when the
event's module depends on that module; the normal dependency and exposure rules
apply. A direct dependency on a nested module is not by itself enough for a
public event payload: every enclosing module must expose the payload type.

When a file declares multiple components, select them explicitly:

<!-- thinai-fragment -->
```thinai
import { Ordering as Orders, Shipping } from "./contexts.tni"
```

An alias renames the component for the importing document. If `Ordering` is
aliased as `Orders`, reference its declarations as `Orders.Member`; the
canonical `Ordering.Member` spelling is not available unless the same file is
also imported with a bare import or the component is imported again without an
alias. An alias applies to every visible declaration of the selected component,
including members declared in the context's part files. Inside a part,
declarations belonging to its own context keep context-relative spellings such
as `Module.Type` and `Type`; no import of the root is needed. Aliases are
document-local scope names; an alias must not collide with any visible path-root
spelling, including a context-relative suffix such as `Module` or `Type`, a
component name, or a canonical declaration visible through imports. Terminal
fields, methods, enum values, and parameters do not conflict with aliases.
Strategic declarations (actors, journeys, and subdomains) are not aliased by
component imports; import them with a bare file import rather than a component
selection. Aliases do not import files on their own: the context root must still
be imported for its members to be visible.

Shared value objects belong in an explicit `shared kernel`. Context maps record
which bounded contexts share that kernel. Modules are optional internal
organization within a bounded context or shared kernel. `exposes` names
declarations the module owns that the grammar allows it to expose: aggregates,
entities, value objects, data objects, read models, enums, events, services,
projectors, repositories, factories, modules, and methods. Exposing a container
also publishes its behavioral members: an aggregate publishes its root entity
and the root entity's methods; an entity, value object, service, projector, or
factory publishes its methods. Child entities and nested value objects or enums
remain private unless exposed explicitly. Fields, parameters, and enum values
inherit visibility from their declaration.
A qualified specification path may traverse structural containers without
exposing each segment: bounded contexts, context maps, shared kernels, modules,
aggregates, entities, services, projectors, and factories. Data-bearing
declarations (value objects, data objects, read models, enums, and fields) are
different: using one as a non-terminal path segment exposes its shape, so the
source must be in the same module, reach it through the public module API or a
direct dependency, share its shared kernel through an authorized relationship,
or traverse an authorized event or published-query contract. The terminal
declaration is still checked
against the applicable visibility rule. Module exposure and context-level
visibility make a declaration available inside the bounded context; they do not
by themselves publish it to another bounded context. In particular, they do not make
another bounded context's value object, data object, read model, or enum
directly usable as a field, parameter, or return type. Use a local mirror for identifiers, an
IntegrationEvent for event data, a shared-kernel type where appropriate, or a
published query result contract for read data. An identifier value object referenced by a `mirrors`
declaration is an explicit exception: the mirror may name an identifier that is
private to its module, because the local mirror is the sanctioned cross-context
use. Exposing a nested module re-exports that module's
public API through the enclosing module, recursively through explicit exposure
edges. A client that depends on the outer module can use the nested module's
exposed declarations without a separate dependency. `depends on` is not a
re-export. Direct dependencies on nested modules remain valid. A module may use
its own exposed nested module's public API without a redundant dependency; use
`depends on` when the nested module itself is not exposed by its parent, while
the nested module still publishes every declaration you reference. A module may expose
declarations it owns plus its direct child modules. Exposing an aggregate
publishes its root entity and root-entity methods; child entities, nested value
objects, and nested enums remain private unless exposed explicitly. Exposing a
service, projector, or factory publishes its methods. Deep re-export requires
each level to expose the next; terminal declarations must still be published
by their owning module. Exposing a query service publishes the operations whose result is a
primitive or a context-visible or module-exposed DataObject; operations returning read models,
value objects, enums, or unexposed module-nested data objects remain local. Cross-context
consumers require a module-exposed query service with a primitive or context-visible or
module-exposed DataObject result; a context-level query service is local and journey-visible
only. Direct module-to-module method references still require the method to be
published by its owning module, either through an exposed container or an
explicit method exposure. Published query DataObjects expose their nested DataObject, value
object, and enum shape, including enum values; aggregate-owned contract types
produce a warning. Published result shapes may be linked through their canonical
type path, including aggregate or entity containers, or through a field path on
the result contract. Journeys are model-level timelines and do not require either
form of module exposure merely to invoke an application-service command.

### Visibility Scopes

Thinai distinguishes four visibility scopes:

| Scope | Meaning |
|---|---|
| **Aggregate/module-local** | Internal to its aggregate or module; not visible outside unless published |
| **Context-visible** | Directly usable anywhere in the same bounded context or shared kernel; no `exposes` needed |
| **Module-exposed** | Published by a module and usable by modules that depend on it |
| **Contract-published** | Explicitly usable across bounded contexts through an integration event, published query result, shared kernel, or identifier mirror |

A context-visible declaration is not automatically contract-published. For
example, a context-level value object is visible throughout its bounded context,
but another bounded context cannot use it as a field, parameter, or return type:

<!-- thinai-fragment -->
```thinai
bounded context Alpha
in bounded context Alpha {
    value object Money {
        raw: string
    }
}

bounded context Beta
in bounded context Beta {
    data object Price {
        amount: Alpha.Money // rejected
    }
}
```

Use a local identifier mirror, an IntegrationEvent payload, a shared-kernel
type, or a published query result contract instead.

Mirrors apply to identifier value objects. Integration events are published
contracts owned by the producer: reference them directly and map their payload
into local domain concepts when isolation is needed. Do not mirror an
IntegrationEvent.

### Visibility at a Glance

Context-level declarations are context-visible within their bounded context or
shared kernel. A module exposes the declarations it owns plus its direct child
modules. Exposing an aggregate publishes its root entity and root-entity
methods; child entities, nested value objects, and nested enums remain private
unless exposed explicitly. Exposing a service, projector, or factory publishes
its methods. Explicit member paths remain valid when you need to be precise.
Fields, parameters, and enum values inherit visibility from their declaration.

**Within a bounded context or shared kernel**

| Target declaration | From its own module | From another module | From outside all modules |
|---|---|---|---|
| Context-visible declaration | ✓ | ✓ | ✓ |
| Declaration in a top-level module | ✓ | exposure + `depends on` | exposure |
| Declaration in a nested module | ✓ | exposure by its owning module + a dependency or exposing-ancestor route | exposure at each level |

`module-exposed` means a declaration or container is listed in `exposes`, or
a container exposure publishes it.
A direct `depends on` the nested module is enough when that module exposes the
declaration; its parent need not expose it. A parent module that exposes a child
module may use the child's public API without a redundant `depends on`. Sibling
modules require both exposure and `depends on`. A dependency does not itself
expose a declaration. From outside all modules, `exposure at each level` means
every enclosing module exposes the next module or declaration; cross-context
access and shared-kernel access from another kernel always require that full
module-exposure chain. Exposing a nested module re-exports its public API but not
its dependencies.

**Across bounded contexts**

| To use | Required mechanism |
|---|---|
| Context-level IntegrationEvent | Import the producer context and an authorizing customer-supplier or partnership relationship. |
| Module-nested IntegrationEvent | Expose the event and every enclosing module, import the producer context, and use an authorizing relationship. |
| IntegrationEvent payload type or field | An exposed, authorized IntegrationEvent. Any method in the consumer context may link the payload shape. |
| DomainEvent | Not visible across bounded contexts. |
| Shared-kernel type, service, or declaration | Import the shared kernel and declare a `sharedKernel` relationship that includes both contexts. Module-nested declarations must also be exposed. |
| Published query result | A module-exposed query service with a primitive or context-visible or module-exposed DataObject result, a customer-supplier or partnership relationship, and an imported context. Link the result type or field, not the query operation. |
| Value object, data object, read model, or enum as a signature type | Not directly. Use a local `mirrors` identifier for identity, an IntegrationEvent payload, or a shared-kernel type; read published query result contracts for cross-context read data. |
| Application-service command in a journey | Journeys are model-level timelines; invoking a command does not require module exposure or a context map. |
| Query service in a journey | A context-level query service is journey-visible; a module-nested query service must be exposed. |
| Query service used by a method | Must be module-exposed; a context-level query service is local and journey-visible only. |
| Repository, factory, domain service, aggregate, or entity | Not directly. Go through a local service, a shared kernel, or a published contract. |

A `mirrors` identifier may name an identifier value object that is private to
its module, because the local mirror is the sanctioned cross-context identifier
use. A `separateWays` relationship authorizes neither event consumption nor
query reads, and a `sharedKernel` relationship authorizes neither.

**Specification path segments**

| Segment | Requirement |
|---|---|
| Structural container (bounded context, context map, shared kernel, aggregate, entity, service, projector, factory) | May be traversed without exposing the segment. |
| Module | Must be accessible through the public module API or a direct dependency; cross-context contract paths may reach private nested modules only when authorized. |
| Method (non-terminal) | Must be exposed by its owning module unless the source is in that module; context-level methods are context-visible. |
| Data-bearing non-terminal (value object, data object, read model, enum, or field) | Must be exposed by its owning module and reachable through the same module, a direct dependency or exposing ancestor, the public module API, an authorized shared kernel, or an authorized event or published-query contract. |
| Terminal declaration | Must satisfy the declaration, contract, or journey visibility rule that applies to it. |

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
visible, a qualified method path may also continue through it directly, such as
`[[Context.Service.method.status]]`; inside the enclosing entity or value
object, a bare `method.field` path is also accepted. That convenience does not make a
current command's `result` binding available early; the timeline rule applies to
the binding and to future operation paths. The name `result` is reserved for the operation result on methods
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
specification clause. A literal line break inside a single- or double-quoted
string is an error; convert it to triple double quotes with the quick fix or by
hand.

Journeys are top-level, actor-led, command-led timelines of non-event
application-service commands and optional query-service reads that may cross
bounded contexts. Any application-service method without an event parameter is
treated as a command; a method with an event parameter is an event handler.
Query-service methods may appear as read steps when their query service is
context-level or module-exposed. Declare each `actor` once at model scope, then
reference it in a `by Actor { ... }` block. Each actor may have at most one `by`
block per journey, and each block must contain at least one command step; a
read-only use case belongs in a query service rather than a journey. A step
names at least a service or context segment before the operation; bare
operation names are not valid journey syntax. A journey does not represent
background event handoffs, a synchronous remote call, or a shared transaction;
event-triggered reactions remain in their contexts. Steps may include optional
descriptive `with "..."` input text and `when "..."` guard text with linked
references; commands enforce their own invariants, while query steps describe
reads.

A journey is a model-level command-led operation timeline, not a module or a
bounded context. Steps are ordered in source order across actor blocks. A later
step's `with` or `when` prose may refer to inputs or results of earlier command
invocations and to visible query results. A command's result binding becomes
visible only to later steps. A command operation invoked later in the same
journey is not visible from an earlier step. Query results are public contract
links rather than private step bindings: a visible query result may be linked
even when the query is not invoked, and a query step does not gate result
access. Visibility is additive: a declaration that is independently
context-level, exposed, or part of a visible query result remains linkable even
if a future command also uses it; only the future operation and its private
contract internals are hidden. In a later step, a prior command result is
referenced through that command's qualified path, such as
`[[Ordering.App.place.result.status]]`; bare `result` is not an implicit
prior-command binding. References to a command result name the nearest earlier
invocation of that command; a journey that invokes the same command more than
once produces a warning because those references are inherently ambiguous.
Duplicate query reads are allowed because they name the same public query
contract. The language deliberately has no step variables, step labels, result
aliases, or executable condition blocks.

Journey step targets are application-service commands or visible query-service
operations. Command targets do not require module exposure merely because a
journey invokes them. Query targets must be context-level or exposed by their
module, matching journey prose visibility. The invoked command's declared
input/output contract is visible to the journey, including nested fields,
collections, field types, and enum values, even when those types live in nested
modules or aggregates. Aggregate-owned value objects and enums are therefore
reusable in command contracts without creating duplicate DTOs. Visibility is
based on the command contract, query contract, and timeline, not on blanket
module exposure. Private aggregate internals that are not reachable through a
command or query contract and private DomainEvent internals remain off-limits.
An exposed command whose contract publishes aggregate-owned or otherwise private
contract types produces a warning, because the command is effectively
publishing those types; use public or shared contract types if that is not
intended. Journey prose is cross-context by design and does not require a
context-map authorization; context maps remain relevant to actual event and
query consumption.

Application-service event handlers, query repositories, repositories, domain
services, projectors, factories, entity fields, and DomainEvents are not
journey step targets or journey-visible declarations. Query services are visible
when they are context-level or exposed by their module; the result shape of a
visible query operation is visible as part of that operation's contract. Read
models, data objects, value objects, and enums are visible when they are
context-level or exposed by their module; aggregate-owned declarations remain
visible only through command or query contract closure. Shared-kernel
declarations do not require a context-map relationship in journey prose, but
module-nested shared-kernel declarations still require module exposure.
Integration events follow their usual rule: context-level events are public, and
module-nested events require exposure. Journey prose may also link visible read
models, query results, data objects, value objects, enums, public integration
events, and user-facing application or query operations from imported contexts.
Links follow the journey timeline for command operations: a command operation
invoked later in the same journey is not visible from an earlier step. `with`
describes the inputs of the step; `when` describes the conditions under which
the step is performed. Both are descriptive prose, not executable expressions.

Thinai supports modules, aggregates, root and child entities, identifiers and
mirrored value objects, data objects, read models, projectors, query services and repositories,
typed methods and constructors, domain services, write repositories, factories,
events, reusable actors, journeys, and context maps.
Built-in collections are
`List<T>`, `Set<T>`, and `Map<K, V>`. Specification paths through a `Map` follow
its value type: for `Map<K, V>`, `[[field.name]]` resolves a field of `V`, not
`K`. Map keys are identity, not navigable data; wrap key data in a value or data
object if it must be referenced.
Primitive types include `string`, `boolean`, `integer`, `decimal`, `date`,
`time`, and `instant`. Use `integer` for counts and other whole numbers, and
`decimal` for money, prices, rates, and exact fractional business values.
Neither numeric type encodes precision, scale, currency, or units; model those
with a value object. There is no generic `number` primitive; choose `integer` or
`decimal` based on the domain value. Use `date` for a calendar date, `time` for
a wall-clock time without a date or time zone, and `instant` for an exact point
on the global timeline. `time` does not represent an elapsed duration; model richer temporal
concepts, such as a time-zone-aware appointment, with a value object.
Use `initial State` only on a non-optional enum field of an entity; it marks the
starting point of that entity's state graph, not a default for arbitrary data.
A transition on that field must start from a state that is reachable from the
initial state. Enum values unused by that field remain valid, so a state enum can
be shared with contracts or other entities.
Describe other creation-time defaults as constructor postconditions or behavior.

When a domain term is also a Thinai keyword, quote the identifier with
backticks in declarations and references:

<!-- thinai-fragment -->
```thinai
data object Request {
  `value`: string
}

behavior "Use [[Request.`value`]]."
```

The same quoted form is available for field, parameter, method, type, and enum
value names. Completion inserts the quoted form automatically for such names.
Identifiers accept Unicode letters, digits, and combining marks; quoted names
may also contain spaces and hyphens. Normalize identifiers to Unicode NFC so
visually identical names link to the same declaration.

The language server provides keyword and cross-reference completion,
navigation, references, document symbols, hover, diagnostics, rename, import-path
completion and links, call hierarchy for method invocations and journey
steps, document formatting, and quick fixes for unresolved
declarations that can be imported and for missing module dependencies or
exposures. Renaming or moving a `.tni` file updates relative import paths. Formatting uses the
editor's indentation options; the VS Code extension defaults Thinai files to two
spaces.

## What's in the folder?

- [src/thinai.langium](src/thinai.langium) — grammar definition.
- [src/thinai-formatter.ts](src/thinai-formatter.ts) — document formatting.
- [src/thinai-validator.ts](src/thinai-validator.ts) — semantic validation.
- [src/thinai-scope-provider.ts](src/thinai-scope-provider.ts),
  [src/thinai-scope-computation.ts](src/thinai-scope-computation.ts), and
  [src/thinai-scope-utils.ts](src/thinai-scope-utils.ts) — import and reference scoping.
- [test](test) — parsing, linking, validation, and LSP tests.

## License

Thinai is released under the [MIT License](https://opensource.org/licenses/MIT).
