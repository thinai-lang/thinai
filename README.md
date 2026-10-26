# Thinai

<p><img src="packages/extension/icons/thinai-light.svg" alt="Thinai logo" width="96"></p>

Thinai is a domain-specific language for modeling domain-driven design (DDD).
Describe subdomains, bounded contexts, aggregates, services, events, and user
journeys in a shared model that is easy to navigate and evolve across files.

Thinai's VS Code language support provides completion, navigation, diagnostics,
formatting, and import quick fixes for `.tni` files.

## Get started

- Explore the [language guides](https://thinai-lang.github.io/) for strategic and
  tactical modeling, events, and behavior.
- Browse the [Order Fulfillment example](./examples/order-fulfillment/README.md)
  for a complete multi-file model.
- Use the [Language Tour](./examples/language-tour/README.md) to see individual
  syntax, module, and sharing features without following the full domain model.
- See the [Thinai language package](./packages/language/README.md),
  [CLI](./packages/cli/README.md), and
  [VS Code extension development guide](./packages/extension/langium-quickstart.md).

After installing dependencies and building the workspace (`npm install` then
`npm run build`), generate a JavaScript summary of the example model and its
imports from the repository root:

```bash
node packages/cli/bin/cli.js generate examples/order-fulfillment/shipping.tni -d examples/order-fulfillment/generated
```

## Development

This workspace targets Node.js 22 or later. To build and test the language
package, run `npm run build` and `npm test` from the repository root. The
language implementation uses [Langium](https://langium.org/); Thinai's grammar,
validation, and language behavior are defined in this project.

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

Install the Langium AI CLI if needed, then run:

```bash
npm install -g langium-ai
lai evaluate
```

Review the selected service's data handling policies before sending project
content.

## License

Thinai is released under the [MIT License](./LICENSE).
