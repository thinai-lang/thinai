# Order Fulfillment Example

This example demonstrates the complete Thinai model across multiple files.

## Files

- `strategic.tni` defines core, supporting, and generic subdomains.
- `context-catalog.tni` declares both canonical bounded contexts and imports their subdomains.
- `ordering.tni` extends Ordering with tactical DDD types and behavior specifications.
- `ordering-events.tni` contributes commands, domain events, integration events, policies, read models, and hotspots.
- `shipping.tni` extends Shipping with a local mirrored identifier and same-context module dependency.
- `shipping-handlers.tni` handles an integration event from Ordering and contains an EventStorming board.
- `context-map.tni` selectively imports Ordering and Shipping from the multi-context catalog and defines their relationship.
- `common-types.tni` defines a shared-kernel value object.

The model demonstrates explicit aggregate-root entities, constructors and methods with signatures, all four behavior-specification kinds, inline method references, optional fields/parameters, and `List`, `Set`, and `Map` types. It also shows identifier fields, a local Shipping identifier that mirrors the Ordering identifier, component-selective imports, and a module dependency within Shipping.

## Try It

Open this directory as a workspace in the Thinai Extension Development Host. The language server will index all `.tni` files and enable cross-file navigation, completion, validation, and import quick fixes.

From the repository root, validate and generate a summary with:

```bash
node packages/cli/bin/cli.js generate examples/order-fulfillment/shipping-handlers.tni -d examples/order-fulfillment/generated
```

The example uses a private `OrderPlaced` domain event and publishes the separate `OrderPlacedV1` integration event. Shipping consumes only the integration event.
