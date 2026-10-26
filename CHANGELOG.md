# Changelog

## 0.1.0-alpha.1 - 2026-10-27

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
