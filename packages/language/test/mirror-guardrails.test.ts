import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
import type { Model } from 'thinai-language';
import { createThinaiServices } from 'thinai-language';

let services: ReturnType<typeof createThinaiServices>;
let parse: ReturnType<typeof parseHelper<Model>>;
beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
    const doParse = parseHelper<Model>(services.Thinai);
    parse = (input: string) => doParse(input, { validation: true });
});

afterEach(async () => {
    await clearDocuments(services.shared, services.shared.workspace.LangiumDocuments.all.toArray());
});

function diagnosticsWithCode(document: LangiumDocument, code: string) {
    return (document.diagnostics ?? []).filter(diagnostic => diagnostic.code === code);
}

const ordering = `bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
        }
        value object OrderId {
            raw: string
        }
    }
}`;

const shippingRelationship = `context map ShippingOrdering {
    customer Shipping -> supplier Ordering
}`;

describe('Mirror guardrails', () => {
    test('accepts a mirror with matching fields and a context relationship', async () => {
        const document = await parse(`${ordering}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw: string
    }
}
${shippingRelationship}`);
        expect(diagnosticsWithCode(document, 'mirror-shape')).toEqual([]);
        expect(diagnosticsWithCode(document, 'mirror-without-relationship')).toEqual([]);
    });

    test('requires every source field', async () => {
        const document = await parse(`${ordering}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
    }
}
${shippingRelationship}`);
        const diagnostics = diagnosticsWithCode(document, 'mirror-shape');
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.message).toContain("must declare field 'raw'");
    });

    test('rejects fields that are not on the source identifier', async () => {
        const document = await parse(`${ordering}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw: string
        tenant: string
    }
}
${shippingRelationship}`);
        const diagnostics = diagnosticsWithCode(document, 'mirror-shape');
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.message).toContain("declares field 'tenant'");
    });

    test('rejects a mismatched field type', async () => {
        const document = await parse(`${ordering}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw: integer
    }
}
${shippingRelationship}`);
        const diagnostics = diagnosticsWithCode(document, 'mirror-shape');
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.message).toContain("must have type 'string'");
    });

    test('rejects a mismatched optionality', async () => {
        const document = await parse(`${ordering}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw?: string
    }
}
${shippingRelationship}`);
        expect(diagnosticsWithCode(document, 'mirror-shape')).toHaveLength(1);
    });

    test('compares collection types recursively', async () => {
        const document = await parse(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
        }
        value object OrderId {
            parts: Map<string, List<integer>>
        }
    }
}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        parts: Map<string, List<decimal>>
    }
}
${shippingRelationship}`);
        const diagnostics = diagnosticsWithCode(document, 'mirror-shape');
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.message).toContain('Map<string, List<integer>>');
    });

    test('does not require methods or constructors to be copied', async () => {
        const document = await parse(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
        }
        value object OrderId {
            constructor(raw: string) {
                invariant "Non-empty."
            }

            method normalize() returns string {
                behavior "Normalize [[OrderId.raw]]."
            }

            raw: string
        }
    }
}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw: string
    }
}
${shippingRelationship}`);
        expect(diagnosticsWithCode(document, 'mirror-shape')).toEqual([]);
        expect(diagnosticsWithCode(document, 'mirror-without-relationship')).toEqual([]);
    });

    test('requires an explicit relationship for the mirror', async () => {
        const document = await parse(`${ordering}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw: string
    }
}`);
        const diagnostics = diagnosticsWithCode(document, 'mirror-without-relationship');
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.message).toContain("connects 'Shipping' and 'Ordering'");
    });

    test('accepts a partnership or shared kernel as the relationship', async () => {
        const partnership = await parse(`${ordering}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw: string
    }
}
context map M {
    partner Shipping <-> partner Ordering
}`);
        expect(diagnosticsWithCode(partnership, 'mirror-without-relationship')).toEqual([]);

        const sharedKernel = await parse(`shared kernel Common {
    value object Currency {
        code: string
    }
}
bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
        }
        value object OrderId {
            raw: string
        }
    }
}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw: string
    }
}
context map M {
    sharedKernel Common {
        participants: [Ordering, Shipping]
    }
}`);
        expect(diagnosticsWithCode(sharedKernel, 'mirror-without-relationship')).toEqual([]);
    });

    test('does not accept separate ways as the relationship', async () => {
        const document = await parse(`${ordering}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw: string
    }
}
context map M {
    separateWays Shipping -x- Ordering
}`);
        expect(diagnosticsWithCode(document, 'mirror-without-relationship')).toHaveLength(1);
    });
});
