import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from '../src/index.js';
import type { CodeAction, TextEdit } from 'vscode-languageserver';

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
});
