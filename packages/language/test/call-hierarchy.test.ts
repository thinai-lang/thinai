import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from '../src/index.js';
import type { CallHierarchyItem } from 'vscode-languageserver';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

const source = `bounded context Shop
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
    exposes OrderAggregate, OrderAggregate.OrderId
  }
  module Api {
    depends on Domain
    application service OrderApplication {
      method placeOrder() returns string {
        behavior "Place."
        invokes Domain.OrderAggregate.Order.place
      }
    }
    exposes OrderApplication
  }
  query service OrderQueries {
    method findOrder() returns string
  }
}
actor Customer
journey PlaceOrder {
  by Customer {
    invoke Shop.OrderQueries.findOrder
    invoke Shop.Api.OrderApplication.placeOrder
  }
}
`;

async function setUp(): Promise<LangiumDocument> {
    const document = services.shared.workspace.LangiumDocuments.createDocument(
        URI.file('/workspace/call-hierarchy/main.tni'),
        source
    );
    documents = [document];
    await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
    return document;
}

async function prepare(document: LangiumDocument, name: string, occurrence = 1): Promise<CallHierarchyItem> {
    let offset = -1;
    for (let index = 0; index < occurrence; index++) {
        offset = source.indexOf(name, offset + 1);
    }
    const items = await services.Thinai.lsp.CallHierarchyProvider!.prepareCallHierarchy(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(offset + name.length)
    });
    expect(items?.[0]).toBeDefined();
    return items![0]!;
}

describe('Call hierarchy', () => {
    test('shows aggregate-root methods called by application services', async () => {
        const document = await setUp();
        const place = await prepare(document, 'place');
        const incoming = await services.Thinai.lsp.CallHierarchyProvider!.incomingCalls({ item: place });
        expect(incoming?.map(call => call.from.name)).toEqual(['placeOrder']);
        expect(await services.Thinai.lsp.CallHierarchyProvider!.outgoingCalls({ item: place })).toEqual([]);
    });

    test('shows journey commands and their target methods', async () => {
        const document = await setUp();
        const placeOrder = await prepare(document, 'placeOrder');
        const incoming = await services.Thinai.lsp.CallHierarchyProvider!.incomingCalls({ item: placeOrder });
        const outgoing = await services.Thinai.lsp.CallHierarchyProvider!.outgoingCalls({ item: placeOrder });
        expect(incoming?.map(call => call.from.name)).toEqual(['PlaceOrder']);
        expect(outgoing?.map(call => call.to.name)).toEqual(['place']);
    });

    test('shows outgoing journey commands and queries', async () => {
        const document = await setUp();
        const journey = await prepare(document, 'PlaceOrder');
        const outgoing = await services.Thinai.lsp.CallHierarchyProvider!.outgoingCalls({ item: journey });
        expect(outgoing?.map(call => call.to.name)).toEqual(['findOrder', 'placeOrder']);
    });

    test('shows journey query steps as incoming calls', async () => {
        const document = await setUp();
        const findOrder = await prepare(document, 'findOrder');
        const incoming = await services.Thinai.lsp.CallHierarchyProvider!.incomingCalls({ item: findOrder });
        expect(incoming?.map(call => call.from.name)).toEqual(['PlaceOrder']);
        expect(await services.Thinai.lsp.CallHierarchyProvider!.outgoingCalls({ item: findOrder })).toEqual([]);
    });
});
