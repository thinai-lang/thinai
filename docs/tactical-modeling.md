# Tactical Modeling

Thinai models aggregates, entities, value objects, and related tactical DDD
declarations. For application services, events, and descriptive domain behavior, see
[Events and behavior](events-and-behavior.md).

## Aggregates, Entities, and Value Objects

An aggregate groups its root entity and other domain types. Entities and value
objects may have typed fields, invariants, constructors, and methods. Common
field types are `string`, `number`, `boolean`, and `date`; fields can be
optional with `?`. Built-in collections are `List<T>`, `Set<T>`, and
`Map<K, V>`.
Every entity has exactly one identifier field. A child entity's identity is
scoped to its aggregate; references to an entity in another aggregate must use
that aggregate's identifier rather than the entity itself.

```thinai
bounded context Ordering {
    aggregate Order {
        root entity Order {
            method update();
            identifier id: OrderId;
            status: OrderStatus;
            lines: List<OrderLine>;
            customerMemo?: string;
        }

        value object OrderId {
            raw: string;
        }

        entity OrderLine {
            method ship() {
                transition status from Open to Shipped;
            }
            identifier id: OrderLineId;
            sku: string;
            quantity: number;
            status: LineStatus initial Open;
        }

        value object OrderLineId { raw: string; }
        enum OrderStatus { Draft, Placed, Paid }
        enum LineStatus { Open, Shipped }
    }
}
```

Identifier value objects can mirror identifiers owned by another context.
Define a local mirror rather than making a foreign context's private type part
of the local model:

```thinai
import "./context-catalog.tni";
import "./ordering.tni";

bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw: string;
    }
}
```

## Operations and Domain Constraints

Entity and value-object bodies contain fields, constructors, and methods at the
same level; write constructors and methods before fields. Invariants may appear
in constructor and method bodies, but not beside fields. Constructors take typed
parameters and return their owning type implicitly. Methods may declare a return
type with `returns`:

```thinai
bounded context Ordering {
    aggregate Order {
        root entity Order {
            constructor(id: OrderId) {
                precondition "The identifier is non-empty.";
                postcondition "The order has an identifier.";
            }
            method ensureOwner() returns boolean {
                invariant "An order has an owner; check [[Order.owner]].";
            }
            identifier id: OrderId;
            owner: string;
        }
        value object OrderId {
            raw: string;
        }
        factory OrderFactory for Order operations {
            method createOrder() returns Order;
        }
    }
}
```

Factory operations are methods that return the root entity of the aggregate
named by `for`. Behavior specifications can link to these methods, just as they
can link to other methods; constructors themselves are not link targets.

Aggregates can also declare methods and invariants in their body. Domain
services group methods. Behavior specifications are explained in
[Events and behavior](events-and-behavior.md).

Root and child entities can both own state and declare transitions, but each
transition must target an enum field declared on that entity. Application
services enter through the aggregate root; root behavior coordinates changes to
child entities so the aggregate's invariants remain protected. An enum state
field may declare an initial value with `initial State`; when present, every enum
state must be reachable through the entity's declared transition graph.

Other declarations include capabilities, repositories, and factories.
Write repositories and factories refer to their target aggregate. Application-service
methods are aggregate-scoped commands; command/query separation is provided by
aggregate-scoped application services and bounded-context-scoped query services.
Commands make persistence
orchestration explicit: use `loads Repository by id` / `invokes` / `saves` for an existing
aggregate and `creates` / `invokes` / `saves` when creating one. Deletion uses
`loads` / `invokes` / `deletes`. A load and write operation must use the same
repository for the application's aggregate; `id` must be a parameter typed by
the root's identifier value object. Each aggregate has one write repository.
Use identity-free data objects for operation input/output shapes. They can contain
primitives, collections, enums, value objects, and nested data objects, but not
entities or read models; they have no identifiers or behavior. Prefer value
objects for shapes that represent domain concepts.

Queries use bounded-context query repositories/read models, can read from several
of them, and do not save, create, delete, or emit events. Mention the repositories
in the query method's descriptive specification text rather than declaring a
separate `reads` clause. Queries can return primitives, data objects, read models,
or collections of these; application-service methods must not return entities.
For example:

```thinai
bounded context Ordering {
    aggregate Order {
        root entity Order {
            method update();
            identifier id: OrderId;
        }
        value object OrderId {
            raw: string;
        }
        repository OrderRepository for Order;
        factory OrderFactory for Order operations {
            method create() returns Order;
        }
    }
    read model OrderSearch { orderNumber: string; status: string; }
    query repository OrderSearchRepository for OrderSearch;
    event OrderUpdated;
    projector OrderSearchProjector for OrderSearch {
        method onOrderUpdated(source: event OrderUpdated) updates OrderSearchRepository after commit;
    }

    application service OrderApplication for Order {
        transactional method updateOrder(id: OrderId) loads OrderRepository by id invokes Order.Order.update saves OrderRepository;
        transactional method createOrder() creates Order.OrderFactory.create saves OrderRepository;
    }
    query service OrderQueries {
        method getOrderStatus(id: OrderId) returns string {
            behavior "Read [[OrderSearchRepository]] for the selected order.";
        }
        method searchOrders(term: string) returns List<string> {
            behavior "Search [[OrderSearchRepository]] for orders matching the term.";
        }
    }
}
```

These clauses describe the allowed application-service workflow; they do not
specify storage technology. Mark aggregate writes `transactional` to declare the
intended atomic boundary; validation cannot prove that the implementation
actually commits atomically.

## Modules

Modules organize declarations within one bounded context or shared kernel.
Use `exposes` to list declarations available to other modules, and `depends on`
to declare a module dependency:

```thinai
bounded context Shipping {
    module Operations {
        exposes TrackingCode;

        value object TrackingCode {
            raw: string;
        }
    }

    module Fulfillment depends on Operations {
        value object ShipmentMetadata {
            trackingCode: TrackingCode;
        }
    }
}
```

Module dependencies across bounded contexts are not supported. Shared value
objects belong in an explicit shared kernel rather than in a business bounded
context.
