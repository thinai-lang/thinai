import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from '../src/index.js';
import type { InitializeParams, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

function createDocument(fileName: string, text: string): LangiumDocument {
    const document = services.shared.workspace.LangiumDocuments.createDocument(
        URI.file(`/workspace/rename/${fileName}`),
        text
    );
    documents.push(document);
    return document;
}

async function buildDocuments(): Promise<void> {
    await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
}

async function renameAt(
    document: LangiumDocument,
    text: string,
    marker: string,
    newName: string,
    markerOffset = 0
): Promise<WorkspaceEdit | undefined> {
    const offset = text.indexOf(marker) + markerOffset;
    return services.Thinai.lsp.RenameProvider!.rename(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(offset),
        newName
    });
}

async function prepareAt(document: LangiumDocument, text: string, marker: string): Promise<Range | undefined> {
    const offset = text.indexOf(marker);
    return services.Thinai.lsp.RenameProvider!.prepareRename(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(offset)
    });
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

describe('Rename', () => {
    test('advertises rename capabilities', async () => {
        const result = await services.shared.lsp.LanguageServer.initialize({
            processId: null,
            rootUri: null,
            capabilities: {},
            workspaceFolders: null
        } as InitializeParams);
        expect(result.capabilities.renameProvider).toMatchObject({ prepareProvider: true });
    });

    test('renames a method declaration, invokes reference, and specification link', async () => {
        const text = `bounded context X
in bounded context X {
  aggregate A {
    root entity E {
      identifier id: string
      method dispath() {
        behavior "Dispatch."
      }
      method run() {
        behavior "Call [[E.dispath]]."
        invokes E.dispath
      }
    }
  }
}
`;
        const document = createDocument('method.tni', text);
        await buildDocuments();

        const prepared = await prepareAt(document, text, 'dispath');
        expect(prepared).toMatchObject({
            start: { line: 5, character: 13 },
            end: { line: 5, character: 20 }
        });

        const edit = await renameAt(document, text, 'dispath', 'dispatch');
        const changes = edit?.changes?.[document.uri.toString()] ?? [];
        expect(changes).toHaveLength(3);

        const applied = applyEdits(document, text, changes);
        expect(applied).not.toContain('dispath');
        expect(applied.match(/dispatch/gu)).toHaveLength(3);
    });

    test('renames references from a usage position', async () => {
        const text = `bounded context X
in bounded context X {
  aggregate A {
    root entity E {
      identifier id: string
      method dispath() {
        behavior "Dispatch."
      }
      method run() {
        invokes E.dispath
      }
    }
  }
}
`;
        const document = createDocument('usage.tni', text);
        await buildDocuments();

        const edit = await renameAt(document, text, 'E.dispath', 'dispatch', 'E.'.length);
        const changes = edit?.changes?.[document.uri.toString()] ?? [];
        const applied = applyEdits(document, text, changes);
        expect(applied).toContain('method dispatch()');
        expect(applied).toContain('invokes E.dispatch');
    });

    test('renames cross-file references and exposure paths', async () => {
        const commonText = `shared kernel Common {
  module Types {
    value object OrderId {
      raw: string
    }
    exposes OrderId
  }
}
`;
        const consumerText = `import { Common } from "./common.tni"
bounded context C
in bounded context C {
  data object D {
    id: Common.Types.OrderId
  }
}
`;
        const common = createDocument('common.tni', commonText);
        createDocument('consumer.tni', consumerText);
        await buildDocuments();

        const edit = await renameAt(common, commonText, 'OrderId', 'OrderKey');
        expect(Object.keys(edit?.changes ?? {}).sort()).toEqual([
            common.uri.toString(),
            documents[1]!.uri.toString()
        ].sort());

        const commonChanges = edit?.changes?.[common.uri.toString()] ?? [];
        const consumerChanges = edit?.changes?.[documents[1]!.uri.toString()] ?? [];
        expect(applyEdits(common, commonText, commonChanges)).toContain('exposes OrderKey');
        expect(applyEdits(documents[1]!, consumerText, consumerChanges)).toContain('Common.Types.OrderKey');
    });

    test('quotes reserved and spaced names', async () => {
        const text = `bounded context X
in bounded context X {
  aggregate A {
    root entity E {
      identifier id: string
      method dispath() {
        behavior "Dispatch."
      }
    }
  }
}
`;
        const document = createDocument('quoted.tni', text);
        await buildDocuments();

        for (const newName of ['domain', 'dispatch action']) {
            const edit = await renameAt(document, text, 'dispath', newName);
            const changes = edit?.changes?.[document.uri.toString()] ?? [];
            expect(changes.length).toBeGreaterThan(0);
            expect(changes.every((change: TextEdit) => change.newText === `\`${newName}\``)).toBe(true);
        }
    });

    test('rejects sibling collisions and invalid identifiers', async () => {
        const text = `bounded context X
in bounded context X {
  aggregate A {
    root entity E {
      identifier id: string
      method dispath() {
        behavior "Dispatch."
      }
      method existing() {
        behavior "Existing."
      }
    }
  }
}
`;
        const document = createDocument('collision.tni', text);
        await buildDocuments();

        await expect(renameAt(document, text, 'dispath', 'existing'))
            .rejects.toThrow("A declaration named 'existing' already exists in this container.");
        await expect(renameAt(document, text, 'dispath', 'bad.name'))
            .rejects.toThrow("'bad.name' is not a valid Thinai identifier.");
        await expect(renameAt(document, text, 'dispath', '   '))
            .rejects.toThrow('The new name must not be empty.');
    });
});
