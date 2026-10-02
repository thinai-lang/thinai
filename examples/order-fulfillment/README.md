# Order Fulfillment Example

This example demonstrates the complete Thinai model across multiple files.

## Files

- `strategic.tni` defines core, supporting, and generic subdomains.
- `context-catalog.tni` declares both canonical bounded contexts and imports their subdomains.
- `ordering.tni` extends Ordering with tactical DDD types, an authorization domain service, a child entity with its own identity/state, and behavior specifications.
- `ordering-events.tni` contributes separate command services for Order, data-object inputs and results, bounded-context query services whose repository prose is linked, read models, event projectors, an exposed integration contract, and user-started flows with descriptive `with`/`when` text. `ordering.tni` declares the internal domain events and a business capability at context scope.
- `shipping.tni` extends Shipping with a local mirrored identifier, an integration-event handler method, and a same-context module dependency.
- `context-map.tni` selectively imports Ordering and Shipping, maps their customer-supplier integration patterns, and connects them through the named `CommonTypes` shared kernel.
- `common-types.tni` defines a shared-kernel value object and the `Role` enum used by both contexts.

The model demonstrates root and child entity identities and transitions, single-aggregate transactional create/update/delete workflows, multiple command services per aggregate, query projections reused across aggregates, post-commit projectors, event-to-integration-event translation, incoming integration-event handling, and descriptive query/command flows. Application-service behavior specifications describe authorization as each method's first step, using a context-local authorization domain service and roles from the shared-kernel enum. It also shows all four behavior-specification kinds, inline links to parameters and event/read-model fields, optional fields/parameters, collections, mirrored identifiers, component-selective imports, context maps, and module dependencies.

## Try It

Open this directory as a workspace in the Thinai Extension Development Host. The language server will index all `.tni` files and enable cross-file navigation, completion, validation, and import quick fixes.

From the repository root, validate and generate a summary with:

```bash
node packages/cli/bin/cli.js generate examples/order-fulfillment/shipping.tni -d examples/order-fulfillment/generated
```

The example uses a private `OrderPlaced` domain event and maps it to the separate `OrderPlacedV1` integration contract. Shipping imports both the producer context and context map, and consumes only the IntegrationEvent.
