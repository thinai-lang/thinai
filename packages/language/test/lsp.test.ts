import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { AstUtils, EmptyFileSystem, type AstNode, type AstNodeDescription, type LangiumDocument, URI } from 'langium';
import { SemanticTokensDecoder } from 'langium/lsp';
import { clearDocuments } from 'langium/test';
import { applyConfiguredIndentation, applyConfiguredIndentationToCompletions, createThinaiServices } from 'thinai-language';
import { ThinaiNodeKindProvider } from '../src/thinai-node-kind-provider.js';
import { ThinaiCompletionProvider } from '../src/thinai-completion.js';
import { ThinaiImportCompletion } from '../src/thinai-import-completion.js';
import { createThinaiSelectionRange } from '../src/thinai-selection-range.js';
import { CompletionItemKind, CompletionTriggerKind, InsertTextMode, SymbolKind, type CompletionItem, type CompletionList } from 'vscode-languageserver';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

describe('LSP services', () => {
    test('provides quoted-string-first selection ranges across Thinai string constructs', () => {
        const source = `import "./external.tni"
context map Channels {
    customer Ordering { integrationPatterns: ["ACL"] } -> supplier Shipping
}
bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        invariant "aggregate invariant"
        root entity Order {
            constructor() {
                invariant "constructor invariant"
                precondition "constructor precondition"
                postcondition "constructor postcondition"
                behavior "constructor behavior"
            }
            method place() {
                invariant "method invariant"
                precondition "method precondition"
                postcondition "method postcondition"
                behavior "method behavior [[Order.place]]"
                invokes Order.place when "invoke guard"
                transition state from Draft to Placed when "transition guard"
                emits OrderPlaced when "emission guard"
            }
        }
    }
}
journey Checkout {
    by Customer {
        invoke Order.place with "journey arguments" when "journey guard"
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/selection-ranges.tni'), source
        );
        documents = [document];

        const cases = [
            ['"./external.tni"', 'import'],
            ['"ACL"', 'integrationPatterns'],
            ['"aggregate invariant"', 'invariant'],
            ['"constructor invariant"', 'invariant'],
            ['"constructor precondition"', 'precondition'],
            ['"constructor postcondition"', 'postcondition'],
            ['"constructor behavior"', 'behavior'],
            ['"method invariant"', 'invariant'],
            ['"method precondition"', 'precondition'],
            ['"method postcondition"', 'postcondition'],
            ['"method behavior [[Order.place]]"', 'behavior'],
            ['"invoke guard"', 'invokes'],
            ['"transition guard"', 'transition'],
            ['"emission guard"', 'emits'],
            ['"journey arguments"', 'with'],
            ['"journey guard"', 'when']
        ] as const;

        for (const [quotedText, enclosingKeyword] of cases) {
            const offset = source.indexOf(quotedText) + 1;
            const position = document.textDocument.positionAt(offset);
            const selection = createThinaiSelectionRange(document, position);

            expect(selection, quotedText).toBeDefined();
            expect(document.textDocument.getText(selection!.range), quotedText).toBe(quotedText);
            expect(selection!.parent, quotedText).toBeDefined();
            expect(document.textDocument.getText(selection!.parent!.range), quotedText).toContain(enclosingKeyword);
        }

        const statementCases = [
            ['"invoke guard"', 'invokes Order.place when "invoke guard"'],
            ['"transition guard"', 'transition state from Draft to Placed when "transition guard"'],
            ['"emission guard"', 'emits OrderPlaced when "emission guard"'],
            ['"journey arguments"', 'invoke Order.place with "journey arguments" when "journey guard"'],
            ['"journey guard"', 'invoke Order.place with "journey arguments" when "journey guard"']
        ] as const;
        for (const [quotedText, expectedStatement] of statementCases) {
            const position = document.textDocument.positionAt(source.indexOf(quotedText) + 1);
            const selection = createThinaiSelectionRange(document, position);
            expect(document.textDocument.getText(selection!.parent!.range), quotedText).toBe(expectedStatement);
        }
    });

    test('selects complete method statements before expanding to their method', () => {
        const source = `bounded context Ordering
context map Relations {
    customer Ordering -> supplier Shipping
    partner Ordering <-> partner Returns
    separateWays Ordering -x- Returns
    sharedKernel Common { participants: [Ordering, Shipping] }
}
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            method place() {
                invokes Order.place
                transition state from Draft to Placed
                emits OrderPlaced
                projects OrderSummary, OrderDetails
            }
        }
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/statement-selection-ranges.tni'), source
        );
        documents = [document];

        const cases = [
            ['invokes Order.place', 'invokes'],
            ['transition state from Draft to Placed', 'transition'],
            ['emits OrderPlaced', 'emits'],
            ['projects OrderSummary, OrderDetails', 'projects'],
            ['customer Ordering -> supplier Shipping', 'customer'],
            ['partner Ordering <-> partner Returns', 'partner'],
            ['separateWays Ordering -x- Returns', 'separateWays'],
            ['sharedKernel Common { participants: [Ordering, Shipping] }', 'sharedKernel']
        ] as const;

        for (const [statement, startToken] of cases) {
            const offset = source.indexOf(startToken) + 1;
            const selection = createThinaiSelectionRange(document, document.textDocument.positionAt(offset));

            expect(selection, statement).toBeDefined();
            expect(document.textDocument.getText(selection!.range), statement).toBe(statement);
            expect(selection!.parent, statement).toBeDefined();
            expect(document.textDocument.getText(selection!.parent!.range), statement).toContain(
                statement.startsWith('customer') || statement.startsWith('partner')
                    || statement.startsWith('separateWays') || statement.startsWith('sharedKernel')
                    ? 'context map'
                    : 'method place'
            );
        }
    });

    test('applies configured indentation to structurally indented completion edits', () => {
        const completionText = '\n  method\n  }';
        expect(applyConfiguredIndentation(completionText, 2, 2, true)).toBe('\n    method\n  }');
        expect(applyConfiguredIndentation(completionText, 2, 4, true)).toBe('\n        method\n  }');
        expect(applyConfiguredIndentation(completionText, 2, 4, false)).toBe('\n\t\tmethod\n  }');
        expect(applyConfiguredIndentation('\r\n  method', 1, 2, true)).toBe('\r\n  method');
        const completionItems = [{
            label: 'method',
            data: { thinaiIndentationDepth: 2 },
            textEdit: {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: '\n  method'
            }
        }];
        expect(applyConfiguredIndentationToCompletions(completionItems, 4, true)[0]?.textEdit?.newText)
            .toBe('\n        method');
        expect(applyConfiguredIndentationToCompletions(completionItems, 4, false)[0]?.textEdit?.newText)
            .toBe('\n\t\tmethod');
    });

    test('formats nested Thinai declarations using the editor indentation options', async () => {
        const source = 'bounded context Ordering in bounded context Ordering { aggregate Order { root entity Order { identifier id:OrderId items:Map<string,number> } } enum OrderStatus { Draft,Placed } } actor Customer';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatting.tni'), source
        );
        documents = [document];

        const formatter = services.Thinai.lsp.Formatter;
        expect(formatter).toBeDefined();
        const edits = await formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });

        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, source);

        expect(formatted).toBe([
            'bounded context Ordering',
            '',
            'in bounded context Ordering {',
            '  aggregate Order {',
            '    root entity Order {',
            '      identifier id: OrderId',
            '      items: Map<string, number>',
            '    }',
            '  }',
            '',
            '  enum OrderStatus {',
            '    Draft,',
            '    Placed',
            '  }',
            '}',
            '',
            'actor Customer'
        ].join('\n'));
        const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatted.tni'), formatted
        );
        documents.push(formattedDocument);
        expect(await formatter!.formatDocument(formattedDocument, {
            textDocument: { uri: formattedDocument.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        })).toEqual([]);
    });

    test('formats repository blocks and method read dependencies', async () => {
        const source = `bounded context Ordering in bounded context Ordering {
            repository OrderRepository { manages Order.Order }
            query repository OrderSummaryRepository { serves OrderSummary reads from Order, Customer }
            application service Commands {
                method run() { reads from OrderRepository, CustomerRepository when "The request needs order and customer data." }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-dependency-formatting.tni'), source
        );
        documents.push(document);
        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 4, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, source);

        expect(formatted).toContain('repository OrderRepository {\n        manages Order.Order\n    }');
        expect(formatted).toContain('query repository OrderSummaryRepository {\n        serves OrderSummary\n        reads from Order, Customer\n    }');
        expect(formatted).toContain('reads from OrderRepository, CustomerRepository\n                when "The request needs order and customer data."');
        const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-dependency-formatted.tni'), formatted
        );
        documents.push(formattedDocument);
        expect(await services.Thinai.lsp.Formatter!.formatDocument(formattedDocument, {
            textDocument: { uri: formattedDocument.uri.toString() },
            options: { tabSize: 4, insertSpaces: true }
        })).toEqual([]);
    });

    test('indents multiline specification text without changing its content', async () => {
        const source = `bounded context Formatting
in bounded context Formatting {
    aggregate OrderAggregate {
        root entity Order {
            constructor(id: OrderId) {
                postcondition "Identifier [[id]] is retained.
  The supplied identifier is non-empty.
"
            }
            method place() {
                behavior """
Place the order using [[status]].
  Preserve relative detail indentation.
"""
                transition status from Draft to Placed
                    when "
The order is ready.
"
                emits OrderPlaced
                    when "
The order was accepted.
"
            }
            identifier id: OrderId
            status: OrderStatus initial Draft
        }
        value object OrderId { raw: string }
        enum OrderStatus { Draft, Placed }
    }
    event OrderPlaced
    application service OrderApplication {
        method placeOrder() {
            invokes OrderAggregate.Order.place when "
The request was authorized.
"
        }
    }
}
actor Customer
journey PlaceOrder {
    by Customer {
        invoke Formatting.OrderApplication.placeOrder
            with "
The selected order identifier.
"
            when "
The order is eligible.
"
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/multiline-specification-formatting.tni'), source
        );
        documents = [document];

        const getSpecificationContents = (sourceDocument: LangiumDocument): string[] =>
            AstUtils.streamAst(sourceDocument.parseResult.value)
                .filter(node => node.$type === 'SpecificationText')
                .map(node => {
                    const specification = node as AstNode & {
                        parts?: Array<{ text?: string; target?: { $refText: string }; targets?: Array<{ $refText: string }> }>
                    };
                    return (specification.parts ?? []).map(part => part.text ??
                        `[[${part.target?.$refText ?? ''}${(part.targets ?? []).map(target => `.${target.$refText}`).join('')}]]`
                    ).join('');
                })
                .toArray();
        const originalSpecifications = getSpecificationContents(document);

        const formatWith = async (tabSize: number, insertSpaces: boolean): Promise<string> => {
            const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
                textDocument: { uri: document.uri.toString() },
                options: { tabSize, insertSpaces }
            });
            return edits
                .slice()
                .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
                .reduce((formatted, edit) => {
                    const start = document.textDocument.offsetAt(edit.range.start);
                    const end = document.textDocument.offsetAt(edit.range.end);
                    return formatted.slice(0, start) + edit.newText + formatted.slice(end);
                }, source);
        };

        const formatted = await formatWith(2, true);
        expect(formatted).toContain([
            '        postcondition "',
            '          Identifier [[id]] is retained.',
            '            The supplied identifier is non-empty.',
            '        "'
        ].join('\n'));
        expect(formatted).toContain([
            '        behavior """',
            '          Place the order using [[status]].',
            '            Preserve relative detail indentation.',
            '        """'
        ].join('\n'));
        expect(formatted).toContain([
            '        transition status from Draft to Placed',
            '          when "',
            '            The order is ready.',
            '          "'
        ].join('\n'));
        const journeyOutput = formatted.slice(formatted.indexOf('journey PlaceOrder'));
        const journeyLines = journeyOutput.split('\n').filter(line =>
            line.trim() === '"' ||
                /(?:invoke Formatting\.OrderApplication\.placeOrder|with "|The selected order identifier\.|when "|The order is eligible\.)/u.test(line)
        );
        expect(journeyLines.map(line => [line.match(/^\s*/u)?.[0].length ?? 0, line.trim()])).toEqual([
            [4, 'invoke Formatting.OrderApplication.placeOrder'],
            [6, 'with "'],
            [8, 'The selected order identifier.'],
            [6, '"'],
            [6, 'when "'],
            [8, 'The order is eligible.'],
            [6, '"']
        ]);

        const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatted-multiline-specifications.tni'), formatted
        );
        documents.push(formattedDocument);
        expect(getSpecificationContents(formattedDocument)).toEqual(originalSpecifications);
        expect(await services.Thinai.lsp.Formatter!.formatDocument(formattedDocument, {
            textDocument: { uri: formattedDocument.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        })).toEqual([]);

        const tabFormatted = await formatWith(4, false);
        expect(tabFormatted).toContain('\t\t\t\tbehavior """\n\t\t\t\t\tPlace the order using [[status]].');
    });

    test('preserves field, method, and constructor source order when formatting', async () => {
        const source = `bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
            method place() {}
            constructor(id: OrderId) {}
        }
        value object OrderId {
            raw: string
            method normalize() {}
            constructor(raw: string) {}
        }
    }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/value-object-member-order-formatting.tni'), source
        );
        documents.push(document);
        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, source);
        expect(formatted.indexOf('raw: string')).toBeLessThan(formatted.indexOf('method normalize'));
        expect(formatted.indexOf('method normalize')).toBeLessThan(formatted.indexOf('constructor(raw'));
        expect(formatted.indexOf('identifier id: OrderId')).toBeLessThan(formatted.indexOf('method place'));
        expect(formatted.indexOf('method place')).toBeLessThan(formatted.indexOf('constructor(id'));
    });

    test('formats context map endpoints and shared-kernel participant lists', async () => {
        const source = 'context map FulfillmentMap{customer Shipping{integrationPatterns:["AntiCorruptionLayer"]}->supplier Orders{integrationPatterns:["OpenHostService","PublishedLanguage"]}sharedKernel CommonTypes{participants:[Orders\n,Shipping]}}';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map-formatting.tni'), source
        );
        documents = [document];

        expect(document.parseResult.parserErrors).toEqual([]);
        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, source);

        expect(formatted).toBe([
            'context map FulfillmentMap {',
            '  customer Shipping {',
            '    integrationPatterns: ["AntiCorruptionLayer"]',
            '  } -> supplier Orders {',
            '    integrationPatterns: ["OpenHostService", "PublishedLanguage"]',
            '  }',
            '',
            '  sharedKernel CommonTypes {',
            '    participants: [Orders, Shipping]',
            '  }',
            '}'
        ].join('\n'));
        const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatted-context-map.tni'), formatted
        );
        documents.push(formattedDocument);
        expect(await services.Thinai.lsp.Formatter!.formatDocument(formattedDocument, {
            textDocument: { uri: formattedDocument.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        })).toEqual([]);
    });

    test('normalizes import, reference, constructor, and enum separators', async () => {
        const source = 'import{One as First,Two}from"things.tni" bounded context Example realizes Core,Supporting in bounded context Example {aggregate Order{root entity Item{constructor(first:string,second:number){}method combine(first:string,second:number){}identifier id:string}enum Status{Draft ,Placed}}module Data   depends   on First,Second{}}';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/list-formatting.tni'), source
        );
        documents = [document];

        expect(document.parseResult.parserErrors).toEqual([]);
        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, source);

        expect(formatted).toContain('import { One as First, Two } from "things.tni"');
        expect(formatted).toContain('bounded context Example realizes Core, Supporting');
        expect(formatted).toContain('in bounded context Example {');
        expect(formatted).toContain('constructor(first: string, second: number) {}');
        expect(formatted).toContain('method combine(first: string, second: number) {}');
        expect(formatted).toContain('Draft,\n      Placed');
        expect(formatted).toContain('module Data depends on First, Second {}');
    });

    test('separates member groups without splitting adjacent fields and preserves comments and text', async () => {
        const source = 'bounded context Sample in bounded context Sample {aggregate Thing{root entity Item{\n// Keep this; note\nmethod first(){behavior "Preserve; this text"}method second(){}identifier id:string name:string}}}';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/member-formatting.tni'), source
        );
        documents = [document];
        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, source);

        expect(formatted).toBe([
            'bounded context Sample',
            '',
            'in bounded context Sample {',
            '  aggregate Thing {',
            '    root entity Item {',
            '      // Keep this; note',
            '      method first() {',
            '        behavior "Preserve; this text"',
            '      }',
            '',
            '      method second() {}',
            '',
            '      identifier id: string',
            '      name: string',
            '    }',
            '  }',
            '}'
        ].join('\n'));
    });

    test('keeps leading comments attached to the sibling statement during formatting', async () => {
        const source = `bounded context Sample
in bounded context Sample {
    event FirstEvent
    // Keep this comment with the second event.
    event SecondEvent
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/leading-comment-formatting.tni'), source
        );
        documents = [document];
        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, source);

        expect(formatted).toBe([
            'bounded context Sample',
            '',
            'in bounded context Sample {',
            '  event FirstEvent',
            '  // Keep this comment with the second event.',
            '  event SecondEvent',
            '}'
        ].join('\n'));

        const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatted-leading-comment.tni'), formatted
        );
        documents.push(formattedDocument);
        expect(await services.Thinai.lsp.Formatter!.formatDocument(formattedDocument, {
            textDocument: { uri: formattedDocument.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        })).toEqual([]);

        const topLevelSource = `bounded context First
// Keep this comment with the second context.
bounded context Second`;
        const topLevelDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/top-level-leading-comment-formatting.tni'), topLevelSource
        );
        documents.push(topLevelDocument);
        const topLevelEdits = await services.Thinai.lsp.Formatter!.formatDocument(topLevelDocument, {
            textDocument: { uri: topLevelDocument.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const topLevelFormatted = topLevelEdits
            .slice()
            .sort((left, right) => topLevelDocument.textDocument.offsetAt(right.range.start) - topLevelDocument.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = topLevelDocument.textDocument.offsetAt(edit.range.start);
                const end = topLevelDocument.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, topLevelSource);
        expect(topLevelFormatted).toBe([
            'bounded context First',
            '// Keep this comment with the second context.',
            'bounded context Second'
        ].join('\n'));
    });

    test('formats guarded event emissions and grouped transitions', async () => {
        const source = `bounded context Ordering in bounded context Ordering {aggregate Order{root entity Order{method confirm(){transition status from Draft to Placed,paymentStatus from Pending to Confirmed when "Payment approved"emits OrderPlaced,PaymentConfirmed when "The status is [[status]]"}identifier id:OrderId status:OrderStatus paymentStatus:PaymentStatus}value object OrderId{raw:string}enum OrderStatus{Draft,Placed}enum PaymentStatus{Pending,Confirmed}}event OrderPlaced event PaymentConfirmed}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/guarded-effects-formatting.tni'), source
        );
        documents = [document];

        expect(document.parseResult.parserErrors).toHaveLength(0);
        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, source);

        const lines = formatted.split('\n');
        const transitionLine = lines.findIndex(line => line.includes('transition status from Draft to Placed,'));
        expect(lines[transitionLine + 1].trimStart()).toBe('paymentStatus from Pending to Confirmed');
        expect(lines[transitionLine + 1].match(/^\s*/)?.[0].length)
            .toBe(lines[transitionLine].indexOf('transition') + 'transition '.length);
        expect(lines[transitionLine + 2].trimStart()).toBe('when "Payment approved"');
        expect(lines[transitionLine + 2].match(/^\s*/)?.[0].length)
            .toBe(lines[transitionLine].match(/^\s*/)![0].length + 2);

        const emissionLine = lines.findIndex(line => line.includes('emits OrderPlaced,'));
        expect(lines[emissionLine + 1].trimStart()).toBe('PaymentConfirmed');
        expect(lines[emissionLine + 1].match(/^\s*/)?.[0].length)
            .toBe(lines[emissionLine].indexOf('emits') + 'emits '.length);
        expect(lines[emissionLine + 2].trimStart()).toBe('when "The status is [[status]]"');
        expect(lines[emissionLine + 2].match(/^\s*/)?.[0].length)
            .toBe(lines[emissionLine].match(/^\s*/)![0].length + 2);

        const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatted-guarded-effects.tni'), formatted
        );
        documents.push(formattedDocument);
        expect(await services.Thinai.lsp.Formatter!.formatDocument(formattedDocument, {
            textDocument: { uri: formattedDocument.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        })).toEqual([]);
    });

    test('formats a guarded method invocation on a continuation line', async () => {
        const source = 'bounded context Ordering in bounded context Ordering {aggregate Order{root entity Order{method place(){invokes validate when "The order is ready."}method validate(){}identifier id:OrderId}value object OrderId{raw:string}}}';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/guarded-invocation-formatting.tni'), source
        );
        documents = [document];
        expect(document.parseResult.parserErrors).toHaveLength(0);

        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, source);
        const lines = formatted.split('\n');
        const invocationLine = lines.findIndex(line => line.includes('invokes validate'));
        expect(lines[invocationLine + 1].trimStart()).toBe('when "The order is ready."');
        expect(lines[invocationLine + 1].match(/^\s*/)?.[0].length)
            .toBe(lines[invocationLine].match(/^\s*/)![0].length + 2);

        const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatted-guarded-invocation.tni'), formatted
        );
        documents.push(formattedDocument);
        expect(await services.Thinai.lsp.Formatter!.formatDocument(formattedDocument, {
            textDocument: { uri: formattedDocument.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        })).toEqual([]);
    });

    test('formats the complete order-fulfillment example', async () => {
        const source = await readFile(new URL('../../../examples/order-fulfillment/ordering-events.tni', import.meta.url), 'utf8');
        const misformattedSource = source
            .replace(/^( +)/gm, indentation => '\t'.repeat(indentation.length / 2))
            .replace('emits Contracts.OrderPlacedV1', 'emits\n        Contracts.OrderPlacedV1')
            .replace('projects OrderSummary', 'projects\n        OrderSummary');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-events.tni'), misformattedSource
        );
        documents = [document];

        expect(document.parseResult.lexerErrors).toHaveLength(0);
        expect(document.parseResult.parserErrors).toHaveLength(0);
        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, misformattedSource);

        expect(edits.length).toBeGreaterThan(0);
        expect(formatted).toContain('actor Customer\n\nactor OrderManager\n\nin bounded context Ordering {');
        expect(formatted).toContain('  application service OrderApplication {');
        expect(formatted).toContain('      emits Contracts.OrderPlacedV1');
        expect(formatted).toContain('      projects OrderSummary');
        expect(formatted).toContain('method findCustomerOrders(customerId: CustomerId) returns List<OrderSummary> {');
        expect(formatted).toContain('      with "input.orderId from [[Ordering.OrderSummary.orderId]]');
        expect(formatted).not.toMatch(/^\t/m);
        const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/formatted-ordering-events.tni'), formatted
        );
        documents.push(formattedDocument);
        expect(await services.Thinai.lsp.Formatter!.formatDocument(formattedDocument, {
            textDocument: { uri: formattedDocument.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        })).toEqual([]);
    });

    test('formats existing tabs as two spaces when requested by the editor', async () => {
        const source = 'bounded context Sample in bounded context Sample {\n\taggregate Order {\n\t\troot entity Order {\n\t\t\tidentifier id:string\n\t\t}\n\t}\n}';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/tab-indented.tni'), source
        );
        documents = [document];
        const edits = await services.Thinai.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const formatted = edits
            .slice()
            .sort((left, right) => document.textDocument.offsetAt(right.range.start) - document.textDocument.offsetAt(left.range.start))
            .reduce((text, edit) => {
                const start = document.textDocument.offsetAt(edit.range.start);
                const end = document.textDocument.offsetAt(edit.range.end);
                return text.slice(0, start) + edit.newText + text.slice(end);
            }, source);

        expect(formatted).toBe([
            'bounded context Sample',
            '',
            'in bounded context Sample {',
            '  aggregate Order {',
            '    root entity Order {',
            '      identifier id: string',
            '    }',
            '  }',
            '}'
        ].join('\n'));
        expect(formatted).not.toContain('\t');
    });

    test('does not apply document-wide separators to a selected range', async () => {
        const source = 'import "./common.tni"\nactor Customer\nbounded context Sample';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/format-selection.tni'), source
        );
        documents = [document];
        const actorOffset = source.indexOf('actor Customer');
        const edits = await services.Thinai.lsp.Formatter!.formatDocumentRange(document, {
            textDocument: { uri: document.uri.toString() },
            range: {
                start: document.textDocument.positionAt(actorOffset),
                end: document.textDocument.positionAt(actorOffset + 'actor Customer'.length)
            },
            options: { tabSize: 2, insertSpaces: true }
        });

        expect(edits).toEqual([]);
    });

    test('offers context members and declaration keywords automatically', async () => {
        const text = 'bounded context Sample in bounded context Sample {\n    \n}\n';
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/declaration-completion.tni'), text
        );
        documents = [document];

        const position = text.indexOf('\n    ') + '    '.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(position)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toEqual(expect.arrayContaining([
            'aggregate', 'application service', 'domain service', 'repository', 'factory', 'projector',
            'query service', 'query repository', 'module', 'value object', 'read model', 'data object'
        ]));
        expect(labels).not.toContain('capability');
    });

    test('completes exposed references but not declaration names', async () => {
        const spaces = '   ';
        const text = `bounded context Ordering
        in bounded context Ordering {
            aggregate Order {
                root entity Root { identifier id: AggregateId }
                value object AggregateId { raw: string }
                value object${spaces}
            }
            value object OutsideId { raw: string }
            module Api {
                exposes${spaces}
                value object OrderId { raw: string }
            }
            module Sibling {
                value object SiblingId { raw: string }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/exposes-and-value-object-completion.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const exposesOffset = text.indexOf('exposes') + 'exposes'.length + spaces.length;
        const exposesCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(exposesOffset)
        });
        expect(exposesCompletion?.items.find(item => item.label === 'OrderId')).toMatchObject({
            kind: CompletionItemKind.Struct,
            detail: expect.stringMatching(/^ValueObject .*Api\.OrderId$/)
        });
        for (const inaccessible of ['AggregateId', 'OutsideId', 'SiblingId']) {
            expect(exposesCompletion?.items.map(item => item.label)).not.toContain(inaccessible);
        }

        const sharedKernelText = `shared kernel CommonTypes {
            module SharedContracts {
                exposes${spaces}
                value object CorrelationId { raw: string }
            }
        }`;
        const sharedKernelDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-kernel-exposes-completion.tni'), sharedKernelText
        );
        documents.push(sharedKernelDocument);
        await services.shared.workspace.DocumentBuilder.build([sharedKernelDocument], { validation: false });
        const sharedExposesOffset = sharedKernelText.indexOf('exposes') + 'exposes'.length + spaces.length;
        const sharedExposesCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(sharedKernelDocument, {
            textDocument: { uri: sharedKernelDocument.uri.toString() },
            position: sharedKernelDocument.textDocument.positionAt(sharedExposesOffset)
        });
        expect(sharedExposesCompletion?.items.find(item => item.label === 'CorrelationId')).toMatchObject({
            kind: CompletionItemKind.Struct,
            detail: expect.stringMatching(/^ValueObject .*SharedContracts\.CorrelationId$/)
        });

        const nestedCompletionCases = [
            { suffix: `${spaces}\n`, typed: '' },
            { suffix: ' E\n', typed: 'E' }
        ];
        for (const [index, completionCase] of nestedCompletionCases.entries()) {
            const nestedModuleText = `shared kernel CommonTypes {
                module SharedContracts {
                    value object CorrelationId { raw: string }
                    module Identifiers {
                        exposes${completionCase.suffix}
                        value object ExternalId { raw: string }
                    }
                }
            }`;
            const nestedModule = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/nested-module-exposes-completion-${index}.tni`), nestedModuleText
            );
            documents.push(nestedModule);
            await services.shared.workspace.DocumentBuilder.build([nestedModule], { validation: false });
            const referencePrefixStart = nestedModuleText.indexOf(`exposes${completionCase.suffix}`) + 'exposes'.length +
                (completionCase.typed ? 1 : spaces.length);
            const position = nestedModule.textDocument.positionAt(referencePrefixStart + completionCase.typed.length);
            const params = {
                textDocument: { uri: nestedModule.uri.toString() },
                position
            };
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(nestedModule, params);
            const item = completion?.items.find(candidate => candidate.label === 'ExternalId');
            expect(item, completionCase.suffix).toMatchObject({
                kind: CompletionItemKind.Struct,
                detail: expect.stringMatching(/^ValueObject .*ExternalId$/)
            });
            if (completionCase.typed) {
                expect(item?.textEdit).toMatchObject({
                    range: {
                        start: nestedModule.textDocument.positionAt(referencePrefixStart),
                        end: position
                    },
                    newText: 'ExternalId'
                });
            }
        }

        const valueObjectOffset = text.indexOf('value object') + 'value object'.length + spaces.length;
        const valueObjectCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(valueObjectOffset)
        });
        expect(valueObjectCompletion?.items.some(item =>
            /^(?:ValueObject|Aggregate|Entity) /.test(item.detail ?? '')
        )).toBe(false);

        const declarationNameCases = [
            `bounded context Billing\nin bounded context Billing {\n    value object ExistingId { raw: string }\n    value object   \n}`,
            `bounded context Billing\nin bounded context Billing {\n    module Api {\n        value object ExistingId { raw: string }\n        value object   \n    }\n}`,
            `shared kernel CommonTypes {\n    value object ExistingId { raw: string }\n    value object   \n}`
        ];
        for (const [index, source] of declarationNameCases.entries()) {
            const declarationDocument = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/value-object-name-completion-${index}.tni`), source
            );
            documents.push(declarationDocument);
            await services.shared.workspace.DocumentBuilder.build([declarationDocument], { validation: false });
            const marker = source.indexOf('value object   ') + 'value object   '.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(declarationDocument, {
                textDocument: { uri: declarationDocument.uri.toString() },
                position: declarationDocument.textDocument.positionAt(marker)
            });
            expect(completion?.items.some(item =>
                /^(?:ValueObject|Aggregate|Entity|EnumType) /.test(item.detail ?? '')
            ), source).toBe(false);
        }
    });

    test('completes exposures in the nested modules from the fulfillment example', async () => {
        const text = await readFile(new URL('../../../examples/order-fulfillment/common-types.tni', import.meta.url), 'utf8');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/common-types-exposure-completion.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const cases = [
            { keywordOffset: text.indexOf('exposes CorrelationId') + 'exposes '.length, expected: ['CorrelationId', 'TenantId'] },
            { keywordOffset: text.indexOf('CorrelationId, TenantId') + 'CorrelationId, '.length, expected: ['TenantId'] },
            { keywordOffset: text.indexOf('exposes ExternalId') + 'exposes '.length, expected: ['ExternalId'] },
            { keywordOffset: text.indexOf('exposes ExternalId') + 'exposes E'.length, expected: ['ExternalId'] }
        ];
        for (const completionCase of cases) {
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.keywordOffset)
            });
            expect(completion?.items.map(item => item.label)).toEqual(expect.arrayContaining(completionCase.expected));
        }

        const marker = '__completion_position__';
        const afterExposureText = `shared kernel CommonTypes {
            module SharedContracts {
                module Identifiers {
                    exposes ExternalId
                    ${marker}
                    value object ExternalId { raw: string }
                }
            }
        }`;
        const afterExposure = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/nested-module-after-exposes-completion.tni'), afterExposureText
        );
        documents.push(afterExposure);
        await services.shared.workspace.DocumentBuilder.build([afterExposure], { validation: false });
        const afterExposurePosition = afterExposure.textDocument.positionAt(afterExposureText.indexOf(marker));
        const afterExposureCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(afterExposure, {
            textDocument: { uri: afterExposure.uri.toString() },
            position: afterExposurePosition
        });
        expect(afterExposureCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'value object', 'domain service', 'module'
        ]));
    });

    test('highlights linked behavior references as methods and fields', async () => {
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/behavior-highlighting.tni'),
            `bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                        status: string
                    }
                    value object OrderId { raw: string }
                }
                application service OrderApplication {
                    method placeOrder() {
                        behavior "Place with [[Order.Order.place]] while status is [[Order.Order.status]]"
                    }
                }
            }`
        );
        documents = [source];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const provider = services.Thinai.lsp.SemanticTokenProvider;
        expect(provider).toBeDefined();
        const tokens = await provider!.semanticHighlight(source, {
            textDocument: { uri: source.uri.toString() }
        });
        const decoded = SemanticTokensDecoder.decode(tokens, provider!.tokenTypes, source);

        const highlightedReferences = decoded.filter(token => ['place', 'status'].includes(token.text));
        expect(highlightedReferences.map(token => [token.text, token.tokenType])).toEqual([
            ['place', 'method'],
            ['status', 'property'],
            ['place', 'method'],
            ['status', 'property']
        ]);
        expect(highlightedReferences.slice(0, 2).map(token => token.tokenModifiers)).toEqual([4, 4]);
    });

    test('classifies Thinai declarations with standard semantic token types', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/semantic-declarations.tni'),
            `bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                        status: OrderStatus
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                }
                event OrderPlaced
                domain service Authorization
            }`
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const provider = services.Thinai.lsp.SemanticTokenProvider;
        const tokens = await provider!.semanticHighlight(document, {
            textDocument: { uri: document.uri.toString() }
        });
        const decoded = SemanticTokensDecoder.decode(tokens, provider!.tokenTypes, document);
        const declarations = decoded.filter(token => token.tokenModifiers === 4);
        const declaredTypes = new Map(declarations.map(token => [token.text, token.tokenType]));
        expect(declaredTypes.get('Ordering')).toBe('namespace');
        expect(declaredTypes.get('Order')).toBe('class');
        expect(declaredTypes.get('OrderId')).toBe('struct');
        expect(declaredTypes.get('OrderStatus')).toBe('enum');
        expect(declaredTypes.get('Draft')).toBe('enumMember');
        expect(declaredTypes.get('Authorization')).toBe('class');
    });

    test('maps all Thinai symbols to standard completion and symbol kinds', () => {
        const provider = new ThinaiNodeKindProvider();
        const mappings: Array<[string, CompletionItemKind, SymbolKind]> = [
            ['Aggregate', CompletionItemKind.Class, SymbolKind.Class],
            ['Entity', CompletionItemKind.Class, SymbolKind.Class],
            ['ValueObject', CompletionItemKind.Struct, SymbolKind.Struct],
            ['DataObject', CompletionItemKind.Struct, SymbolKind.Struct],
            ['ReadModel', CompletionItemKind.Struct, SymbolKind.Struct],
            ['EnumType', CompletionItemKind.Enum, SymbolKind.Enum],
            ['EnumValue', CompletionItemKind.EnumMember, SymbolKind.EnumMember],
            ['Field', CompletionItemKind.Field, SymbolKind.Field],
            ['Parameter', CompletionItemKind.Variable, SymbolKind.Variable],
            ['Method', CompletionItemKind.Method, SymbolKind.Method],
            ['DomainEvent', CompletionItemKind.Event, SymbolKind.Event],
            ['IntegrationEvent', CompletionItemKind.Event, SymbolKind.Event],
            ['Repository', CompletionItemKind.Interface, SymbolKind.Interface],
            ['QueryRepository', CompletionItemKind.Interface, SymbolKind.Interface],
            ['Module', CompletionItemKind.Module, SymbolKind.Namespace],
            ['BoundedContext', CompletionItemKind.Module, SymbolKind.Namespace],
            ['BoundedContextPart', CompletionItemKind.Module, SymbolKind.Namespace],
            ['SharedKernel', CompletionItemKind.Module, SymbolKind.Namespace],
            ['Subdomain', CompletionItemKind.Module, SymbolKind.Namespace],
            ['ContextMap', CompletionItemKind.Module, SymbolKind.Namespace],
            ['Journey', CompletionItemKind.Function, SymbolKind.Function],
            ['Actor', CompletionItemKind.Variable, SymbolKind.Object],
            ['ApplicationService', CompletionItemKind.Class, SymbolKind.Class],
            ['DomainService', CompletionItemKind.Class, SymbolKind.Class],
            ['QueryService', CompletionItemKind.Class, SymbolKind.Class],
            ['Projector', CompletionItemKind.Class, SymbolKind.Class],
            ['Factory', CompletionItemKind.Class, SymbolKind.Class]
        ];

        for (const [type, completionKind, symbolKind] of mappings) {
            const node = { $type: type } as AstNode;
            expect(provider.getCompletionItemKind(node), `${type} completion kind`).toBe(completionKind);
            expect(provider.getSymbolKind(node), `${type} symbol kind`).toBe(symbolKind);
        }

        const unknownAst = { $type: 'Unknown' } as AstNode;
        const unknownDescription = { type: 'Unknown' } as AstNodeDescription;
        expect(provider.getCompletionItemKind(unknownAst)).toBe(CompletionItemKind.Reference);
        expect(provider.getCompletionItemKind(unknownDescription)).toBe(CompletionItemKind.Reference);
        expect(provider.getSymbolKind(unknownAst)).toBe(SymbolKind.Variable);
        expect(provider.getSymbolKind(unknownDescription)).toBe(SymbolKind.Variable);
    });

    test('describes completion details for methods, fields, parameters, and enum values', () => {
        const provider = new ThinaiCompletionProvider(services.Thinai);
        const getDetail = (description: AstNodeDescription) =>
            (provider as unknown as { getCompletionDetail(value: AstNodeDescription): string }).getCompletionDetail(description);
        const typeNode = (type: string, name: string) => ({ $type: type, name }) as AstNode;
        const domainEvent = typeNode('DomainEvent', 'OrderPlaced');

        expect(getDetail({ type: 'Method', name: 'external' } as AstNodeDescription)).toBe('Method external');
        expect(getDetail({
            type: 'Method',
            name: 'find',
            node: {
                $type: 'Method',
                name: 'find',
                parameters: [
                    { $type: 'Parameter', name: 'id', primitive: 'string', optional: false },
                    { $type: 'Parameter', name: 'source', type: { ref: domainEvent, $refText: 'OrderPlaced' }, optional: true },
                    { $type: 'Parameter', name: 'ids', collection: { kind: 'List', elementPrimitive: 'number' }, optional: false }
                ],
                returnType: { ref: typeNode('ValueObject', 'OrderId'), $refText: 'OrderId' }
            } as unknown as AstNode
        } as AstNodeDescription)).toBe('Method find(id: string, source?: event OrderPlaced, ids: List<number>) returns OrderId');
        expect(getDetail({
            type: 'Method',
            name: 'summarize',
            node: {
                $type: 'Method', name: 'summarize', parameters: [],
                returnCollection: {
                    kind: 'Map',
                    elementCollection: { kind: 'Set', elementType: { ref: typeNode('ValueObject', 'OrderId'), $refText: 'OrderId' } },
                    valueCollection: { kind: 'List', elementPrimitive: 'string' }
                }
            } as unknown as AstNode
        } as AstNodeDescription)).toBe('Method summarize() returns Map<Set<OrderId>, List<string>>');
        expect(getDetail({
            type: 'Method',
            name: 'count',
            node: { $type: 'Method', name: 'count', parameters: [], returnPrimitive: 'number' } as unknown as AstNode
        } as AstNodeDescription)).toBe('Method count() returns number');
        expect(getDetail({
            type: 'Method',
            name: 'clear',
            node: { $type: 'Method', name: 'clear', parameters: [] } as unknown as AstNode
        } as AstNodeDescription)).toBe('Method clear()');

        expect(getDetail({
            type: 'Field',
            name: 'items',
            node: { $type: 'Field', name: 'items', collection: { kind: 'List', elementPrimitive: 'number' } } as unknown as AstNode
        } as AstNodeDescription)).toBe('Field items: List<number>');
        expect(getDetail({
            type: 'Field',
            name: 'status',
            node: { $type: 'Field', name: 'status', type: { ref: typeNode('EnumType', 'OrderStatus'), $refText: 'OrderStatus' } } as unknown as AstNode
        } as AstNodeDescription)).toBe('Field status: OrderStatus');
        expect(getDetail({
            type: 'Parameter',
            name: 'source',
            node: { $type: 'Parameter', name: 'source', type: { ref: domainEvent, $refText: 'OrderPlaced' }, optional: false } as unknown as AstNode
        } as AstNodeDescription)).toBe('Parameter source: event OrderPlaced');
        expect(getDetail({
            type: 'Parameter',
            name: 'value',
            node: { $type: 'Parameter', name: 'value', optional: false } as unknown as AstNode
        } as AstNodeDescription)).toBe('Parameter value: unknown');
        expect(getDetail({
            type: 'EnumValue',
            name: 'Placed',
            node: { $type: 'EnumValue', name: 'Placed', $container: typeNode('EnumType', 'OrderStatus') } as unknown as AstNode
        } as AstNodeDescription)).toBe('Enum value OrderStatus.Placed (OrderStatus)');
        expect(getDetail({
            type: 'Aggregate',
            name: 'Order',
            node: { $type: 'Aggregate', name: 'Order' } as AstNode
        } as AstNodeDescription)).toBe('Aggregate Order');
    });

    test('suggests workspace files inside import paths', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file("/workspace/order's.tni"),
            'bounded context Ordering'
        );
        documents = [target];
        const sourceText = 'import "./order\'s';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-consumer.tni'),
            sourceText
        );
        documents.push(source);

        const workspaceManager = services.shared.workspace.WorkspaceManager;
        const workspaceFolders = vi.spyOn(workspaceManager, 'workspaceFolders', 'get').mockReturnValue([
            { uri: URI.file('/workspace').toString(), name: 'workspace' }
        ]);
        const searchFolder = vi.spyOn(workspaceManager, 'searchFolder').mockResolvedValue([
            URI.file('/workspace/notes.md')
        ]);

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(sourceText.length)
        });
        await services.Thinai.lsp.CompletionProvider?.getCompletion(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(sourceText.length)
        });
        expect(searchFolder).toHaveBeenCalledTimes(1);

        const importSuggestions = completion?.items.filter(item => item.kind === CompletionItemKind.File) ?? [];
        expect(importSuggestions.map(item => item.label)).toEqual(["./order's.tni"]);
        expect(importSuggestions[0].textEdit).toMatchObject({
            newText: "./order's.tni",
            range: {
                start: source.textDocument.positionAt('import "'.length),
                end: source.textDocument.positionAt(sourceText.length)
            }
        });

        workspaceFolders.mockRestore();
        searchFolder.mockRestore();

        const outsideImport = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/outside-import.tni'), 'actor Customer'
        );
        documents.push(outsideImport);
        const ordinaryCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(outsideImport, {
            textDocument: { uri: outsideImport.uri.toString() },
            position: outsideImport.textDocument.positionAt('actor Customer'.length)
        });
        expect(ordinaryCompletion?.items.some(item => item.kind === CompletionItemKind.File)).toBe(false);
    });

    test('caches import file searches and invalidates them on file create and delete', async () => {
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-cache.tni'), 'import "./'
        );
        documents = [document];
        const workspaceManager = services.shared.workspace.WorkspaceManager;
        const workspaceFolders = vi.spyOn(workspaceManager, 'workspaceFolders', 'get').mockReturnValue([
            { uri: URI.file('/workspace').toString(), name: 'workspace' }
        ]);
        const searchFolder = vi.spyOn(workspaceManager, 'searchFolder').mockResolvedValue([]);
        const updateListeners: Array<(changed: URI[], deleted: URI[]) => void> = [];
        const onUpdate = vi.spyOn(services.shared.workspace.DocumentBuilder, 'onUpdate').mockImplementation(callback => {
            updateListeners.push(callback);
            return { dispose: () => undefined };
        });
        const completion = new ThinaiImportCompletion(services.Thinai);

        const getCompletions = () => completion.getCompletions(document, './', 9);
        await getCompletions();
        await getCompletions();
        expect(searchFolder).toHaveBeenCalledTimes(1);

        const addedUri = URI.file('/workspace/new-file.tni');
        updateListeners[0]!([addedUri], []);
        await getCompletions();
        expect(searchFolder).toHaveBeenCalledTimes(2);

        updateListeners[0]!([], [addedUri]);
        await getCompletions();
        expect(searchFolder).toHaveBeenCalledTimes(3);

        onUpdate.mockRestore();
        searchFolder.mockRestore();
        workspaceFolders.mockRestore();
    });

    test('navigates from import paths to the start of target documents', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/common-types.tni'),
            'shared kernel CommonTypes {}'
        );
        const importText = 'import "./common-types.tni"';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/import-link.tni'), importText
        );
        documents = [target, source];

        const pathOffset = importText.indexOf('./common-types.tni');
        const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(pathOffset)
        });
        expect(definitions).toHaveLength(1);
        expect(definitions?.[0]?.targetUri).toBe(target.uri.toString());
        expect(definitions?.[0]?.originSelectionRange).toEqual({
            start: source.textDocument.positionAt(pathOffset),
            end: source.textDocument.positionAt(pathOffset + './common-types.tni'.length)
        });
        expect(definitions?.[0]?.targetSelectionRange.start).toEqual({ line: 0, character: 0 });
    });

    test('navigates from an initial state to its enum value declaration', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    identifier id: OrderId
                    status: OrderStatus initial Draft
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/initial-state-definition.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

        const initialValueOffset = text.indexOf('Draft', text.indexOf('initial'));
        const definitions = await services.Thinai.lsp.DefinitionProvider?.getDefinition(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(initialValueOffset)
        });

        expect(definitions).toHaveLength(1);
        expect(definitions?.[0]?.targetUri).toBe(document.uri.toString());
        expect(definitions?.[0]?.targetSelectionRange.start).toEqual(
            document.textDocument.positionAt(text.lastIndexOf('Draft'))
        );
    });

    test('navigates only from within single- or double-quoted import paths', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/common-types.tni'), 'shared kernel CommonTypes {}'
        );
        const sourceText = `import './common-types.tni'\nimport { CommonTypes } from "./common-types.tni"`;
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/quoted-imports.tni'), sourceText
        );
        documents = [target, source];
        const provider = services.Thinai.lsp.DefinitionProvider!;

        for (const pathStart of [sourceText.indexOf('./common-types.tni'), sourceText.lastIndexOf('./common-types.tni')]) {
            const definition = await provider.getDefinition(source, {
                textDocument: { uri: source.uri.toString() },
                position: source.textDocument.positionAt(pathStart)
            });
            expect(definition).toHaveLength(1);
            expect(definition?.[0]?.targetUri).toBe(target.uri.toString());
        }

        const closingQuote = sourceText.indexOf("'./common-types.tni'") + './common-types.tni'.length + 1;
        expect(await provider.getDefinition(source, {
            textDocument: { uri: source.uri.toString() },
            position: source.textDocument.positionAt(closingQuote)
        })).toBeUndefined();
    });

    test('completes invocation path segments with Thinai symbol kinds', async () => {
        const template = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method place()
                    method submit() { invokes   }
                    identifier id: OrderId
                }
                value object OrderId { raw: string }
            }
        }`;
        documents = [];
        for (const prefix of ['', 'O', 'Or', 'Order']) {
            const typedText = template.replace('invokes  ', `invokes ${prefix} `);
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/invocation-completion-${prefix || 'empty'}.tni`), typedText
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
            const source = typedText.indexOf(`invokes ${prefix} `) + 'invokes '.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source + prefix.length)
            });
            expect(completion?.items.some(item => item.label === 'Order' && item.detail?.includes('Aggregate') === true)).toBe(true);
        }

        const withPrefix = template.replace('invokes  ', 'invokes Order. ');
        const prefixedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/invocation-completion-prefix.tni'), withPrefix
        );
        documents.push(prefixedDocument);
        await services.shared.workspace.DocumentBuilder.build([prefixedDocument], { validation: true });
        const childSegmentOffset = withPrefix.indexOf('invokes Order.') + 'invokes Order.'.length;
        const childItems = await services.Thinai.lsp.CompletionProvider?.getCompletion(prefixedDocument, {
            textDocument: { uri: prefixedDocument.uri.toString() },
            position: prefixedDocument.textDocument.positionAt(childSegmentOffset)
        });
        expect(childItems?.items.find(item => item.label === 'place')).toMatchObject({
            kind: CompletionItemKind.Method,
            detail: expect.stringContaining('place(')
        });
        expect(childItems?.items.find(item => item.label === 'Order')).toMatchObject({
            kind: CompletionItemKind.Class,
            detail: expect.stringContaining('Entity Order')
        });
    });

    test('keeps nested behavior references available while typing', async () => {
        for (const prefix of ['o', 'or', 'order']) {
            const text = `bounded context Ordering in bounded context Ordering {
                data object Request { orderId: string }
                application service OrderApplication {
                    method place(request: Request) { behavior "
                        Use [[request.${prefix}]]
                    " }
                }
            }`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/specification-completion-${prefix}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

            const referenceStart = text.indexOf('[[request.') + '[[request.'.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(referenceStart + prefix.length)
            });
            expect(completion?.items.some(item => item.label === 'orderId' && item.kind === CompletionItemKind.Field)).toBe(true);
        }
    });

    test('does not offer language keywords in multiline specification prose', async () => {
        const marker = '__completion_position__';
        const cases = [
            {
                name: 'closed double-quoted multiline specification',
                source: `bounded context Ordering in bounded context Ordering {
                    application service App {
                        method run() { behavior "
                            Place the order; literal \\[[ is not a reference.
                            inv${marker}
                        " }
                    }
                }`
            },
            {
                name: 'closed triple-double-quoted multiline specification',
                source: `bounded context Ordering in bounded context Ordering {
                    application service App {
                        method run() { behavior """
                            Literal { braces } and [[ links stay prose.
                            inv${marker}
                        """ }
                    }
                }`
            },
            {
                name: 'open single-quoted multiline specification with an escaped quote',
                source: String.raw`bounded context Ordering in bounded context Ordering {
                    application service App {
                        method run() { behavior '
                            The order\'s status is still being described.
                            tran${marker}`
            }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.source.indexOf(marker);
            const text = completionCase.source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/multiline-specification-keyword-completion-${index}.tni`), text
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items ?? [], completionCase.name).toEqual([]);
        }
    });

    test('triggers completion when an inline specification reference opens', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            data object Request { orderId: string }
            application service OrderApplication {
                method place(request: Request) { behavior "Use [[request.orderId]]" }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/specification-open-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(services.Thinai.lsp.CompletionProvider?.completionOptions?.triggerCharacters).toContain('[');
        const openingOffset = text.indexOf('[[request.orderId]]') + '[['.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(openingOffset)
        });
        expect(completion?.items.some(item => item.label === 'request' && item.kind === CompletionItemKind.Variable)).toBe(true);
    });

    test('filters reads-from completion candidates by CQRS method role', async () => {
        const marker = '__read_source__';
        const source = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            repository OrderRepository {
                manages Order.Order
            }
            read model OrderSummary { status: string }
            query repository OrderSummaryRepository {
                serves OrderSummary
            }
            application service Commands {
                method place() { reads from ${marker} }
            }
            query service Queries {
                method find() returns OrderSummary { reads from ${marker} }
            }
        }`;
        const positions = [...source.matchAll(new RegExp(marker, 'g'))].map(match => match.index!);
        const text = source.replace(marker, '').replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-completion.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const appPosition = document.textDocument.positionAt(positions[0]!);
        const queryPosition = document.textDocument.positionAt(positions[1]! - marker.length);
        const appCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: appPosition
        });
        const queryCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: queryPosition
        });
        const appLabels = appCompletion?.items.map(item => item.label) ?? [];
        const queryLabels = queryCompletion?.items.map(item => item.label) ?? [];
        expect(appLabels).toContain('OrderRepository');
        expect(appLabels).not.toContain('OrderSummaryRepository');
        expect(queryLabels).toContain('OrderSummaryRepository');
        expect(queryLabels).not.toContain('OrderRepository');
        const repositoryItem = appCompletion?.items.find(item => item.label === 'OrderRepository');
        expect(repositoryItem?.kind).toBe(CompletionItemKind.Interface);
        expect(repositoryItem?.textEdit).toMatchObject({
            newText: 'OrderRepository',
            range: { start: appPosition, end: appPosition }
        });
    });

    test('does not offer method-body siblings while completing a reads-from source', async () => {
        const prefix = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            repository OrderRepository {
                manages Order.Order
            }
            application service Commands {
                method place() {
                    reads from OrderRep`;
        const source = `${prefix}\n                }\n            }\n        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-partial-source.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('OrderRepository');
        for (const sibling of ['behavior', 'invokes', 'reads from', 'projects', 'invariant', 'postcondition']) {
            expect(labels).not.toContain(sibling);
        }
    });

    test('offers method-body siblings after a complete reads-from source', async () => {
        const prefix = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            repository OrderRepository {
                manages Order.Order
            }
            application service Commands {
                method place() {
                    reads from OrderRepository`;
        const source = `${prefix}\n                }\n            }\n        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-complete-source-sibling.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const behavior = completion?.items.find(item => item.label === 'behavior');
        expect(behavior).toBeDefined();
        expect(behavior?.data?.thinaiSiblingCompletion).toBe(true);
    });

    test('completes authorized external query methods as reads-from sources', async () => {
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-api-contexts.tni'),
            'bounded context Catalog bounded context Ordering'
        );
        const catalog = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-api-catalog.tni'),
            `import "./read-api-contexts.tni"
             in bounded context Catalog {
                 module PublicApi {
                     exposes ProductQueries, ProductInfo
                     query service ProductQueries {
                         method findProduct(sku: string) returns ProductInfo
                     }
                     data object ProductInfo {
                         available: boolean
                     }
                 }
             }`
        );
        const contextMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-api-map.tni'),
            `import "./read-api-contexts.tni"
             context map Commerce {
                 customer Ordering -> supplier Catalog
             }`
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/read-api-consumer.tni'),
            `import "./read-api-contexts.tni"
             import "./read-api-catalog.tni"
             import { Commerce } from "./read-api-map.tni"
             in bounded context Ordering {
                 application service OrderCommands {
                     method checkProduct(sku: string) {
                         reads from Catalog.PublicApi.ProductQueries.
                     }
                 }
             }`
        );
        documents.push(contexts, catalog, contextMap, consumer);
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(consumer.textDocument.getText().indexOf('ProductQueries.') + 'ProductQueries.'.length)
        });
        const queryItem = completion?.items.find(item => item.label === 'findProduct');
        expect(queryItem).toBeDefined();
        expect(queryItem?.kind).toBe(CompletionItemKind.Method);
        const cursorOffset = consumer.textDocument.getText().indexOf('ProductQueries.') + 'ProductQueries.'.length;
        expect(queryItem?.textEdit).toMatchObject({
            newText: 'findProduct',
            range: {
                start: consumer.textDocument.positionAt(cursorOffset),
                end: consumer.textDocument.positionAt(cursorOffset)
            }
        });
        expect(completion?.items.map(item => item.label)).not.toContain('OrderRepository');
    });

    test('offers read models for projector targets with read-model icons', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            read model OrderSummary { status: string }
            event OrderPlaced
            projector OrderProjector {
                method onOrderPlaced(source: OrderPlaced) { projects   }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('projects  ') + 'projects '.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        expect(completion?.items.find(item => item.label === 'OrderSummary')).toMatchObject({
            kind: CompletionItemKind.Struct,
            detail: expect.stringContaining('OrderSummary')
        });
    });

    test('offers entity fields and enum members in transition clauses', async () => {
        const text = `bounded context Shipping in bounded context Shipping {
            aggregate Shipment {
                root entity Shipment {
                    method ship() { transition status from  to Shipped }
                    identifier id: ShipmentId
                    status: ShipmentStatus
                }
                value object ShipmentId { raw: string }
                enum ShipmentStatus { Open, Shipped }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/transition-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const transition = text.indexOf('transition status');
        const fieldItems = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(transition + 'transition sta'.length)
        });
        expect(fieldItems?.items.find(item => item.label === 'status')).toMatchObject({
            kind: CompletionItemKind.Field,
            detail: expect.stringContaining('.status:')
        });

        const enumValueOffset = text.indexOf('from  to') + 'from '.length;
        const valueItems = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(enumValueOffset)
        });
        expect(valueItems?.items.find(item => item.label === 'Open')).toMatchObject({
            kind: CompletionItemKind.EnumMember,
            detail: expect.stringContaining('.Open')
        });
        expect(valueItems?.items.map(item => item.label)).not.toContain('Shipped');
    });

    test('completes each transition change from its own enum field', async () => {
        const fieldText = `bounded context Shipping in bounded context Shipping {
            aggregate Shipment {
                root entity Shipment {
                    method ship() {
                        transition status from Open to Shipped,  from Pending to Confirmed
                    }
                    identifier id: ShipmentId
                    status: ShipmentStatus
                    paymentStatus: PaymentStatus
                }
                value object ShipmentId { raw: string }
                enum ShipmentStatus { Open, Shipped }
                enum PaymentStatus { Pending, Confirmed }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/multiple-transition-change-completion.tni'), fieldText
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const secondFieldOffset = fieldText.indexOf('Shipped,  ') + 'Shipped,  '.length;
        const fieldCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(secondFieldOffset)
        });
        expect(fieldCompletion?.items.map(item => item.label)).toContain('paymentStatus');
        expect(fieldCompletion?.items.map(item => item.label)).not.toContain('status');
        expect(fieldCompletion?.items.map(item => item.label)).not.toContain('id');
        for (const sibling of ['when', 'invariant', 'precondition', 'postcondition', 'behavior', 'invokes', 'transition', 'emits', 'projects']) {
            expect(fieldCompletion?.items.map(item => item.label), `after transition comma: ${sibling}`).not.toContain(sibling);
        }

        const stateText = fieldText.replace('Shipped,  from', 'Shipped, paymentStatus from');
        const stateDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/multiple-transition-change-state-completion.tni'), stateText
        );
        documents.push(stateDocument);
        await services.shared.workspace.DocumentBuilder.build([stateDocument], { validation: false });
        const secondFromOffset = stateText.indexOf('paymentStatus from ') + 'paymentStatus from '.length;
        const fromCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(stateDocument, {
            textDocument: { uri: stateDocument.uri.toString() },
            position: stateDocument.textDocument.positionAt(secondFromOffset)
        });
        expect(fromCompletion?.items.map(item => item.label)).toContain('Pending');
        expect(fromCompletion?.items.map(item => item.label)).not.toContain('Open');
        expect(fromCompletion?.items.map(item => item.label)).not.toContain('Shipped');

        const toOffset = stateText.indexOf('paymentStatus from Pending to ') + 'paymentStatus from Pending to '.length;
        const toCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(stateDocument, {
            textDocument: { uri: stateDocument.uri.toString() },
            position: stateDocument.textDocument.positionAt(toOffset)
        });
        expect(toCompletion?.items.map(item => item.label)).toContain('Confirmed');
        expect(toCompletion?.items.map(item => item.label)).not.toContain('Pending');
    });

    test('suggests when guards after transitions, emissions, method invocations, and journey steps', async () => {
        const marker = '__completion_position__';
        const common = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method validate()
                    method place() { CLAUSE }
                    identifier id: OrderId
                    status: OrderStatus
                    paymentStatus: PaymentStatus
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed }
                enum PaymentStatus { Pending, Confirmed }
            }
            event OrderPlaced
            application service OrderApplication {
                method placeOrder() {}
            }
        }`;
        const cases = [
            {
                name: 'transition',
                expected: ['when'],
                text: common.replace('CLAUSE', `transition status from Draft to Placed ${marker}`)
            },
            {
                name: 'emission',
                expected: ['when'],
                text: common.replace('CLAUSE', `emits OrderPlaced ${marker}`)
            },
            {
                name: 'method invocation',
                expected: ['when'],
                text: common.replace('CLAUSE', `invokes validate ${marker}`)
            },
            {
                name: 'journey step',
                expected: ['when'],
                text: `actor Customer
                    ${common.replace('CLAUSE', '')}
                    journey PlaceOrder { by Customer { invoke Ordering.OrderApplication.placeOrder with "Order input" ${marker} } }`
            },
            {
                name: 'journey step clauses',
                expected: ['with', 'when'],
                text: `actor Customer
                    ${common.replace('CLAUSE', '')}
                    journey PlaceOrder { by Customer { invoke Ordering.OrderApplication.placeOrder ${marker} } }`
            }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.text.indexOf(marker);
            const text = completionCase.text.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/when-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
            expect(document.parseResult.parserErrors, completionCase.name).toEqual([]);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            for (const keyword of completionCase.expected) {
                expect(completion?.items.map(item => item.label), completionCase.name).toContain(keyword);
            }
        }

        const partialText = common.replace('CLAUSE', 'invokes validate w');
        const partialDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/when-prefix-completion.tni'), partialText
        );
        documents.push(partialDocument);
        await services.shared.workspace.DocumentBuilder.build([partialDocument], { validation: false });
        const partialOffset = partialText.indexOf('invokes validate w') + 'invokes validate w'.length;
        const partialCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(partialDocument, {
            textDocument: { uri: partialDocument.uri.toString() },
            position: partialDocument.textDocument.positionAt(partialOffset)
        });
        const whenItem = partialCompletion?.items.find(item => item.label === 'when');
        expect(whenItem?.textEdit).toMatchObject({
            newText: 'when',
            range: {
                start: partialDocument.textDocument.positionAt(partialOffset - 1),
                end: partialDocument.textDocument.positionAt(partialOffset)
            }
        });
    });

    test('does not offer optional clauses after method effects disallowed for their owner', async () => {
        const marker = '__completion_position__';
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate OrderAggregate {
                root entity Order {
                    identifier id: OrderId
                    status: OrderStatus
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed }
            }
            event OrderPlaced
            query service OrderQueries {
                method findOrder() returns string { emits OrderPlaced ${marker} }
            }
            domain service Pricing { method calculate() returns number }
            projector OrderProjector {
                method onOrderPlaced(source: OrderPlaced) { invokes Pricing.calculate ${marker} }
            }
            application service OrderCommands {
                method place() { transition status from Draft to Placed ${marker} }
            }
        }
        actor Customer
        journey ReadOrder {
            by Customer { invoke Ordering.OrderQueries.findOrder ${marker} }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/disallowed-optional-specification-clauses.tni'), text.split(marker).join('')
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        let searchFrom = 0;
        for (const source of [
            'emits OrderPlaced ',
            'invokes Pricing.calculate ',
            'transition status from Draft to Placed ',
            'invoke Ordering.OrderQueries.findOrder '
        ]) {
            const offset = text.indexOf(source, searchFrom) + source.length;
            searchFrom = offset;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items.map(item => item.label), source).not.toContain('when');
            if (source.startsWith('invoke ')) {
                expect(completion?.items.map(item => item.label), source).not.toContain('with');
            }
        }
    });

    test('offers required transition and emission continuations before optional guards', async () => {
        const marker = '__completion_position__';
        const common = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method place() { CLAUSE }
                    identifier id: OrderId
                    status: OrderStatus
                    paymentStatus: PaymentStatus
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed }
                enum PaymentStatus { Pending, Confirmed }
            }
            event OrderPlaced
        }`;
        const cases = [
            {
                name: 'transition field requires from',
                clause: `transition status ${marker}`,
                expected: ['from'],
                forbidden: ['when']
            },
            {
                name: 'transition source state requires to',
                clause: `transition status from Draft ${marker}`,
                expected: ['to'],
                forbidden: ['when']
            },
            {
                name: 'partial destination state does not allow when',
                clause: `transition status from Draft to Pl${marker}`,
                expected: ['Placed'],
                forbidden: ['when']
            },
            {
                name: 'partial when after a forward-declared transition field and state',
                clause: `transition status from Draft to Placed w${marker}`,
                expected: ['when'],
                forbidden: []
            },
            {
                name: 'transition comma requires another field before when',
                clause: `transition status from Draft to Placed, ${marker}`,
                expected: ['paymentStatus'],
                forbidden: ['when']
            },
            {
                name: 'emission requires an event before when',
                clause: `emits ${marker}`,
                expected: ['OrderPlaced'],
                forbidden: ['when']
            },
            {
                name: 'partial event name does not allow when',
                clause: `emits OrderP${marker}`,
                expected: ['OrderPlaced'],
                forbidden: ['when']
            },
            {
                name: 'complete emission allows when',
                clause: `emits OrderPlaced ${marker}`,
                expected: ['when'],
                forbidden: []
            },
            {
                name: 'partially typed when after a forward-declared event',
                clause: `emits OrderPlaced w${marker}`,
                expected: ['when'],
                forbidden: []
            },
            {
                name: 'does not repeat a fully typed when keyword',
                clause: `emits OrderPlaced when${marker}`,
                expected: [],
                forbidden: ['when']
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const text = common.replace('CLAUSE', completionCase.clause);
            const offset = text.indexOf(marker);
            const source = text.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/required-operation-continuation-${index}.tni`), source
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const label of completionCase.expected) {
                expect(labels, completionCase.name).toContain(label);
            }
            for (const label of completionCase.forbidden) {
                expect(labels, completionCase.name).not.toContain(label);
            }
            if (completionCase.name === 'partial when after a forward-declared transition field and state') {
                const whenItem = completion?.items.find(item => item.label === 'when');
                expect(whenItem?.textEdit).toMatchObject({
                    newText: 'when',
                    range: {
                        start: document.textDocument.positionAt(offset - 1),
                        end: document.textDocument.positionAt(offset)
                    }
                });
            }
            if (completionCase.name === 'partially typed when after a forward-declared event') {
                const whenItem = completion?.items.find(item => item.label === 'when');
                expect(whenItem?.textEdit).toMatchObject({
                    newText: 'when',
                    range: {
                        start: document.textDocument.positionAt(offset - 1),
                        end: document.textDocument.positionAt(offset)
                    }
                });
            }
        }
    });

    test('offers transition continuations only for enum fields in entity methods', async () => {
        const marker = '__completion_position__';
        const cases = [
            {
                name: 'application-service method',
                source: `bounded context Ordering\nin bounded context Ordering { application service App { method run() { transition status f${marker} } } }`
            },
            {
                name: 'non-enum entity field',
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { method run() { transition status f${marker} } status: string } } }`
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.source.indexOf(marker);
            const source = completionCase.source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/invalid-transition-continuation-${index}.tni`), source
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items.map(item => item.label), completionCase.name).not.toContain('from');
        }
    });

    test('inserts optional clauses with required spacing at a completed path', async () => {
        const text = `bounded context Ordering
        in bounded context Ordering {
            application service OrderApplication {
                method validate()
                method placeOrder() {
                    invokes validate
                }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/optional-clause-spacing.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        const offset = text.indexOf('invokes validate') + 'invokes validate'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('when');
        expect(labels).toContain('invokes');
        expect(labels).not.toContain('emits');
        expect(completion?.items.find(item => item.label === 'invokes')?.detail).toBe('Language keyword');
        expect(completion?.items.find(item => item.label === 'when')?.textEdit).toMatchObject({
            newText: ' when',
            range: { start: document.textDocument.positionAt(offset), end: document.textDocument.positionAt(offset) }
        });
    });

    test('suggests optional keywords at their grammar positions', async () => {
        const marker = '__completion_position__';
        const cases = [
            { name: 'bounded-context realizes', keyword: 'realizes', source: `subdomain Commerce\nbounded context Ordering ${marker}` },
            { name: 'subdomain kind', keyword: 'kind', source: `subdomain Commerce ${marker}` },
            { name: 'module dependencies', keyword: 'depends on', source: `bounded context Ordering\nin bounded context Ordering { module Api ${marker} {} }` },
            { name: 'value-object mirrors', keyword: 'mirrors', source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { value object Base { raw: string }\nvalue object Mirror ${marker} { raw: string } } }` },
            { name: 'method return type', keyword: 'returns', source: `bounded context Ordering\nin bounded context Ordering { application service Queries { method find() ${marker} } }` },
            { name: 'field initial state', keyword: 'initial', source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { identifier id: Id\nstatus: Status ${marker} }\nvalue object Id { raw: string }\nenum Status { Draft, Placed } } }` }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.source.indexOf(marker);
            const text = completionCase.source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/optional-keyword-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            expect(document.parseResult.parserErrors, completionCase.name).toHaveLength(0);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items.map(item => item.label), completionCase.name).toContain(completionCase.keyword);
        }
    });

    test('offers only realizes before a newline after a bounded-context declaration', async () => {
        const sameLineText = 'bounded context Ordering ';
        const sameLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/realizes-same-line-completion.tni'), sameLineText
        );
        documents.push(sameLine);
        const sameLinePosition = sameLine.textDocument.positionAt(sameLineText.length);
        const sameLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(sameLine, {
            textDocument: { uri: sameLine.uri.toString() },
            position: sameLinePosition
        });
        expect(sameLineCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'realizes', 'bounded context', 'subdomain', 'context map'
        ]));

        const nextLineText = 'bounded context Ordering\n';
        const nextLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/realizes-next-line-completion.tni'), nextLineText
        );
        documents.push(nextLine);
        const nextLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(nextLine, {
            textDocument: { uri: nextLine.uri.toString() },
            position: nextLine.textDocument.positionAt(nextLineText.length)
        });
        const nextLineLabels = nextLineCompletion?.items.map(item => item.label) ?? [];
        expect(nextLineLabels).toContain('realizes');
        expect(nextLineLabels).toContain('bounded context');
        expect(nextLineLabels).toContain('in bounded context');
    });

    test('keeps required keyword continuations available on the same line', async () => {
        const cases = [
            { name: 'bounded context', source: 'bounded ', expected: ['context'] },
            { name: 'in bounded context', source: 'in bounded ', expected: ['context'] },
            { name: 'context map', source: 'context ', expected: ['map'] },
            { name: 'shared kernel', source: 'shared ', expected: ['kernel'] },
            { name: 'application service', source: 'bounded context X\nin bounded context X {\napplication ', expected: ['service'] },
            { name: 'domain service', source: 'bounded context X\nin bounded context X {\ndomain ', expected: ['service'] },
            { name: 'read model', source: 'bounded context X\nin bounded context X {\nread ', expected: ['model'] },
            { name: 'data object', source: 'bounded context X\nin bounded context X {\ndata ', expected: ['object'] },
            { name: 'value object', source: 'bounded context X\nin bounded context X { aggregate A {\nvalue ', expected: ['object'] },
            { name: 'root entity', source: 'bounded context X\nin bounded context X { aggregate A {\nroot ', expected: ['entity'] },
            { name: 'query service and repository', source: 'bounded context X\nin bounded context X {\nquery ', expected: ['repository', 'service'] },
            { name: 'integration event', source: 'bounded context X\nin bounded context X {\nintegration ', expected: ['event'] },
            { name: 'module depends on', source: 'bounded context X\nin bounded context X {\nmodule M depends ', expected: ['on'] },
            { name: 'repository manages', source: 'bounded context X\nin bounded context X {\nrepository R { ', expected: ['manages'] },
            { name: 'query repository serves', source: 'bounded context X\nin bounded context X {\nquery repository R { ', expected: ['serves'] },
            { name: 'import from', source: 'import { Foo } ', expected: ['from'] }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/keyword-continuation-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const position = document.textDocument.positionAt(completionCase.source.length);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const expected of completionCase.expected) {
                expect(labels, completionCase.name).toContain(expected);
            }
        }
    });

    test('completes subdomain kind values and partial values', async () => {
        const cases = [
            { source: 'subdomain Commerce kind ', expected: ['core', 'supporting', 'generic'] },
            { source: 'subdomain Commerce kind s', expected: ['supporting'] }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/subdomain-kind-completion-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.length)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const expected of completionCase.expected) {
                expect(labels, completionCase.source).toContain(expected);
                expect(labels.filter(label => label === expected), `${completionCase.source}: ${expected}`).toHaveLength(1);
            }
            if (completionCase.source.endsWith('kind s')) {
                expect(completion?.items.find(item => item.label === 'supporting')?.textEdit).toMatchObject({
                    newText: 'supporting',
                    range: {
                        start: document.textDocument.positionAt(completionCase.source.length - 1),
                        end: document.textDocument.positionAt(completionCase.source.length)
                    }
                });
            }
        }
    });

    test('completes partial multiword keywords and replaces only their typed prefix', async () => {
        const cases = [
            ['bounded c', 'context'],
            ['in bounded c', 'context'],
            ['shared k', 'kernel'],
            ['application s', 'service'],
            ['domain s', 'service'],
            ['query r', 'repository'],
            ['query s', 'service'],
            ['read m', 'model'],
            ['data o', 'object'],
            ['value o', 'object'],
            ['bounded context X\nin bounded context X { aggregate A { root e', 'entity'],
            ['integration e', 'event'],
            ['depends o', 'on'],
            ['context m', 'map'],
            ['import { Foo } f', 'from'],
            ['repository Orders { m', 'manages'],
            ['query repository Orders { s', 'serves'],
            ['bounded context X\nin bounded context X { application service A { method run() { reads f', 'reads from'],
            ['bounded context X\nin bounded context X { application service A { method run() { reads from OrderRepository w', 'when'],
            ['bounded context Ordering\nin bounded context Ordering { aggregate Order { enum Status { Draft, Placed } root entity Order { status: Status method place() { transition status f', 'from'],
            ['bounded context Ordering\nin bounded context Ordering { aggregate Order { enum Status { Draft, Placed } root entity Order { status: Status method place() { transition status from Draft t', 'to'],
            ['sharedKernel Common { p', 'participants'],
            ['customer Ordering -> s', 'supplier'],
            ['partner Ordering <-> p', 'partner'],
            ['customer Ordering { i', 'integrationPatterns'],
            ['customer Alpha -> supplier Beta { i', 'integrationPatterns']
        ] as const;

        for (const [index, [source, expected]] of cases.entries()) {
            const text = expected === 'from' || expected === 'to' || expected === 'reads from' ? `${source} } } }` : source;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/partial-keyword-${index}.tni`), text
            );
            documents.push(document);
            if (expected === 'from' || expected === 'to' || expected === 'reads from') {
                await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            }
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source.length)
            });
            const item = completion?.items.find(candidate => candidate.label === expected);
            expect(item, source).toBeDefined();
            expect(completion?.items.filter(candidate => candidate.label === expected), source).toHaveLength(1);
            if (expected === 'reads from') {
                expect(item?.textEdit?.newText).toContain('reads from');
                expect(completion?.items.map(candidate => candidate.label)).not.toContain('reads');
                expect(completion?.items.map(candidate => candidate.label)).not.toContain('from');
            } else {
                expect(item?.textEdit).toMatchObject({
                    newText: expected,
                    range: {
                        start: document.textDocument.positionAt(source.length - 1),
                        end: document.textDocument.positionAt(source.length)
                    }
                });
            }
        }
    });

    test('completes repository block statements and query-repository sources', async () => {
        const marker = '__cursor__';
        const cases = [
            {
                name: 'write repository in an empty block',
                body: `repository OrderRepository {
                    ${marker}
                }`,
                expected: 'manages'
            },
            {
                name: 'query repository in an empty block',
                body: `query repository OrderSummaryRepository {
                    ${marker}
                }`,
                expected: 'serves'
            },
            {
                name: 'query repository source after serves',
                body: `query repository OrderSummaryRepository {
                    serves OrderSummary
                    ${marker}
                }`,
                expected: 'reads from'
            },
            {
                name: 'query repository source after serves on the same line',
                body: `query repository OrderSummaryRepository { serves OrderSummary${marker} }`,
                expected: 'reads from'
            },
            {
                name: 'query repository source after a partially typed served model',
                body: `query repository OrderSummaryRepository {
                    serves OrderSumm${marker}
                }`,
                expected: 'reads from'
            },
            {
                name: 'query repository reads continuation',
                body: `query repository OrderSummaryRepository {
                    serves OrderSummary
                    reads ${marker}
                }`,
                expected: 'reads from'
            },
            {
                name: 'aggregate sources for a query repository',
                body: `query repository OrderSummaryRepository {
                    serves OrderSummary
                    reads from ${marker}
                }`,
                expected: 'Order'
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const source = `bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                read model OrderSummary { status: string }
                ${completionCase.body}
            }`;
            const offset = source.indexOf(marker);
            const text = source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/repository-block-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset),
                ...(completionCase.name === 'query repository source after serves'
                    ? { context: { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: '\n' } }
                    : {})
            });
            expect(services.Thinai.lsp.CompletionProvider?.completionOptions?.triggerCharacters).toContain('\n');
            const item = completion?.items.find(candidate => candidate.label === completionCase.expected);
            expect(item, `${completionCase.name}: ${completion?.items.map(candidate => candidate.label).join(', ')}`).toBeDefined();
            if (completionCase.name === 'query repository in an empty block') {
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('reads from');
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('reads');
            }
            if (completionCase.name === 'query repository source after serves' ||
                completionCase.name === 'query repository source after serves on the same line' ||
                completionCase.name === 'query repository source after a partially typed served model') {
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('reads');
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('from');
            }
            if (completionCase.name === 'query repository reads continuation') {
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('reads');
                expect(completion?.items.map(candidate => candidate.label), completionCase.name).not.toContain('from');
            }
            if (['manages', 'serves', 'reads', 'from', 'reads from'].includes(completionCase.expected)) {
                expect(item?.kind, completionCase.name).toBe(CompletionItemKind.Keyword);
                if (completionCase.expected === 'reads from') {
                    expect(item?.textEdit?.newText, completionCase.name).toMatch(/\r?\n\s*reads from$/u);
                } else {
                    expect(item?.textEdit?.newText, completionCase.name).toContain(completionCase.expected);
                }
            }
            if (completionCase.expected === 'Order') {
                expect(completion?.items.map(item => item.label), completionCase.name).not.toContain('OrderRepository');
                expect(item?.kind).toBe(CompletionItemKind.Class);
                expect(item?.textEdit).toMatchObject({
                    newText: 'Order',
                    range: {
                        start: document.textDocument.positionAt(offset),
                        end: document.textDocument.positionAt(offset)
                    }
                });
            }
        }
    });

    test('does not leak enclosing keywords after a query repository read source', async () => {
        const marker = '__cursor__';
        const source = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            read model OrderSummary {
                status: string
            }
            query repository OrderSummaryRepository {
                serves OrderSummary
                reads from Order
                ${marker}
            }
        }`;
        const offset = source.indexOf(marker);
        const text = source.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/query-repository-read-sibling-completion.tni'), text
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        const forbidden = [
            'aggregate', 'application service', 'domain service', 'projector', 'query repository',
            'query service', 'read model', 'repository', 'behavior', 'invokes', 'reads from', 'projects'
        ];
        expect(labels.filter(label => forbidden.includes(String(label)))).toEqual([]);
    });

    test('completes partially typed optional continuations', async () => {
        const cases = [
            { source: 'bounded context Ordering r', expected: 'realizes', typed: 'r' },
            { source: 'subdomain Commerce k', expected: 'kind', typed: 'k' },
            { source: 'bounded context Ordering\nin bounded context Ordering {\n    module Api d\n}', expected: 'depends', typed: 'd' },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    aggregate Order {\n        value object Mirror m { raw: string }\n    }\n}',
                expected: 'mirrors',
                typed: 'm'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    aggregate Order {\n        root entity Order {\n            status: Status i\n        }\n        enum Status { Draft, Placed }\n    }\n}',
                expected: 'initial',
                typed: 'i'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    application service Queries {\n        method find() r\n    }\n}',
                expected: 'returns',
                typed: 'r'
            },
            { source: 'bounded context Ordering\nr', expected: 'realizes', typed: 'r' },
            { source: 'subdomain Commerce\nk', expected: 'kind', typed: 'k' },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    module Api\n    d\n}',
                expected: 'depends',
                typed: 'd'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    aggregate Order {\n        value object Mirror\n        m { raw: string }\n    }\n}',
                expected: 'mirrors',
                typed: 'm'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    application service Queries {\n        method find()\n        r\n    }\n}',
                expected: 'returns',
                typed: 'r'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    aggregate Order {\n        root entity Order {\n            status: Status\n            i\n        }\n        enum Status { Draft, Placed }\n    }\n}',
                expected: 'initial',
                typed: 'i'
            }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/partial-optional-continuation-${index}.tni`), completionCase.source
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const prefixStart = completionCase.source.lastIndexOf(completionCase.typed);
            const position = document.textDocument.positionAt(prefixStart + completionCase.typed.length);
            if (completionCase.expected === 'initial') {
                const provider = services.Thinai.lsp.CompletionProvider as unknown as {
                    getPartialInitialKeywordCompletions(document: LangiumDocument, position: import('vscode-languageserver').Position): CompletionItem[];
                };
                expect(provider.getPartialInitialKeywordCompletions(document, position)).not.toEqual([]);
            }
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.expected);
            expect(item, completionCase.source).toBeDefined();
            expect(item?.textEdit).toMatchObject({
                range: { start: document.textDocument.positionAt(prefixStart), end: position },
                newText: completionCase.expected
            });
        }
    });

    test('suggests bounded contexts without context-map keywords in relationship endpoints', async () => {
        const cases = [
            { name: 'customer-supplier supplier', relationship: 'customer Alpha -> supplier ' },
            { name: 'partnership right', relationship: 'partner Alpha <-> partner ' },
            { name: 'separate ways right', relationship: 'separateWays Alpha -x- ' }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${completionCase.relationship}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-endpoint-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(text.indexOf(completionCase.relationship) + completionCase.relationship.length)
            });
            const labels = completion?.items.map(item => item.label) ?? [];

            expect(labels, completionCase.name).not.toContain('Alpha');
            expect(labels, completionCase.name).toContain('Beta');
            expect(completion?.items.every(item => item.detail?.startsWith('BoundedContext ')), completionCase.name)
                .toBe(true);
            for (const keyword of ['customer', 'partner', 'separateWays', 'sharedKernel']) {
                expect(labels, completionCase.name).not.toContain(keyword);
            }
        }

        const emptyMapText = 'context map Relations {\n    \n}';
        const emptyMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map-relationship-keyword-completion.tni'), emptyMapText
        );
        documents.push(emptyMap);
        const relationshipKeywords = await services.Thinai.lsp.CompletionProvider?.getCompletion(emptyMap, {
            textDocument: { uri: emptyMap.uri.toString() },
            position: emptyMap.textDocument.positionAt(emptyMapText.indexOf('\n    ') + '\n    '.length)
        });
        expect(relationshipKeywords?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'customer', 'partner', 'separateWays', 'sharedKernel'
        ]));
    });

    test('offers relationship-start keywords after a newline and after a completed same-line relationship', async () => {
        const cases = [
            { name: 'customer-supplier', relationship: 'customer Alpha ' },
            { name: 'partnership', relationship: 'partner Alpha ' },
            { name: 'separate ways', relationship: 'separateWays Alpha ' }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${completionCase.relationship}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/incomplete-context-map-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(text.indexOf(completionCase.relationship) + completionCase.relationship.length)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const keyword of ['customer', 'partner', 'separateWays', 'sharedKernel']) {
                expect(labels, completionCase.name).not.toContain(keyword);
            }
        }

        const completedRelationships = [
            'customer Alpha -> supplier Beta ',
            'partner Alpha <-> partner Beta ',
            'separateWays Alpha -x- Beta ',
            'customer Alpha { integrationPatterns: ["AntiCorruptionLayer"] } -> supplier Beta { integrationPatterns: ["OpenHostService"] } '
        ];
        for (const [index, relationship] of completedRelationships.entries()) {
            const completedLineText = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${relationship}\n}`;
            const completedLine = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-completed-line-completion-${index}.tni`), completedLineText
            );
            documents.push(completedLine);
            await services.shared.workspace.DocumentBuilder.build([completedLine], { validation: false });
            const sameLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(completedLine, {
                textDocument: { uri: completedLine.uri.toString() },
                position: completedLine.textDocument.positionAt(completedLineText.indexOf(relationship) + relationship.length)
            });
            expect(sameLineCompletion?.items.map(item => item.label), relationship).toEqual(expect.arrayContaining([
                'customer', 'partner', 'separateWays', 'sharedKernel'
            ]));
            expect(sameLineCompletion?.items.every(item => item.data?.thinaiSiblingCompletion === true), relationship).toBe(true);
        }

        const nextLineText = 'bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    customer Alpha -> supplier Beta\n    \n}';
        const nextLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map-next-relationship-completion.tni'), nextLineText
        );
        documents.push(nextLine);
        const nextLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(nextLine, {
            textDocument: { uri: nextLine.uri.toString() },
            position: nextLine.textDocument.positionAt(nextLineText.indexOf('\n    \n}') + '\n    '.length)
        });
        expect(nextLineCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'customer', 'partner', 'separateWays', 'sharedKernel'
        ]));

        const partialKeywords = [
            { relationship: 'customer Alpha -> supplier Beta', prefix: 'c' },
            { relationship: 'partner Alpha <-> partner Beta', prefix: 'p' },
            { relationship: 'separateWays Alpha -x- Beta', prefix: 's' },
            { relationship: 'customer Alpha -> supplier Beta { integrationPatterns: ["OpenHostService"] }', prefix: 's' }
        ];
        for (const [index, completionCase] of partialKeywords.entries()) {
            const source = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${completionCase.relationship} ${completionCase.prefix}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-partial-next-keyword-${index}.tni`), source
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source.indexOf(`${completionCase.relationship} ${completionCase.prefix}`) + `${completionCase.relationship} ${completionCase.prefix}`.length)
            });
            expect(completion?.items.some(item => item.data?.thinaiSiblingCompletion === true), completionCase.relationship).toBe(true);
            expect(completion?.items.find(item => item.data?.thinaiSiblingCompletion === true)?.textEdit?.newText)
                .toMatch(/^\n\s+/u);
        }
    });

    test('suggests the relationship operator and required counterpart after the left context', async () => {
        const cases = [
            { relationship: 'customer Alpha ', continuation: '-> supplier' },
            { relationship: 'customer Alpha { integrationPatterns: ["AntiCorruptionLayer"] }\n    ', continuation: '-> supplier' },
            { relationship: 'partner Alpha ', continuation: '<-> partner' },
            { relationship: 'partner Alpha { integrationPatterns: ["Conformist"] }\n    ', continuation: '<-> partner' },
            { relationship: 'separateWays Alpha ', continuation: '-x-' }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${completionCase.relationship}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-operator-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

            const position = document.textDocument.positionAt(
                text.indexOf(completionCase.relationship) + completionCase.relationship.length
            );
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.continuation);

            expect(item, completionCase.relationship).toMatchObject({
                kind: CompletionItemKind.Operator,
                detail: 'Context-map relationship continuation',
                textEdit: {
                    range: { start: position, end: position },
                    newText: `${completionCase.continuation} `
                }
            });
        }
    });

    test('triggers right-side completions directly after relationship symbols', async () => {
        const keywordCases = [
            { prefix: 'customer Alpha ->', keyword: 'supplier', newText: ' supplier' },
            { prefix: 'partner Alpha <->', keyword: 'partner', newText: ' partner' }
        ];

        expect(services.Thinai.lsp.CompletionProvider?.completionOptions?.triggerCharacters).toEqual(
            expect.arrayContaining(['>', '-'])
        );

        for (const [index, completionCase] of keywordCases.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${completionCase.prefix}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-right-keyword-after-symbol-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const position = document.textDocument.positionAt(text.indexOf(completionCase.prefix) + completionCase.prefix.length);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            expect(completion?.items.find(item => item.label === completionCase.keyword)).toMatchObject({
                kind: CompletionItemKind.Keyword,
                textEdit: {
                    range: { start: position, end: position },
                    newText: completionCase.newText
                }
            });
        }

        const separateWaysText = 'bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    separateWays Alpha -x-\n}';
        const separateWays = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-map-right-context-after-symbol.tni'), separateWaysText
        );
        documents.push(separateWays);
        await services.shared.workspace.DocumentBuilder.build([separateWays], { validation: false });
        const separateWaysPosition = separateWays.textDocument.positionAt(separateWaysText.indexOf('separateWays Alpha -x-') + 'separateWays Alpha -x-'.length);
        const contextCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(separateWays, {
            textDocument: { uri: separateWays.uri.toString() },
            position: separateWaysPosition
        });
        expect(contextCompletion?.items.map(item => item.label)).toContain('Beta');
        expect(contextCompletion?.items.map(item => item.label)).not.toContain('Alpha');
        expect(contextCompletion?.items.find(item => item.label === 'Beta')).toMatchObject({
            kind: CompletionItemKind.Module,
            detail: 'BoundedContext Beta',
            textEdit: {
                range: { start: separateWaysPosition, end: separateWaysPosition },
                newText: ' Beta'
            }
        });
        expect(contextCompletion?.items.map(item => item.label)).not.toContain('customer');
        expect(contextCompletion?.items.map(item => item.label)).not.toContain('partner');
        expect(contextCompletion?.items.map(item => item.label)).not.toContain('sharedKernel');

        const rightContextCases = [
            'customer Alpha -> supplier',
            'partner Alpha <-> partner'
        ];
        for (const [index, relationship] of rightContextCases.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${relationship}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-right-context-completion-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const position = document.textDocument.positionAt(text.indexOf(relationship) + relationship.length);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            expect(completion?.items.map(item => item.label), relationship).toContain('Beta');
            expect(completion?.items.map(item => item.label), relationship).not.toContain('Alpha');
        }

        const multilineRightContexts = [
            `customer Alpha {\n        integrationPatterns: ["AntiCorruptionLayer"]\n    } -> supplier`,
            `partner Alpha {\n        integrationPatterns: ["Conformist"]\n    } <-> partner`,
            `separateWays Alpha\n    -x-`
        ];
        for (const [index, relationship] of multilineRightContexts.entries()) {
            const text = `bounded context Alpha\nbounded context Beta\ncontext map Relations {\n    ${relationship}\n}`;
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/context-map-multiline-right-context-${index}.tni`), text
            );
            documents.push(document);
            await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            const position = document.textDocument.positionAt(text.indexOf(relationship) + relationship.length);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position
            });
            expect(completion?.items.map(item => item.label), relationship).toContain('Beta');
            expect(completion?.items.map(item => item.label), relationship).not.toContain('Alpha');
        }
    });

    test('inserts multiword keywords as complete phrases', async () => {
        const cases = [
            { source: '', label: 'shared kernel' },
            { source: '', label: 'bounded context' },
            { source: 'bounded context X\nin bounded context X { aggregate A { ', label: 'value object' }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/compound-keyword-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.length)
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.label);
            expect(item, completionCase.source).toBeDefined();
            expect(item?.textEdit).toMatchObject({ newText: completionCase.label });
        }
    });

    test('offers top-level sibling keywords from a completed declaration on the same line', async () => {
        const sameLineText = 'bounded context Ordering realizes OrderManagement ';
        const sameLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/top-level-same-line-completion.tni'), sameLineText
        );
        documents.push(sameLine);
        const sameLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(sameLine, {
            textDocument: { uri: sameLine.uri.toString() },
            position: sameLine.textDocument.positionAt(sameLineText.length)
        });
        const siblingKeywords = ['bounded context', 'subdomain', 'context map'];
        for (const keyword of siblingKeywords) {
            expect(sameLineCompletion?.items.map(item => item.label)).toContain(keyword);
            const item = sameLineCompletion?.items.find(candidate => candidate.label === keyword);
            expect(item?.detail).toBe('Language keyword');
            expect(item?.data?.thinaiSiblingCompletion).toBe(true);
            expect(item?.textEdit).toMatchObject({
                range: {
                    start: sameLine.textDocument.positionAt(sameLineText.trimEnd().length),
                    end: sameLine.textDocument.positionAt(sameLineText.length)
                },
                newText: `\n${keyword}`
            });
        }

        const partialSiblingText = `${sameLineText.trimEnd()} bounded `;
        const partialSibling = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/top-level-partial-sibling-same-line-completion.tni'), partialSiblingText
        );
        documents.push(partialSibling);
        const partialSiblingCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(partialSibling, {
            textDocument: { uri: partialSibling.uri.toString() },
            position: partialSibling.textDocument.positionAt(partialSiblingText.length)
        });
        const partialSiblingItem = partialSiblingCompletion?.items.find(item => item.label === 'bounded context');
        expect(partialSiblingItem?.detail).toBe('Language keyword');
        expect(partialSiblingItem?.data?.thinaiSiblingCompletion).toBe(true);
        expect(partialSiblingItem?.textEdit).toMatchObject({
            range: {
                start: partialSibling.textDocument.positionAt(sameLineText.trimEnd().length),
                end: partialSibling.textDocument.positionAt(partialSiblingText.length)
            },
            newText: '\nbounded context'
        });

        const crlfText = 'subdomain Commerce\r\nbounded context Ordering realizes OrderManagement ';
        const crlfDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/top-level-crlf-sibling-completion.tni'), crlfText
        );
        documents.push(crlfDocument);
        const crlfCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(crlfDocument, {
            textDocument: { uri: crlfDocument.uri.toString() },
            position: crlfDocument.textDocument.positionAt(crlfText.length)
        });
        expect(crlfCompletion?.items.find(item => item.label === 'bounded context')?.textEdit)
            .toMatchObject({ newText: '\r\nbounded context' });

        const nextLineText = `${sameLineText.trimEnd()}\n`;
        const nextLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/top-level-next-line-completion.tni'), nextLineText
        );
        documents.push(nextLine);
        const nextLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(nextLine, {
            textDocument: { uri: nextLine.uri.toString() },
            position: nextLine.textDocument.positionAt(nextLineText.length)
        });
        expect(nextLineCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining(siblingKeywords));
    });

    test('completes partially typed top-level keywords in declaration gaps', async () => {
        const cases = [
            { source: 'bounded context Ordering realizes Commerce\nb', expected: 'bounded context', typed: 'b' },
            { source: 'bounded context Ordering realizes Commerce\nbounded c', expected: 'context', typed: 'c' },
            { source: 'bounded context Ordering realizes Commerce\nsh', expected: 'shared kernel', typed: 'sh' },
            { source: 'b', expected: 'bounded context', typed: 'b' }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/top-level-partial-completion-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.length)
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.expected);
            expect(item, completionCase.source).toBeDefined();
            expect(item?.textEdit).toMatchObject({
                newText: completionCase.expected,
                range: {
                    start: document.textDocument.positionAt(completionCase.source.length - completionCase.typed.length),
                    end: document.textDocument.positionAt(completionCase.source.length)
                }
            });
        }
    });

    test('filters partially typed block keywords and replaces only their prefix', async () => {
        const cases = [
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    ag\n}',
                expected: 'aggregate',
                typed: 'ag'
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering {\n    application s\n}',
                expected: 'service',
                typed: 's'
            },
            {
                source: 'context map Fulfillment {\n    c\n}',
                expected: 'customer',
                typed: 'c'
            }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/block-partial-completion-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.lastIndexOf(completionCase.typed) + completionCase.typed.length)
            });
            const item = completion?.items.find(candidate => candidate.label === completionCase.expected);
            expect(item, completionCase.source).toBeDefined();
            expect(item?.textEdit).toMatchObject({
                newText: completionCase.expected,
                range: {
                    start: document.textDocument.positionAt(completionCase.source.lastIndexOf(completionCase.typed)),
                    end: document.textDocument.positionAt(completionCase.source.lastIndexOf(completionCase.typed) + completionCase.typed.length)
                }
            });
            expect(completion?.items.filter(candidate => candidate.kind === CompletionItemKind.Keyword)
                .every(candidate => completionCase.expected === candidate.label), completionCase.source).toBe(true);
        }
    });

    test('offers context-member sibling suggestions on the same line and after a newline', async () => {
        const sameLineText = 'bounded context Ordering\nin bounded context Ordering {\n    event OrderPlaced \n}';
        const sameLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-member-same-line-completion.tni'), sameLineText
        );
        documents.push(sameLine);
        const sameLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(sameLine, {
            textDocument: { uri: sameLine.uri.toString() },
            position: sameLine.textDocument.positionAt(sameLineText.indexOf('event OrderPlaced') + 'event OrderPlaced '.length)
        });
        expect(sameLineCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'aggregate', 'application service', 'module', 'value object'
        ]));
        const sameLineSibling = sameLineCompletion?.items.find(item => item.label === 'aggregate');
        expect(sameLineSibling?.textEdit).toMatchObject({ newText: '\n    aggregate' });

        const nextLineText = 'bounded context Ordering\nin bounded context Ordering {\n    event OrderPlaced\n    \n}';
        const nextLine = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-member-next-line-completion.tni'), nextLineText
        );
        documents.push(nextLine);
        const nextLineCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(nextLine, {
            textDocument: { uri: nextLine.uri.toString() },
            position: nextLine.textDocument.positionAt(nextLineText.indexOf('\n    \n}') + '\n    '.length)
        });
        expect(nextLineCompletion?.items.map(item => item.label)).toEqual(expect.arrayContaining([
            'aggregate', 'application service', 'module', 'value object'
        ]));
    });

    test('waits for a statement boundary while typing a bare declaration name', async () => {
        const declaration = 'bounded context Ordering\nin bounded context Ordering { domain service Curr';
        const inName = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/sibling-completion-at-domain-service-name.tni'), declaration
        );
        documents.push(inName);
        const inNameCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(inName, {
            textDocument: { uri: inName.uri.toString() },
            position: inName.textDocument.positionAt(declaration.length)
        });
        expect(inNameCompletion?.items.some(item => item.data?.thinaiSiblingCompletion === true)).toBe(false);

        const completeDeclaration = `${declaration.replace(/Curr$/u, 'Currency')} `;
        const afterName = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/sibling-completion-after-domain-service-name.tni'), completeDeclaration
        );
        documents.push(afterName);
        const afterNameCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(afterName, {
            textDocument: { uri: afterName.uri.toString() },
            position: afterName.textDocument.positionAt(completeDeclaration.length)
        });
        expect(afterNameCompletion?.items.some(item => item.data?.thinaiSiblingCompletion === true)).toBe(true);
        expect(afterNameCompletion?.items.map(item => item.label)).toContain('value object');
    });

    test('does not offer same-line siblings while the current field or method is incomplete', async () => {
        const cases = [
            {
                source: 'shared kernel CommonTypes { value object Currency { raw: string amount: str',
                name: 'incomplete field type',
                forbidden: ['constructor', 'method']
            },
            {
                source: 'shared kernel CommonTypes { value object Currency { raw: string method normalize',
                name: 'incomplete method signature',
                forbidden: ['constructor', 'method']
            },
            {
                source: 'shared kernel CommonTypes { value object Currency',
                name: 'incomplete value-object declaration',
                forbidden: ['enum', 'domain service', 'module']
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering { module Api { exposes',
                name: 'incomplete exposure',
                forbidden: ['aggregate', 'application service', 'value object']
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering { repository OrderRepository {',
                name: 'repository without manages target',
                forbidden: ['aggregate', 'application service', 'value object']
            },
            {
                source: 'bounded context Ordering\nin bounded context Ordering { query repository OrderQueries {',
                name: 'query repository without serves target',
                forbidden: ['aggregate', 'application service', 'value object']
            },
            {
                source: 'shared kernel CommonTypes { value object Currency { raw: string method normalize() { behavior "Normalize',
                name: 'unfinished behavior text',
                forbidden: ['invariant', 'precondition', 'postcondition', 'behavior', 'transition', 'invokes', 'emits']
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/incomplete-same-line-sibling-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.length)
            });
            expect(completion?.items.filter(item => item.data?.thinaiSiblingCompletion === true).map(item => item.label), completionCase.name)
                .toEqual([]);
            for (const label of completionCase.forbidden) {
                expect(completion?.items.map(item => item.label), completionCase.name).not.toContain(label);
            }
        }
    });

    test('does not repeat the method keyword while its declaration is being typed', async () => {
        const sources = [
            'shared kernel CommonTypes {\n  value object Currency {\n    method ',
            'shared kernel CommonTypes {\n  value object Currency {\n    method normal'
        ];
        for (const [index, source] of sources.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/method-keyword-not-repeated-${index}.tni`), source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(source.length)
            });
            expect(completion?.items.map(item => item.label), source).not.toContain('method');
        }
    });

    test('does not suggest method-body siblings before invocation, emission, or transition syntax is complete', async () => {
        const cases = [
            {
                name: 'invocation without a target',
                source: 'bounded context Ordering\nin bounded context Ordering { application service App { method run() { invokes'
            },
            {
                name: 'emission without an event',
                source: 'bounded context Ordering\nin bounded context Ordering { application service App { method run() { emits'
            },
            {
                name: 'transition missing a destination state',
                source: 'bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { method change() { transition status from Draft to'
            },
            {
                name: 'read dependency without a source',
                source: 'bounded context Ordering\nin bounded context Ordering { application service App { method run() { reads from'
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/incomplete-method-sibling-${index}.tni`), completionCase.source
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(completionCase.source.length)
            });
            expect(completion?.items.some(item => item.data?.thinaiSiblingCompletion === true), completionCase.name)
                .toBe(false);
            for (const sibling of ['invariant', 'emits', 'transition', 'invokes', 'projects', 'reads from']) {
                expect(completion?.items.map(item => item.label), completionCase.name).not.toContain(sibling);
            }
        }
    });

    test('indents sibling completions by structural nesting when existing statements are inline', async () => {
        const prefix = 'bounded context Ordering\nin bounded context Ordering { aggregate Order { value object OrderId { raw: string } ';
        const source = `${prefix}} }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/inline-nested-sibling-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        expect(completion?.items.map(item => item.label)).toContain('enum');
        const enumCompletion = completion?.items.find(item => item.label === 'enum');
        expect(enumCompletion?.detail).toBe('Language keyword');
        expect(enumCompletion?.data?.thinaiSiblingCompletion).toBe(true);
        expect(enumCompletion?.insertTextMode).toBe(InsertTextMode.asIs);
        expect(enumCompletion?.data).toMatchObject({ thinaiIndentationDepth: 2 });
        expect(enumCompletion?.textEdit)
            .toMatchObject({
                range: {
                    start: document.textDocument.positionAt(
                        prefix.indexOf('value object OrderId { raw: string }') + 'value object OrderId { raw: string }'.length
                    ),
                    end: document.textDocument.positionAt(prefix.length)
                },
                newText: '\n    enum'
            });
    });

    test('offers reads-from as a method sibling with a structural line break', async () => {
        const prefix = 'bounded context Ordering\nin bounded context Ordering { application service App { method run() { behavior "Check the request." ';
        const source = `${prefix}} }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-sibling-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const item = completion?.items.find(candidate => candidate.label === 'reads from');
        expect(item).toBeDefined();
        expect(item?.data?.thinaiSiblingCompletion).toBe(true);
        expect(item?.insertTextMode).toBe(InsertTextMode.asIs);
        expect(item?.textEdit?.newText).toBe('\n      reads from');
        expect(completion?.items.map(candidate => candidate.label)).not.toContain('reads');
        expect(completion?.items.map(candidate => candidate.label)).not.toContain('from');
    });

    test('offers reads from as one item in an empty method body', async () => {
        const prefix = `bounded context Ordering in bounded context Ordering {
            application service App {
                method run() {
                    `;
        const source = `${prefix}\n                }\n            }\n        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reads-from-empty-method-completion.tni'), source
        );
        documents.push(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const item = completion?.items.find(candidate => candidate.label === 'reads from');
        expect(item).toBeDefined();
        expect(item?.kind).toBe(CompletionItemKind.Keyword);
        expect(item?.textEdit?.newText).toContain('reads from');
        expect(completion?.items.map(candidate => candidate.label)).not.toContain('reads');
        expect(completion?.items.map(candidate => candidate.label)).not.toContain('from');
    });

    test('ignores braces inside behavior text when computing sibling indentation depth', async () => {
        const prefix = 'bounded context Ordering\nin bounded context Ordering { application service App { method run() { invokes validate when "Keep {" ';
        const source = `${prefix}} } }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/brace-in-specification-sibling-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const invocation = completion?.items.find(item => item.label === 'invokes');
        expect(invocation?.data).toMatchObject({ thinaiIndentationDepth: 3 });
        expect(invocation?.textEdit).toMatchObject({ newText: '\n      invokes' });
    });

    test('expands an empty value-object block when completing its first member', async () => {
        const prefix = 'bounded context Ordering\nin bounded context Ordering {\n  value object OrderId {';
        const source = `${prefix}}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/empty-value-object-member-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        for (const label of ['constructor', 'method']) {
            const item = completion?.items.find(candidate => candidate.label === label);
            expect(item?.detail).toBe('Language keyword');
            expect(item?.data?.thinaiSiblingCompletion).toBe(true);
            expect(item?.insertTextMode).toBe(InsertTextMode.asIs);
            expect(item?.data).toMatchObject({ thinaiIndentationDepth: 2 });
            expect(item?.textEdit).toMatchObject({
                range: {
                    start: document.textDocument.positionAt(prefix.length),
                    end: document.textDocument.positionAt(source.length - 1)
                },
                newText: `\n    ${label}\n  `
            });
        }
    });

    test('corrects indentation when completing a member on an already-indented next line', async () => {
        const prefix = `bounded context Ordering
in bounded context Ordering {
  value object Currency {
    code: string
        con`;
        const source = `${prefix}
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/incorrectly-indented-value-object-member.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const constructor = completion?.items.find(item => item.label === 'constructor');
        expect(constructor?.detail).toBe('Language keyword');
        expect(constructor?.data?.thinaiSiblingCompletion).toBe(true);
        expect(constructor?.textEdit).toMatchObject({
            range: {
                start: document.textDocument.positionAt(prefix.lastIndexOf('\n') + 1),
                end: document.textDocument.positionAt(prefix.length)
            },
            newText: '    constructor'
        });
    });

    test('aligns blank-line member completion with the preceding field in a shared-kernel value object', async () => {
        const prefix = `shared kernel CommonTypes {
  value object Currency {
    code: string
        `;
        const source = `${prefix}
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-kernel-value-object-member-completion.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const method = completion?.items.find(item => item.label === 'method');
        expect(method?.detail).toBe('Language keyword');
        expect(method?.data?.thinaiSiblingCompletion).toBe(true);
        expect(method?.preselect).toBe(true);
        expect(method?.textEdit).toMatchObject({
            range: {
                start: document.textDocument.positionAt(prefix.lastIndexOf('\n') + 1),
                end: document.textDocument.positionAt(prefix.length)
            },
            newText: '    method'
        });
    });

    test('replaces a partially typed same-line value-object member when moving it to a sibling line', async () => {
        const prefix = 'shared kernel CommonTypes\n  value object Currency {\n    code: string met';
        const source = `${prefix}\n  }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/partial-same-line-value-object-member.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const method = completion?.items.find(item => item.label === 'method');
        expect(method?.detail).toBe('Language keyword');
        expect(method?.data?.thinaiSiblingCompletion).toBe(true);
        expect(method?.preselect).toBe(true);
        expect(method?.textEdit).toMatchObject({
            range: {
                start: document.textDocument.positionAt(prefix.indexOf('code: string') + 'code: string'.length),
                end: document.textDocument.positionAt(prefix.length)
            },
            newText: '\n    method'
        });
    });

    test('replaces partial member text on an over-indented next line in a shared kernel', async () => {
        const prefix = `shared kernel CommonTypes {
  value object Currency {
    code: string
        met`;
        const source = `${prefix}
  }
}`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/partial-next-line-shared-kernel-member.tni'), source
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(prefix.length)
        });
        const method = completion?.items.find(item => item.label === 'method');
        expect(method?.detail).toBe('Language keyword');
        expect(method?.data?.thinaiSiblingCompletion).toBe(true);
        expect(method?.textEdit).toMatchObject({
            range: {
                start: document.textDocument.positionAt(prefix.lastIndexOf('\n') + 1),
                end: document.textDocument.positionAt(prefix.length)
            },
            newText: '    method'
        });
    });

    test('offers top-level keywords in a gap before a later declaration', async () => {
        const marker = '__completion_position__';
        const source = `import "./strategic.tni"

bounded context Ordering realizes OrderManagement, SharedCapabilities

${marker}
bounded context Shipping realizes Fulfillment

bounded context Billing realizes Payments`;
        const offset = source.indexOf(marker);
        const text = source.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/context-catalog-gap-completion.tni'), text
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('bounded context');
        expect(labels).toContain('subdomain');
        expect(labels).toContain('shared kernel');
        expect(labels).toContain('context map');
    });

    test('completes module members after exposure declarations without throwing', async () => {
        const marker = '__completion_position__';
        const source = `shared kernel Common {
            value object CorrelationId { raw: string }
            value object TenantId { constructor(raw: string) {} raw: string }
            module Identity {
                exposes CorrelationId, TenantId
                ${marker}
            }
        }`;
        const offset = source.indexOf(marker);
        const text = source.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/module-exposure-completion.tni'), text
        );
        documents.push(document);
        expect(document.parseResult.parserErrors).toEqual([]);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('value object');
        expect(labels).toContain('domain service');
        expect(labels).not.toContain('aggregate');
        expect(labels).not.toContain('application service');
    });

    test('restricts module keyword suggestions inside shared kernels', async () => {
        const marker = '__completion_position__';
        const source = `shared kernel Common {
            value object CorrelationId { raw: string }
            module Types { ${marker} }
        }`;
        const offset = source.indexOf(marker);
        const text = source.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-kernel-module-completion.tni'), text
        );
        documents.push(document);
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toEqual(expect.arrayContaining([
            'exposes', 'domain service', 'module', 'value object', 'enum'
        ]));
        for (const unsupported of [
            'aggregate', 'application service', 'data object', 'entity', 'repository',
            'string', 'number', 'boolean', 'date', 'time', 'instant', 'List', 'Set', 'Map'
        ]) {
            expect(labels).not.toContain(unsupported);
        }
    });

    test('does not treat inherited object properties as compound keywords', () => {
        const provider = new ThinaiCompletionProvider(services.Thinai) as unknown as {
            withCompoundKeywordCompletions: (
                completion: CompletionList,
                continuations: CompletionItem[]
            ) => CompletionList | undefined
        };
        const completion: CompletionList = {
            isIncomplete: false,
            items: [{ label: 'constructor', kind: CompletionItemKind.Keyword }]
        };
        expect(provider.withCompoundKeywordCompletions(completion, [])?.items).toEqual(completion.items);
    });

    test('offers sibling elements after a closing brace on the same line or after a newline', async () => {
        const marker = '__completion_position__';
        const cases = [
            {
                name: 'module in bounded context, same line',
                prefix: 'bounded context Ordering\nin bounded context Ordering {\n    module Api {}',
                suffix: '\n}',
                expected: ['aggregate', 'application service']
            },
            {
                name: 'module in bounded context, next line',
                prefix: 'bounded context Ordering\nin bounded context Ordering {\n    module Api {}\n    ',
                suffix: '\n}',
                expected: ['aggregate', 'application service']
            },
            {
                name: 'module in shared kernel',
                prefix: 'shared kernel Common {\n    module Api {}\n    ',
                suffix: '\n}',
                expected: ['value object', 'domain service']
            },
            {
                name: 'value object in aggregate',
                prefix: 'bounded context Ordering\nin bounded context Ordering { aggregate A { value object V { raw: string }\n    ',
                suffix: ' } }',
                expected: ['entity', 'enum']
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const source = `${completionCase.prefix}${marker}${completionCase.suffix}`;
            const offset = source.indexOf(marker);
            const text = source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/closing-brace-completion-${index}.tni`), text
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const expected of completionCase.expected) {
                expect(labels, completionCase.name).toContain(expected);
            }
        }
    });

    test('offers primitive types while completing incomplete type positions', async () => {
        const marker = '__completion_position__';
        expect(services.Thinai.lsp.CompletionProvider?.completionOptions?.triggerCharacters).toEqual(
            expect.arrayContaining([':', '<', ','])
        );
        const cases = [
            {
                name: 'field type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amount: ${marker} } } }`,
                expectedPrefix: ''
            },
            {
                name: 'field type without a separating space',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amount:${marker} } } }`,
                expectedPrefix: ''
            },
            {
                name: 'partial field type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amount: str${marker} } } }`,
                expectedPrefix: 'str'
            },
            {
                name: 'partial time field type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { opensAt: ti${marker} } } }`,
                expectedPrefix: 'ti',
                expectedPrimitive: 'time'
            },
            {
                name: 'partial instant field type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { createdAt: ins${marker} } } }`,
                expectedPrefix: 'ins',
                expectedPrimitive: 'instant'
            },
            {
                name: 'method parameter type',
                before: `bounded context Sample\nin bounded context Sample { application service App { method run(amount: ${marker}) } }`,
                expectedPrefix: ''
            },
            {
                name: 'constructor parameter type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { constructor(amount: ${marker}) {} } } }`,
                expectedPrefix: ''
            },
            {
                name: 'method parameter collection element type',
                before: `bounded context Sample\nin bounded context Sample { application service App { method run(amounts: List<${marker}>) } }`,
                expectedPrefix: ''
            },
            {
                name: 'method return type',
                before: `bounded context Sample\nin bounded context Sample { application service App { method run() returns ${marker} } }`,
                expectedPrefix: ''
            },
            {
                name: 'method return collection element type',
                before: `bounded context Sample\nin bounded context Sample { application service App { method run() returns List<${marker}> } }`,
                expectedPrefix: ''
            },
            {
                name: 'collection element type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amounts: List<${marker}> } } }`,
                expectedPrefix: ''
            },
            {
                name: 'nested collection element type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amounts: List<Set<${marker}>> } } }`,
                expectedPrefix: ''
            },
            {
                name: 'map key type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amounts: Map<${marker}, string> } } }`,
                expectedPrefix: ''
            },
            {
                name: 'map value type',
                before: `bounded context Sample\nin bounded context Sample { aggregate Order { root entity Order { amounts: Map<string, ${marker}> } } }`,
                expectedPrefix: ''
            },
            {
                name: 'type inside a nested shared-kernel module',
                before: `shared kernel Common { module Outer { module Inner { value object Identifier { raw: ${marker} } } } }`,
                expectedPrefix: ''
            }
        ];
        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.before.indexOf(marker);
            const text = completionCase.before.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/primitive-type-completion-${index}.tni`), text
            );
            documents.push(document);
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const expectedPrimitive = completionCase.expectedPrimitive ?? 'string';
            const primitive = completion?.items.find(item => item.label === expectedPrimitive);
            expect(primitive, completionCase.name).toMatchObject({
                kind: CompletionItemKind.Keyword,
                textEdit: {
                    range: {
                        start: document.textDocument.positionAt(offset - completionCase.expectedPrefix.length),
                        end: document.textDocument.positionAt(offset)
                    },
                    newText: expectedPrimitive
                }
            });
            expect(completion?.items.map(item => item.label), completionCase.name).toEqual(
                expect.arrayContaining(completionCase.expectedPrefix
                    ? [expectedPrimitive]
                    : ['string', 'number', 'boolean', 'date', 'time', 'instant'])
            );
        }
    });

    test('offers the allowed declaration and method-body keywords in each block', async () => {
        const marker = '__completion_position__';
        const cases = [
            {
                name: 'method body',
                expected: ['invariant', 'precondition', 'postcondition', 'behavior', 'invokes'],
                forbidden: ['transition', 'projects', 'emits', 'identifier', 'entity', 'root entity'],
                source: `bounded context Ordering\nin bounded context Ordering { application service App { method execute() { ${marker} } } }`
            },
            {
                name: 'aggregate root method body',
                expected: ['transition', 'emits'],
                forbidden: ['identifier', 'entity', 'root entity'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { method place() { ${marker} } } } }`
            },
            {
                name: 'partially typed emits keyword in aggregate root method',
                expected: ['emits'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { method place() { emi${marker} } } } }`
            },
            {
                name: 'partially typed transition keyword in entity method',
                expected: ['transition'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { method place() { tran${marker} } } } }`
            },
            {
                name: 'partially typed projects keyword in projector method',
                expected: ['projects'],
                source: `bounded context Ordering\nin bounded context Ordering { projector OrderProjector { method project() { pro${marker} } } }`
            },
            {
                name: 'partially typed emits keyword is excluded from application service',
                expected: [],
                forbidden: ['emits'],
                source: `bounded context Ordering\nin bounded context Ordering { application service App { method place() { emi${marker} } } }`
            },
            {
                name: 'projector method body',
                expected: ['projects'],
                forbidden: ['invokes', 'transition', 'emits', 'returns'],
                source: `bounded context Ordering\nin bounded context Ordering { projector OrderProjector { method project() { ${marker} } } }`
            },
            {
                name: 'query-service method body allows read-helper invocation',
                expected: ['invokes'],
                source: `bounded context Ordering\nin bounded context Ordering { query service Queries { method find() returns string { ${marker} } } }`
            },
            {
                name: 'constructor body',
                expected: ['invariant', 'precondition', 'postcondition', 'behavior'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { constructor() { ${marker} }\nidentifier id: OrderId }\nvalue object OrderId { raw: string } } }`
            },
            {
                name: 'aggregate body',
                expected: ['entity', 'value object', 'enum', 'invariant'],
                forbidden: ['transition', 'projects', 'emits'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { ${marker} root entity Order { identifier id: OrderId }\nvalue object OrderId { raw: string } } }`
            },
            {
                name: 'entity fields allow identifier',
                expected: ['identifier'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { root entity Order { ${marker} } } }`
            },
            {
                name: 'value object fields exclude identifier',
                expected: ['method', 'constructor'],
                forbidden: ['identifier', 'entity', 'root entity'],
                source: `bounded context Ordering\nin bounded context Ordering { aggregate Order { value object OrderId { ${marker} } } }`
            },
            {
                name: 'module body',
                expected: ['exposes', 'aggregate', 'application service', 'domain service', 'query service'],
                source: `bounded context Ordering\nin bounded context Ordering { module Api { ${marker} } }`
            },
            {
                name: 'unfinished module body on opening-brace line',
                expected: ['aggregate', 'application service', 'domain service', 'query service'],
                source: `bounded context Ordering\nin bounded context Ordering { module Api { ${marker}`
            },
            {
                name: 'journey body',
                expected: ['by'],
                source: `actor Customer\njourney PlaceOrder { ${marker} }`
            },
            {
                name: 'journey actor body',
                expected: ['invoke'],
                source: `actor Customer\njourney PlaceOrder { by Customer { ${marker} } }`
            },
            {
                name: 'context map body',
                expected: ['customer', 'partner', 'separateWays', 'sharedKernel'],
                source: `context map Fulfillment { ${marker} }`
            }
        ];

        for (const [index, completionCase] of cases.entries()) {
            const offset = completionCase.source.indexOf(marker);
            const text = completionCase.source.replace(marker, '');
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/block-completion-${index}.tni`), text
            );
            documents.push(document);
            if (!completionCase.name.startsWith('unfinished') && !completionCase.name.startsWith('partially typed')) {
                expect(document.parseResult.parserErrors, completionCase.name).toHaveLength(0);
            }
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            for (const keyword of completionCase.expected) {
                expect(labels, completionCase.name).toContain(keyword);
            }
            for (const keyword of completionCase.forbidden ?? []) {
                expect(labels, completionCase.name).not.toContain(keyword);
            }
        }
    });

    test('constrains projector and factory method specification completions', async () => {
        const model = `bounded context Ordering in bounded context Ordering {
            aggregate OrderAggregate {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            value object Price { amount: number }
            enum OrderStatus { Draft, Placed }
            event OrderPlaced
            read model OrderSummary { status: OrderStatus }
            domain service Pricing { method calculate() returns number }
            factory OrderFactory { method create() returns Order }
            projector OrderProjector {
                method project(source: OrderPlaced) { projects OrderSummary }
            }
        }`;
        const signaturePosition = model.indexOf(') { projects') + 1;
        const signatureDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-returns-keyword.tni'), model
        );
        documents.push(signatureDocument);
        const signatureCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(signatureDocument, {
            textDocument: { uri: signatureDocument.uri.toString() },
            position: signatureDocument.textDocument.positionAt(signaturePosition)
        });
        expect(signatureCompletion?.items.map(item => item.label)).not.toContain('returns');

        const projectorParameterText = model.replace(
            'method project(source: OrderPlaced)',
            'method project(source: )'
        );
        const projectorParameterDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-event-parameter-type.tni'), projectorParameterText
        );
        documents.push(projectorParameterDocument);
        await services.shared.workspace.DocumentBuilder.build([projectorParameterDocument], { validation: false });
        const parameterOffset = projectorParameterText.indexOf('source: ') + 'source: '.length;
        const parameterCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(projectorParameterDocument, {
            textDocument: { uri: projectorParameterDocument.uri.toString() },
            position: projectorParameterDocument.textDocument.positionAt(parameterOffset)
        });
        const parameterLabels = parameterCompletion?.items.map(item => item.label) ?? [];
        expect(parameterLabels).toContain('OrderPlaced');
        for (const invalid of ['Order', 'OrderId', 'Price', 'string', 'List']) {
            expect(parameterLabels).not.toContain(invalid);
        }

        const projectorReturnText = model.replace(
            'method project(source: OrderPlaced) { projects OrderSummary }',
            'method project(source: OrderPlaced) returns '
        );
        const projectorReturnDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-return-type.tni'), projectorReturnText
        );
        documents.push(projectorReturnDocument);
        await services.shared.workspace.DocumentBuilder.build([projectorReturnDocument], { validation: false });
        const returnOffset = projectorReturnText.indexOf('returns ', projectorReturnText.indexOf('projector OrderProjector')) + 'returns '.length;
        const projectorReturnCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(projectorReturnDocument, {
            textDocument: { uri: projectorReturnDocument.uri.toString() },
            position: projectorReturnDocument.textDocument.positionAt(returnOffset)
        });
        const projectorReturnLabels = projectorReturnCompletion?.items.map(item => item.label) ?? [];
        for (const invalid of ['string', 'List', 'Order', 'OrderId', 'Price', 'OrderStatus']) {
            expect(projectorReturnLabels).not.toContain(invalid);
        }

        const projectorInvocationText = model.replace(
            'projects OrderSummary',
            'invokes OrderFactory.cr'
        );
        const projectorInvocationDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/projector-invocation-target.tni'), projectorInvocationText
        );
        documents.push(projectorInvocationDocument);
        await services.shared.workspace.DocumentBuilder.build([projectorInvocationDocument], { validation: false });
        const invocationOffset = projectorInvocationText.indexOf('OrderFactory.cr') + 'OrderFactory.cr'.length;
        const invocationCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(projectorInvocationDocument, {
            textDocument: { uri: projectorInvocationDocument.uri.toString() },
            position: projectorInvocationDocument.textDocument.positionAt(invocationOffset)
        });
        expect(invocationCompletion?.items.map(item => item.label)).not.toContain('create');

        const factoryText = model.replace('method create() returns Order', 'method create() returns ');
        const factoryDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/factory-return-type.tni'), factoryText
        );
        documents.push(factoryDocument);
        await services.shared.workspace.DocumentBuilder.build([factoryDocument], { validation: false });
        const factoryOffset = factoryText.indexOf('method create() returns ') + 'method create() returns '.length;
        const factoryCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(factoryDocument, {
            textDocument: { uri: factoryDocument.uri.toString() },
            position: factoryDocument.textDocument.positionAt(factoryOffset)
        });
        const factoryLabels = factoryCompletion?.items.map(item => item.label) ?? [];
        expect(factoryLabels).toContain('Order');
        for (const invalid of ['string', 'List', 'Price', 'OrderId', 'OrderStatus', 'OrderSummary']) {
            expect(factoryLabels).not.toContain(invalid);
        }
    });

    test('offers only subdomains, not arbitrary declarations, for bounded-context realization', async () => {
        const marker = '__completion_position__';
        const markedText = `subdomain Commerce
            bounded context Ordering realizes ${marker}
            in bounded context Ordering {
                aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
                application service Pricing {}
            }`;
        const offset = markedText.indexOf(marker);
        const text = markedText.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/realizes-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('Commerce');
        expect(labels).not.toContain('Order');
        expect(labels).not.toContain('Pricing');
    });

    test('completes valid module dependencies and excludes self, foreign, and cyclic modules', async () => {
        const marker = '__completion_position__';
        const markedText = `bounded context Ordering in bounded context Ordering {
            module A depends on ${marker} {}
            module B {}
            module C depends on A {}
        }
        bounded context Shipping in bounded context Shipping { module Foreign {} }`;
        const offset = markedText.indexOf(marker);
        const text = markedText.replace(marker, '');
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/module-dependency-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('B');
        expect(labels).not.toContain('A');
        expect(labels).not.toContain('C');
        expect(labels).not.toContain('Foreign');
    });

    test('filters mirrors to foreign identifier value objects and query repositories to local read models', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reference-producer.tni'),
            `bounded context Ordering in bounded context Ordering {
                aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
                value object NotAnIdentifier { raw: string }
                read model ShipmentSummaryForeign {}
            }`
        );
        const marker = '__completion_position__';
        const markedText = `import "./reference-producer.tni"
            bounded context Shipping in bounded context Shipping {
                aggregate Shipment {
                    root entity Shipment { identifier id: ShipmentId }
                    value object ShipmentId { raw: string }
                    value object LocalMirror mirrors ${marker} {}
                }
                read model ShipmentSummary {}
                query repository ShipmentQueries {
                    serves ShipmentSummary${marker}
                }
            }`;
        const text = markedText.replace(marker, '').replace(marker, '');
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/reference-consumer.tni'), text
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const mirrorOffset = markedText.indexOf(marker);
        const mirrorCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(mirrorOffset)
        });
        const mirrorLabels = mirrorCompletion?.items.map(item => item.label) ?? [];
        expect(mirrorLabels).toContain('OrderId');
        expect(mirrorLabels).not.toContain('NotAnIdentifier');
        expect(mirrorLabels).not.toContain('ShipmentId');

        const readModelOffset = text.indexOf('ShipmentSummary', text.indexOf('serves')) + 'ShipmentSummary'.length;
        const readModelCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(readModelOffset)
        });
        expect(readModelCompletion?.items.some(item => item.label === 'ShipmentSummaryForeign')).toBe(false);
        expect(readModelCompletion?.items.map(item => item.label)).toContain('ShipmentSummary');
    });

    test('filters invalid entity, read-model, and data-object method parameter types', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
            read model OrderSummary {}
            data object Request {}
            application service OrderApplication { method submit(input: ) {} }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/method-parameter-type-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        const offset = text.indexOf('input:') + 'input: '.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('Request');
        expect(labels).not.toContain('Order');
        expect(labels).not.toContain('OrderSummary');
    });

    test('offers enum states for initial values and allowed context-map integration patterns', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate Order { root entity Order { identifier id: OrderId status: Status initial Dr } value object OrderId { raw: string } enum Status { Draft, Placed } }
        }
        bounded context Shipping
        context map Fulfillment { customer Shipping { integrationPatterns: ["Anti"] } -> supplier Ordering }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/constrained-value-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const initialOffset = text.indexOf('initial Dr') + 'initial Dr'.length;
        const initialCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(initialOffset)
        });
        expect(initialCompletion?.items.some(item => item.label === 'Draft' && item.kind === CompletionItemKind.EnumMember)).toBe(true);

        const patternOffset = text.indexOf('"Anti') + '"Anti'.length;
        const patternCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(patternOffset)
        });
        expect(patternCompletion?.items.some(item => item.label === 'AntiCorruptionLayer')).toBe(true);
        expect(patternCompletion?.items.some(item => item.label === 'Conformist')).toBe(false);
    });

    test('does not offer initial-state values on optional or non-entity fields', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    identifier id: OrderId
                    optionalStatus?: Status initial Dr
                }
                value object OrderId { raw: string }
                value object StatusHolder { status: Status initial Dr }
                enum Status { Draft, Placed }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/invalid-initial-state-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        for (const marker of ['optionalStatus?: Status initial Dr', 'status: Status initial Dr']) {
            const offset = text.indexOf(marker) + marker.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            expect(completion?.items.map(item => item.label)).not.toContain('Draft');
            expect(completion?.items.map(item => item.label)).not.toContain('Placed');
        }
    });

    test('excludes the already-selected context from context-map endpoint and participant completions', async () => {
        const marker = '__completion_position__';
        const text = `bounded context Ordering
            bounded context Shipping
            bounded context Billing
            shared kernel Common
            context map Fulfillment {
                customer Ordering -> supplier ${marker}
                partner Ordering <-> partner ${marker}
                separateWays Ordering -x- ${marker}
                sharedKernel Common { participants: [Ordering, ${marker}] }
            }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/distinct-context-map-candidates.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const markers = [...text.matchAll(new RegExp(marker, 'gu'))];
        for (const [index, match] of markers.entries()) {
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(match.index)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            expect(labels, `completion ${index}`).not.toContain('Ordering');
            expect(labels, `completion ${index}`).toEqual(expect.arrayContaining(['Shipping', 'Billing']));
            for (const contextName of ['Shipping', 'Billing']) {
                expect(labels.filter(label => label === contextName), `completion ${index}: ${contextName}`).toHaveLength(1);
            }
        }
    });

    test('hides declarations in sibling modules unless exposed through a dependency', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            module Internal {
                value object PrivateCode { raw: string }
            }
            module Consumer {
                data object Request { code: PrivateC }
            }
            value object RootRequest { code: PrivateC }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/module-private-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('PrivateC') + 'PrivateC'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        expect(completion?.items.some(item => item.label === 'PrivateCode')).toBe(false);
        const rootOffset = text.lastIndexOf('PrivateC') + 'PrivateC'.length;
        const rootCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(rootOffset)
        });
        expect(rootCompletion?.items.some(item => item.label === 'PrivateCode')).toBe(false);

        const allowedText = `bounded context Shipping in bounded context Shipping {
            value object RootCode { raw: string }
            module Producer {
                exposes ExposedCode
                value object ExposedCode { raw: string }
            }
            module Consumer depends on Producer {
                data object Request {
                    code: ExposedC
                    rootCode: RootC
                }
            }
            value object RootRequest { code: ExposedC }
        }`;
        const allowedDocument = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/module-exposed-completion.tni'), allowedText
        );
        documents.push(allowedDocument);
        await services.shared.workspace.DocumentBuilder.build([allowedDocument], { validation: true });
        const allowedOffset = allowedText.indexOf('ExposedC') + 'ExposedC'.length;
        const allowedCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(allowedDocument, {
            textDocument: { uri: allowedDocument.uri.toString() },
            position: allowedDocument.textDocument.positionAt(allowedOffset)
        });
        expect(allowedCompletion?.items.some(item => item.label === 'ExposedCode')).toBe(true);
        const rootTypeOffset = allowedText.indexOf('rootCode: RootC') + 'rootCode: RootC'.length;
        const moduleRootTypeCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(allowedDocument, {
            textDocument: { uri: allowedDocument.uri.toString() },
            position: allowedDocument.textDocument.positionAt(rootTypeOffset)
        });
        expect(moduleRootTypeCompletion?.items.some(item => item.label === 'RootCode')).toBe(true);
        const exposedRootOffset = allowedText.lastIndexOf('ExposedC') + 'ExposedC'.length;
        const exposedRootCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(allowedDocument, {
            textDocument: { uri: allowedDocument.uri.toString() },
            position: allowedDocument.textDocument.positionAt(exposedRootOffset)
        });
        expect(exposedRootCompletion?.items.some(item => item.label === 'ExposedCode')).toBe(true);
    });

    test('filters private cross-context types and domain events from completion', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-producer.tni'),
            'bounded context Ordering in bounded context Ordering { value object OrderId { raw: string } event OrderPlaced }'
        );
        const text = `import "./completion-producer.tni"
            bounded context Shipping in bounded context Shipping {
                application service ShipmentApplication {
                    method receive(source: Order) {}
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-consumer.tni'), text
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('source: Order') + 'source: Order'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).not.toContain('OrderId');
        expect(labels).not.toContain('OrderPlaced');

        const eventContexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/authorized-event-contexts.tni'),
            'bounded context Ordering in bounded context Ordering { integration event OrderPlacedV1 } bounded context Shipping'
        );
        const eventMap = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/authorized-event-map.tni'),
            'import "./authorized-event-contexts.tni" context map Fulfillment { partner Shipping <-> partner Ordering }'
        );
        const authorizedText = `import "./authorized-event-contexts.tni"
            import "./authorized-event-map.tni"
            in bounded context Shipping {
                application service ShipmentApplication {
                    method receive(source: OrderPlaced) {}
                }
            }`;
        const authorizedConsumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/authorized-event-completion.tni'), authorizedText
        );
        documents.push(eventContexts, eventMap, authorizedConsumer);
        await services.shared.workspace.DocumentBuilder.build([eventContexts, eventMap, authorizedConsumer], { validation: true });
        const authorizedOffset = authorizedText.indexOf('source: OrderPlaced') + 'source: OrderPlaced'.length;
        const authorizedCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(authorizedConsumer, {
            textDocument: { uri: authorizedConsumer.uri.toString() },
            position: authorizedConsumer.textDocument.positionAt(authorizedOffset)
        });
        expect(authorizedCompletion?.items.some(item => item.label === 'OrderPlacedV1')).toBe(true);
    });

    test('filters private cross-context declarations from inline specification references', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/specification-private-producer.tni'),
            'bounded context Ordering in bounded context Ordering { aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } } }'
        );
        const text = `import "./specification-private-producer.tni"
            bounded context Shipping in bounded context Shipping {
                application service ShipmentApplication {
                    method receive() { behavior "Use [[Ordering.Order]]" }
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/specification-private-consumer.tni'), text
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('Ordering.Order]]') + 'Ordering.Order'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        expect(completion?.items.some(item => item.label === 'OrderId')).toBe(false);
    });

    test('filters foreign read models and events from projector and emit completions', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/foreign-projections.tni'),
            'bounded context Ordering in bounded context Ordering { read model OrderSummary { total: number } integration event OrderPlacedV1 }'
        );
        const text = `import "./foreign-projections.tni"
            bounded context Shipping in bounded context Shipping {
                read model ShipmentSummary { status: string }
                event ShipmentSent
                aggregate Shipment {
                    root entity Shipment {
                        method ship() { emits ShipmentSent }
                        identifier id: ShipmentId
                    }
                    value object ShipmentId { raw: string }
                }
                projector ShipmentProjector {
                    method project(source: ShipmentSent) { projects OrderSummary }
                }
                application service ShipmentApplication {
                    method dispatch() { emits OrderPlacedV1 }
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/foreign-projections-consumer.tni'), text
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const projectionsOffset = text.indexOf('projects OrderSummary') + 'projects OrderSummary'.length;
        const projections = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(projectionsOffset)
        });
        expect(projections?.items.some(item => item.label === 'OrderSummary')).toBe(false);

        const emitsOffset = text.indexOf('emits OrderPlacedV1') + 'emits OrderPlacedV1'.length;
        const emits = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(emitsOffset)
        });
        expect(emits?.items.some(item => item.label === 'OrderPlacedV1')).toBe(false);
        expect(emits?.items.some(item => item.label === 'Ordering')).toBe(false);

        const localEmitsOffset = text.indexOf('emits ShipmentSent') + 'emits ShipmentSent'.length;
        const localEmits = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(localEmitsOffset)
        });
        expect(localEmits?.items.some(item => item.label === 'ShipmentSent')).toBe(true);
    });

    test('filters unqualified child entities from repository-root completion', async () => {
        const text = `bounded context Shipping in bounded context Shipping {
            aggregate Shipment {
                root entity Shipment { identifier id: ShipmentId }
                entity ShipmentLine { identifier id: ShipmentLineId }
                value object ShipmentId { raw: string }
                value object ShipmentLineId { raw: string }
            }
            repository ShipmentRepository {
                manages ShipmentL
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/repository-root-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('ShipmentL') + 'ShipmentL'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        expect(completion?.items.some(item => item.label === 'ShipmentLine')).toBe(false);
    });

    test('filters inaccessible module and query-service invocation targets', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            module Producer {
                domain service Policy { method check() }
            }
            module Consumer {
                domain service Handler { method run() { invokes Policy.ch } }
            }
            query service FirstQueries { method first() { invokes SecondQueries.other } }
            query service SecondQueries { method other() }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/invocation-scope-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const moduleOffset = text.indexOf('Policy.ch') + 'Policy.ch'.length;
        const moduleCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(moduleOffset)
        });
        expect(moduleCompletion?.items.some(item => item.label === 'check')).toBe(false);

        const queryOffset = text.indexOf('SecondQueries.other') + 'SecondQueries.other'.length;
        const queryCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(queryOffset)
        });
        expect(queryCompletion?.items.some(item => item.label === 'other')).toBe(false);
    });

    test('does not suggest cross-context invocation targets from an event handler', async () => {
        const producer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/cross-context-invocation-producer.tni'),
            `bounded context Ordering in bounded context Ordering {
                integration event OrderPlacedV1
                application service OrderApplication { method placeOrder() }
            }`
        );
        const text = `import "./cross-context-invocation-producer.tni"
            bounded context Shipping in bounded context Shipping {
                application service ShipmentApplication {
                    method onOrderPlaced(source: Ordering.OrderPlacedV1) {
                        invokes Ordering.OrderApplication.placeOrder
                    }
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/cross-context-invocation-consumer.tni'), text
        );
        documents = [producer, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('Ordering.OrderApplication.placeOrder') + 'Ordering.OrderApplication.'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        expect(completion?.items.some(item => item.label === 'placeOrder')).toBe(false);
    });

    test('completion reflects application-service invocation direction', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method place() { invokes Pricing }
                    identifier id: OrderId
                }
                value object OrderId { raw: string }
            }
            domain service Pricing { method calculate() }
            application service OrderApplication {
                method placeOrder() {
                    invokes Pricing
                    invokes Order
                }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/application-invocation-direction-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const rootServiceOffset = text.indexOf('invokes Pricing') + 'invokes Pricing'.length;
        const rootServiceCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(rootServiceOffset)
        });
        expect(rootServiceCompletion?.items.some(item => item.label === 'Pricing')).toBe(false);

        const applicationServiceOffset = text.lastIndexOf('invokes Pricing') + 'invokes Pricing'.length;
        const applicationServiceCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(applicationServiceOffset)
        });
        expect(applicationServiceCompletion?.items.some(item => item.label === 'Pricing')).toBe(true);

        const applicationAggregateOffset = text.indexOf('invokes Order') + 'invokes Order'.length;
        const applicationAggregateCompletion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(applicationAggregateOffset)
        });
        expect(applicationAggregateCompletion?.items.some(item => item.label === 'Order')).toBe(true);
    });

    test('limits domain-service invocation targets to other domain services', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            aggregate OrderAggregate {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            domain service Policy { method calculate() returns number }
            query service Queries { method find() returns string }
            factory OrderFactory { method create() returns Order }
            domain service Pricing {
                method calculate() { invokes Policy.ca }
                method read() { invokes Queries.fi }
                method create() { invokes OrderFactory.cr }
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/domain-service-invocation-targets.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

        const cases = [
            { source: 'invokes Policy.ca', expected: 'calculate', forbidden: ['find', 'create'] },
            { source: 'invokes Queries.fi', expected: undefined, forbidden: ['find'] },
            { source: 'invokes OrderFactory.cr', expected: undefined, forbidden: ['create'] }
        ];
        for (const completionCase of cases) {
            const offset = text.indexOf(completionCase.source) + completionCase.source.length;
            const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.uri.toString() },
                position: document.textDocument.positionAt(offset)
            });
            const labels = completion?.items.map(item => item.label) ?? [];
            if (completionCase.expected) {
                expect(labels).toContain(completionCase.expected);
            }
            for (const forbidden of completionCase.forbidden) {
                expect(labels).not.toContain(forbidden);
            }
        }
    });

    test('completes shared-kernel domain services only for participating contexts', async () => {
        const shared = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-kernel.tni'),
            'shared kernel Common { domain service PricingPolicy { method normalize(amount: number) returns number } }'
        );
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-contexts.tni'),
            'bounded context Ordering bounded context Shipping'
        );
        const map = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-map.tni'),
            'import "./completion-shared-kernel.tni" import "./completion-shared-contexts.tni" context map SharedPolicies { sharedKernel Common { participants: [Ordering, Shipping] } }'
        );
        const text = `import "./completion-shared-contexts.tni"
            import { Common } from "./completion-shared-kernel.tni"
            import { SharedPolicies } from "./completion-shared-map.tni"
            in bounded context Ordering {
                application service OrderApplication {
                    method normalize(amount: number) returns number { invokes Common.PricingPolicy.norm }
                }
            }`;
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/completion-shared-consumer.tni'), text
        );
        documents = [shared, contexts, map, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('Common.PricingPolicy.norm') + 'Common.PricingPolicy.norm'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(consumer, {
            textDocument: { uri: consumer.uri.toString() },
            position: consumer.textDocument.positionAt(offset)
        });
        expect(completion?.items.some(item => item.label === 'normalize')).toBe(true);
    });

    test('journey path completion offers commands but not query methods', async () => {
        const text = `bounded context Ordering in bounded context Ordering {
            application service OrderApplication {
                method placeOrder()
            }
            query service OrderQueries {
                method findOrder() returns string
            }
        }
        actor Customer
        journey PlaceOrder {
            by Customer {
                invoke Ordering.OrderApplication.
            }
        }`;
        const document = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/journey-command-completion.tni'), text
        );
        documents = [document];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const offset = text.indexOf('Ordering.OrderApplication.') + 'Ordering.OrderApplication.'.length;
        const completion = await services.Thinai.lsp.CompletionProvider?.getCompletion(document, {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(offset)
        });
        const labels = completion?.items.map(item => item.label) ?? [];
        expect(labels).toContain('placeOrder');
        expect(labels).not.toContain('findOrder');
    });

    test('offers an import code action for an unresolved indexed declaration', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering in bounded context Ordering { event OrderPlaced }'
        );
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/consumer.tni'),
            'in bounded context Ordering { application service ShipmentApplication { method onOrderPlaced(source: OrderPlaced) {} } }'
        );
        documents = [target, source];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const actions = await services.Thinai.lsp.CodeActionProvider?.getCodeActions(source, {
            textDocument: { uri: source.uri.toString() },
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: source.textDocument.getText().length }
            },
            context: { diagnostics: source.diagnostics ?? [] }
        });

        expect(actions?.some(action => 'title' in action && action.title === "Import 'OrderPlaced' from './ordering.tni'")).toBe(true);
    });

    test('extends an existing selective import for an unresolved component', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/components.tni'),
            'bounded context Ordering\nbounded context Shipping'
        );
        const sourceText = 'import { Ordering } from "./components.tni"\nin bounded context Shipping {}';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/selective-consumer.tni'), sourceText
        );
        documents = [target, source];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const actions = await services.Thinai.lsp.CodeActionProvider?.getCodeActions(source, {
            textDocument: { uri: source.uri.toString() },
            range: {
                start: { line: 0, character: 0 },
                end: { line: 1, character: sourceText.length - sourceText.indexOf('\n') - 1 }
            },
            context: { diagnostics: source.diagnostics ?? [] }
        });
        const action = actions?.find(candidate => 'title' in candidate && candidate.title === "Import 'Shipping' from './components.tni'");
        expect(action && 'edit' in action ? action.edit?.changes?.[source.uri.toString()]?.[0]?.newText : undefined)
            .toBe(', Shipping');
    });

    test('does not offer import quick fixes for private cross-context types', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/private-types.tni'),
            'bounded context Ordering in bounded context Ordering { value object OrderId { raw: string } }'
        );
        const sourceText = 'bounded context Shipping in bounded context Shipping { data object Request { id: OrderId } }';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/private-type-consumer.tni'), sourceText
        );
        documents = [target, source];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const actions = await services.Thinai.lsp.CodeActionProvider?.getCodeActions(source, {
            textDocument: { uri: source.uri.toString() },
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: sourceText.length }
            },
            context: { diagnostics: source.diagnostics ?? [] }
        });
        expect(actions?.some(candidate => 'title' in candidate && candidate.title.includes("Import 'OrderId'"))).toBe(false);
    });

    test('does not offer import quick fixes for same-named declarations of the wrong type', async () => {
        const target = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/wrong-kind.tni'),
            'actor OrderId'
        );
        const sourceText = 'bounded context Ordering in bounded context Ordering { data object Request { id: OrderId } }';
        const source = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/wrong-kind-consumer.tni'), sourceText
        );
        documents = [target, source];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        const actions = await services.Thinai.lsp.CodeActionProvider?.getCodeActions(source, {
            textDocument: { uri: source.uri.toString() },
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: sourceText.length }
            },
            context: { diagnostics: source.diagnostics ?? [] }
        });
        expect(actions?.some(candidate => 'title' in candidate && candidate.title.includes("Import 'OrderId'"))).toBe(false);
    });
});
