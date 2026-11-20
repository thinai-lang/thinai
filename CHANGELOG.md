# Changelog

## Unreleased

- Reject literal line breaks in single- and double-quoted strings; use triple double quotes for multiline text.
- Auto-close triple double quotes and remove the closing delimiter when the opening triple is deleted.
- Expand selection inside quoted strings starting with the string content, then the quoted literal.

## 0.1.5-alpha.5 - 2026-11-01

- Add read-only MCP tools `get_source` and `resolve_element` for declaration text and exact qualified-name lookup.
- Add `kind`, `role`, `offset`, and `limit` filters to MCP `get_dependencies`; qualifier edges are opt-in.
- Add `depth` and `limit` to `impact_of_change` and `thinai-cli impact`, with `totalAffected` and truncation reporting.
- Align the language, CLI, and extension on the shared `0.1.5-alpha.5` release version.
- Refresh the `thinai-model` skill and agent workflow documentation.

## 0.1.0-alpha.3 - 2026-10-31

- Accept Unicode identifiers in declarations and references, including quoted names.
- Warn when an identifier is not in Unicode NFC form so visually identical names link consistently.
- Keep keyword lexing correct when an identifier starts with a keyword, such as `input` or `boundedness`.
- Require a mirrored identifier to declare the same fields, types, and optionality as its source.
- Require a customer-supplier, partnership, or shared-kernel relationship for a mirrored identifier.
- Publish the VS Code extension as a `0.1.3` pre-release with the same language behavior.

## 0.1.0-alpha.2 - 2026-10-30

- Point package metadata, READMEs, and support links at the public documentation, examples, and issue tracker.
- Publish the VS Code extension through Marketplace trusted publishing as a pre-release.

## 0.1.0-alpha.1 - 2026-10-27

- Add stable model export, context slices, impact reports, validation, and a read-only MCP server to the CLI.
- Add an agent workflow skill and documentation for model-first coding.
- Add declaration hover and verify find-all-references, document symbols, and references in the language server.
- Fix circular completion payloads in LSP clients by stripping internal node descriptions.
- Replace the generic `number` primitive with `integer` for whole numbers and add `decimal` for exact base-10 values.
- Scope duplicate declaration names to each import-connected model.
- Separate actor, journey, and subdomain namespaces from path declarations.
- Keep map specification paths value-oriented; map keys are not implicitly navigable.
- Clarify direct cross-context type use and additive journey visibility.
- Fix journey visibility for private query services and published aggregate contract paths.
- Improve completion parity for reserved result parameters, single-quoted text, and specification paths.
- Make clean-checkout builds and tests reproducible and add CI.
- Revalidate complete import-connected components after incremental changes.
- Complete structural roots for qualified read sources and append continuation dots.
- Preserve context-relative module paths inside aliased contributions.
- Allow multiple component imports from one file and relax alias collisions with terminal member names.
- Align context-map local authorization docs and messages with the implementation.
- Complete import components even when the import path follows the cursor, and omit already imported components.
- Complete typed canonical paths, aliases, and duplicate short names with correct filter text.
- Append continuation dots for typed parameter and method-result specification roots.
- Suppress compound-keyword, `reads from`, and event-handler parameter completions outside their valid contexts.
- Omit shared-kernel participants that conflict with existing separate-ways relationships.
- Offer bare import quick fixes for unowned strategic declarations such as actors.
- Align sysprompt, README, and evaluations with line-break, domain-service, and enum rules.
- Require commas between enum values and enforce backtick-quoted reserved words in specification references.
- Deduplicate exposure completions already present earlier in the same `exposes` clause.
- Validate complete sysprompt snippets and mark fragment examples explicitly.
- Deduplicate identical completion items and validate completion text-edit ranges across examples.
- Return line selection ranges inside line and block comments.
- Exclude source maps from the VS Code extension package.
- Run CI on Linux, Windows, and macOS; document ASCII-only identifiers.
- Add a Language Tour example and expand Order Fulfillment coverage for quoting, guards, shared-kernel services, nested re-exports, and journey result links.
- Validate and format every example directory in tests.
- Support session-header gateways in evaluations and increase the eval request timeout.
- Clarify evaluation prompts for strategic structures, mirroring, and integration-pattern labels.
- Reach full passing scores across the evaluation suite.
- Document module, shared-kernel, cross-context, and specification-path visibility in the language README.
- Extend the Language Tour with context-level value-object behavior and a module-private identifier mirror.
- Reject entities, aggregate-owned types, and private module types inside collection-typed event payloads.
- Require method exposure for non-terminal specification path segments and align nested-module path visibility.
- Avoid invalid member-keyword completions at model scope.
- Normalize parameter-list parentheses in the formatter.
- Reject unaliased import component names that collide with local path roots.
- Document the CLI import-closure validation scope and alpha limitations.
