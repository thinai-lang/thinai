# Events and Behavior

Thinai represents domain interactions with commands, events, policies, and
EventStorming boards. Behavior specifications add human-readable domain
meaning to types and operations; they are descriptive, not executable.

## Behavior Specifications

Use these forms to describe domain rules and operation intent:

- `invariant` — a rule that should hold for a domain type.
- `precondition` — what must hold before an operation.
- `postcondition` — what is guaranteed after successful completion.
- `behavior` — a natural-language description of what an operation does.

Attach these specifications to relevant types, constructors, methods, or
commands. Plain quoted strings are valid. To make a method name navigable from
the text, use an interpolated template string such as
`$"Normalize with ${OrderId.normalize}."`. The interpolation must refer to a
declared method; it is not a method call or expression. Write `\${` when the
text should contain a literal interpolation marker.

## Commands and Events

Commands can name a handler, target aggregate, typed fields, and emitted
events. A command can also carry behavior specifications:

```thinai
bounded context Ordering {
    actor Customer;

    aggregate Order {
        root entity OrderRoot {
            identifier id: OrderId;
        }
        identifier value object OrderId for OrderRoot {
            raw: string;
        }
        value object OrderLine {
            sku: string;
        }
    }

    command PlaceOrder
        handled by Customer
        targets Order
        with items: List<OrderLine>
        emits OrderPlaced {
            precondition "The order contains at least one item.";
            behavior "Place the order and emit its event.";
        }

    event OrderPlaced caused by PlaceOrder for Order;
}
```

Domain events are local to their bounded context by default. To let another
context consume an event, publish or declare an integration event:

```thinai
bounded context Ordering {
    aggregate Order {
        root entity OrderRoot {
            identifier id: OrderId;
        }
        identifier value object OrderId for OrderRoot {
            raw: string;
        }
    }

    event OrderPlaced for Order publishes integration OrderPlacedV1;
    integration event OrderPlacedV1 from OrderPlaced;
}
```

Policies connect event triggers to commands using `when` and `then`. Read
models can list their source events. Actors, external systems, and hotspots
can also be declared.

## EventStorming

An EventStorming board references canonical declarations rather than
redefining them:

```thinai
bounded context Ordering {
    actor Customer;

    aggregate Order {
        root entity OrderRoot {
            identifier id: OrderId;
        }
        identifier value object OrderId for OrderRoot {
            raw: string;
        }
    }

    command PlaceOrder handled by Customer targets Order emits OrderPlaced;
    event OrderPlaced caused by PlaceOrder for Order;

    event storming OrderLifecycle {
        actor Customer;
        command PlaceOrder;
        event OrderPlaced;
        aggregate Order;
    }
}
```

For a complete multi-file example, including cross-context integration-event
consumption, see the [Order Fulfillment example](../examples/order-fulfillment/README.md).
