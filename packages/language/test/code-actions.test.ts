import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from '../src/index.js';
import type { CodeAction, Diagnostic, TextEdit } from 'vscode-languageserver';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

function model(depends: boolean, exposes: boolean): string {
    return `bounded context Shop
in bounded context Shop {
  module Domain {
    aggregate OrderAggregate {
      value object OrderId {
        raw: string
      }
      root entity Order {
        identifier id: OrderId
        method place() {
          behavior "Place."
        }
      }
    }
    ${exposes ? 'exposes OrderAggregate' : ''}
  }
  module Api {
    ${depends ? 'depends on Domain' : ''}
    application service OrderApplication {
      method placeOrder() returns string {
        behavior "Place."
        invokes Domain.OrderAggregate.Order.place
      }
    }
    exposes OrderApplication
  }
}
`;
}

async function actionsFor(text: string) {
    const document = services.shared.workspace.LangiumDocuments.createDocument(
        URI.file('/workspace/code-actions/exposure.tni'),
        text
    );
    documents = [document];
    await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
    const diagnostics = (document.diagnostics ?? []).filter(diagnostic =>
        String(diagnostic.message).includes('module reference requires')
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    const actions = await services.Thinai.lsp.CodeActionProvider!.getCodeActions(document, {
        textDocument: { uri: document.uri.toString() },
        range: diagnostics[0]!.range,
        context: { diagnostics }
    }) as CodeAction[] | undefined;
    return { document, actions: actions ?? [] };
}

function applyEdits(document: LangiumDocument, text: string, edits: TextEdit[]): string {
    return [...edits]
        .sort((left, right) =>
            document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start)
        )
        .reduce((source, edit) => {
            const start = document.textDocument.offsetAt(edit.range.start);
            const end = document.textDocument.offsetAt(edit.range.end);
            return source.slice(0, start) + edit.newText + source.slice(end);
        }, text);
}

function editsOf(action: { edit?: { changes?: Record<string, TextEdit[]> } }, document: LangiumDocument): TextEdit[] {
    return action.edit?.changes?.[document.uri.toString()] ?? [];
}

describe('Exposure code actions', () => {
    test('adds a missing module dependency', async () => {
        const text = model(false, true);
        const { document, actions } = await actionsFor(text);
        const action = actions.find(candidate => candidate.title.includes("depends on Domain"));
        expect(action).toBeDefined();
        const applied = applyEdits(document, text, editsOf(action!, document));
        expect(applied).toContain('depends on Domain');
    });

    test('exposes an aggregate for a root method reference', async () => {
        const text = model(true, false);
        const { document, actions } = await actionsFor(text);
        const action = actions.find(candidate => candidate.title.includes("Expose 'OrderAggregate'"));
        expect(action).toBeDefined();
        const applied = applyEdits(document, text, editsOf(action!, document));
        expect(applied).toContain('exposes OrderAggregate');
    });

    test('combines dependency and exposure fixes', async () => {
        const text = model(false, false);
        const { document, actions } = await actionsFor(text);
        const action = actions.find(candidate => candidate.title.includes('Make'));
        expect(action).toBeDefined();
        const applied = applyEdits(document, text, editsOf(action!, document));
        expect(applied).toContain('depends on Domain');
        expect(applied).toContain('exposes OrderAggregate');
    });

    test('appends to existing dependency and exposure clauses', async () => {
        const text = `bounded context Shop
in bounded context Shop {
  module Other {
  }
  module Domain {
    value object OrderId {
      raw: string
    }
    aggregate OrderAggregate {
      root entity Order {
        identifier id: OrderId
        method place() {
          behavior "Place."
        }
      }
    }
    exposes OrderId
  }
  module Api {
    depends on Other
    application service OrderApplication {
      method placeOrder() returns string {
        behavior "Place."
        invokes Domain.OrderAggregate.Order.place
      }
    }
    exposes OrderApplication
  }
}
`;
        const { document, actions } = await actionsFor(text);
        const action = actions.find(candidate => candidate.title.includes('Make'));
        expect(action).toBeDefined();
        const applied = applyEdits(document, text, editsOf(action!, document));
        expect(applied).toContain('depends on Other, Domain');
        expect(applied).toContain('exposes OrderId, OrderAggregate');
    });

    test('converts multiline quoted text to triple double quotes', async () => {
        const text = `bounded context Shop
in bounded context Shop {
  application service OrderApplication {
    method placeOrder() {
      behavior "Line one.
Line two."
    }
  }
}
`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/code-actions/multiline-string.tni'),
            text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        const diagnostic = (document.diagnostics ?? []).find(candidate =>
            candidate.code === 'multiline-string-requires-triple-quotes'
        );
        expect(diagnostic).toBeDefined();
        const actions = await services.Thinai.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.uri.toString() },
            range: diagnostic!.range,
            context: { diagnostics: [diagnostic!] }
        }) as CodeAction[] | undefined;
        const action = actions?.find(candidate => candidate.title === 'Use triple double quotes');
        expect(action).toBeDefined();
        const applied = applyEdits(document, text, editsOf(action!, document));
        expect(applied).toContain('behavior """\nLine one.\nLine two.\n"""');
    });
});

