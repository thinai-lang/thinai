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
        expect(identifierLabels).not.toContain('string');
        expect(identifierLabels).not.toContain('List');
        expect(identifierLabels).not.toContain('Set');
        expect(identifierLabels).not.toContain('Map');
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
