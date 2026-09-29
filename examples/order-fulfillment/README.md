# Order Fulfillment Example

This example demonstrates the complete Thinai model across multiple files.

## Files

- `strategic.tni` defines core, supporting, and generic subdomains.
- `context-catalog.tni` declares both canonical bounded contexts and imports their subdomains.
- `ordering.tni` extends Ordering with tactical DDD types and behavior specifications.
- `ordering-events.tni` contributes application-service methods, an integration-event contract, and a user-started flow that names its initiating actor inline. `ordering.tni` declares the internal domain event and a business capability at context scope.
- `shipping.tni` extends Shipping with a local mirrored identifier, an integration-event handler method, and a same-context module dependency.
- `context-map.tni` selectively imports Ordering and Shipping, maps their customer-supplier integration patterns, and connects them through the named `CommonTypes` shared kernel.
- `common-types.tni` defines a shared-kernel value object.

The model demonstrates explicit aggregate-root entities, constructors and methods with signatures, aggregate state transitions and event emissions, event-to-integration-event translation, incoming integration-event handling, all four behavior-specification kinds, inline method references, optional fields/parameters, and `List`, `Set`, and `Map` types. It also shows identifier fields, a local Shipping identifier that mirrors the Ordering identifier, component-selective imports, an imported context map, and a module dependency within Shipping.

## Try It

Open this directory as a workspace in the Thinai Extension Development Host. The language server will index all `.tni` files and enable cross-file navigation, completion, validation, and import quick fixes.

From the repository root, validate and generate a summary with:

```bash
node packages/cli/bin/cli.js generate examples/order-fulfillment/shipping.tni -d examples/order-fulfillment/generated
```

The example uses a private `OrderPlaced` domain event and maps it to the separate `OrderPlacedV1` integration contract. Shipping imports both the producer context and context map, and consumes only the IntegrationEvent.
