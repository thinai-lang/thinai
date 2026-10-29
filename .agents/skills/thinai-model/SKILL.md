---
name: thinai-model
description: Use Thinai as the source of truth when implementing or reviewing a domain model. Covers model discovery, context slices, module visibility, MCP/CLI/LSP access, and verification.
user-invocable: false
---

# Working with Thinai Models

Thinai is a descriptive DDD modeling language. There is no code generator: use the model to understand the domain, then implement code in the repository using its conventions.

## Access paths

Use whichever interface the environment provides:

- **LSP** — completion, diagnostics, definitions, references, symbols, hover.
- **CLI** — `inspect`, `context`, `impact`, `validate`.
- **MCP** — structured model queries when an MCP server is available.

The model is the source of truth. Do not infer domain rules from generated code.

## Workflow

1. **Locate the model**
   - Find `.tni` files and the root model for the task.
   - Use `thinai inspect <file>` if you need the full graph.
   - Use MCP `list_elements` or `search_elements` for targeted discovery.

2. **Select a context slice**
   - Prefer one aggregate, bounded context, module, or contract.
   - CLI: `thinai context <file> <element-id> --format md --depth 1`
   - MCP: `get_context`
   - Do not load the entire model when one slice is enough.

3. **Respect the model**
   - Context-level declarations are inside their bounded context or shared kernel.
   - Module-nested declarations follow exposure and `depends on` rules.
   - Cross-context type use requires a mirror, shared kernel, integration event, or published query contract.
   - Identifier fields require a value object declared in the same aggregate.
   - Use `string`, `boolean`, `integer`, `decimal`, `date`, `time`, and `instant`.
   - Do not use `number`; it is not a Thinai primitive.

4. **Implement**
   - Follow the existing repository’s language, framework, and naming conventions.
   - Keep domain invariants and preconditions represented in the implementation or tests.
   - Keep boundary types (data objects, integration events) out of the domain layer.

5. **Validate**
   - CLI: `thinai validate <file>`
   - LSP diagnostics
   - MCP: `validate_model`
   - Run the repository’s tests.

6. **Verify model coverage**
   - Check that every aggregate, event, contract, and exposed operation you touched has a code counterpart.
   - A deterministic `thinai verify` manifest workflow is planned but not part of this alpha.

## Useful commands

```bash
thinai inspect path/to/model.tni
thinai context path/to/model.tni Aggregate:Ordering.Order --format md
thinai impact path/to/model.tni ValueObject:Ordering.Order.OrderId --json
thinai validate path/to/model.tni
thinai mcp path/to/model.tni
```

## MCP tools

- `list_elements`
- `search_elements`
- `get_element`
- `get_context`
- `get_dependencies`
- `get_visibility`
- `validate_model`
- `impact_of_change`

The server is read-only. Edit files through the workspace, not through MCP.

## What not to do

- Do not invent a code generator or assume generated artifacts exist.
- Do not use private module declarations from outside their allowed scope.
- Do not treat journeys, behavior text, or invariants as executable code.
- Do not silently change the model to fit an implementation; surface the mismatch.
