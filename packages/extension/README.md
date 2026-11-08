# Thinai for VS Code

Thinai is a domain-specific language for modeling domain-driven design (DDD).
This extension provides language support for `.tni` files:

- completion for declarations, paths, specifications, and imports
- go-to-definition, find-all-references, document symbols, and hover
- call hierarchy for aggregate behavior and journey commands
- rename for declarations, references, and import aliases
- clickable import paths and automatic import updates when files move
- import, dependency, and exposure quick fixes
- validation and diagnostics
- document formatting
- semantic highlighting and selection ranges

> **Alpha:** Thinai is in alpha. Language rules and extension
> behavior may change between alpha releases.

## Getting started

Open a folder containing `.tni` files, or create a new file with the `.tni`
extension. The language server indexes the files in the workspace and resolves
imports relative to each document.

The [Order Fulfillment example](https://github.com/thinai-lang/thinai-lang.github.io/tree/main/examples/order-fulfillment)
demonstrates strategic and tactical modeling, events, CQRS, and journeys.

## Documentation

See the [Thinai language guides](https://thinai-lang.dev/) for the full
language documentation.

## Source

The Thinai source repository is private during the alpha. Report bugs and
feature requests in the [public issue tracker](https://github.com/thinai-lang/issues).

The language server is bundled into `out/language/main.cjs`; the extension entry
point is `out/extension/main.cjs`.
