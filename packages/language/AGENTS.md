# Language Package Guidance

When changing the Thinai grammar, references, or language services, treat completion behavior as part of the feature:

- Check valid continuations within a statement on the same line, and next-sibling suggestions after a newline, at the end of a completed statement, and in an empty block. Sibling completions must insert line breaks and indentation so the resulting source remains valid.
- Non-empty statement blocks require the first statement to start on the line after `{`; empty `{}` blocks remain valid. Entity and value-object fields, constructors, and methods may appear in any source order, which formatting must preserve. Enum values are a list rather than statements: inline enums such as `enum Status { Draft, Placed }` are valid, commas are required between enum values, and the first-statement line-break rule does not apply to enum values.
- Cover complete and incomplete constructs, partial keyword and reference prefixes, operators, and optional clauses or blocks where applicable.
- Add or update LSP completion tests for suggestion labels, kinds, text-edit ranges, and spacing. Verify that invalid alternatives are excluded while valid continuations remain available.
- Keep completion behavior independent of formatting, and keep valid within-statement suggestions available before formatting normalizes indentation. When a completion inserts a line break, preserve the document's newline style and use the active editor's resolved tab size and spaces/tabs setting.

## Keyword-policy layering

- `thinai-layout.ts` is the source of truth for which sibling keywords may appear in each container. Keep new container keyword rules there rather than in individual completion providers.
- `thinai-keyword-continuations.ts` owns partial and compound keyword continuations, including the active-block check that prevents a phrase such as `context map` or `value object` from being suggested inside an unrelated block.
- Completion providers apply cursor-specific filtering and edit/indentation behavior on top of those policies. Do not duplicate sibling keyword lists in a provider.

A future consolidation of this policy must preserve this layering and remain behavior-preserving; add characterization tests before moving code.
