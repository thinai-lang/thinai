import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from '../src/index.js';
import { DiagnosticSeverity } from 'vscode-languageserver';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

async function build(sources: Record<string, string>): Promise<Record<string, LangiumDocument>> {
    const result = Object.fromEntries(Object.entries(sources).map(([file, source]) => [
        file,
        services.shared.workspace.LangiumDocuments.createDocument(
            URI.file(`/workspace/${file}`), source
        )
    ]));
    documents = Object.values(result);
    await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
    return result;
}

function errors(document: LangiumDocument): string[] {
    return (document.diagnostics ?? [])
        .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
        .map(diagnostic => String(diagnostic.message));
}

async function completion(document: LangiumDocument, offset: number) {
    return services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(offset)
    });
}

describe('Multi-file bounded contexts', () => {
    test('lets a part reference a peer part without importing it', async () => {
        const docs = await build({
            'ordering.tni': `import "./ordering-domain.tni"
import "./ordering-api.tni"

bounded context Ordering`,
            'ordering-domain.tni': `in bounded context Ordering {
    value object OrderId {
        raw: string
    }
}`,
            'ordering-api.tni': `in bounded context Ordering {
    module Api {
        depends on Domain
        application service Orders {
            method place(id: OrderId)
        }
    }
    module Domain {
        exposes OrderId
        value object OrderId {
            raw: string
        }
    }
}`
        });

        expect(errors(docs['ordering.tni']!)).toEqual([]);
        expect(errors(docs['ordering-domain.tni']!)).toEqual([]);
        expect(errors(docs['ordering-api.tni']!)).toEqual([]);
    });

    test('resolves a part context to the root declaration', async () => {
        const docs = await build({
            'ordering.tni': `import "./ordering-api.tni"

bounded context Ordering`,
            'ordering-api.tni': `in bounded context Ordering {
    application service Orders {
        method place()
    }
}`
        });

        expect(errors(docs['ordering.tni']!)).toEqual([]);
        expect(errors(docs['ordering-api.tni']!)).toEqual([]);
        const source = docs['ordering-api.tni']!.textDocument.getText();
        const offset = source.indexOf('Ordering') + 'Ordering'.length;
        const items = await completion(docs['ordering-api.tni']!, offset);
        expect(items?.items.map(item => item.label)).toContain('Ordering');
    });

    test('offers the root context while a new part is being created', async () => {
        const docs = await build({
            'ordering.tni': `import "./pricing.tni"

bounded context Ordering`,
            'pricing.tni': 'in bounded context '
        });

        const source = docs['pricing.tni']!.textDocument.getText();
        const items = await completion(docs['pricing.tni']!, source.length);
        expect(items?.items.map(item => item.label)).toContain('Ordering');
    });

    test('reports a part that no root imports', async () => {
        const docs = await build({
            'ordering.tni': 'bounded context Ordering',
            'api.tni': `in bounded context Ordering {
    application service Orders {
        method place()
    }
}`
        });

        expect(errors(docs['api.tni']!).some(message =>
            message.includes('not included by a bounded-context root')
        )).toBe(true);
    });

    test('rejects a part that imports its root', async () => {
        const docs = await build({
            'ordering.tni': `import "./api.tni"

bounded context Ordering`,
            'api.tni': `import "./ordering.tni"

in bounded context Ordering {
    application service Orders {
        method place()
    }
}`
        });

        expect(errors(docs['api.tni']!).some(message =>
            message.includes('must not import its root')
        )).toBe(true);
    });

    test('rejects a part that imports a peer part', async () => {
        const docs = await build({
            'ordering.tni': `import "./api.tni"
import "./domain.tni"

bounded context Ordering`,
            'domain.tni': `in bounded context Ordering {
    value object OrderId {
        raw: string
    }
}`,
            'api.tni': `import "./domain.tni"

in bounded context Ordering {
    application service Orders {
        method place(id: OrderId)
    }
}`
        });

        expect(errors(docs['api.tni']!).some(message =>
            message.includes('must not import another part')
        )).toBe(true);
    });

    test('reports a part imported by more than one root', async () => {
        const docs = await build({
            'a.tni': `import "./shared-part.tni"

bounded context Ordering`,
            'b.tni': `import "./shared-part.tni"

bounded context Ordering`,
            'shared-part.tni': `in bounded context Ordering {
    application service Orders {
        method place()
    }
}`
        });

        expect(errors(docs['shared-part.tni']!).some(message =>
            message.includes('included by more than one root')
        )).toBe(true);
    });

    test('expands an imported root to its parts for an external context', async () => {
        const docs = await build({
            'ordering.tni': `import "./ordering-events.tni"

bounded context Ordering`,
            'ordering-events.tni': `in bounded context Ordering {
    module Contracts {
        exposes OrderPlacedV1
        integration event OrderPlacedV1 {
            orderId: string
        }
    }
}`,
            'shipping.tni': `import "./ordering.tni"

bounded context Shipping
in bounded context Shipping {
    read model ShipmentView {
        orderId: string
    }
    projector ShipmentProjector {
        method onOrderPlaced(source: Ordering.Contracts.OrderPlacedV1) {
            projects ShipmentView
        }
    }
}
context map Fulfillment {
    customer Shipping -> supplier Ordering
}`
        });

        expect(errors(docs['shipping.tni']!).some(message =>
            message.includes('Could not resolve reference')
        )).toBe(false);
    });

    test('rejects importing a part directly from another context', async () => {
        const docs = await build({
            'ordering.tni': `import "./ordering-api.tni"

bounded context Ordering`,
            'ordering-api.tni': `in bounded context Ordering {
    integration event OrderPlaced {
        raw: string
    }
}`,
            'shipping.tni': `import "./ordering-api.tni"

bounded context Shipping
in bounded context Shipping {
    data object Use {
        placed: Ordering.OrderPlaced
    }
}`
        });

        expect(errors(docs['shipping.tni']!).some(message =>
            message.includes('Import the bounded-context root')
        )).toBe(true);
    });

    test('keeps a part external import local to that part', async () => {
        const docs = await build({
            'shared.tni': `shared kernel Common {
    value object Shared {
        raw: string
    }
}`,
            'ordering.tni': `import "./api.tni"
import "./domain.tni"

bounded context Ordering`,
            'domain.tni': `import "./shared.tni"

in bounded context Ordering {
    value object Use {
        common: Shared
    }
}`,
            'api.tni': `in bounded context Ordering {
    data object Broken {
        amount: Shared
    }
}`
        });

        expect(errors(docs['api.tni']!).some(message =>
            message.includes("Could not resolve reference") && message.includes('Shared')
        )).toBe(true);
        expect(errors(docs['domain.tni']!).some(message =>
            message.includes("Could not resolve reference") && message.includes('Shared')
        )).toBe(false);
    });

    test('does not let shared context scope bypass module visibility', async () => {
        const docs = await build({
            'ordering.tni': `import "./domain.tni"
import "./api.tni"

bounded context Ordering`,
            'domain.tni': `in bounded context Ordering {
    module Domain {
        value object Hidden {
            raw: string
        }
    }
}`,
            'api.tni': `in bounded context Ordering {
    module Api {
        data object Use {
            hidden: Hidden
        }
    }
}`
        });

        expect(errors(docs['api.tni']!).some(message =>
            message.includes('requires a dependency on a module')
        )).toBe(true);
    });

    test('rejects module dependency cycles across parts', async () => {
        const docs = await build({
            'ordering.tni': `import "./a.tni"
import "./b.tni"

bounded context Ordering`,
            'a.tni': `in bounded context Ordering {
    module A {
        depends on B
        exposes AType
        value object AType {
            raw: string
        }
    }
}`,
            'b.tni': `in bounded context Ordering {
    module B {
        depends on A
        exposes BType
        value object BType {
            raw: string
        }
    }
}`
        });

        expect(errors(docs['a.tni']!).some(message =>
            message.includes('Module dependencies cannot contain a cycle')
        )).toBe(true);
    });

    test('reports duplicate members across parts', async () => {
        const docs = await build({
            'ordering.tni': `import "./a.tni"
import "./b.tni"

bounded context Ordering`,
            'a.tni': `in bounded context Ordering {
    value object Same {
        raw: string
    }
}`,
            'b.tni': `in bounded context Ordering {
    value object Same {
        raw: string
    }
}`
        });

        expect(errors(docs['a.tni']!).some(message =>
            message.includes("Duplicate declaration 'Ordering.Same'")
        )).toBe(true);
    });
});
