# Thinai Language

Thinai models strategic DDD, tactical DDD, and EventStorming.

## File Model

Declare a bounded context once, then extend it from any number of explicitly imported files:

```thinai
// ordering.tni
subdomain OrderManagement kind core;

bounded context Ordering realizes OrderManagement {
    aggregate Order {
        root entity OrderRoot {
            identifier id: OrderId;
        }
        identifier value object OrderId for OrderRoot {
            raw: string;
        }
    }
}
```

```thinai
// ordering-events.tni
import "./ordering.tni";

part of bounded context Ordering {
    command PlaceOrder targets Order emits OrderPlaced;
    event OrderPlaced for Order publishes integration OrderPlacedV1;
    integration event OrderPlacedV1 from OrderPlaced;
}
```

Imports are direct and relative. Declarations from unrelated workspace files are not visible. Unaliased imports expose their declarations by simple or qualified names. A file may contain multiple bounded contexts; select only the components a file needs with a named import:

```thinai
import "./contexts.tni" { Ordering as Orders, Shipping };
```

An alias applies only to its selected bounded context or shared kernel. The older `import "./file.tni" as Alias` form remains a shorthand when the file contains exactly one bounded context or shared kernel; use selectors for files with multiple components.

Domain events are local to their bounded context by default. Cross-context consumers must reference an integration event, either explicitly declared with `integration event ... from ...` or exposed with `publishes integration`.

Modules are optional internal namespaces. Use `exposes` and `depends on` to enforce module-level architectural dependencies within the same bounded context or shared kernel. Direct module dependencies across bounded contexts are not supported. Shared value objects belong in an explicit `shared kernel` rather than in a business bounded context.

## Behavior specifications

Use `invariant`, `precondition`, `postcondition`, and `behavior` to describe domain meaning on aggregates, entities, value objects, constructors, methods, and commands. Plain quoted strings remain valid. Behavior-specification strings can span multiple lines, and line breaks are preserved. For inline method references, prefix the string with `$`, as in `$"... ${MethodName} ..."`:

```thinai
root entity OrderRoot operations {
    constructor(id: OrderId) {
        invariant "An order must have an identifier.";
        postcondition $"The identifier is normalized by ${OrderId.normalize}.";
    }
    method ensureOwner();
} {
    identifier id: OrderId;
    invariant $"An order must have an owner; check ${OrderRoot.ensureOwner}.";
}

command PlaceOrder targets Order {
    precondition "The order contains at least one item.";
    behavior $"Check ${Order.OrderRoot.ensureOwner}, then place the order.";
    postcondition "OrderPlaced is emitted.";
}
```

An EventStorming board references the canonical command, so its behavior specifications are not duplicated on the board. Interpolations are links to declared methods, with completion, navigation, and unresolved-reference diagnostics; write `\${` when the text should contain a literal interpolation marker. They are descriptive—not executable—and Thinai does not prove that a method enforces the surrounding prose. Entity and value-object methods and constructors are declared in an `operations` block before the regular field/invariant block; methods have typed parameters and optional return types, while constructors return their owning type implicitly.

Fields and method signatures accept built-in `List<T>`, `Set<T>`, and `Map<K, V>` collection types. User-defined generic type declarations are not supported.

The language server provides keyword and cross-reference completion, relative `.tni` import-path completion, and quick fixes for unresolved declarations that can be imported from another workspace file.

## Supported Concepts

- Strategic DDD: bounded contexts, subdomains, capabilities, context maps, context relationships, and shared kernels.
- Tactical DDD: modules, aggregates, root entities, explicit identifier fields, identifier value objects, mirrored identifiers, entities, value objects, typed methods and constructors, built-in collection types, domain services, repositories, factories, commands, events, policies, and read models.
- EventStorming: actors, external systems, commands, domain events, integration events, policies, hotspots, and EventStorming boards.

As a general Langium reference, see the [Langium grammar guide](https://langium.org/docs/learn/workflow/write_grammar/).

## What's in the folder?

- [package.json](./package.json) - The manifest file of your language package.
- [tsconfig.src.json](./tsconfig.src.json) - The packages specific TypeScript compiler configuration extending the [base config](../../tsconfig.json)
- [tsconfig.json](./tsconfig.json) - TypeScript compiler configuration options required for proper functionality of VSCode.
- [src/thinai.langium](src/thinai.langium) -  The grammar definition of your language
- [src/thinai-module.ts](src/thinai-module.ts) - The dependency injection module of your language implementation. Use this to register overridden and added services.
- [src/thinai-validator.ts](src/thinai-validator.ts) - Semantic validation for the domain model.
- [src/thinai-completion.ts](src/thinai-completion.ts) - Completion support for import paths and language references.
- [src/thinai-code-actions.ts](src/thinai-code-actions.ts) - Quick fixes for missing imports.
- [src/generated/ast.ts](src/generated/ast.ts) - AST generated by `langium generate`.
- [src/generated/grammar.ts](src/generated/grammar.ts) - Grammar generated by `langium generate`.
- [src/generated/module.ts](src/generated/module.ts) - Module generated by `langium generate`.
- [syntaxes/thinai.tmLanguage.json](syntaxes/thinai.tmLanguage.json) - Textmate based syntax highlighting instructions.
- [src/index.ts](src/index.ts) Defines what is exported to other packages.

If you selected the test option as well, then the following files will be present in addition:

- [tsconfig.test.json](./tsconfig.test.json) - The package specific TypeScript compiler configuration for the unit tests extending the [tsconfig.src.json](./tsconfig.src.json)
- [test/linking.test.ts](test/linking.test.ts) - Unit tests checking linking.
- [test/lsp.test.ts](test/lsp.test.ts) - Completion and import code-action tests.
- [test/parsing.test.ts](test/parsing.test.ts) - Unit tests regarding parsing.
- [test/validating.test.ts](test/validating.test.ts) - Unit tests regarding validation.
