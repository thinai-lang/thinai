# Thinai for VS Code

Thinai is a domain-specific language for modeling domain-driven design (DDD).
This extension provides language support for `.tni` files:

- completion for declarations, paths, specifications, and imports
- go-to-definition and import quick fixes
- validation and diagnostics
- document formatting
- semantic highlighting and selection ranges

> **Alpha:** This is the first Thinai alpha. Language rules and extension
> behavior may change between alpha releases.

## Getting started

Open a folder containing `.tni` files, or create a new file with the `.tni`
extension. The language server indexes the files in the workspace and resolves
imports relative to each document.

The Order Fulfillment example in the repository demonstrates strategic and
tactical modeling, events, CQRS, and journeys.

## Documentation

See the [Thinai language guides](https://thinai-lang.github.io/) for the full
language documentation.

## Development

This extension is built from the repository root:

```bash
npm install
npm run build
```

The language server is bundled into `out/language/main.cjs`; the extension entry
point is `out/extension/main.cjs`.
