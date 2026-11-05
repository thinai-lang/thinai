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
        value object Money { amount: decimal }
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

    test('completes canonical specification fields through a field type', async () => {
        const nested = await build(`bounded context Shop
in bounded context Shop {
    value object Address {
        city: string
    }
    data object Dto {
        address: Address
    }
    application service App {
        method handle() {
            behavior "[[Shop.Dto.address.${marker}]]."
        }
    }
}`);
        expect(nested.completion?.items.map(item => item.label)).toContain('city');

        const parameter = await build(`bounded context Shop
in bounded context Shop {
    value object Address {
        city: string
    }
    data object Dto {
        address: Address
    }
    application service App {
        method handle(input: Dto) {
            behavior "[[input.${marker}]]."
        }
    }
}`);
        const addressItem = parameter.completion?.items.find(item => item.label === 'address');
        expect(addressItem?.textEdit?.newText).toBe('address.');
    });

    test('completes entity fields from specification result and parameter roots', async () => {
        const result = await build(`bounded context Shop
in bounded context Shop {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
            status: OrderStatus
            method check() returns Order {
                behavior "[[result.${marker}]]."
            }
        }
        value object OrderId {
            raw: string
        }
        enum OrderStatus {
            Draft,
            Done
        }
    }
}`);
        expect(result.completion?.items.map(item => item.label)).toContain('status');

        const parameter = await build(`bounded context Shop
in bounded context Shop {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
            status: OrderStatus
        }
        value object OrderId {
            raw: string
        }
        enum OrderStatus {
            Draft,
            Done
        }
    }
    domain service Policy {
        method inspect(order: Order.Order) {
            behavior "[[order.${marker}]]."
        }
    }
}`);
        expect(parameter.completion?.items.map(item => item.label)).toContain('status');
    });

    test('completes canonical nested journey event fields', async () => {
        const journey = await build(`bounded context Shop
in bounded context Shop {
    value object Address {
        city: string
    }
    module Contracts {
        exposes E, Address
        integration event E {
            address: Address
        }
    }
    application service App {
        method run() {}
    }
}
actor User
journey CheckEvent {
    by User {
        invoke Shop.App.run
            when "[[Shop.Contracts.E.address.${marker}]]."
    }
}`);
        expect(journey.completion?.items.map(item => item.label)).toContain('city');
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

    test('does not offer an already imported file or component again', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-duplicate-target.tni'),
            'bounded context Alpha\nbounded context Beta'
        );
        const pathText = `import "./import-duplicate-target.tni"
import "${marker}"
bounded context Consumer`;
        const pathOffset = pathText.indexOf(marker);
        const pathDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-duplicate-path.tni'), pathText.replace(marker, '')
        );
        documents.push(target, pathDocument);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });
        const pathCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(pathDocument, {
            textDocument: { uri: pathDocument.uri.toString() },
            position: pathDocument.textDocument.positionAt(pathOffset)
        });
        expect(pathCompletion?.items.map(item => item.label)).not.toContain('./import-duplicate-target.tni');

        const componentText = `import { Alpha } from "./import-duplicate-target.tni"
import { ${marker} } from "./import-duplicate-target.tni"
bounded context Consumer`;
        const componentOffset = componentText.indexOf(marker);
        const componentDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-duplicate-component.tni'), componentText.replace(marker, '')
        );
        documents.push(componentDocument);
        await services.shared.workspace.DocumentBuilder.build([componentDocument], { validation: false });
        const componentCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(componentDocument, {
            textDocument: { uri: componentDocument.uri.toString() },
            position: componentDocument.textDocument.positionAt(componentOffset)
        });
        const labels = componentCompletion?.items.map(item => item.label) ?? [];
        expect(labels).not.toContain('Alpha');
        expect(labels).not.toContain('actor');
        expect(labels).not.toContain('journey');
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

    test('appends a continuation dot for a non-journey structural specification root', async () => {
        const result = await build(`bounded context Ordering
in bounded context Ordering {
    module Api {
        value object Money { amount: decimal }
    }
    application service App {
        method run() {
            behavior "Use [[${marker}]]."
        }
    }
}`);
        const item = result.completion?.items.find(candidate => candidate.label === 'Ordering');
        expect(item?.textEdit?.newText ?? item?.insertText).toBe('Ordering.');
    });

    test('completes backtick-delimited names while the closing backtick is being typed', async () => {
        const result = await build(`bounded context Ordering
in bounded context Ordering {
    data object \`Order Result\` { raw: string }
    application service App {
        method run(input: \`Ord${marker})
    }
}`);
        expect(result.completion?.items.map(item => item.label)).toContain('Order Result');
    });

    test('the implicit result root wins over a colliding parameter in completion', async () => {
        const result = await build(`bounded context Ordering
in bounded context Ordering {
    data object Input { raw: string }
    data object Output { actualStatus: string }
    application service OrderApplication {
        method place(result: Input) returns Output {
            behavior "Use [[res${marker}]]."
        }
    }
}`);
        const resultItems = result.completion?.items.filter(item => item.label === 'result') ?? [];
        expect(resultItems).toHaveLength(1);
        expect(resultItems[0]?.kind).toBe(CompletionItemKind.Method);
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

    test('offers exposes before and after module members, but not twice', async () => {
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
        expect(afterMember.completion?.items.map(item => item.label)).toContain('exposes');

        const alreadyExposed = await build(`bounded context Ordering
in bounded context Ordering {
    module Api {
        exposes Value
        value object Value { raw: string }
        ${marker}
    }
}`);
        expect(alreadyExposed.completion?.items.map(item => item.label)).not.toContain('exposes');
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

    test('keeps exposure completion responses JSON-serializable', async () => {
        const result = await build(`bounded context O
in bounded context O {
    module M {
        exposes ${marker}
        value object V {
            raw: string
        }
    }
}`);
        expect(() => JSON.stringify(result.completion)).not.toThrow();
        const item = result.completion?.items.find(candidate => candidate.label === 'V');
        expect(item).toBeDefined();
        expect(item).not.toHaveProperty('nodeDescription');
    });

    test('completes Unicode declaration names', async () => {
        const result = await build(`bounded context ஆர்டர்
in bounded context ஆர்டர் {
    aggregate ஆர்டர் {
        root entity ஆர்டர் {
            identifier id: ஆர்டர்Id
            amount: ${marker}
        }
        value object ஆர்டர்Id {
            raw: string
        }
    }
}`);
        const labels = result.completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('ஆர்டர்Id');
    });

    test('does not offer an already exposed declaration again', async () => {
        const afterComma = await build(`bounded context Ordering
in bounded context Ordering {
    module Api {
        exposes V, ${marker}
        value object V { raw: string }
        value object W { raw: string }
        value object U { raw: string }
    }
}`);
        const afterCommaLabels = afterComma.completion?.items.map(item => item.label) ?? [];
        expect(afterCommaLabels).toContain('W');
        expect(afterCommaLabels).toContain('U');
        expect(afterCommaLabels).not.toContain('V');

        const exactCurrent = await build(`bounded context Ordering
in bounded context Ordering {
    module Api {
        exposes V, W${marker}
        value object V { raw: string }
        value object W { raw: string }
        value object Weekly { raw: string }
    }
}`);
        const exactLabels = exactCurrent.completion?.items.map(item => item.label) ?? [];
        expect(exactLabels).not.toContain('W');
        expect(exactLabels).not.toContain('V');
        expect(exactLabels).toContain('Weekly');
    });

    test('offers exposed sibling-module integration-event payload types', async () => {
        const completion = await build(`bounded context O
in bounded context O {
    module Types {
        exposes Payload
        value object Payload { raw: string }
    }
    module Contracts depends on Types {
        exposes OrderPlacedV1
        integration event OrderPlacedV1 { payload: ${marker} }
    }
}`);
        expect(completion.completion?.items.map(item => item.label)).toContain('Payload');
    });

    test('inserts quoted identifiers for reserved-word names', async () => {
        const quotedValue = '`value`';
        const completion = await build(`bounded context O
in bounded context O {
    data object D {
        ${quotedValue}: string
    }
    application service S {
        method run(input: D) {
            behavior "Use [[input.${marker}]]."
        }
    }
}`);
        const item = completion.completion?.items.find(candidate => candidate.label === 'value');
        expect(item).toBeDefined();
        expect(item?.textEdit?.newText ?? item?.insertText).toBe(quotedValue);
    });

    test('filters entity and DataObject types for restricted signatures', async () => {
        const factory = await build(`bounded context O
in bounded context O {
    aggregate A { root entity E { identifier id: Id } value object Id { raw: string } }
    data object Input { raw: string }
    factory F { method create(arg: ${marker}) returns A.E }
}`);
        const factoryLabels = factory.completion?.items.map(item => item.label) ?? [];
        expect(factoryLabels).not.toContain('E');
        expect(factoryLabels).not.toContain('A.E');
        expect(factoryLabels).not.toContain('Input');

        const valueObjectMethod = await build(`bounded context O
in bounded context O {
    aggregate A { root entity E { identifier id: Id } value object Id { raw: string } }
    data object Input { raw: string }
    value object V {
        raw: string
        method use(arg: ${marker})
    }
}`);
        const valueObjectMethodLabels = valueObjectMethod.completion?.items.map(item => item.label) ?? [];
        expect(valueObjectMethodLabels).not.toContain('E');
        expect(valueObjectMethodLabels).not.toContain('Input');

        const valueObjectReturn = await build(`bounded context O
in bounded context O {
    aggregate A { root entity E { identifier id: Id } value object Id { raw: string } }
    data object Input { raw: string }
    value object V {
        raw: string
        method create() returns ${marker}
    }
}`);
        const valueObjectReturnLabels = valueObjectReturn.completion?.items.map(item => item.label) ?? [];
        expect(valueObjectReturnLabels).not.toContain('E');
        expect(valueObjectReturnLabels).not.toContain('Input');

        const entityMethod = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            method use(arg: ${marker})
            identifier id: Id
        }
        value object Id { raw: string }
    }
    data object Input { raw: string }
}`);
        expect(entityMethod.completion?.items.map(item => item.label)).not.toContain('Input');

        const entityReturn = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            method create() returns ${marker}
            identifier id: Id
        }
        value object Id { raw: string }
    }
    data object Input { raw: string }
}`);
        expect(entityReturn.completion?.items.map(item => item.label)).not.toContain('Input');

        const aggregateValueObjectMethod = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E { identifier id: Id }
        value object Id { raw: string }
        value object V {
            raw: string
            method use(arg: ${marker})
        }
    }
    data object Input { raw: string }
}`);
        expect(aggregateValueObjectMethod.completion?.items.map(item => item.label)).not.toContain('Input');

        const aggregateValueObjectReturn = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E { identifier id: Id }
        value object Id { raw: string }
        value object V {
            raw: string
            method create() returns ${marker}
        }
    }
    data object Input { raw: string }
}`);
        expect(aggregateValueObjectReturn.completion?.items.map(item => item.label)).not.toContain('Input');

        const domainServiceParameter = await build(`bounded context O
in bounded context O {
    aggregate A { root entity E { identifier id: Id } value object Id { raw: string } }
    data object Input { raw: string }
    domain service D {
        method use(arg: ${marker}) returns string
    }
}`);
        const domainServiceParameterLabels = domainServiceParameter.completion?.items.map(item => item.label) ?? [];
        expect(domainServiceParameterLabels).not.toContain('Input');
        expect(domainServiceParameterLabels).toContain('E');
        expect(domainServiceParameterLabels.filter(label => label === 'E' || label === 'A.E')).toEqual(['E']);

        const domainServiceCollection = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E { identifier id: Id }
        value object Id { raw: string }
    }
    value object Holder { item: A.E }
    value object Money { amount: decimal }
    domain service D {
        method use(items: List<${marker}>) returns string
    }
}`);
        const domainServiceCollectionLabels = domainServiceCollection.completion?.items.map(item => item.label) ?? [];
        expect(domainServiceCollectionLabels).not.toContain('E');
        expect(domainServiceCollectionLabels).not.toContain('A.E');
        expect(domainServiceCollectionLabels).not.toContain('Holder');
        expect(domainServiceCollectionLabels).toContain('Money');

        const domainServiceReturn = await build(`bounded context O
