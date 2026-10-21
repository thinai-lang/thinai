import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { AstUtils, EmptyFileSystem, isReference, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { CompletionItemKind, type CompletionList } from 'vscode-languageserver';
import { createThinaiServices, isField } from '../src/index.js';
import { getTypeReferences } from '../src/thinai-type-utils.js';

const marker = '__completion_position__';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];
let fileIndex = 0;

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

async function build(markedText: string, validation = false): Promise<{
    document: LangiumDocument;
    completion: CompletionList | undefined;
    text: string;
    offset: number;
}> {
    const offset = markedText.indexOf(marker);
    const text = markedText.replace(marker, '');
    const document = services.shared.workspace.LangiumDocuments.createDocument(
        URI.file(`/workspace/completion-regression-${fileIndex++}.tni`),
        text
    );
    documents.push(document);
    await services.shared.workspace.DocumentBuilder.build([document], { validation });
    const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(offset)
    });
    return { document, completion, text, offset };
}

describe('Completion regressions', () => {
    test('completes the next segment of qualified repository, type, and mirror paths', async () => {
        const repository = await build(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order { identifier id: OrderId }
        value object OrderId { raw: string }
    }
    repository OrderRepository { manages Order.${marker} }
}`);
        const repositoryLabels = repository.completion?.items.map(item => item.label) ?? [];
        expect(repositoryLabels).toContain('Order');
        expect(repositoryLabels).not.toContain('Ordering');
        expect(repositoryLabels).not.toContain('Ordering.Order.Order');

        const typePath = await build(`bounded context Ordering
in bounded context Ordering {
    module Contracts {
        exposes Money, Currency
        value object Money { amount: number }
        enum Currency { USD, EUR }
    }
    data object Quote { price: Contracts.${marker} }
}`);
        const typeLabels = typePath.completion?.items.map(item => item.label) ?? [];
        expect(typeLabels).toContain('Money');
        expect(typeLabels).toContain('Currency');
        expect(typeLabels).not.toContain('Quote');
        expect(typeLabels).not.toContain('Contracts');
        expect(typeLabels).not.toContain('Ordering');

        const mirror = await build(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order { identifier id: OrderId }
        value object OrderId { raw: string }
    }
}
bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.${marker} }
}`);
        const mirrorLabels = mirror.completion?.items.map(item => item.label) ?? [];
        expect(mirrorLabels).toContain('OrderId');
        expect(mirrorLabels).not.toContain('Ordering.Order.OrderId');
    });

    test('does not offer path roots or terminal names when completing after a qualified path', async () => {
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/qualified-path-contexts.tni'),
            'bounded context Catalog bounded context Ordering'
        );
        const catalog = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/qualified-path-catalog.tni'),
            `import "./qualified-path-contexts.tni"
in bounded context Catalog {
    module PublicApi {
        exposes ProductQueries, ProductInfo
        query service ProductQueries {
            method findProduct(sku: string) returns ProductInfo
        }
        data object ProductInfo { available: boolean }
    }
}`
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/qualified-path-map.tni'),
            `import "./qualified-path-contexts.tni"
context map Commerce {
    customer Ordering -> supplier Catalog
}`
        );
        const consumerText = `import "./qualified-path-contexts.tni"
import "./qualified-path-catalog.tni"
import { Commerce } from "./qualified-path-map.tni"
in bounded context Ordering {
    application service OrderCommands {
        method checkProduct(sku: string) {
            reads from Catalog.PublicApi.ProductQueries.${marker}
        }
    }
}`;
        const offset = consumerText.indexOf(marker);
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/qualified-path-consumer.tni'),
            consumerText.replace(marker, '')
        );
        documents.push(contexts, catalog, contextMap, consumer);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('findProduct');
        expect(labels).not.toContain('Catalog');
        expect(labels).not.toContain('PublicApi');
        expect(labels).not.toContain('ProductQueries');
    });

    test('replaces the complete import path when completing inside it', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-target.tni'),
            'bounded context Target'
        );
        const sourceText = 'import "./import-target.tni"';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-source.tni'), sourceText
        );
        documents.push(target, source);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const cursor = sourceText.indexOf('./import-target.tni') + './import'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(cursor)
        });
        const item = completion?.items.find(candidate => candidate.label === './import-target.tni');
        expect(item?.textEdit).toMatchObject({
            range: {
                start: source.textDocument.positionAt(sourceText.indexOf('./import-target.tni')),
                end: source.textDocument.positionAt(sourceText.indexOf('./import-target.tni') + './import-target.tni'.length)
            }
        });
    });

    test('offers the synthetic result root in specification completion', async () => {
        const root = await build(`bounded context Ordering
in bounded context Ordering {
    data object PlaceOrderResult { orderId: string }
    application service OrderApplication {
        method placeOrder() returns PlaceOrderResult {
            behavior "Use [[${marker}]]."
        }
    }
}`);
        const rootItem = root.completion?.items.find(item => item.label === 'result');
        expect(rootItem).toMatchObject({ kind: CompletionItemKind.Method });

        const typedRoot = await build(`bounded context Ordering
in bounded context Ordering {
    data object PlaceOrderResult { orderId: string }
    application service OrderApplication {
        method placeOrder() returns PlaceOrderResult {
            behavior "Use [[res${marker}]]."
        }
    }
}`);
        expect(typedRoot.completion?.items.map(item => item.label)).toContain('result');
    });

    test('links and completes enum values through command contract fields', async () => {
        const source = `bounded context Ordering
in bounded context Ordering {
    enum Status { Draft, Placed }
    data object CommandInput { status: Status }
    data object CommandResult { status: Status }
    application service OrderApplication {
        method place(input: CommandInput) returns CommandResult
        method pay() returns CommandResult
    }
}
actor Customer
journey Checkout {
    by Customer {
        invoke Ordering.OrderApplication.place
            with "Use [[input.status.Draft]]."
        invoke Ordering.OrderApplication.pay
            when "Use [[Ordering.OrderApplication.place.result.status.Placed]]."
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/journey-contract-enum.tni'), source
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

        expect(document.diagnostics?.filter(diagnostic =>
            diagnostic.severity === 1 && !String(diagnostic.code).startsWith('line-break-required')
        )).toEqual([]);
        const references = AstUtils.streamAst(document.parseResult.value)
            .flatMap(node => AstUtils.streamReferences(node).map(info => info.reference))
            .filter(isReference)
            .toArray();
        const enumValues = references.filter(reference => reference.ref?.$type === 'EnumValue');
        expect(enumValues.map(reference => reference.$refText)).toEqual(['Draft', 'Placed']);

        const inputOffset = source.indexOf('input.status.') + 'input.status.'.length;
        const inputCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(inputOffset)
        });
        expect(inputCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining(['Draft', 'Placed']));

        const priorResultOffset = source.indexOf('place.result.status.') + 'place.result.status.'.length;
        const priorResultCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(priorResultOffset)
        });
        expect(priorResultCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining(['Draft', 'Placed']));
    });

    test('offers exposes before module members but not after them', async () => {
        const emptyModule = await build(`bounded context Ordering
in bounded context Ordering {
    module Api {
        ${marker}
    }
}`);
        expect(emptyModule.completion?.items.map(item => item.label)).toContain('exposes');

        const afterMember = await build(`bounded context Ordering
in bounded context Ordering {
    module Api {
        value object Value { raw: string }
        ${marker}
    }
}`);
        expect(afterMember.completion?.items.map(item => item.label)).not.toContain('exposes');
    });

    test('filters exposure candidates to declarations owned by the module', async () => {
        const emptyExposure = await build(`bounded context Ordering
in bounded context Ordering {
    module Outer { value object Foreign { raw: string } }
    module Api {
        exposes ${marker}
        value object Owned { raw: string }
    }
}`);
        const emptyLabels = emptyExposure.completion?.items.map(item => item.label) ?? [];
        expect(emptyLabels).toContain('Owned');
        expect(emptyLabels).not.toContain('Foreign');

        const typedExposure = await build(`bounded context Ordering
in bounded context Ordering {
    module Outer { value object Foreign { raw: string } }
    module Api {
        exposes Outer${marker}
        value object Owned { raw: string }
    }
}`);
        const typedLabels = typedExposure.completion?.items.map(item => item.label) ?? [];
        expect(typedLabels).not.toContain('Outer');
        expect(typedLabels).not.toContain('Outer.Foreign');
    });

    test('collects only terminal type references from collection types', async () => {
        const source = `bounded context Ordering
in bounded context Ordering {
    module Shared { value object Money { amount: number } }
    data object Quote {
        direct: Shared.Money
        collection: List<Shared.Money>
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/collection-type-references.tni'), source
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const quote = AstUtils.streamAst(document.parseResult.value).filter(isField).find(field => field.name === 'collection');
        expect(getTypeReferences(quote?.type, quote?.collection).map(reference => reference.$refText)).toEqual(['Money']);
    });
});
