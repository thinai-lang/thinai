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

describe('Scope and visibility policy regressions', () => {
    test('applies context aliases to contributed members from other files', async () => {
        const docs = await build({
            'catalog.tni': 'bounded context Ordering',
            'ordering.tni': `import "./catalog.tni"
in bounded context Ordering {
    data object Result {
        raw: string
    }
}`,
            'consumer.tni': `import { Ordering as Ctx } from "./catalog.tni"
import "./ordering.tni"
in bounded context Ctx {
    data object Use {
        result: Ctx.Result
    }
}`
        });

        expect(errors(docs['consumer.tni']!)).toEqual([]);
        const source = docs['consumer.tni']!.textDocument.getText();
        const offset = source.indexOf('Ctx.Result') + 'Ctx.'.length;
        const items = await completion(docs['consumer.tni']!, offset);
        expect(items?.items.map(item => item.label)).toContain('Result');
    });

    test('hides canonical paths when a component is aliased', async () => {
        const docs = await build({
            'catalog.tni': `bounded context Ordering
in bounded context Ordering {
    data object Result {
        raw: string
    }
}`,
            'consumer.tni': `import { Ordering as Ctx } from "./catalog.tni"
in bounded context Ctx {
    data object Use {
        aliased: Ctx.Result
        canonical: Ordering.Result
    }
}`
        });

        expect(errors(docs['consumer.tni']!).some(message =>
            message.includes('Could not resolve reference') && message.includes("named 'Ordering'")
        )).toBe(true);
        const source = docs['consumer.tni']!.textDocument.getText();
        const aliasedOffset = source.indexOf('Ctx.Result') + 'Ctx.'.length;
        const aliasedItems = await completion(docs['consumer.tni']!, aliasedOffset);
        expect(aliasedItems?.items.map(item => item.label)).toContain('Result');
        const canonicalOffset = source.indexOf('Ordering.Result') + 'Ordering.'.length;
        const canonicalItems = await completion(docs['consumer.tni']!, canonicalOffset);
        expect(canonicalItems?.items.map(item => item.label)).not.toContain('Result');
    });

    test('keeps canonical paths when the component is also imported unaliased', async () => {
        const docs = await build({
            'catalog.tni': `bounded context Ordering
in bounded context Ordering {
    data object Result {
        raw: string
    }
}`,
            'consumer.tni': `import { Ordering as Ctx, Ordering } from "./catalog.tni"
in bounded context Ctx {
    data object Use {
        aliased: Ctx.Result
        canonical: Ordering.Result
    }
}`
        });

        expect(errors(docs['consumer.tni']!)).toEqual([]);
    });

    test('keeps canonical paths when the file is also imported bare', async () => {
        const docs = await build({
            'catalog.tni': `bounded context Ordering
in bounded context Ordering {
    data object Result {
        raw: string
    }
}`,
            'consumer.tni': `import { Ordering as Ctx } from "./catalog.tni"
import "./catalog.tni"
in bounded context Ctx {
    data object Use {
        aliased: Ctx.Result
        canonical: Ordering.Result
    }
}`
        });

        expect(errors(docs['consumer.tni']!)).toEqual([]);
    });

    test('applies aliases to local context contributions', async () => {
        const docs = await build({
            'catalog.tni': 'bounded context Ordering',
            'contribution.tni': `import { Ordering as Ctx } from "./catalog.tni"
in bounded context Ctx {
    data object A {
        raw: string
    }
    data object B {
        a: Ctx.A
    }
}`
        });

        expect(errors(docs['contribution.tni']!)).toEqual([]);
    });

    test('keeps context-relative module paths inside an aliased contribution', async () => {
        const docs = await build({
            'catalog.tni': `bounded context Catalog
in bounded context Catalog {
    module B {
        exposes Money, Service, run
        value object Money {
            raw: string
        }
        domain service Service {
            method run()
        }
    }
}`,
            'consumer.tni': `import { Catalog as Ctx } from "./catalog.tni"
in bounded context Ctx {
    module A {
    depends on Ctx.B

        value object Holder {
            money: B.Money
        }
        application service App {
            method use() {
                invokes B.Service.run
            }
        }
    }
}`
        });

        expect(errors(docs['consumer.tni']!)).toEqual([]);
        const source = docs['consumer.tni']!.textDocument.getText();
        const offset = source.indexOf('B.Money') + 'B.'.length;
        const items = await completion(docs['consumer.tni']!, offset);
        expect(items?.items.map(item => item.label)).toContain('Money');
    });

    test('allows an alias to match a terminal field or method name', async () => {
        const docs = await build({
            'catalog.tni': 'bounded context Catalog',
            'consumer.tni': `import { Catalog as Orders } from "./catalog.tni"
bounded context Consumer
in bounded context Consumer {
    data object D {
        Orders: string
    }
    application service App {
        method Orders()
    }
}`
        });

        expect(errors(docs['consumer.tni']!)).toEqual([]);
    });

    test('does not make an unimported contribution visible through an alias', async () => {
        const docs = await build({
            'catalog.tni': 'bounded context Ordering',
            'ordering.tni': `import "./catalog.tni"
in bounded context Ordering {
    data object Result {
        raw: string
    }
}`,
            'consumer.tni': `import { Ordering as Ctx } from "./catalog.tni"
in bounded context Ctx {
    data object Use {
        result: Ctx.Result
    }
}`
        });

        expect(errors(docs['consumer.tni']!).some(message => message.includes("'Result'"))).toBe(true);
    });

    test('resolves same-file and imported journey commands consistently', async () => {
        const app = `bounded context C
in bounded context C {
    application service App {
        method run()
    }
}`;
        const sameFile = await build({
            'same.tni': `${app}
actor Customer
journey Same {
    by Customer {
        invoke App.run
    }
}`
        });
        expect(errors(sameFile['same.tni']!)).toEqual([]);
        const sameSource = sameFile['same.tni']!.textDocument.getText();
        const sameOffset = sameSource.indexOf('invoke ') + 'invoke '.length;
        const sameItems = await completion(sameFile['same.tni']!, sameOffset);

        await clearDocuments(services.shared, documents);
        const imported = await build({
            'app.tni': app,
            'journey.tni': `import "./app.tni"
actor Customer
journey Imported {
    by Customer {
        invoke App.run
    }
}`
        });
        expect(errors(imported['journey.tni']!)).toEqual([]);

        const importedSource = imported['journey.tni']!.textDocument.getText();
        const importedOffset = importedSource.indexOf('invoke ') + 'invoke '.length;
        const importedItems = await completion(imported['journey.tni']!, importedOffset);
        expect(sameItems?.items.map(item => item.label)).toEqual(importedItems?.items.map(item => item.label));
    });

    test('does not offer bare commands at the start of a journey path', async () => {
        const docs = await build({
            'journey.tni': `bounded context C
in bounded context C {
    application service App {
        method run()
    }
}
actor Customer
journey J {
    by Customer {
        invoke 
    }
}`
        });
        const source = docs['journey.tni']!.textDocument.getText();
        const offset = source.indexOf('invoke ') + 'invoke '.length;
        const items = await completion(docs['journey.tni']!, offset);
        const labels = items?.items.map(item => item.label) ?? [];
        expect(labels).toContain('App');
        expect(labels).not.toContain('run');
    });

    test('hides event handlers, query repositories, and private module internals from journey prose', async () => {
        const docs = await build({
            'provider.tni': `bounded context P
in bounded context P {
    event Changed
    module Internal {
        read model Hidden {
            secret: string
        }
        query repository HiddenRepository {
            serves Hidden
        }
        query service HiddenQueries {
            method find() returns Hidden {
                reads from HiddenRepository
            }
        }
    }
    application service App {
        method run()
        method onChanged(source: Changed)
    }
}`,
            'journey.tni': `import "./provider.tni"
actor Customer
journey J {
    by Customer {
        invoke P.App.run
            with "[[P.Internal.Hidden.secret]]"
            when "[[P.Internal.HiddenQueries.find.result.secret]] [[P.App.onChanged]] [[P.Internal.HiddenRepository]]"
    }
}`
        });

        const messages = errors(docs['journey.tni']!);
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.every(message =>
            message.includes('Journey specifications may reference') ||
            message.includes('This specification path segment is not visible') ||
            message.includes('Could not resolve reference')
        )).toBe(true);
        expect(messages.some(message => message.includes('This specification path segment is not visible'))).toBe(true);
    });

    test('keeps context-level and exposed query results visible in journey prose', async () => {
        const docs = await build({
            'a.tni': `bounded context C
in bounded context C {
    application service App {
        method run()
    }
    read model PublicResult {
        raw: string
    }
    query repository PublicRepository {
        serves PublicResult
    }
    query service PublicQueries {
        method find() returns PublicResult {
            reads from PublicRepository
        }
    }
    module Api {
        exposes PrivateQueries
        read model PrivateResult {
            raw: string
        }
        query repository PrivateRepository {
            serves PrivateResult
        }
        query service PrivateQueries {
            method find() returns PrivateResult {
                reads from PrivateRepository
            }
        }
    }
}
actor Customer
journey J {
    by Customer {
        invoke C.App.run
            when "[[C.PublicQueries.find.result.raw]] [[C.Api.PrivateQueries.find.result.raw]]"
    }
}`
        });

        expect(errors(docs['a.tni']!)).toEqual([]);
    });

    test('allows context-level shared-kernel links in journey prose without a context map', async () => {
        const docs = await build({
            'shared.tni': `shared kernel Common {
    value object V {
        raw: string
    }
}`,
            'app.tni': `bounded context C
in bounded context C {
    application service App {
        method run()
    }
}`,
            'journey.tni': `import "./shared.tni"
import "./app.tni"
actor Customer
journey J {
    by Customer {
        invoke C.App.run
            when "[[Common.V.raw]]"
    }
}`
        });

        expect(errors(docs['journey.tni']!)).toEqual([]);
    });

    test('rejects terminal module or service container links in journey prose', async () => {
        const docs = await build({
            'a.tni': `bounded context C
in bounded context C {
    application service App {
        method run()
    }
}
actor Customer
journey J {
    by Customer {
        invoke C.App.run
            when "[[C]] [[C.App]]"
    }
}`
        });

        const messages = errors(docs['a.tni']!);
        expect(messages.filter(message => message.includes('must end at a visible declaration'))).toHaveLength(2);
    });

    test('restricts unqualified specification methods to the enclosing entity', async () => {
        const docs = await build({
            'a.tni': `bounded context C
in bounded context C {
    aggregate A {
        root entity A {
            method m() {
                behavior "Uses [[other]]."
            }
            identifier id: AId
        }
        value object AId {
            raw: string
        }
    }
    aggregate B {
        root entity B {
            method other()
            identifier id: BId
        }
        value object BId {
            raw: string
        }
    }
}`
        });
        expect(errors(docs['a.tni']!).some(message => message.includes("'other'"))).toBe(true);

        await clearDocuments(services.shared, documents);
        const qualified = await build({
            'a.tni': `bounded context C
in bounded context C {
    aggregate A {
        root entity A {
            method m() {
                behavior "Uses [[B.B.other]]."
            }
            identifier id: AId
        }
        value object AId {
            raw: string
        }
    }
    aggregate B {
        root entity B {
            method other()
            identifier id: BId
        }
        value object BId {
            raw: string
        }
    }
}`
        });
        expect(errors(qualified['a.tni']!)).toEqual([]);
    });

    test('re-exports exposed nested module APIs through an outer dependency', async () => {
        const docs = await build({
            'a.tni': `bounded context C
in bounded context C {
    module A {
        exposes B
        module B {
            exposes V
            value object V {
                raw: string
            }
        }
    }
    module D {
    depends on A

        data object E {
            v: B.V
        }
    }
}`
        });
        expect(errors(docs['a.tni']!)).toEqual([]);
    });

    test('does not re-export from a dependency edge alone', async () => {
        const docs = await build({
            'a.tni': `bounded context C
in bounded context C {
    module A {
    depends on B

    }
    module B {
        exposes V
        value object V {
            raw: string
        }
    }
    module D {
    depends on A

        data object E {
            v: B.V
        }
    }
}`
        });
        expect(errors(docs['a.tni']!).some(message => message.includes('dependency on a module'))).toBe(true);
    });

    test('deduplicates completion items for one target', async () => {
        const docs = await build({
            'a.tni': `bounded context C
in bounded context C {
    aggregate A {
        root entity A {
            identifier id: Id
        }
        value object Id {
            raw: string
        }
    }
    repository R {
        manages 
    }
}`
        });
        const source = docs['a.tni']!.textDocument.getText();
        const offset = source.indexOf('manages ') + 'manages '.length;
        const items = await completion(docs['a.tni']!, offset);
        const labels = items?.items.map(item => item.label) ?? [];
        expect(labels.filter(label => label === 'A' || label === 'A.A' || label === 'C.A.A')).toHaveLength(1);
    });

    test('rejects import aliases that collide with local declarations', async () => {
        const docs = await build({
            'other.tni': `bounded context Other
in bounded context Other {
    value object V {
        raw: string
    }
}`,
            'consumer.tni': `import { Other as Local } from "./other.tni"
bounded context Local
in bounded context Local {
    data object D {
        payload: Local.V
    }
}`
        });
        expect(errors(docs['consumer.tni']!)).toContain(
            "Import alias 'Local' conflicts with a declaration in this file."
        );
    });

    test('rejects import aliases that collide with a context-relative path-root suffix', async () => {
        const docs = await build({
            'catalog.tni': `bounded context Catalog
in bounded context Catalog {
    module Shared {
        value object Money {
            raw: string
        }
    }
}`,
            'other.tni': `bounded context Other
in bounded context Other {
    value object V {
        raw: string
    }
}`,
            'consumer.tni': `import { Catalog } from "./catalog.tni"
import { Other as Shared } from "./other.tni"
bounded context Consumer`
        });
        expect(errors(docs['consumer.tni']!)).toContain(
            "Import alias 'Shared' conflicts with an imported declaration."
        );
    });

    test('rejects unaliased component names that collide with local path roots', async () => {
        const docs = await build({
            'contexts.tni': `bounded context Ordering`,
            'consumer.tni': `import { Ordering } from "./contexts.tni"
bounded context C
in bounded context C {
    value object Ordering {
        raw: string
    }
}`
        });
        expect(errors(docs['consumer.tni']!)).toContain(
            "Import component name 'Ordering' conflicts with a declaration in this file."
        );
    });

    test('publishes service methods when the service is exposed', async () => {
        const docs = await build({
            'a.tni': `bounded context C
in bounded context C {
    module A {
        exposes Service, Result
        data object Result {
            amount: decimal
        }
        application service Service {
            method privateHelper() returns Result {
                behavior "Return the result."
            }
        }
    }
    module B {
    depends on A

        application service Consumer {
            method run() {
                behavior "Use [[A.Service.privateHelper.amount]]."
            }
        }
    }
}`
        });
        expect(errors(docs['a.tni']!)).toEqual([]);

        const source = docs['a.tni']!.textDocument.getText();
        const offset = source.indexOf('privateHelper.') + 'privateHelper.'.length;
        const items = await completion(docs['a.tni']!, offset);
        expect(items?.items.map(item => item.label) ?? []).toContain('amount');
    });

    test('allows an exposed method as a non-terminal specification path segment', async () => {
        const docs = await build({
            'a.tni': `bounded context C
in bounded context C {
    module A {
        exposes Service, Result, publicHelper
        data object Result {
            amount: decimal
        }
        application service Service {
            method publicHelper() returns Result {
                behavior "Return the result."
            }
        }
    }
    module B {
    depends on A

        application service Consumer {
            method run() {
                behavior "Use [[A.Service.publicHelper.amount]]."
            }
        }
    }
}`
        });
        expect(errors(docs['a.tni']!)).toEqual([]);
    });

    test('publishes aggregate root behavior when the aggregate is exposed', async () => {
        const docs = await build({
            'a.tni': `bounded context Shop
in bounded context Shop {
    module Domain {
        aggregate OrderAggregate {
            value object OrderId {
                raw: string
            }
            value object LineId {
                raw: string
            }
            root entity Order {
                identifier id: OrderId
                method place() {
                    behavior "Place the order."
                }
            }
            entity Line {
                identifier id: LineId
                method validate() {
                    behavior "Validate the line."
                }
            }
        }
        exposes OrderAggregate
    }
    module Api {
        depends on Domain

        application service OrderApplication {
            method placeOrder() returns string {
                behavior "Place an order."
                invokes Domain.OrderAggregate.Order.place
            }
        }
        exposes OrderApplication
    }
}`
        });
        expect(errors(docs['a.tni']!)).toEqual([]);

        const source = docs['a.tni']!.textDocument.getText();
        const offset = source.indexOf('invokes ') + 'invokes '.length;
        const items = await completion(docs['a.tni']!, offset);
        const labels = items?.items.map(item => item.label) ?? [];
        expect(labels).toEqual(expect.arrayContaining(['Domain', 'OrderAggregate', 'Order', 'place']));
        expect(labels).not.toContain('validate');
    });

    test('does not publish child-entity behavior with an exposed aggregate', async () => {
        const docs = await build({
            'a.tni': `bounded context Shop
in bounded context Shop {
    module Domain {
        aggregate OrderAggregate {
            value object OrderId {
                raw: string
            }
            value object LineId {
                raw: string
            }
            root entity Order {
                identifier id: OrderId
                method place() {
                    behavior "Place the order."
                }
            }
            entity Line {
                identifier id: LineId
                method validate() {
                    behavior "Validate the line."
                }
            }
        }
        exposes OrderAggregate
    }
    module Api {
        depends on Domain

        application service OrderApplication {
            method placeOrder() returns string {
                behavior "Place an order."
                invokes Domain.OrderAggregate.Line.validate
            }
        }
        exposes OrderApplication
    }
}`
        });
        expect(errors(docs['a.tni']!)).toContain(
            'An application service may invoke only aggregate-root behavior or a factory method that creates an aggregate root.'
        );
    });

    test('allows a direct dependency on an exposed private nested module in specification paths', async () => {
        const docs = await build({
            'a.tni': `bounded context C
in bounded context C {
    module Outer {
        module Inner {
            exposes V
            value object V {
                raw: string
            }
        }
    }
    module Sibling {
    depends on Outer.Inner

        application service App {
            method run() {
                behavior "Use [[Inner.V.raw]]."
            }
        }
    }
}`
        });
        expect(errors(docs['a.tni']!)).toEqual([]);
    });
});
