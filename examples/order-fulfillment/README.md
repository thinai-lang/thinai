# Order Fulfillment Example

This example demonstrates the complete Thinai model across multiple files.

## Files

- `strategic.tni` defines core, supporting, and generic subdomains.
- `ordering.tni` defines the Ordering bounded context and tactical DDD types.
- `ordering-events.tni` contributes commands, domain events, integration events, policies, read models, and hotspots.
- `shipping.tni` defines a second bounded context.
- `shipping-handlers.tni` handles an integration event from Ordering and contains an EventStorming board.
- `context-map.tni` defines the relationship between the bounded contexts.
- `common-types.tni` defines a shared-kernel value object.

The model also demonstrates optional modules, explicit aggregate-root entities, identifier fields, a local Shipping identifier that mirrors the Ordering identifier, typed collection signatures, and inline method references in behavior specifications. The context map uses component-selective imports.

## Try It

Open this directory as a workspace in the Thinai Extension Development Host. The language server will index all `.tni` files and enable cross-file navigation, completion, validation, and import quick fixes.

From the repository root, validate and generate a summary with:

```bash
node packages/cli/bin/cli.js generate examples/order-fulfillment/shipping-handlers.tni -d examples/order-fulfillment/generated
```

The example uses a private `OrderPlaced` domain event and publishes the separate `OrderPlacedV1` integration event. Shipping consumes only the integration event.
