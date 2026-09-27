# Language Model

Thinai models strategic DDD concepts and lets you compose a bounded context
across multiple `.tni` files.

## A Small Model

This example declares a subdomain, bounded context, aggregate, and command:

```thinai
subdomain OrderManagement kind core;

bounded context Ordering realizes OrderManagement {
    aggregate Order {
        root entity OrderRoot {
            identifier id: OrderId;
        }
        identifier value object OrderId for OrderRoot {
            raw: string;
        }
    }

    command PlaceOrder targets Order emits OrderPlaced;
    event OrderPlaced for Order;
}
```

An aggregate has exactly one root entity. The root and its identifier value
object are siblings inside the aggregate, and the root has an `identifier`
field typed by that identifier value object.

## Subdomains and Bounded Contexts

Subdomains can be classified as `core`, `supporting`, or `generic`. A bounded
context can realize one or more subdomains:

```thinai
subdomain Fulfillment kind supporting;

bounded context Shipping realizes Fulfillment {
    // Context members go here.
}
```

Declare a bounded context canonically once. Other files can add declarations
to it with `part of bounded context Name`.

## Context Maps and Shared Kernels

A context map describes relationships between bounded contexts:

```thinai
bounded context Ordering {}
bounded context Shipping {}

context map FulfillmentMap {
    Ordering customer supplier Shipping;
}
```

Relationship kinds include `partnership`, `customer supplier`, `conformist`,
`shared kernel`, `published language`, `open host`, `anti corruption layer`,
and `separate ways`.

A shared kernel is an explicit place for types shared across contexts. It may
contain value objects, enumerations, and modules:

```thinai
shared kernel Common {
    value object Currency {
        code: string;
    }
}
```

## Working Across Files

Imports are explicit, direct, and relative to the importing `.tni` file. A
declaration in an unrelated workspace file is not automatically visible. A
later file can extend a bounded context by importing the file that declares
the canonical context and using `part of`:

```thinai
// ordering-events.tni
import "./context-catalog.tni";
import "./ordering.tni";

part of bounded context Ordering {
    command PlaceOrder targets Order emits OrderPlaced;
    event OrderPlaced for Order;
}
```

When an imported file declares several bounded contexts or shared kernels,
select the components needed by the importing file. An alias applies to the
selected component:

```thinai
import "./contexts.tni" { Ordering as Orders, Shipping };
```

The older file-level form `import "./file.tni" as Alias;` is supported only
when that file contains exactly one bounded context or shared kernel.

## Language Tooling

The language server provides keyword and cross-reference completion, relative
`.tni` import-path completion, navigation, and diagnostics. It also offers
quick fixes for unresolved declarations that can be imported from another
workspace file. The [Order Fulfillment example](../examples/order-fulfillment/README.md)
demonstrates these features in a complete multi-file model.
