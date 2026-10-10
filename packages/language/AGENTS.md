# Language Package Guidance

When changing the Thinai grammar, references, or language services, treat completion behavior as part of the feature:

- Check valid continuations within a statement on the same line, and next-sibling suggestions after a newline. Sibling declarations and statements must start on a new line; do not suggest the next sibling on the current line.
- Cover complete and incomplete constructs, partial keyword and reference prefixes, operators, and optional clauses or blocks where applicable.
- Add or update LSP completion tests for suggestion labels, kinds, text-edit ranges, and spacing. Verify that invalid alternatives are excluded while valid continuations remain available.
- Keep completion behavior independent of formatting: do not insert line breaks as a side effect of completion, and keep valid within-statement suggestions available before formatting normalizes indentation.
