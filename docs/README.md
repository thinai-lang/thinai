# Thinai Language Docs

Thinai is a domain-specific language for describing domain-driven design (DDD)
and EventStorming models in `.tni` files. Use these guides to explore the
language by topic:

- [Language model](language-model.md) — subdomains, bounded contexts, context
  maps, shared kernels, imports, and working across files.
- [Tactical modeling](tactical-modeling.md) — aggregates, entities, value
  objects, operations, modules, and domain constraints.
- [Events and behavior](events-and-behavior.md) — commands, domain and
  integration events, EventStorming, and behavior specifications.

For a complete multi-file model, see the
[Order Fulfillment example](../examples/order-fulfillment/README.md). The
[language package README](../packages/language/README.md) describes the
implementation package; the [grammar](../packages/language/src/thinai.langium)
defines the syntax precisely.
