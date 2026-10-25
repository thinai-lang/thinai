# Language Tour

These files are a compact syntax tour that complements the realistic
[Order Fulfillment](../order-fulfillment/README.md) model. Every file is valid
Thinai source and is validated by the repository test suite.

## Files

- `syntax.tni` demonstrates quoted reserved-word identifiers, single and
  multiline specification text, escaped specification markers, comments,
  optional fields and parameters, primitive and nested collection types, and
  qualified value-object references.
- `modules.tni` demonstrates nested modules, module re-exports, dependencies,
  qualified exposure paths, exposed methods, and an event-triggered command
  dispatched to an exposed method in another application service.
- `sharing.tni` demonstrates a shared kernel with a domain service, a
  same-document context map, a shared-kernel service invocation, a
  module-exposed query service, and an authorized cross-context query read.

## Feature coverage

| Feature | Location |
| --- | --- |
| Backtick-quoted reserved identifiers and references | `syntax.tni` |
| Triple-quoted specification text and escaped `\[[` markers | `syntax.tni` |
| Line comments and block comments | `syntax.tni` |
| Optional fields and optional method parameters | `syntax.tni` |
| Primitive, value-object, and nested `List`/`Set`/`Map` types | `syntax.tni` |
| Nested modules and nested-module re-exports | `modules.tni` |
| Module dependencies and qualified exposure paths | `modules.tni` |
| Exposed methods and event-triggered cross-service dispatch | `modules.tni` |
| Shared-kernel value objects and domain services | `sharing.tni` |
| Same-document context map and shared-kernel relationship | `sharing.tni` |
| Module-exposed query service and authorized cross-context query read | `sharing.tni` |

The main Order Fulfillment example remains the reference for a realistic
multi-file model. Use this tour when you want to see an individual syntax or
visibility feature without following the full domain model.

## Try It

Open this directory as a workspace in the Thinai Extension Development Host, or
validate any file from the repository root:

```bash
node packages/cli/bin/cli.js generate examples/language-tour/sharing.tni -d examples/language-tour/generated
```
