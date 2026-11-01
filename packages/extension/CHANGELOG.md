# Changelog

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
