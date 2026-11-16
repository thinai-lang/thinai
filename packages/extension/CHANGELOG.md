# Changelog

## 0.1.8-alpha.8 - 2026-11-17

- Warn when a context-map integration pattern is listed on the wrong customer or supplier side, and offer only role-appropriate patterns in completion.
- Validate public documentation snippets and check the public example and grammar mirrors in CI.
- Refresh the public examples, coverage notes, and documentation tables.
- Align the language, CLI, and extension on the shared `0.1.8-alpha.8` release version.

## 0.1.7-alpha.7 - 2026-11-16

- Rework completion path matching for qualified, abbreviated, and dotless chains across invokes, exposures, and specification links.
- Keep exposure completion consistent after `exposes`, rank local declarations first, and exclude targets already exposed.
- Add smart selection expansion for qualified paths, statements, blocks, and `[[...]]` references.
- Auto-close and symmetrically delete `[[...]]` specification links.
- Use commit characters instead of inserting trailing dots for container completions.
- Suppress automatic completion after complete generic collection types.
- Improve module, import, formatting, and journey/query completion behavior.
- Restrict integration-event handlers to consumer bounded contexts; local reactions must use domain events.
- Add document symbols for bounded-context parts so the editor breadcrumb includes the bounded context.
- Refresh examples, demo notes, and Thinai editor defaults.
- Align the language, CLI, and extension on the shared `0.1.7-alpha.7` release version.

## 0.1.6-alpha.6 - 2026-11-05

- Allow `exposes` anywhere in a module body; a module may declare it at most once.
- Preserve the export clause position when formatting.
- Offer `exposes` after module members and suppress a second clause in completion.
- Align the language, CLI, and extension on the shared `0.1.6-alpha.6` release version.

## 0.1.5-alpha.5 - 2026-11-01

- Add read-only MCP tools `get_source` and `resolve_element` for declaration text and exact qualified-name lookup.
- Add `kind`, `role`, `offset`, and `limit` filters to MCP `get_dependencies`; qualifier edges are opt-in.
- Add `depth` and `limit` to `impact_of_change` and `thinai-cli impact`, with `totalAffected` and truncation reporting.
- Align the language, CLI, and extension on the shared `0.1.5-alpha.5` release version.
- Refresh the `thinai-model` skill and agent workflow documentation.

## 0.1.4-alpha.1 - 2026-11-01

- Remove the CLI JavaScript-summary generator; Thinai remains model-first with no code generation.
- Disable rename until new-name validation and identifier quoting are implemented.
- Treat UAX #31 Unicode identifiers as words in VS Code.
- Replace the complete token when completing existing words and backtick-quoted references.
- Align model-export visibility with validator public-API rules and export semantic relationship roles.

## 0.1.3-alpha.1 - 2026-10-31

- Add UAX #31 Unicode identifiers and NFC normalization warnings.
- Validate mirror field shape, optionality, and context-map authorization.
- Improve module visibility, journey contract, and query-contract validation.
- Update the alpha documentation, package metadata, and support links.

## 0.1.2-alpha.1 - 2026-10-30

- Restore repository metadata used for Marketplace namespace verification.

## 0.1.1-alpha.1 - 2026-10-29

- Point package metadata and support links at the public documentation site.

## 0.1.0-alpha.1 - 2026-10-27

- Add declaration hover and verify find-all-references, document symbols, and references.
- Fix circular completion payloads that could fail in VS Code.
- Replace the generic `number` primitive with `integer` for whole numbers and add `decimal` for exact base-10 values.
- Scope duplicate declarations to each document's import-connected model.
- Separate strategic declaration namespaces so a subdomain may share a name with its bounded context.
- Treat map specification paths as value-oriented; map keys are no longer implicitly navigable.
- Improve journey visibility for private query services and future command contracts.
- Improve completion for published contract paths and reserved result parameters.
- Avoid auto-closing brackets inside strings and comments, and preserve backtick-delimited words.
- Improve keyword highlighting for integration patterns and shared-kernel participants.
- Reject invalid collection-typed event payloads and private method specification paths.
- Avoid invalid member-keyword completion at model scope and normalize parameter spacing.
- Reject unaliased import component names that collide with local path roots.
