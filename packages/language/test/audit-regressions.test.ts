import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { createThinaiServices } from '../src/index.js';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

function addDocument(name: string, text: string): LangiumDocument {
    const document = services.shared.workspace.LangiumDocuments.createDocument(
        URI.file(`/workspace/${name}`),
        text
    );
    documents.push(document);
    return document;
}

async function buildFiles(files: Record<string, string>) {
    const built = new Map<string, LangiumDocument>();
    for (const [name, text] of Object.entries(files)) {
        built.set(name, addDocument(name, text));
    }
    await services.shared.workspace.DocumentBuilder.build([...built.values()], { validation: true });
    return built;
}

async function completionLabels(document: LangiumDocument, offset: number): Promise<string[]> {
    const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(offset)
    });
    return (completion?.items ?? []).map(item => String(item.label));
}

async function completionItems(document: LangiumDocument, offset: number) {
    const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(offset)
    });
    return completion?.items ?? [];
}

let markerSequence = 0;

async function labelsAt(source: string, marker: string): Promise<string[]> {
    const offset = source.indexOf(marker);
    const text = source.replace(marker, '');
    const built = addDocument(`marker-${markerSequence++}.tni`, text);
    await services.shared.workspace.DocumentBuilder.build([built], { validation: false });
    return completionLabels(built, offset);
}

function errors(document: LangiumDocument): string[] {
    return (document.diagnostics ?? [])
        .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
        .map(diagnostic => String(diagnostic.message));
}

const declarationKeywords = [
    'aggregate', 'application service', 'domain service', 'repository', 'query repository',
    'query service', 'projector', 'factory', 'value object', 'enum', 'read model',
    'data object', 'event', 'integration event', 'module'
];

