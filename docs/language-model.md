# Language Model

Thinai models strategic DDD concepts and lets you compose a bounded context
across multiple `.tni` files.

## A Small Model

This example declares a subdomain, bounded context, aggregate, application-service command method, and domain event:

```thinai
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
        identifier value object OrderId for OrderRoot {
            raw: string;
        }
        enum OrderStatus { Draft, Placed }
    }

    event OrderPlaced;

    application service OrderApplication for Order {
        method placeOrder() invokes Order.OrderRoot.place;
    }
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
shared kernel CommonTypes {}

context map FulfillmentMap {
    customer Shipping {
        integrationPatterns: ["AntiCorruptionLayer"];
    } -> supplier Ordering {
        integrationPatterns: ["OpenHostService", "PublishedLanguage"];
    }

    partner Ordering <-> partner Shipping;
    separateWays Ordering -x- Shipping;

    sharedKernel CommonTypes {
        participants: [Ordering, Shipping];
    }
}
```

The customer-to-supplier arrow points from the downstream customer to the
upstream supplier; it describes the relationship direction, not message flow.
Each endpoint may list its own `integrationPatterns`: `Conformist` and
`AntiCorruptionLayer` typically describe the downstream side, while
`OpenHostService` and `PublishedLanguage` describe the upstream side. These are
quoted labels from a predefined set, recorded as descriptive metadata. They do
not assert that an implementation conforms to a pattern or affect event
authorization. Only their spelling and uniqueness are validated; unknown and
duplicate labels are rejected.

`partner ... <-> partner ...` expresses a symmetric partnership. An imported
customer-supplier relationship authorizes the customer to consume the
supplier's IntegrationEvents; an imported partnership authorizes consumption
in either direction. Pattern labels do not affect this authorization.
`separateWays ... -x- ...` expresses a deliberate lack of integration and does
not take integration patterns. A `sharedKernel` relationship names the actual
shared-kernel component and lists the bounded contexts that share it.

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
    application service OrderApplication for Order { method placeOrder() invokes Order.OrderRoot.place {} }
    event OrderPlaced;
}
```

When an imported file declares several bounded contexts, context maps, or shared kernels,
select the components needed by the importing file. A context map can also be
selected and imported when a cross-context IntegrationEvent is consumed. An
alias applies to the selected component:

```thinai
import "./contexts.tni" { Ordering as Orders, Shipping };
```

The older file-level form `import "./file.tni" as Alias;` is supported only
when that file contains exactly one bounded context, context map, or shared
kernel. Cross-context IntegrationEvent use requires an imported context map
with an authorized relationship; DomainEvents remain private to their context.

## Language Tooling

The language server provides keyword and cross-reference completion, relative
`.tni` import-path completion, navigation, and diagnostics. It also offers
quick fixes for unresolved declarations that can be imported from another
workspace file. The [Order Fulfillment example](../examples/order-fulfillment/README.md)
demonstrates these features in a complete multi-file model.