in bounded context O {
    aggregate A { root entity E { identifier id: Id } value object Id { raw: string } }
    data object Input { raw: string }
    domain service D {
        method use(arg: string) returns ${marker}
    }
}`);
        expect(domainServiceReturn.completion?.items.map(item => item.label)).not.toContain('Input');
    });

    test('does not offer initial or identifier keywords outside their documented positions', async () => {
        for (const declaration of [
            'data object D { x: string',
            'read model R { x: string',
            'event E { x: string',
            'value object V { x: string'
        ]) {
            const completion = await build(`bounded context O
in bounded context O {
    ${declaration}
        ${marker}
    }
}`);
            expect(completion.completion?.items.map(item => item.label), declaration).not.toContain('initial');
        }

        const nonEnumField = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            identifier id: Id
            name: string
            ${marker}
        }
        value object Id { raw: string }
    }
}`);
        expect(nonEnumField.completion?.items.map(item => item.label)).not.toContain('initial');

        const duplicateIdentifier = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            identifier id: Id
            ${marker}
        }
        value object Id { raw: string }
    }
}`);
        expect(duplicateIdentifier.completion?.items.map(item => item.label)).not.toContain('identifier');

        const identifierType = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            identifier id: ${marker}
        }
        value object Id { raw: string }
    }
}`);
        const identifierLabels = identifierType.completion?.items.map(item => item.label) ?? [];
        expect(identifierLabels).toContain('Id');
        expect(identifierLabels).not.toContain('string');
        expect(identifierLabels).not.toContain('integer');
        expect(identifierLabels).not.toContain('decimal');
        expect(identifierLabels).not.toContain('List');
        expect(identifierLabels).not.toContain('Set');
        expect(identifierLabels).not.toContain('Map');
    });

    test('offers identifier completion from partial entity keyword prefixes', async () => {
        for (const prefix of ['id', 'iden', 'ident', 'identi']) {
            const result = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            ${prefix}${marker}
        }
        value object Id { raw: string }
    }
}`);
            const labels = result.completion?.items.map(item => item.label) ?? [];
            expect(labels, prefix).toContain('identifier');
            const identifierItem = result.completion?.items.find(item => item.label === 'identifier');
            expect(identifierItem?.detail, prefix)
                .toBe('Entity identifier; type must be a value object declared in the same aggregate.');
        }
    });

    test('does not offer identifier completion outside an entity or after it is declared', async () => {
        const contexts = [
            `aggregate A {
    value object V {
        ident${marker}
    }
}`,
            `data object D {
    ident${marker}
}`,
            `read model R {
    ident${marker}
}`
        ];
        for (const context of contexts) {
            const result = await build(`bounded context O
