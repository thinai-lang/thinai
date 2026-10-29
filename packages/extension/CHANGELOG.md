# Changelog

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
