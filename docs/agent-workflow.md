# Agent Workflow

Thinai is a descriptive DDD modeling language. The intended AI-native workflow is:

1. Read the model.
2. Select the relevant context.
3. Implement code using the repository's conventions.
4. Validate the model and the implementation.

There is no code generator. The model is the source of truth.

## Interfaces

### LSP

Use the language server for editor-style work: diagnostics, completion, definitions, references, symbols, hover, and formatting.

### CLI

```bash
thinai inspect path/to/model.tni
thinai context path/to/model.tni Aggregate:Ordering.Order --format md
thinai impact path/to/model.tni ValueObject:Ordering.Order.OrderId --json
thinai validate path/to/model.tni
```

### MCP

Start a read-only model server:

```bash
thinai mcp path/to/model.tni
```

Tools:

- `list_elements`
- `search_elements`
- `get_element`
- `get_context`
- `get_dependencies`
- `get_visibility`
- `validate_model`
- `impact_of_change`

## Context selection

Prefer one of:

- an aggregate;
- a bounded context;
- a module;
- a published query contract;
- an integration event.

Ask for a context slice before loading many model files. This keeps the model within the agent's context window and makes visibility boundaries explicit.

## Model rules to preserve

- `identifier` fields reference a value object declared in the same aggregate.
- Module visibility requires exposure and, for sibling modules, `depends on`.
- Cross-context use requires a mirror, shared kernel, integration event, or published query contract.
- Domain events are context-private; integration events are cross-context contracts.
- Data objects are boundary shapes, not domain state.
- Primitives are `string`, `boolean`, `integer`, `decimal`, `date`, `time`, and `instant`.

## Verification

For the alpha:

1. Run `thinai validate`.
2. Run the target repository's tests.
3. Check every model element touched by the task has a code counterpart.

A deterministic manifest and `thinai verify` conformance workflow is planned for a later release.