describe('Audit regressions', () => {
    test('query repository completion does not treat a partial serves keyword as a served model', async () => {
        for (const prefix of ['', 's', 'se', 'ser', 'serv', 'serve']) {
            const source = `bounded context C
in bounded context C {
    read model Summary {
        total: decimal
    }
    query repository Q { ${prefix} }
}
`;
            const document = addDocument(`query-repository-${prefix || 'empty'}.tni`, source);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const offset = source.indexOf(`query repository Q { ${prefix}`) +
                `query repository Q { ${prefix}`.length;
            const labels = await completionLabels(document, offset);
            expect(labels, `prefix '${prefix}'`).toContain('serves');
            expect(labels, `prefix '${prefix}'`).not.toContain('reads from');
        }
    });

    test('query repository completion waits for a resolved served model before reads from', async () => {
        const partial = `bounded context C
in bounded context C {
    read model Summary {
        total: decimal
    }
    query repository Q { serves Summ }
}
`;
        const partialDocument = addDocument('query-repository-partial.tni', partial);
        await services.shared.workspace.DocumentBuilder.build([partialDocument], { validation: false });
        const partialOffset = partial.indexOf('serves Summ') + 'serves Summ'.length;
        const partialLabels = await completionLabels(partialDocument, partialOffset);
        expect(partialLabels).toContain('Summary');
        expect(partialLabels).not.toContain('reads from');

        const complete = partial.replace('serves Summ', 'serves Summary ');
        const completeDocument = addDocument('query-repository-complete.tni', complete);
        await services.shared.workspace.DocumentBuilder.build([completeDocument], { validation: false });
        const completeOffset = complete.indexOf('serves Summary ') + 'serves Summary '.length;
        const completeLabels = await completionLabels(completeDocument, completeOffset);
        expect(completeLabels).toContain('reads from');
    });

    test('terminal blocks do not offer unrelated declaration keywords', async () => {
        const enumSource = `bounded context C
in bounded context C {
    enum E { __POS__ }
}
`;
        const enumLabels = await labelsAt(enumSource, '__POS__');
        expect(enumLabels.some(label => declarationKeywords.includes(label))).toBe(false);

        const enumValueSource = `bounded context C
in bounded context C {
    enum E {
        A,
        __POS__
    }
}
`;
        const enumValueLabels = await labelsAt(enumValueSource, '__POS__');
        expect(enumValueLabels.some(label => declarationKeywords.includes(label))).toBe(false);

        const repositorySource = `bounded context C
in bounded context C {
    aggregate O {
        root entity O { identifier id: I }
        value object I { raw: string }
    }
    repository R {
        manages O.O
        __POS__
    }
}
`;
        const repositoryLabels = await labelsAt(repositorySource, '__POS__');
        expect(repositoryLabels.some(label => declarationKeywords.includes(label))).toBe(false);

        const endpointSource = `bounded context A
bounded context B
context map M {
    customer A {
        integrationPatterns: ["ACL"]
        __POS__
    } -> supplier B
}
`;
        const endpointLabels = await labelsAt(endpointSource, '__POS__');
        expect(endpointLabels.some(label => ['customer', 'partner', 'separateWays', 'sharedKernel'].includes(label))).toBe(false);

        const sharedKernelSource = `shared kernel K {
    value object V { raw: string }
}
bounded context A
bounded context B
context map M {
    sharedKernel K {
        participants: [A, B]
        __POS__
    }
}
`;
        const sharedKernelLabels = await labelsAt(sharedKernelSource, '__POS__');
        expect(sharedKernelLabels.some(label => ['customer', 'partner', 'separateWays', 'sharedKernel'].includes(label))).toBe(false);
    });

    test('quoted field and parameter names still receive type keyword completion', async () => {
        const fieldSource = `bounded context C
in bounded context C {
    value object V {
        \`value\`: __POS__
    }
}
`;
        const fieldDocument = addDocument('quoted-field.tni', fieldSource.replace('__POS__', ''));
        await services.shared.workspace.DocumentBuilder.build([fieldDocument], { validation: false });
        const fieldOffset = fieldSource.indexOf('`value`: ') + '`value`: '.length;
        const fieldLabels = await completionLabels(fieldDocument, fieldOffset);
        expect(fieldLabels).toEqual(expect.arrayContaining(['string', 'boolean', 'integer', 'decimal', 'date', 'time', 'instant', 'List', 'Set', 'Map']));
        expect(fieldLabels).not.toContain('constructor');
        expect(fieldLabels).not.toContain('method');

        const parameterSource = `bounded context C
in bounded context C {
    value object V { raw: string }
    application service S {
        method run(\`value\`: __POS__) {
        }
    }
}
`;
        const parameterDocument = addDocument('quoted-parameter.tni', parameterSource.replace('__POS__', ''));
        await services.shared.workspace.DocumentBuilder.build([parameterDocument], { validation: false });
        const parameterOffset = parameterSource.indexOf('`value`: ') + '`value`: '.length;
        const parameterLabels = await completionLabels(parameterDocument, parameterOffset);
        expect(parameterLabels).toEqual(expect.arrayContaining(['string', 'boolean', 'integer', 'decimal', 'List', 'Map', 'V']));
    });

    test('quoted path segments still receive invocation completion', async () => {
        const source = `bounded context C
in bounded context C {
    aggregate \`order\` {
        root entity Order {
            identifier id: Id
            method place() {
                behavior "Place."
            }
        }
        value object Id { raw: string }
    }
    application service S {
        method run() {
            invokes \`order\`.
        }
    }
}
`;
        const document = addDocument('quoted-invocation.tni', source);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const offset = source.indexOf('invokes `order`.') + 'invokes `order`.'.length;
        expect(await completionLabels(document, offset)).toContain('Order');
    });

    test('quoted transition fields and states still receive from/to completion', async () => {
        const source = `bounded context C
in bounded context C {
    aggregate A {
        root entity E {
            identifier id: Id
            \`value\`: S
            method run() {
                transition \`value\` from Open to Closed
            }
        }
        value object Id { raw: string }
        enum S { Open, Closed }
    }
}
`;
        const fromSource = source.replace('transition `value` from Open to Closed', 'transition `value` ');
        const fromDocument = addDocument('quoted-transition-from.tni', fromSource);
        await services.shared.workspace.DocumentBuilder.build([fromDocument], { validation: false });
        const fromOffset = fromSource.indexOf('transition `value` ') + 'transition `value` '.length;
        expect(await completionLabels(fromDocument, fromOffset)).toContain('from');

        const toSource = source.replace('transition `value` from Open to Closed', 'transition `value` from Open ');
        const toDocument = addDocument('quoted-transition-to.tni', toSource);
        await services.shared.workspace.DocumentBuilder.build([toDocument], { validation: false });
        const toOffset = toSource.indexOf('transition `value` from Open ') + 'transition `value` from Open '.length;
        expect(await completionLabels(toDocument, toOffset)).toContain('to');
    });

    test('quoted subdomain and context-map names still receive continuations', async () => {
        const subdomainSource = 'subdomain `order` kind ';
        const subdomainDocument = addDocument('quoted-subdomain.tni', subdomainSource);
        await services.shared.workspace.DocumentBuilder.build([subdomainDocument], { validation: false });
        expect(await completionLabels(subdomainDocument, subdomainSource.length))
            .toEqual(expect.arrayContaining(['core', 'supporting', 'generic']));

        const continuationSource = `bounded context \`C\`
bounded context D
context map M {
    customer \`C\` 
}
`;
        const continuationDocument = addDocument('quoted-map-continuation.tni', continuationSource);
        await services.shared.workspace.DocumentBuilder.build([continuationDocument], { validation: false });
        const continuationOffset = continuationSource.indexOf('customer `C` ') + 'customer `C` '.length;
        expect(await completionLabels(continuationDocument, continuationOffset)).toContain('-> supplier');

        const rightSource = `bounded context \`C\`
bounded context D
context map M {
    customer \`C\` -> supplier 
}
`;
        const rightDocument = addDocument('quoted-map-right.tni', rightSource);
        await services.shared.workspace.DocumentBuilder.build([rightDocument], { validation: false });
        const rightOffset = rightSource.indexOf('supplier ') + 'supplier '.length;
        expect(await completionLabels(rightDocument, rightOffset)).toContain('D');

        const patternSource = `bounded context \`C\`
bounded context D
context map M {
    customer \`C\` {
        
    } -> supplier D
}
`;
        const patternDocument = addDocument('quoted-map-patterns.tni', patternSource);
        await services.shared.workspace.DocumentBuilder.build([patternDocument], { validation: false });
        const patternOffset = patternSource.indexOf('customer `C` {') + 'customer `C` {'.length;
        expect(await completionLabels(patternDocument, patternOffset)).toContain('integrationPatterns');
    });

    test('integrations events offer context-level payload value objects and enums', async () => {
        const source = `bounded context C
in bounded context C {
    value object Info {
        raw: string
    }
    enum Category {
        A,
        B
    }
    integration event E {
        info: 
        category: Category
    }
}
`;
        const document = addDocument('integration-payload.tni', source);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const offset = source.indexOf('info: ') + 'info: '.length;
        const labels = await completionLabels(document, offset);
        expect(labels).toContain('Info');
        expect(labels).toContain('Category');
    });

    test('completion avoids a shadowed spelling that resolves to another declaration', async () => {
        const files = {
            'a.tni': `bounded context C
in bounded context C {
    module A {
        exposes X
        value object X {
            fromA: string
        }
    }
}
`,
            'b.tni': `import "./a.tni"
in bounded context C {
    module B {
    depends on A

        value object X {
            fromB: string
        }
        value object Holder {
            x: 
        }
    }
}
`
        };
        const built = await buildFiles(files);
        const document = built.get('b.tni')!;
        const source = files['b.tni'];
        const offset = source.indexOf('x: ') + 'x: '.length;
        const items = await completionItems(document, offset);
        const local = items.find(item => item.detail?.includes('C.B.X'));
        const imported = items.find(item => item.detail?.includes('C.A.X'));
        expect(local?.textEdit?.newText ?? local?.insertText).toBe('X');
        expect(imported?.textEdit?.newText ?? imported?.insertText).toMatch(/A\.X$/);
    });

    test('duplicate list candidates are excluded from completion', async () => {
        const realizesSource = `subdomain A
subdomain B
bounded context C realizes A, 
`;
        const realizesDocument = addDocument('realizes-duplicate.tni', realizesSource);
        await services.shared.workspace.DocumentBuilder.build([realizesDocument], { validation: false });
        const realizesLabels = await completionLabels(realizesDocument,
            realizesSource.indexOf('realizes A, ') + 'realizes A, '.length);
        expect(realizesLabels).not.toContain('A');
        expect(realizesLabels).toContain('B');

        const aggregateSource = `bounded context C
in bounded context C {
    aggregate O {
        root entity O { identifier id: I }
        value object I { raw: string }
    }
    aggregate P {
        root entity P { identifier id: J }
        value object J { raw: string }
    }
    read model S {
        total: decimal
    }
    query repository Q {
        serves S
        reads from O, 
    }
}
`;
        const aggregateDocument = addDocument('query-source-duplicate.tni', aggregateSource);
        await services.shared.workspace.DocumentBuilder.build([aggregateDocument], { validation: false });
        const aggregateLabels = await completionLabels(aggregateDocument,
            aggregateSource.indexOf('reads from O, ') + 'reads from O, '.length);
        expect(aggregateLabels).not.toContain('O');
        expect(aggregateLabels).toContain('P');

        const journeySource = `bounded context C
in bounded context C {
    application service App {
        method run() {
            behavior "Run."
        }
    }
}
actor Customer
actor Admin
journey J {
    by Customer {
        invoke C.App.run
    }
    by 
}
`;
        const journeyDocument = addDocument('journey-actor-duplicate.tni', journeySource);
        await services.shared.workspace.DocumentBuilder.build([journeyDocument], { validation: false });
        const journeyLabels = await completionLabels(journeyDocument,
            journeySource.lastIndexOf('by ') + 'by '.length);
        expect(journeyLabels).not.toContain('Customer');
        expect(journeyLabels).toContain('Admin');

        const mapSource = `bounded context A
bounded context B
bounded context C
context map M {
    customer A -> supplier B
    customer A -> supplier 
}
`;
        const mapDocument = addDocument('context-map-duplicate.tni', mapSource);
        await services.shared.workspace.DocumentBuilder.build([mapDocument], { validation: false });
        const mapLabels = await completionLabels(mapDocument, mapSource.lastIndexOf('supplier ') + 'supplier '.length);
        expect(mapLabels).not.toContain('B');
        expect(mapLabels).toContain('C');
    });

    test('future command operations stay timeline-restricted and use the updated diagnostic', async () => {
        const source = `bounded context C
in bounded context C {
    application service App {
        method first() {
            behavior "First."
        }
        method second() {
            behavior "Second."
        }
    }
}
actor Customer
journey J {
    by Customer {
        invoke C.App.first with "[[C.App.second]]"
        invoke C.App.second
    }
}
`;
        const document = addDocument('future-command.tni', source);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
        expect(errors(document).some(message => message.includes('later command operations, private command contract inputs or results'))).toBe(true);
        const offset = source.indexOf('[[C.App.') + '[[C.App.'.length;
        const labels = await completionLabels(document, offset);
        expect(labels).not.toContain('second');
    });

    test('same-service application-service helper composition is allowed', async () => {
        const source = `bounded context C
in bounded context C {
    aggregate Order {
        root entity Order {
            identifier id: Id
            method place() {
                behavior "Place."
            }
        }
        value object Id {
            raw: string
        }
    }
    application service App {
        method run() {
            invokes helper
        }
        method helper() {
            invokes Order.Order.place
        }
    }
}
`;
        const document = addDocument('same-service-helper.tni', source);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
        expect(errors(document)).toEqual([]);
    });

    test('mirrors may target module-private identifier value objects', async () => {
        const files = {
            'a.tni': `bounded context A
in bounded context A {
    module Internal {
        aggregate Order {
            root entity Order {
                identifier id: OrderId
            }
            value object OrderId {
                raw: string
            }
        }
    }
}
`,
            'b.tni': `import "./a.tni"
bounded context B
in bounded context B {
    value object MirroredId mirrors OrderId {
        raw: string
    }
}
context map AB {
    customer B -> supplier A
}
`
        };
        const built = await buildFiles(files);
        expect(errors(built.get('b.tni')!)).toEqual([]);
    });

    test('direct method result paths remain valid', async () => {
        const source = `bounded context C
in bounded context C {
    data object PlaceResult {
        status: string
    }
    application service App {
        method place() returns PlaceResult {
            behavior "Place."
        }
        method ship() {
            behavior "Ship."
        }
    }
}
actor Customer
journey J {
    by Customer {
        invoke C.App.place
        invoke C.App.ship with "[[C.App.place.status]]"
    }
}
`;
        const document = addDocument('direct-result.tni', source);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
        expect(errors(document)).toEqual([]);
    });

    test('published query operations are rejected in method prose with a result-contract diagnostic', async () => {
        const files = {
            'catalog.tni': `bounded context A
in bounded context A {
    module Api {
        exposes ProductQueries, ProductInfo
        data object ProductInfo {
            available: boolean
        }
        query service ProductQueries {
            method findProduct(id: string) returns ProductInfo {
                behavior "Find."
            }
        }
    }
}
bounded context B
`,
            'map.tni': `import "./catalog.tni"
context map ProductMap {
    customer B -> supplier A
}
`,
            'consumer.tni': `import "./catalog.tni"
import "./map.tni"
in bounded context B {
    application service Consumer {
        method run(id: string) {
            reads from A.Api.ProductQueries.findProduct
            behavior "[[A.Api.ProductQueries.findProduct]]"
        }
    }
}
`
        };
        const built = await buildFiles(files);
        expect(errors(built.get('consumer.tni')!).some(message =>
            message.includes('published result type or field')
        )).toBe(true);
    });
});