describe('Bounded-context part code actions', () => {
    async function buildDocuments(sources: Record<string, string>) {
        const result = Object.fromEntries(Object.entries(sources).map(([file, source]) => [
            file,
            services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/part-actions/${file}`),
                source
            )
        ]));
        documents = Object.values(result);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        return result;
    }

    async function actionsAt(document: LangiumDocument, diagnostic: Diagnostic) {
        const actions = await services.Thinai.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.uri.toString() },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        return (actions ?? []) as CodeAction[];
    }

    test('adds an unrooted part to its bounded-context root', async () => {
        const docs = await buildDocuments({
            'ordering.tni': 'bounded context Ordering',
            'pricing.tni': `in bounded context Ordering {
    domain service Pricing {
        method total() returns decimal
    }
}`
        });
        const part = docs['pricing.tni']!;
        const diagnostic = (part.diagnostics ?? []).find(candidate => candidate.code === 'part-without-root');
        expect(diagnostic).toBeDefined();

        const actions = await actionsAt(part, diagnostic!);
        const action = actions.find(candidate => candidate.title === "Add this part to './ordering.tni'");
        expect(action).toBeDefined();

        const root = docs['ordering.tni']!;
        const edits = action!.edit?.changes?.[root.uri.toString()] ?? [];
        expect(edits).toHaveLength(1);
        const rootText = applyEdits(root, root.textDocument.getText(), edits);
        expect(rootText).toContain('import "./pricing.tni"');

        await clearDocuments(services.shared, documents);
        documents = [];
        const rebuilt = await buildDocuments({
            'ordering.tni': rootText,
            'pricing.tni': part.textDocument.getText()
        });
        expect((rebuilt['pricing.tni']!.diagnostics ?? []).filter(candidate => candidate.severity === 1)).toEqual([]);
    });

    test('offers one root action per candidate root', async () => {
        const docs = await buildDocuments({
            'a.tni': 'bounded context Ordering',
            'b.tni': 'bounded context Ordering',
            'pricing.tni': `in bounded context Ordering {
    value object Amount {
        raw: string
    }
}`
        });
        const part = docs['pricing.tni']!;
        const diagnostic = (part.diagnostics ?? []).find(candidate => candidate.code === 'part-without-root');
        expect(diagnostic).toBeDefined();

        const actions = await actionsAt(part, diagnostic!);
        expect(actions.some(candidate => candidate.title === "Add this part to './a.tni'")).toBe(true);
        expect(actions.some(candidate => candidate.title === "Add this part to './b.tni'")).toBe(true);
    });

    test('does not offer a root action when no root declares the context', async () => {
        const docs = await buildDocuments({
            'pricing.tni': `in bounded context Ordering {
    value object Amount {
        raw: string
    }
}`
        });
        const part = docs['pricing.tni']!;
        const diagnostic = (part.diagnostics ?? []).find(candidate => candidate.code === 'part-without-root');
        expect(diagnostic).toBeDefined();

        const actions = await actionsAt(part, diagnostic!);
        expect(actions.some(candidate => candidate.title.startsWith('Add this part to'))).toBe(false);
    });

    test('replaces a direct part import with the bounded-context root', async () => {
        const docs = await buildDocuments({
            'ordering.tni': `import "./pricing.tni"
bounded context Ordering`,
            'pricing.tni': `in bounded context Ordering {
    value object Amount {
        raw: string
    }
}`,
            'shipping.tni': `import "./pricing.tni"

bounded context Shipping
in bounded context Shipping {
    application service ShippingApplication {
        method openDispatch()
    }
}`
        });
        const consumer = docs['shipping.tni']!;
        const diagnostic = (consumer.diagnostics ?? []).find(candidate => candidate.code === 'import-part-directly');
        expect(diagnostic).toBeDefined();

        const actions = await actionsAt(consumer, diagnostic!);
        const action = actions.find(candidate => candidate.title === "Import './ordering.tni' instead");
        expect(action).toBeDefined();

        const edits = action!.edit?.changes?.[consumer.uri.toString()] ?? [];
        const fixedText = applyEdits(consumer, consumer.textDocument.getText(), edits);
        expect(fixedText).toContain('import "./ordering.tni"');
        expect(fixedText).not.toContain('import "./pricing.tni"');

        await clearDocuments(services.shared, documents);
        documents = [];
        const rebuilt = await buildDocuments({
            'ordering.tni': docs['ordering.tni']!.textDocument.getText(),
            'pricing.tni': docs['pricing.tni']!.textDocument.getText(),
            'shipping.tni': fixedText
        });
        expect((rebuilt['shipping.tni']!.diagnostics ?? []).filter(candidate => candidate.severity === 1)).toEqual([]);
    });
});
