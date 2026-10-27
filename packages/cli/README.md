# Thinai CLI

<p><img src="https://raw.githubusercontent.com/thinai-lang/thinai/main/packages/extension/icons/thinai-light.svg" alt="Thinai logo" width="80"></p>

The Thinai CLI reads a `.tni` model and its imported files, then generates a
JavaScript summary of the declarations.

> **Alpha:** This is the first Thinai alpha. CLI behavior and output may change
> between alpha releases.

After running `npm install` and `npm run build` from the repository root, try it
with the Order Fulfillment example:

```bash
node packages/cli/bin/cli.js generate examples/order-fulfillment/shipping.tni -d examples/order-fulfillment/generated
```

Run `node packages/cli/bin/cli.js --help` to see the available command and
options. The CLI is implemented in TypeScript and uses the Thinai language
package to parse and validate models.

## Validation scope

The CLI validates the source file and its transitive imports. It does not
discover separate files that import the source file. Use the VS Code extension
or another workspace-aware client when you need to validate the complete
import-connected model, including importers.

## Implementation files

- [package.json](./package.json) — package metadata and executable definition.
- [bin/cli.js](bin/cli.js) — executable entry point.
- [src/main.ts](src/main.ts) — command definition and generation action.
- [src/generator.ts](src/generator.ts) — JavaScript summary generation.
- [src/util.ts](src/util.ts) — model document and destination utilities.

Langium provides the parser and generation utilities used by this project. For
general framework background, see the
[Langium CLI tutorial](https://langium.org/docs/learn/minilogo/customizing_cli/).
