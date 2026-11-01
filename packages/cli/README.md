# Thinai CLI

<p><img src="https://raw.githubusercontent.com/thinai-lang/thinai-lang.github.io/main/public/assets/thinai-light.svg" alt="Thinai logo" width="80"></p>

The Thinai CLI reads a `.tni` model and its imported files. It exports the model
graph, produces task-scoped context slices, reports model impact, validates
models, and runs a read-only MCP server.

> **Alpha:** Thinai is in alpha. CLI behavior and output may change
> between alpha releases.

Install it globally:

```bash
npm install -g thinai-cli@alpha
thinai-cli --version
```

Or run it without installing:

```bash
npx thinai-cli@alpha --version
```

Try it with the public [Order Fulfillment example](https://github.com/thinai-lang/thinai-lang.github.io/tree/main/examples/order-fulfillment):

```bash
thinai-cli validate examples/order-fulfillment/shipping.tni
thinai-cli inspect examples/order-fulfillment/shipping.tni --out model.json
```

## Agent and model inspection commands

```bash
# Full model graph as JSON
thinai-cli inspect path/to/model.tni --out model.json

# One aggregate or context and its visible dependencies
thinai-cli context path/to/model.tni Aggregate:Ordering.Order --format md

# Model elements that reference a declaration
thinai-cli impact path/to/model.tni ValueObject:Ordering.Order.OrderId --json

# Validate the source file and its transitive imports
thinai-cli validate path/to/model.tni

# Start a read-only MCP server over stdio
thinai-cli mcp path/to/model.tni
```

The exported model uses the stable `thinai-model-v1` schema. Element IDs are
canonical and kind-prefixed, for example `Aggregate:Ordering.Order` and
`Field:Ordering.Order.Order.id`.

Run `thinai-cli --help` to see all commands and options. The CLI is implemented
in TypeScript and uses the Thinai language package to parse and validate models.

## Validation scope

The CLI validates the source file and its transitive imports. It does not
discover separate files that import the source file. Use the VS Code extension
or another workspace-aware client when you need to validate the complete
import-connected model, including importers.

## Implementation files

- [package.json](./package.json) — package metadata and executable definition.
- [bin/cli.js](bin/cli.js) — executable entry point.
- [src/main.ts](src/main.ts) — command definition.
- [src/model.ts](src/model.ts) — model export, context, impact, and validation actions.
- [src/mcp.ts](src/mcp.ts) — read-only MCP server.
- [src/util.ts](src/util.ts) — model document loading utilities.
