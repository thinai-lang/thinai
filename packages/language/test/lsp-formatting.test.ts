import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { AstUtils, EmptyFileSystem, type AstNode, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from 'thinai-language';

let services: ReturnType<typeof createThinaiServices>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
});

afterEach(async () => {
    await clearDocuments(services.shared, documents);
    documents = [];
});

describe('LSP formatting', () => {
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

    test('dedents and formats multiline specification text with CR and CRLF line endings', async () => {
        const lines = [
            'bounded context Formatting',
            'in bounded context Formatting {',
            '  aggregate Order {',
            '    root entity Order {',
            '      method place() {',
            '        behavior """',
            '            Keep this line.',
            '              Preserve relative indentation.',
            '        """',
            '      }',
            '    }',
            '  }',
            '}'
        ];

        for (const [index, newline] of ['\r', '\r\n'].entries()) {
            const source = lines.join(newline);
            const document = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/specification-formatting-newline-${index}.tni`), source
            );
            documents.push(document);

            const specification = AstUtils.streamAst(document.parseResult.value)
                .find(node => node.$type === 'SpecificationText') as AstNode & { parts?: Array<{ text?: string }> };
            expect(specification.parts?.map(part => part.text ?? '').join(''))
                .toBe('Keep this line.\n  Preserve relative indentation.');

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
            const lineEndings = [...formatted.matchAll(/\r\n|\r|\n/gu)].map(match => match[0]);
            expect(lineEndings.length).toBeGreaterThan(0);
            expect(new Set(lineEndings)).toEqual(new Set([newline]));

            const formattedDocument = services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/specification-formatting-newline-${index}-formatted.tni`), formatted
            );
            documents.push(formattedDocument);
            expect(await services.Thinai.lsp.Formatter!.formatDocument(formattedDocument, {
                textDocument: { uri: formattedDocument.uri.toString() },
                options: { tabSize: 2, insertSpaces: true }
            })).toEqual([]);
        }
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
});
