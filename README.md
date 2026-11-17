# Thinai

<p><img src="packages/extension/icons/thinai-light.svg" alt="Thinai logo" width="96"></p>

> **Alpha:** Thinai is in alpha. Syntax and tooling may change between releases.

Thinai is a domain-specific language for modeling domain-driven design (DDD).
Describe subdomains, bounded contexts, aggregates, services, events, and user
journeys in a shared model that is easy to navigate and evolve across files.

Thinai's VS Code language support provides completion, navigation, diagnostics,
references, document symbols, hover, rename, call hierarchy, formatting,
clickable imports, automatic import updates on file moves, and
import/dependency/exposure quick fixes for `.tni` files.

## Support

Report bugs, documentation problems, and feature requests in the public
[issue tracker](https://github.com/thinai-lang/issues). The source repository is
private during the alpha. Report security vulnerabilities privately to
`security@thinai-lang.dev` or through GitHub advisories, not in a public issue.

## Get started

- Explore the [language guides](https://thinai-lang.dev/) for strategic and
  tactical modeling, events, and behavior.
- Browse the [Order Fulfillment example](./examples/order-fulfillment/README.md)
  for a complete multi-file model.
- Use the [Language Tour](./examples/language-tour/README.md) to see individual
  syntax, module, and sharing features without following the full domain model.
- See the [agent workflow guide](https://thinai-lang.dev/agent-workflow/) for
  model-first coding with CLI, MCP, and LSP.
- See the [Thinai language package](./packages/language/README.md),
  [CLI](./packages/cli/README.md), and
  [VS Code extension development guide](./packages/extension/extension-development.md).

After installing dependencies and building the workspace (`npm install` then
`npm run build`), inspect the model graph or request an agent context slice
from the repository root:

```bash
node packages/cli/bin/cli.js inspect examples/order-fulfillment/shipping.tni
node packages/cli/bin/cli.js context examples/order-fulfillment/shipping.tni Aggregate:Shipping.Shipment --format md
node packages/cli/bin/cli.js validate examples/order-fulfillment/shipping.tni
```

## Development

This workspace targets Node.js 22 or later. To build and test the language
package, run `npm run build` and `npm test` from the repository root. Thinai's
grammar, validation, and language behavior are defined in this project.

See [RELEASING.md](./RELEASING.md) for the CI publishing workflows, version
mapping, and release checklist.

### LLM evaluations

Evaluations use an API that implements the OpenAI-compatible chat completions
format. Set the model and, if needed, the API endpoint and key for the service
you want to use:

```bash
export EVAL_LLM_MODEL="your-model-name"
export EVAL_LLM_BASE_URL="https://api.example.com/v1"
export EVAL_LLM_API_KEY="your-api-key"
```

`EVAL_LLM_BASE_URL` and `EVAL_LLM_API_KEY` can be omitted when the API uses the
SDK's default endpoint or does not require authentication. The checked-in
Thinai system prompt is used. Some OpenAI-compatible gateways require a stable
session header. Set both variables for such a gateway:

```bash
export EVAL_LLM_SESSION_HEADER="<header-name>"
export EVAL_LLM_SESSION_ID="<stable-session-id>"
```

`EVAL_LLM_SESSION_HEADER` and `EVAL_LLM_SESSION_ID` can be omitted for gateways
that do not require a stable session. For OpenCode Go, use
`deepseek-v4.1-flash` through the OpenAI-compatible inference API:

```bash
export EVAL_LLM_MODEL="deepseek-v4.1-flash"
export EVAL_LLM_BASE_URL="https://opencode.ai/inference/go/openai/v1"
export EVAL_LLM_SESSION_HEADER="x-opencode-session"
export EVAL_LLM_SESSION_ID="thinai-lai-evals"
# Set EVAL_LLM_API_KEY from your OpenCode Console personal API key.
```

Create the key in the [OpenCode Console](https://opencode.ai/console) under
**Account → Personal API keys**. Do not commit it.

Install the Langium AI CLI if needed, then run:

```bash
npm install -g langium-ai
lai evaluate
```

Review the selected service's data handling policies before sending project
content.

## License

Thinai is released under the [MIT License](./LICENSE).