in bounded context O {
    ${context}
}`);
            expect(result.completion?.items.map(item => item.label), context).not.toContain('identifier');
        }

        const duplicate = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            identifier id: Id
            ident${marker}
        }
        value object Id { raw: string }
    }
}`);
        expect(duplicate.completion?.items.map(item => item.label)).not.toContain('identifier');
    });

    test('does not apply the identifier keyword hint to declared items named identifier', async () => {
        const result = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            identifier id: Id
            \`identifier\`: Status
            method run() {
                transition ${marker}
            }
        }
        value object Id { raw: string }
        enum Status { One, Two }
    }
}`);
        const field = result.completion?.items.find(item => item.label === 'identifier');
        expect(field?.kind).toBe(CompletionItemKind.Field);
        expect(field?.detail).toContain('Field ');
        expect(field?.detail).not.toContain('Entity identifier');
    });

    test('filters primitive types for identifier fields split across lines', async () => {
        for (const source of [
            `bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            identifier
            id: ${marker}
        }
        value object Id { raw: string }
    }
}`,
            `bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            identifier id:
                ${marker}
        }
        value object Id { raw: string }
    }
}`
        ]) {
            const result = await build(source);
            const labels = result.completion?.items.map(item => item.label) ?? [];
            expect(labels).toContain('Id');
            for (const primitive of ['string', 'boolean', 'integer', 'decimal', 'date', 'time', 'instant', 'List', 'Set', 'Map']) {
                expect(labels, primitive).not.toContain(primitive);
            }
        }
    });

    test('keeps type completion for unrelated fields after an incomplete identifier field', async () => {
        const result = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            identifier id:
        }
        value object Id { raw: string }
    }
    data object D {
        amount: ${marker}
    }
}`);
        const labels = result.completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('string');
        expect(labels).toContain('integer');
        expect(labels).toContain('decimal');
        expect(labels).toContain('Id');
    });

    test('does not offer values already selected in list contexts', async () => {
        const dependency = await build(`bounded context O
in bounded context O {
    module A {}
    module B depends on A, ${marker} {}
}`);
        expect(dependency.completion?.items.map(item => item.label)).not.toEqual(
            expect.arrayContaining(['A', 'O.A'])
        );

        const exposures = await build(`bounded context O
in bounded context O {
    module Api {
        exposes Foo
        exposes ${marker}
        value object Foo { raw: string }
        value object Bar { raw: string }
    }
}`);
        expect(exposures.completion?.items.map(item => item.label)).not.toEqual(
            expect.arrayContaining(['Foo', 'O.Api.Foo', 'Api.Foo'])
        );

        const emissions = await build(`bounded context O
in bounded context O {
    aggregate A {
        root entity E {
            identifier id: Id
            method run() { emits E1, ${marker} }
        }
        value object Id { raw: string }
        event E1
        event E2
    }
}`);
        expect(emissions.completion?.items.map(item => item.label)).not.toEqual(
            expect.arrayContaining(['E1', 'O.E1'])
        );

        const projects = await build(`bounded context O
in bounded context O {
    read model R1 { x: string }
    read model R2 { x: string }
    event E1
    projector P {
        method onE(source: E1) {
            projects R1, ${marker}
        }
    }
}`);
        expect(projects.completion?.items.map(item => item.label)).not.toEqual(
            expect.arrayContaining(['R1', 'O.R1'])
        );

        const reads = await build(`bounded context O
in bounded context O {
    aggregate A { root entity E { identifier id: Id } value object Id { raw: string } }
    aggregate B { root entity E { identifier id: Id } value object Id { raw: string } }
    repository R1 { manages A.E }
    repository R2 { manages B.E }
    application service S {
        method run() {
            reads from R1, ${marker}
        }
    }
}`);
        expect(reads.completion?.items.map(item => item.label)).not.toEqual(
            expect.arrayContaining(['R1', 'O.R1'])
        );
    });

    test('completes aggregate containers in published query contract paths', async () => {
        const completion = await build(`bounded context P
in bounded context P {
    aggregate Order {
        root entity Order { identifier id: OrderId }
        value object OrderId { raw: string }
    }
    data object OrderDto {
        orderId: OrderId
    }
    module Api {
        exposes Queries
        query service Queries {
            method find() returns OrderDto
        }
    }
}
bounded context C
in bounded context C {
    application service App {
        method run() {
            reads from P.Api.Queries.find
            behavior "Use [[P.${marker}]]."
        }
    }
}
context map M { customer C -> supplier P }`);
        const item = completion.completion?.items.find(candidate => candidate.label === 'Order');
        expect(item).toBeDefined();
        expect(item?.textEdit?.newText).toBe('Order.');
    });

    test('does not offer private query service containers in journeys', async () => {
        const completion = await build(`bounded context C
