# Workspace overview

Depending on the selection during the project generation you will have one or more packages contained in the packages directory.
Please check the specific projects here:

- [packages/language](./packages/language/README.md) This package is always available and contains the language definition.
- [packages/cli](./packages/cli/README.md) *Optional* Is only available if you chose to use the command-line interface.
- [packages/extension](./packages/extension/langium-quickstart.md) *Optional* Contains the VSCode extension if you chose to create it.
- [examples/order-fulfillment](./examples/order-fulfillment/README.md) Complete multi-file DDD and EventStorming example.

## LLM evaluations

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
Thinai system prompt is used. Install the Langium AI CLI if needed, then run:

```bash
npm install -g langium-ai
lai evaluate
```

Review the selected service's data handling policies before sending project
content.

## What's in the folder?

Some file are contained in the root directory as well.

- [package.json](./package.json) - The manifest file the main workspace package
- [tsconfig.json](./tsconfig.json) - The base TypeScript compiler configuration
- [tsconfig.build.json](./tsconfig.build.json) - Configuration used to build the complete source code.
- [.gitignore](.gitignore) - Files ignored by git
