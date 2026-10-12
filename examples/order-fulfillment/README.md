# Order Fulfillment Example

This single example folder demonstrates Thinai's language concepts through one
coherent, multi-file Order Fulfillment model. The coverage index below points to
the syntax variants so readers can review the language without switching
examples.

## Files

- `strategic.tni` defines all subdomain kinds and an unclassified subdomain.
- `context-catalog.tni` declares canonical bounded contexts, including zero, one, and multiple subdomain realizations.
- `ordering.tni` demonstrates aggregates, entities, value objects, enums, primitive and nested collection fields, constructors, all specification clauses, escaped specification markers, and grouped guarded transitions.
- `ordering-events.tni` demonstrates nested data objects, services, repositories, factories, read models, projectors with multiple targets, multiple emitted contracts, and multi-actor journeys.
- `shipping.tni` demonstrates a mirrored identifier, an integration-event handler, module exposures, and multiple module dependencies.
- `context-map.tni` demonstrates every relationship form and every integration-pattern label.
- `common-types.tni` defines shared-kernel values, services, and nested modules.

The model demonstrates root and child entity identities and transitions, constructors that accept domain values and describe non-state initialization in postconditions (for example, `createdAt`), DataObjects kept at the application-service boundary, a grouped transition across two status fields with one shared descriptive guard, guarded method invocations, conditional emissions, application-service calls to aggregate-root and factory methods, multiple command services per aggregate, query projections reused across aggregates, event-driven projectors, event-to-integration-event translation, incoming integration-event handling, and descriptive cross-context journeys. Where authorization is relevant, application-service behavior specifications describe it as the first step, using a context-local authorization domain service and roles from the shared-kernel enum. It also shows all four behavior-specification kinds, inline links to parameters and event/read-model fields, optional fields/parameters, collections, mirrored identifiers, component-selective imports, context maps, and module dependencies.

## Language coverage index

| Language feature | Example location |
| --- | --- |
| All subdomain kinds, an unkinded subdomain, and contexts with zero, one, or multiple realizations | `strategic.tni`, `context-catalog.tni` |
| Simple and component-selective imports, aliases, and qualified references | `ordering.tni`, `context-map.tni`, `ordering-events.tni`, `shipping.tni` |
| Customer-supplier, partnership, separate-ways, and shared-kernel relationships; all integration-pattern labels | `context-map.tni` |
| Shared-kernel value objects, enum, domain services, nested modules, and multiple exposures | `common-types.tni` |
| `string`, `number`, `boolean`, `date`, `time`, and `instant`; `List`, `Set`, `Map`, and nested collection types | `ordering.tni`, `ordering-events.tni` |
| Nested data objects, optional fields/parameters, identifiers, enum initial states, constructors, and mirrored value objects | `ordering.tni`, `ordering-events.tni`, `shipping.tni` |
| Application/domain/query services, repositories, factories, projectors, read models, events, and exposed integration contracts | `ordering.tni`, `ordering-events.tni`, `shipping.tni` |
| All behavior clauses, multiple emits/projects targets, guarded and grouped transitions, enum-value links | `ordering.tni`, `ordering-events.tni` |
| Single- and double-quoted strings, line/block comments, and escaped `\[[` markers | `strategic.tni`, `common-types.tni`, `ordering.tni`, `context-map.tni` |
| Multiple journey actors/steps with `with` and `when` descriptions | `ordering-events.tni` |

## Try It

Open this directory as a workspace in the Thinai Extension Development Host. The language server will index all `.tni` files and enable cross-file navigation, completion, validation, and import quick fixes.

From the repository root, validate and generate a summary with:

```bash
node packages/cli/bin/cli.js generate examples/order-fulfillment/shipping.tni -d examples/order-fulfillment/generated
```

The example uses a private `OrderPlaced` domain event and maps it to the separate `OrderPlacedV1` integration contract. Shipping imports both the producer context and context map, and consumes only the IntegrationEvent.