in bounded context C {
    data object Result {
        status: string
    }
    module Internal {
        exposes Visible
        query service Hidden {
            method find() returns Result
        }
        query service Visible {
            method find() returns Result
        }
    }
    application service App {
        method run()
    }
}
actor Customer
journey J {
    by Customer {
        invoke C.App.run when "[[C.Internal.${marker}]]"
    }
}`);
        const labels = completion.completion?.items.map(item => item.label) ?? [];
        expect(labels).not.toContain('Hidden');
        expect(labels).toContain('Visible');
    });

    test('does not offer a reserved result parameter as a completion', async () => {
        const completion = await build(`bounded context C
in bounded context C {
    application service App {
        method run(result: string) {
            behavior "Use [[res${marker}]]."
        }
    }
}`);
        expect(completion.completion?.items.map(item => item.label) ?? []).not.toContain('result');
    });

    test('completes specification references inside single-quoted text', async () => {
        const completion = await build(`bounded context C
in bounded context C {
    data object D {
        payload: string
    }
    application service App {
        method run(input: D) {
            behavior 'Use [[inp${marker}]]'
        }
    }
}`);
        expect(completion.completion?.items.map(item => item.label) ?? []).toContain('input');
    });

    test('triggers completion for single-quoted strings', async () => {
        expect(services.Thinai.lsp.CompletionProvider?.completionOptions?.triggerCharacters)
            .toContain("'");
    });

    test('offers published query result value-object and enum references', async () => {
        const model = `bounded context Api
bounded context Consumer
in bounded context Api {
    module Contracts {
        exposes Status, Address, Result
        enum Status { Ready, Done }
        value object Address { city: string }
        data object Result { status: Status address: Address }
    }
    module Services depends on Contracts {
        exposes Queries
        query service Queries { method find() returns Result }
    }
}
in bounded context Consumer {
    application service App {
        method use() {
            reads from Api.Services.Queries.find
            behavior "Use [[Api.Contracts.${marker}]] and [[Api.Contracts.Status.Ready]]."
        }
    }
}
context map M { customer Consumer -> supplier Api }`;

        const contract = await build(model);
        const contractLabels = contract.completion?.items.map(item => item.label) ?? [];
        expect(contractLabels).toEqual(expect.arrayContaining(['Address', 'Status', 'Result']));

        const enumModel = model.replace(
            `Api.Contracts.${marker}`,
            `Api.Contracts.Status.${marker}`
        );
        const enumCompletion = await build(enumModel);
        expect(enumCompletion.completion?.items.map(item => item.label)).toContain('Ready');
    });

    test('collects only terminal type references from collection types', async () => {
        const source = `bounded context Ordering
