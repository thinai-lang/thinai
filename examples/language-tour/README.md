# Thinai Language Tour

This directory is a syntax-coverage companion to the realistic
[Order Fulfillment example](../order-fulfillment/README.md). The files form one
small multi-file model and are intended to be opened together as a workspace.
The tour demonstrates grammar forms; it is not a recommendation to use every
construct in a production model.

## Coverage index

| Language area | Demonstrated in |
| --- | --- |
| All subdomain kinds plus an unkinded subdomain, contexts with zero and multiple realizations, actors, shared-kernel value types/services/modules, nested modules | `foundations.tni` |
| Simple and component-selective imports, aliases, all context-map relationship types, all integration-pattern labels | `context-map.tni` |
| Primitive and nested collection types, nested data objects, optional members, enum initial state, constructors, mirrors, comments, both specification quote styles and escaped reference markers, grouped transitions | `types-and-behavior.tni` |
| Application/domain/query services, repositories, factories, projectors, read models, internal and integration events, grouped emissions/projections, linked enum values | `services-and-journeys.tni` |
| Multiple journey actors and steps, `with` and `when` descriptions | `services-and-journeys.tni` |

## Validate

Open this directory as a workspace to exercise cross-file linking. From the
repository root, run the CLI against `services-and-journeys.tni`; it loads the
file's imports and validates the model while generating its summary.
