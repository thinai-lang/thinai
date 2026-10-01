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

```thinai
bounded context Ordering {
    aggregate Order {
        root entity OrderRoot {
            identifier id: OrderId;
            status: OrderStatus;
            lines: List<OrderLine>;
            customerMemo?: string;
        }

        identifier value object OrderId for OrderRoot {
            raw: string;
        }

        value object OrderLine {
            sku: string;
            quantity: number;
        }

        enum OrderStatus { Draft, Placed, Paid }
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
    identifier value object OrderId mirrors Ordering.Order.OrderId {
        raw: string;
    }
}
```

## Operations and Domain Constraints

Entity and value-object constructors and methods go in an `operations` block,
before the fields and invariants block. Constructors take typed parameters and
return their owning type implicitly. Methods may declare a return type with
`returns`:

```thinai
bounded context Ordering {
    aggregate Order {
        root entity OrderRoot operations {
            constructor(id: OrderId) {
                precondition "The identifier is non-empty.";
                postcondition "The order has an identifier.";
            }
            method ensureOwner() returns boolean;
        } {
            identifier id: OrderId;
            owner: string;
            invariant $"An order must have an owner; check ${OrderRoot.owner} and ${OrderRoot.ensureOwner}.";
        }
        identifier value object OrderId for OrderRoot {
            raw: string;
        }
        factory OrderFactory for Order operations {
            method createOrder() returns OrderRoot;
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

Other declarations include capabilities, repositories, and factories.
Repositories and factories refer to their target aggregate:

```thinai
bounded context Ordering {
    aggregate Order {
        root entity OrderRoot {
            identifier id: OrderId;
        }
        identifier value object OrderId for OrderRoot {
            raw: string;
        }
        repository OrderRepository for Order;
        factory OrderFactory for Order;
    }
}
```

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