in bounded context Ordering {
    module Shared { value object Money { amount: decimal } }
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
    test('keeps comma lists incomplete instead of offering sibling declarations', async () => {
        const emissions = await build(`bounded context C
in bounded context C {
    event A
    event B
    aggregate X {
        root entity X {
            method run() {
                emits A,
                ${marker}
            }
            identifier id: Id
        }
        value object Id { raw: string }
    }
}`);
        const emissionLabels = emissions.completion?.items.map(item => item.label) ?? [];
        expect(emissionLabels).toContain('B');
        expect(emissionLabels).not.toContain('invariant');
        expect(emissionLabels).not.toContain('behavior');
        expect(emissionLabels).not.toContain('emits');

        const transition = await build(`bounded context C
in bounded context C {
    aggregate A {
        root entity E {
            method run() {
                transition status from Draft to
                ${marker}
            }
            identifier id: Id
            status: S
        }
        value object Id { raw: string }
        enum S { Draft, Placed }
    }
}`);
        const transitionLabels = transition.completion?.items.map(item => item.label) ?? [];
        expect(transitionLabels).toContain('Placed');
        expect(transitionLabels).not.toContain('invariant');
        expect(transitionLabels).not.toContain('emits');

        const reads = await build(`bounded context C
in bounded context C {
    aggregate A { root entity E { identifier id: Id } value object Id { raw: string } }
    aggregate B { root entity E { identifier id: Id } value object Id { raw: string } }
    repository R1 { manages A.E }
    repository R2 { manages B.E }
    application service S {
        method run() {
            reads from R1,
            ${marker}
        }
    }
}`);
        const readLabels = reads.completion?.items.map(item => item.label) ?? [];
        expect(readLabels).toContain('R2');
        expect(readLabels).not.toContain('R1');
        expect(readLabels).not.toContain('behavior');

        const projects = await build(`bounded context C
in bounded context C {
    read model M { x: string }
    read model N { y: string }
    event A
    projector P {
        method on(source: A) {
            projects M,
            ${marker}
        }
    }
}`);
        const projectLabels = projects.completion?.items.map(item => item.label) ?? [];
        expect(projectLabels).toContain('N');
        expect(projectLabels).not.toContain('method');

        const realizes = await build(`subdomain A
subdomain B
bounded context C realizes A,
${marker}
`);
        const realizeLabels = realizes.completion?.items.map(item => item.label) ?? [];
        expect(realizeLabels).toContain('B');
        expect(realizeLabels).not.toContain('bounded context');

        const dependencies = await build(`bounded context C
in bounded context C {
    module A { value object X { raw: string } }
    module B { value object Y { raw: string } }
    module D depends on A,
    ${marker}
    { value object Z { raw: string } }
}`);
        const dependencyLabels = dependencies.completion?.items.map(item => item.label) ?? [];
        expect(dependencyLabels).toContain('B');
        expect(dependencyLabels).not.toContain('value object');
    });

    test('keeps completed guard-bearing clauses and their siblings available', async () => {
        const emissions = await build(`bounded context C
in bounded context C {
    event A
    aggregate X {
        root entity X {
            method run() {
                emits A
                ${marker}
            }
            identifier id: Id
        }
        value object Id { raw: string }
    }
}`);
        const emissionLabels = emissions.completion?.items.map(item => item.label) ?? [];
        expect(emissionLabels).toEqual(expect.arrayContaining(['when', 'invariant', 'behavior', 'invokes']));

        const reads = await build(`bounded context C
in bounded context C {
    aggregate A { root entity E { identifier id: Id } value object Id { raw: string } }
    repository R { manages A.E }
    application service S {
        method run() {
            reads from R
            ${marker}
        }
    }
}`);
        const readLabels = reads.completion?.items.map(item => item.label) ?? [];
        expect(readLabels).toEqual(expect.arrayContaining(['when', 'behavior', 'invokes', 'reads from']));
    });

    test('completes journey path containers as path prefixes, not terminals', async () => {
        const journey = await build(`bounded context Ordering
in bounded context Ordering {
    module Contracts {
        exposes Result
        data object Result { status: string }
    }
    application service App { method place() returns Contracts.Result }
    read model Summary { total: decimal }
    query service Queries { method find() returns Summary }
}
actor Customer
journey J {
    by Customer {
        invoke Ordering.App.place with "[[${marker}]]"
    }
}`);
        const items = journey.completion?.items ?? [];
        const context = items.find(item => item.label === 'Ordering');
        const service = items.find(item => item.label === 'App');
        const readModel = items.find(item => item.label === 'Summary');
        expect(context?.textEdit?.newText).toBe('Ordering.');
        expect(service?.textEdit?.newText).toBe('App.');
        expect(readModel?.textEdit?.newText).toBe('Summary');
    });

    test('does not offer private nested module segments or members', async () => {
        const closed = await build(`bounded context C
in bounded context C {
    module Outer {
        module Inner {
            exposes V
            value object V { raw: string }
        }
    }
    data object D { payload: C.Outer.${marker} }
}`);
        expect(closed.completion?.items.map(item => item.label)).not.toContain('Inner');

        const exposed = await build(`bounded context C2
in bounded context C2 {
    module Outer {
        exposes Inner
        module Inner {
            exposes V
            value object V { raw: string }
        }
    }
    data object D { payload: C2.Outer.${marker} }
}`);
        expect(exposed.completion?.items.map(item => item.label)).toContain('Inner');

        const hiddenRoot = await build(`bounded context C3
in bounded context C3 {
    module Outer {
        module Inner {
            exposes V
            value object V { raw: string }
        }
    }
    data object D { payload: ${marker} }
}`);
        expect(hiddenRoot.completion?.items.map(item => item.label)).not.toContain('V');
    });

    test('does not complete private query result paths in journeys', async () => {
        const privateQuery = await build(`bounded context C
in bounded context C {
    data object Result { status: string }
    module Internal {
        query service Hidden { method find() returns Result }
    }
    application service App { method run() }
}
actor Customer
journey J {
    by Customer {
        invoke C.App.run when "[[C.Internal.Hidden.find.${marker}]]"
    }
}`);
        const labels = privateQuery.completion?.items.map(item => item.label) ?? [];
        expect(labels).not.toContain('result');
        expect(labels).not.toContain('status');
    });

    test('completes published aggregate-owned contract types through their canonical path', async () => {
        const aggregatePath = await build(`bounded context P
in bounded context P {
    aggregate Order {
        root entity Order { identifier id: OrderId }
        value object OrderId { raw: string }
    }
    data object OrderDto { orderId: OrderId }
    module Api {
        exposes Queries
        query service Queries { method find() returns OrderDto }
    }
}
bounded context C
in bounded context C {
    application service App {
        method run() {
            reads from P.Api.Queries.find
            behavior "Use [[P.Order.${marker}]]."
        }
    }
}
context map M { customer C -> supplier P }`);
        expect(aggregatePath.completion?.items.map(item => item.label)).toContain('OrderId');
    });

    test('completes authorized integration-event payload shapes outside event handlers', async () => {
        const payload = await build(`bounded context P
in bounded context P {
    value object OrderId { raw: string }
    integration event E { orderId: OrderId }
}
bounded context C
in bounded context C {
    application service App {
        method use() { behavior "Use [[P.E.orderId.${marker}]]." }
    }
}
context map M { customer C -> supplier P }`);
        expect(payload.completion?.items.map(item => item.label)).toContain('raw');
    });

    test('offers private nested module prefixes for authorized journey contracts', async () => {
        const currentInput = await build(`bounded context C
in bounded context C {
    module Outer {
        module Inner {
            data object RunInput { orderId: string }
            data object RunResult { accepted: boolean }
            application service App {
                method run(input: RunInput) returns RunResult
            }
        }
    }
}
actor Customer
journey J {
    by Customer {
        invoke C.Outer.Inner.App.run with "[[C.Outer.${marker}]]"
    }
}`);
        expect(currentInput.completion?.items.map(item => item.label)).toContain('Inner');

        const priorResult = await build(`bounded context C2
in bounded context C2 {
    module Outer {
        module Inner {
            data object Result { status: string }
        }
    }
    application service App {
        method place() returns Outer.Inner.Result
        method pay()
    }
}
actor Customer
journey J2 {
    by Customer {
        invoke C2.App.place
        invoke C2.App.pay when "[[C2.Outer.${marker}]]"
    }
}`);
        expect(priorResult.completion?.items.map(item => item.label)).toContain('Inner');
    });

    test('still hides private nested module prefixes without a contract terminal', async () => {
        const noContract = await build(`bounded context C
in bounded context C {
    module Outer {
        module Inner {
            exposes V
            value object V { raw: string }
        }
    }
    application service App {
        method run() { behavior "[[C.Outer.${marker}]]" }
    }
}`);
        expect(noContract.completion?.items.map(item => item.label)).not.toContain('Inner');
    });

    test('offers private nested module prefixes for published query contracts', async () => {
        const published = await build(`bounded context P
in bounded context P {
    module Outer {
        module Inner {
            exposes Result
            data object Result { status: string }
        }
    }
    module Api depends on Inner {
        exposes Queries
        query service Queries { method find() returns Outer.Inner.Result }
    }
}
bounded context C
in bounded context C {
    application service App {
        method use() {
            reads from P.Api.Queries.find
            behavior "[[P.Outer.${marker}]]"
        }
    }
}
context map M { customer C -> supplier P }`);
        expect(published.completion?.items.map(item => item.label)).toContain('Inner');
    });

    test('completes prior command results under canonical and suffix spellings', async () => {
        const suffixFirst = await build(`bounded context C
in bounded context C {
    data object Result { status: string }
    application service App {
        method place() returns Result
        method pay()
    }
}
actor Customer
journey J {
    by Customer {
        invoke App.place
        invoke C.App.pay when "[[C.App.place.${marker}]]"
    }
}`);
        expect(suffixFirst.completion?.items.map(item => item.label)).toContain('result');

        const canonicalFirst = await build(`bounded context C2
in bounded context C2 {
    data object Result { status: string }
    application service App {
        method place() returns Result
        method pay()
    }
}
actor Customer
journey J2 {
    by Customer {
        invoke C2.App.place
        invoke C2.App.pay when "[[App.place.${marker}]]"
    }
}`);
        expect(canonicalFirst.completion?.items.map(item => item.label)).toContain('result');
    });

    test('completes integrationPatterns inside a context-map endpoint only once', async () => {
        for (const prefix of ['', 'int', 'integrationP']) {
            const endpoint = await build(`bounded context A
bounded context B
context map M {
    customer A {
        ${prefix}${marker}
    } -> supplier B
}`);
            expect(endpoint.completion?.items.map(item => item.label), prefix).toContain('integrationPatterns');
        }

        const afterPatterns = await build(`bounded context A
bounded context B
context map M {
    customer A {
        integrationPatterns: ["Conformist"]
        ${marker}
    } -> supplier B
}`);
        expect(afterPatterns.completion?.items.map(item => item.label)).not.toContain('integrationPatterns');
    });

    test('does not complete fields through private journey path segments', async () => {
        const privatePrefix = await build(`bounded context C
in bounded context C {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
            internal: Details
        }
        value object OrderId { raw: string }
        value object Details { publicField: string }
    }
    application service App { method run() }
}
actor Customer
journey J {
    by Customer {
        invoke C.App.run when "[[C.Order.Order.internal.${marker}]]"
    }
}`);
        expect(privatePrefix.completion?.items ?? []).toEqual([]);
    });

    test('applies recursive type-shape rules to completion candidates', async () => {
        const applicationParameter = await build(`bounded context C
in bounded context C {
    aggregate A {
        root entity E { identifier id: Id }
        value object Id { raw: string }
    }
    value object Wrapper { item: A.E }
    application service App {
        method run(input: ${marker})
    }
}`);
        expect(applicationParameter.completion?.items.map(item => item.label)).not.toContain('Wrapper');

        const domainEventPayload = await build(`bounded context C
in bounded context C {
    aggregate A {
        root entity E { identifier id: Id }
        value object Id { raw: string }
    }
    value object Wrapper { item: A.E }
    event E1 { payload: ${marker} }
}`);
        expect(domainEventPayload.completion?.items.map(item => item.label)).not.toContain('Wrapper');

        const integrationEventPayload = await build(`bounded context C
in bounded context C {
    module Internal {
        value object Payload { raw: string }
    }
    integration event E1 { payload: ${marker} }
}`);
        expect(integrationEventPayload.completion?.items.map(item => item.label)).not.toContain('Payload');
    });

    test('appends a dot when the selected read-source segment is not a valid terminal', async () => {
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/path-dot-contexts.tni'),
            'bounded context P bounded context C'
        );
        const catalog = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/path-dot-catalog.tni'),
            `import "./path-dot-contexts.tni"
in bounded context P {
    module Api {
        exposes Queries, Info
        data object Info { ok: boolean }
        query service Queries { method find() returns Info }
    }
}`
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/path-dot-map.tni'),
            `import "./path-dot-contexts.tni"
context map M { customer C -> supplier P }`
        );
        const consumerText = `import "./path-dot-contexts.tni"
import "./path-dot-catalog.tni"
import { M } from "./path-dot-map.tni"
in bounded context C {
    application service App {
        method run() {
            reads from P.Api.${marker}
        }
    }
}`;
        const offset = consumerText.indexOf(marker);
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/path-dot-consumer.tni'), consumerText.replace(marker, '')
        );
        documents.push(contexts, catalog, contextMap, consumer);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        const queryService = completion?.items.find(item => item.label === 'Queries');
        expect(queryService?.textEdit?.newText).toBe('Queries.');
    });

    test('requires a shared-kernel relationship for non-journey shared-kernel prefixes', async () => {
        const common = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-prefix-common.tni'),
            `shared kernel Common {
    module Private {
        exposes Code
        value object Code { raw: string }
    }
}`
        );
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-prefix-contexts.tni'),
            'bounded context A bounded context B'
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-prefix-map.tni'),
            `import "./shared-prefix-common.tni"
import "./shared-prefix-contexts.tni"
context map M { sharedKernel Common { participants: [A, B] } }`
        );
        const text = `import "./shared-prefix-contexts.tni"
import { Common } from "./shared-prefix-common.tni"
import { M } from "./shared-prefix-map.tni"
in bounded context A {
    application service App {
        method run() {
            behavior "Use [[Common.${marker}]]."
        }
    }
}`;
        const offset = text.indexOf(marker);
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-prefix-consumer.tni'), text.replace(marker, '')
        );
        documents.push(common, contexts, contextMap, consumer);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        expect(completion?.items.map(item => item.label)).toContain('Private');

        const unrelatedText = `import "./shared-prefix-contexts.tni"
import { Common } from "./shared-prefix-common.tni"
in bounded context B {
    application service App {
        method run() {
            behavior "Use [[Common.${marker}]]."
        }
    }
}`;
        const unrelatedOffset = unrelatedText.indexOf(marker);
        const unrelated = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-prefix-unrelated.tni'), unrelatedText.replace(marker, '')
        );
        documents.push(unrelated);
        await services.shared.workspace.DocumentBuilder.build([unrelated], { validation: false });

        const withoutRelationship = await services.Thinai.lsp.CompletionProvider?.getCompletion(unrelated, {
            textDocument: { uri: unrelated.uri.toString() },
            position: unrelated.textDocument.positionAt(unrelatedOffset)
        });
        expect(withoutRelationship?.items.map(item => item.label)).not.toContain('Private');
    });

    test('does not continue into qualified top-level declaration paths', async () => {
        const cases = [
            `subdomain Marketing
bounded context Ordering
bounded context Shipping
in bounded context Ordering.${marker}`,
            `subdomain Marketing
bounded context Ordering
bounded context Billing realizes Ordering.${marker}`,
            `bounded context Ordering
bounded context Shipping
context map M { customer Ordering.${marker} }`,
            `bounded context Ordering
bounded context Shipping
context map M { customer Ordering.${marker} -> supplier Shipping }`,
            `bounded context Ordering
bounded context Shipping
context map M { customer Ordering -> supplier Shipping.${marker} }`,
            `bounded context Ordering
bounded context Shipping
context map M { partner Ordering.${marker} }`,
            `bounded context Ordering
bounded context Shipping
context map M { separateWays Ordering.${marker} -x- Shipping }`,
            `bounded context Ordering
bounded context Shipping
context map M { separateWays Ordering -x- Shipping.${marker} }`,
            `shared kernel Common
bounded context Ordering
context map M { sharedKernel Common.${marker} { participants: [Ordering] } }`,
            `bounded context Ordering
bounded context Shipping
context map M { sharedKernel Common { participants: [Ordering.${marker}, Shipping] } }`
        ];
        for (const [index, source] of cases.entries()) {
            const completion = await build(source);
            expect(completion.completion?.items ?? [], `case ${index}`).toEqual([]);
        }
    });

    test('keeps terminal completion for top-level declarations and participants', async () => {
        const realizes = await build(`subdomain Marketing
bounded context Billing realizes ${marker}`);
        expect(realizes.completion?.items.map(item => item.label)).toContain('Marketing');

        const customer = await build(`bounded context Ordering
bounded context Shipping
context map M { customer ${marker} -> supplier Shipping }`);
        expect(customer.completion?.items.map(item => item.label)).toContain('Ordering');

        const sharedKernel = await build(`shared kernel Common
bounded context Ordering
context map M { sharedKernel ${marker} { participants: [Ordering] } }`);
        expect(sharedKernel.completion?.items.map(item => item.label)).toContain('Common');

        const participant = await build(`bounded context Ordering
bounded context Shipping
shared kernel Common
context map M { sharedKernel Common { participants: [${marker}, Shipping] } }`);
        expect(participant.completion?.items.map(item => item.label)).toContain('Ordering');
    });

    test('does not offer member declaration continuations at model scope', async () => {
        const cases: Array<[string, string]> = [
            ['value', 'object'],
            ['application', 'service'],
            ['integration', 'event'],
            ['query', 'repository'],
            ['query', 'service'],
            ['data', 'object'],
            ['read', 'model'],
            ['domain', 'service']
        ];
        for (const [base, continuation] of cases) {
            const result = await build(`bounded context C
${base} ${marker}`);
            expect(
                result.completion?.items.map(item => item.label) ?? [],
                `${base} at model scope`
            ).not.toContain(continuation);
        }

        const valid = await build(`bounded context C
in bounded context C {
    value ${marker}
}`);
        expect(valid.completion?.items.map(item => item.label)).toContain('object');
    });

    test('completes transition from and to on a new line', async () => {
        const from = await build(`bounded context C
in bounded context C {
    aggregate A {
        root entity E {
            method run() {
                transition status from Draft to Placed,
                    status fr${marker}
            }
            identifier id: Id
            status: S
        }
        value object Id { raw: string }
        enum S { Draft, Placed }
    }
}`);
        const fromLabels = from.completion?.items.map(item => item.label) ?? [];
        expect(fromLabels).toContain('from');
        expect(fromLabels).not.toContain('invariant');
        expect(fromLabels).not.toContain('emits');

        const to = await build(`bounded context C
in bounded context C {
    aggregate A {
        root entity E {
            method run() {
                transition status from Draft to Placed,
                    status from Draft ${marker}
            }
            identifier id: Id
            status: S
        }
        value object Id { raw: string }
        enum S { Draft, Placed }
    }
}`);
        const toLabels = to.completion?.items.map(item => item.label) ?? [];
        expect(toLabels).toContain('to');
        expect(toLabels).not.toContain('invariant');
        expect(toLabels).not.toContain('emits');
    });

    test('treats a quoted transition-named field as a field, not the clause keyword', async () => {
        const from = await build(`bounded context C
in bounded context C {
    aggregate A {
        root entity E {
            identifier id: Id
            \`transition\`: S
            method run() {
                transition \`transition\` ${marker}
            }
        }
        value object Id { raw: string }
        enum S { Open, Closed }
    }
}`);
        expect(from.completion?.items.map(item => item.label)).toContain('from');

        const to = await build(`bounded context C
in bounded context C {
    aggregate A {
        root entity E {
            identifier id: Id
            \`transition\`: S
            method run() {
                transition \`transition\` from Open ${marker}
            }
        }
        value object Id { raw: string }
        enum S { Open, Closed }
    }
}`);
        expect(to.completion?.items.map(item => item.label)).toContain('to');
    });

    test('does not continue a header with an unrelated declaration keyword', async () => {
        const cases: Array<[source: string, forbidden: string]> = [
            [`bounded context A\nactor Rea${marker}`, 'realizes'],
            [`subdomain A\nactor Kin${marker}`, 'kind'],
            [`module Api\nactor Dep${marker}`, 'depends'],
            [`value object V\nactor Mir${marker}`, 'mirrors']
        ];
        for (const [source, forbidden] of cases) {
            const completion = await build(source);
            expect(completion.completion?.items.map(item => item.label), source).not.toContain(forbidden);
        }

        const moduleContinuation = await build(`bounded context O
in bounded context O {
    module Api
    dep${marker}
    { value object V { raw: string } }
}`);
        expect(moduleContinuation.completion?.items.map(item => item.label)).toContain('depends');
    });

    test('ignores incomplete statements in an unrelated block', async () => {
        const completion = await build(`bounded context C
in bounded context C {
    aggregate A {
        root entity A {
            identifier id: IdA
            broken:
        }
        value object IdA { raw: string }
    }
    aggregate B {
        root entity B {
            identifier id: IdB
            ${marker}
        }
        value object IdB { raw: string }
    }
}`);
        expect(completion.completion?.items.map(item => item.label)).toContain('method');
    });

    test('keeps context as a bounded-context continuation across a line break', async () => {
        for (const source of [
            `bounded\ncon${marker}`,
            `bounded context A\nin bounded\ncon${marker}`
        ]) {
            const completion = await build(source);
            const labels = completion.completion?.items.map(item => item.label) ?? [];
            expect(labels, source).toContain('context');
            expect(labels, source).not.toContain('context map');
        }
    });

    test('completes typed canonical paths and duplicate short names', async () => {
        const canonical = await build(`bounded context Ordering
in bounded context Ordering {
    module Contracts {
        exposes Money, Currency
        value object Money { amount: decimal }
        enum Currency { USD, EUR }
    }
    data object Quote { price: Co${marker} }
}`);
        const money = canonical.completion?.items.find(item => item.label === 'Contracts.Money');
        expect(money?.textEdit?.newText).toBe('Contracts.Money');

        const duplicates = await build(`bounded context C
in bounded context C {
    module M1 { exposes Id value object Id { raw: string } }
    module M2 { exposes Id value object Id { raw: string } }
    data object D { x: Id${marker} }
}`);
        const idItems = duplicates.completion?.items.filter(item => item.label === 'Id') ?? [];
        expect(idItems.map(item => item.textEdit?.newText).sort()).toEqual(['M1.Id', 'M2.Id']);
    });

    test('appends a continuation dot to typed parameter and result roots', async () => {
        const input = await build(`bounded context C
in bounded context C {
    data object D { status: string }
    application service S {
        method run(input: D) {
            behavior "Use [[inp${marker}]].\"
        }
    }
}`);
        expect(input.completion?.items.find(item => item.label === 'input')?.textEdit?.newText).toBe('input.');

        const result = await build(`bounded context C
in bounded context C {
    data object D { status: string }
    application service S {
        method run() returns D {
            behavior "Use [[res${marker}]].\"
        }
    }
}`);
        expect(result.completion?.items.find(item => item.label === 'result')?.textEdit?.newText).toBe('result.');
    });

    test('does not expand compound keywords inside unrelated blocks', async () => {
        const contextMap = await build(`bounded context A
bounded context B
context map M {
    context ${marker}
}`);
        expect(contextMap.completion?.items.map(item => item.label) ?? []).not.toContain('map');

        const entity = await build(`bounded context C
in bounded context C {
    aggregate A {
        root entity A {
            value ${marker}
        }
    }
}`);
        expect(entity.completion?.items.map(item => item.label) ?? []).not.toContain('object');

        const method = await build(`bounded context C
in bounded context C {
    application service S {
        method run() {
            query ${marker}
        }
    }
}`);
        expect(method.completion?.items.map(item => item.label) ?? [])
            .not.toEqual(expect.arrayContaining(['repository', 'service']));

        const shared = await build(`bounded context C
in bounded context C {
    application service S {
        method run() {
            shared ${marker}
        }
    }
}`);
        expect(shared.completion?.items.map(item => item.label) ?? []).not.toContain('kernel');
    });

    test('filters shared-kernel participants that conflict with separate ways', async () => {
        const conflict = await build(`bounded context A
bounded context B
shared kernel K {
    value object V { raw: string }
}
context map M {
    separateWays A -x- B
    sharedKernel K {
        participants: [A, ${marker}]
    }
}`, true);
        expect(conflict.completion?.items.map(item => item.label) ?? []).not.toContain('B');

        const compatible = await build(`bounded context A
bounded context B
shared kernel K {
    value object V { raw: string }
}
context map M {
    sharedKernel K {
        participants: [A, ${marker}]
    }
}`, true);
        expect(compatible.completion?.items.map(item => item.label) ?? []).toContain('B');
    });

    test('does not offer DataObjects for an extra event-handler parameter', async () => {
        const handler = await build(`bounded context C
in bounded context C {
    data object D { x: string }
    event E
    application service S {
        method handle(source: E, extra: ${marker}) {}
    }
}`, true);
        expect(handler.completion?.items.map(item => item.label) ?? []).not.toContain('D');
    });

    test('completes importable components when the import path follows the cursor', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-component-audit/target.tni'),
            `bounded context Ordering
in bounded context Ordering {
    value object V { raw: string }
}`
        );
        documents.push(target);
        await services.shared.workspace.DocumentBuilder.build([target], { validation: false });

        for (const [sourceText, expected] of [
            ['import { __completion_position__ } from "./target.tni"', true],
            ['import { Ord__completion_position__ } from "./target.tni"', true],
            ['import { Ordering, __completion_position__ } from "./target.tni"', false]
        ] as const) {
            const offset = sourceText.indexOf(marker);
            const text = sourceText.replace(marker, '');
            const consumer = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/import-component-audit/consumer-${fileIndex++}.tni`),
                text
            );
            documents.push(consumer);
            await services.shared.workspace.DocumentBuilder.build([consumer], { validation: false });
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
                textDocument: { uri: consumer.uri.toString() },
                position: consumer.textDocument.positionAt(offset)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            expect(labels.includes('Ordering'), sourceText).toBe(expected);
        }
    });

    test('offers a bare import quick fix for an unowned actor', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/actor-quickfix/target.tni'),
            `bounded context C
in bounded context C {
    value object V { raw: string }
}
actor Customer`
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/actor-quickfix/consumer.tni'),
            `import { C } from "./target.tni"
journey J {
    by Customer {
        invoke C.App.run
    }
}
in bounded context C {
    application service App {
        method run() {}
    }
}`
        );
        documents.push(target, consumer);
        await services.shared.workspace.DocumentBuilder.build([target, consumer], { validation: true });

        const diagnostic = consumer.diagnostics?.find(candidate =>
            candidate.severity === 1 && String(candidate.message).includes("Could not resolve reference to Actor named 'Customer'")
        );
        expect(diagnostic).toBeDefined();
        const actions = await Promise.resolve(services.Thinai.lsp.CodeActionProvider?.getCodeActions(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            range: diagnostic!.range,
            context: { diagnostics: consumer.diagnostics ?? [] }
        }));
        expect(actions?.map(action => action.title)).toContain("Import 'Customer' from './target.tni'");
    });

    test('replaces an existing list item instead of duplicating it', async () => {
        const result = await build(`bounded context C
in bounded context C {
    module Outer {
        exposes ${marker}Inner, PublicValue
        module Inner {
            value object InnerValue {
                raw: string
            }
        }
        value object PublicValue {
            raw: string
        }
    }
}`);
        const item = result.completion?.items.find(candidate => candidate.label === 'Inner');
        expect(item).toBeDefined();

        const edit = item!.textEdit;
        const range = edit && 'range' in edit ? edit.range : edit?.replace;
        expect(range).toBeDefined();
        const start = result.document.textDocument.offsetAt(range!.start);
        const end = result.document.textDocument.offsetAt(range!.end);
        const applied = result.text.slice(0, start) + (edit?.newText ?? '') + result.text.slice(end);
        const exposureLine = applied.split('\n').find(line => line.includes('exposes'));

        expect(exposureLine?.trim()).toBe('exposes Inner, PublicValue');
        expect(services.Thinai.parser.LangiumParser.parse(applied).parserErrors).toEqual([]);
    });

    test('replaces the complete backtick-quoted reference token', async () => {
        const result = await build(`bounded context Ordering
in bounded context Ordering {
    value object Adjustment {
        \`value\`: decimal
    }
    application service App {
        method run() {
            behavior "Use [[Adjustment.\`val${marker}ue\`]]."
        }
    }
}`);
        const item = result.completion?.items.find(candidate => candidate.label === 'value');
        expect(item).toBeDefined();

        const edit = item!.textEdit;
        const range = edit && 'range' in edit ? edit.range : edit?.replace;
        expect(range).toBeDefined();
        const start = result.document.textDocument.offsetAt(range!.start);
        const end = result.document.textDocument.offsetAt(range!.end);
        const applied = result.text.slice(0, start) + (edit?.newText ?? '') + result.text.slice(end);

        expect(applied).toContain('[[Adjustment.`value`]]');
        expect(services.Thinai.parser.LangiumParser.parse(applied).lexerErrors).toEqual([]);
        expect(services.Thinai.parser.LangiumParser.parse(applied).parserErrors).toEqual([]);
    });
});
