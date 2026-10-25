import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { expandToString as s } from 'langium/generate';
import { parseHelper } from 'langium/test';
import type { Model } from 'thinai-language';
import {
    createThinaiServices,
    isBoundedContext,
    isBoundedContextPart,
    isDataObject,
    isJourney,
    isModel
} from 'thinai-language';

let parse: ReturnType<typeof parseHelper<Model>>;
let services: ReturnType<typeof createThinaiServices>;

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.Thinai);
});

describe('Parsing tests', () => {
    test('rejects semicolon terminators', async () => {
        const document = await parse('actor Customer;');
        expect(document.parseResult.lexerErrors.length + document.parseResult.parserErrors.length).toBeGreaterThan(0);
    });

    test('rejects aliases on file-level imports', async () => {
        const document = await parse('import "./contexts.tni" as Contexts');
        expect(document.parseResult.lexerErrors.length + document.parseResult.parserErrors.length).toBeGreaterThan(0);
    });

    test('explains that enum values in initial and transition clauses cannot be quoted', async () => {
        const document = await parse(`bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    status: OrderStatus initial "asdf"
                    method ship() { transition status from "op" to Shipped }
                }
                enum OrderStatus { Open, Shipped }
            }
        }`);

        const parserMessages = document.parseResult.parserErrors.map(error => error.message);
        expect(parserMessages.filter(message =>
            message === 'Enum values must be identifiers (use backticks for reserved names), not quoted strings.'
        )).toHaveLength(2);
    });

    test('explains that event names in emits clauses cannot be quoted', async () => {
        const document = await parse(`bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method place() { emits "OrderPlaced", OrderPaid, 'OrderCancelled' }
                    identifier id: OrderId
                }
                value object OrderId { raw: string }
                event OrderPlaced
            }
        }`);

        expect(document.parseResult.parserErrors.filter(error =>
            error.message === 'Event names must be identifiers (use backticks for reserved names), not quoted strings.'
        )).toHaveLength(2);
    });

    test('requires commas between enum values', async () => {
        const missingComma = await parse(`bounded context Sample
in bounded context Sample {
    enum Status { Draft Placed }
}`);
        expect(missingComma.parseResult.parserErrors.length).toBeGreaterThan(0);

        const inline = await parse(`bounded context Sample
in bounded context Sample {
    enum Status { Draft, Placed }
}`);
        expect(inline.parseResult.parserErrors).toEqual([]);

        const multiline = await parse(`bounded context Sample
in bounded context Sample {
    enum Status {
        Draft,
        Placed
    }
}`);
        expect(multiline.parseResult.parserErrors).toEqual([]);
    });

    test('supports quoted identifiers for reserved words', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                data object D {
                    \`value\`: string
                    \`event\`: number
                }
                application service S {
                    method \`run\`(input: D) returns string
                }
            }
        `);

        expect(document.parseResult.lexerErrors).toHaveLength(0);
        expect(document.parseResult.parserErrors).toHaveLength(0);
        const fields = document.parseResult.value.declarations
            .filter(isBoundedContextPart)
            .flatMap(part => part.members)
            .filter(isDataObject)
            .flatMap(dataObject => dataObject.fields)
            .map(field => field.name);
        expect(fields).toEqual(['value', 'event']);
    });

    test('rejects entity inheritance syntax', async () => {
        const document = await parse('bounded context Ordering in bounded context Ordering { aggregate Order { root entity Order {} entity SpecialOrder extends Order {} } }');
        expect(document.parseResult.lexerErrors.length + document.parseResult.parserErrors.length).toBeGreaterThan(0);
    });

    test('parses strategic, tactical, and behavior elements', async () => {
        const document = await parse(s`
            subdomain OrderManagement kind core
            actor Customer

            bounded context Ordering realizes OrderManagement

            in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() {
                            emits OrderPlaced
                        }
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                }

                application service OrderApplication {
                    method placeOrder(items: string) {
                        invokes Order.Order.place
                    }
                    method publishOrderPlaced(source: OrderPlaced) {
                        emits OrderPlacedV1, OrderPlacedAuditV1
                    }
                }
                event OrderPlaced {
                    orderId: OrderId
                }
                integration event OrderPlacedV1
                integration event OrderPlacedAuditV1
            }
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.OrderApplication.placeOrder with "items from the selected order"
                }
            }
        `);

        expect(checkDocumentValid(document)).toBeUndefined();
        expect(document.parseResult.value?.declarations.map(declaration => declaration.$type)).toEqual([
            'Subdomain',
            'Actor',
            'BoundedContext',
            'BoundedContextPart',
            'Journey'
        ]);
        expect((document.parseResult.value?.declarations[3] as Model['declarations'][number] & { members?: unknown[] }).members).toHaveLength(5);

        const journey = document.parseResult.value?.declarations[4];
        expect(journey && isJourney(journey)).toBe(true);
        if (journey && isJourney(journey)) {
            expect(journey.actors[0].actor.ref?.name).toBe('Customer');
            expect(journey.actors[0].steps[0].target?.ref?.name).toBe('placeOrder');
        }

        expect(document.parseResult.value && isModel(document.parseResult.value)).toBe(true);
        expect(document.parseResult.value && isBoundedContext(document.parseResult.value.declarations[2])).toBe(true);
        expect(document.parseResult.value && isBoundedContextPart(document.parseResult.value.declarations[3])).toBe(true);
    });

    test('parses all context-map relationship operators together without terminators', async () => {
        const document = await parse(s`
            subdomain Commerce kind core
            subdomain Fulfillment kind supporting
            bounded context Ordering realizes Commerce
            bounded context Shipping realizes Fulfillment
            bounded context Returns realizes Fulfillment
            shared kernel CommonTypes { value object CorrelationId { raw: string } }

            context map CommerceMap {
                customer Ordering { integrationPatterns: ["AntiCorruptionLayer"] } -> supplier Shipping { integrationPatterns: ["PublishedLanguage"] }
                partner Ordering <-> partner Returns
                separateWays Shipping -x- Returns
                sharedKernel CommonTypes { participants: [Ordering, Shipping] }
            }
        `);

        expect(document.parseResult.lexerErrors).toEqual([]);
        expect(document.parseResult.parserErrors).toEqual([]);
    });

    test('parses bounded-context contribution blocks and imports', async () => {
        const document = await parse(s`
            import "./ordering.tni"

            in bounded context Ordering {
                integration event OrderPlacedV1
            }
        `);

        expect(checkDocumentValid(document) || document.parseResult.value?.imports[0].path).toBe('./ordering.tni');
        expect(document.parseResult.value?.declarations[0].$type).toBe('BoundedContextPart');
    });

    test('parses triple-quoted string literals and retains legacy multiline quotes', async () => {
        const triple = await parse(`import """./ordering.tni"""
bounded context Ordering`);
        expect(triple.parseResult.lexerErrors).toEqual([]);
        expect(triple.parseResult.parserErrors).toEqual([]);
        expect(triple.parseResult.value?.imports[0]?.path).toBe('./ordering.tni');

        const emptyTriple = await parse('import """"""\nbounded context Ordering');
        expect(emptyTriple.parseResult.lexerErrors).toEqual([]);
        expect(emptyTriple.parseResult.parserErrors).toEqual([]);
        expect(emptyTriple.parseResult.value?.imports[0]?.path).toBe('');

        for (const source of ['import ""\nbounded context Ordering', "import ''\nbounded context Ordering"]) {
            const emptyQuoted = await parse(source);
            expect(emptyQuoted.parseResult.lexerErrors).toEqual([]);
            expect(emptyQuoted.parseResult.parserErrors).toEqual([]);
            expect(emptyQuoted.parseResult.value?.imports[0]?.path).toBe('');
        }

        const legacy = await parse(`bounded context Legacy in bounded context Legacy {
            aggregate Sample {
                invariant "first line
                    second line
                "
                root entity Item {}
            }
        }`);
        expect(legacy.parseResult.lexerErrors).toEqual([]);
        expect(legacy.parseResult.parserErrors).toEqual([]);
    });

    test('rejects braced canonical contexts and part-of contributions', async () => {
        const braced = await parse('bounded context Ordering {}');
        const partOf = await parse('part of bounded context Ordering {}');

        expect(braced.parseResult.lexerErrors.length + braced.parseResult.parserErrors.length).toBeGreaterThan(0);
        expect(partOf.parseResult.lexerErrors.length + partOf.parseResult.parserErrors.length).toBeGreaterThan(0);
    });

    test('parses behavior specifications, method signatures, constructors, and collections', async () => {
        const document = await parse(s`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        constructor(id: OrderId) {
                            invariant "An order must have an identifier"
                            precondition "The id must be non-empty"
                            behavior "Normalize an order's id with [[OrderId.normalize]] before creating"
                            postcondition "The identifier is set"
                        }
                        method ensureOwner() {
                            invariant "An order has a valid owner."
                        }
                        method addLines(lines: List<OrderLine>) returns Order.Order
                        identifier id: OrderId
                    }
                    value object OrderId {
                        method normalize() returns string
                        raw: string
                    }
                    invariant "Placed orders retain [[Order.ensureOwner]]"
                }
                domain service Pricing {
                    method calculate(lines: List<OrderLine>, currency?: Currency) returns Money {
                        behavior "Calculate a total for [[Order.Order.ensureOwner]]"
                    }
                }
                application service OrderApplication {
                    method placeOrder(description?: string) {
                        precondition "The order can be placed"
                        behavior "Validate with [[Order.Order.ensureOwner]] then place"
                        postcondition "OrderPlaced is emitted"
                    }
                }
            }
        `);

        expect(checkDocumentValid(document)).toBeUndefined();
        const model = document.parseResult.value;
        expect(model && isModel(model)).toBe(true);
        type TextPart = { $type: string; text?: string; target?: { $refText: string }; targets: Array<{ $refText: string }> };
        type BehaviorShape = { description: { parts: TextPart[] } };
        type MemberShape = {
            $type: string;
            name: string;
            members?: MemberShape[];
            constructors?: Array<{ behaviors: BehaviorShape[]; invariants: unknown[] }>;
            methods?: Array<{ parameters: Array<{ optional: boolean }>; invariants: unknown[] }>;
        };
        const context = model?.declarations[1] as Model['declarations'][number] & { members: MemberShape[] };
        const aggregate = context.members.find(member => member.$type === 'Aggregate');
        const root = aggregate?.members?.find(member => member.name === 'Order');
        const behaviorParts = root?.constructors?.[0].behaviors[0].description.parts ?? [];
        expect(behaviorParts).toHaveLength(3);
        expect(behaviorParts[0].text).toBe('Normalize an order\'s id with ');
        expect(behaviorParts[1].target?.$refText).toBe('OrderId');
        expect(behaviorParts[1].targets.map(target => target.$refText)).toEqual(['normalize']);
        expect(behaviorParts[2].text).toBe(' before creating');
        expect(root?.constructors?.[0].invariants).toHaveLength(1);
        expect(root?.methods?.[0].invariants).toHaveLength(1);
        const applicationService = context.members.find(member => member.$type === 'ApplicationService');
        expect(applicationService?.methods?.[0].parameters[0].optional).toBe(true);
        const pricing = context.members.find(member => member.$type === 'DomainService');
        expect(pricing?.methods?.[0].parameters[1].optional).toBe(true);
    });

    test('preserves multiline behavior text and links in quoted strings', async () => {
        const document = await parse([
            'bounded context Ordering in bounded context Ordering {',
            '    aggregate Order { root entity Order { method ensureOwner() identifier id: OrderId } value object OrderId { raw: string } }',
            '    application service OrderApplication {',
            '    method placeOrder() {',
            '        behavior "Place the order',
            'after validation"',
            '        behavior "Check [[Order.ensureOwner]]',
            'before placing"',
            '        behavior "',
            '            Check [[Order.ensureOwner]]',
            '            before placing.',
            '            "',
            '    } }',
            '}'
        ].join('\n'));

        expect(checkDocumentValid(document)).toBeUndefined();
        type Part = { text?: string; target?: { $refText: string }; targets: Array<{ $refText: string }> };
        type BehaviorShape = { description: { parts: Part[] } };
        type MethodShape = { behaviors: BehaviorShape[] };
        const context = document.parseResult.value?.declarations[1] as {
            members: Array<{ $type: string; methods?: MethodShape[] }>;
        };
        const service = context.members.find(member => member.$type === 'ApplicationService');
        const behaviors = service?.methods?.[0].behaviors ?? [];
        const linkedParts = behaviors[1].description.parts ?? [];
        const dedentedParts = behaviors[2].description.parts ?? [];

        expect(behaviors[0].description.parts.map(part => part.text).join('')).toBe('Place the order\nafter validation');
        expect(linkedParts).toHaveLength(3);
        expect(linkedParts[0].text).toBe('Check ');
        expect(linkedParts[1].target?.$refText).toBe('Order');
        expect(linkedParts[1].targets.map(target => target.$refText)).toEqual(['ensureOwner']);
        expect(linkedParts[2].text).toBe('\nbefore placing');
        expect(dedentedParts.map(part => part.text ?? '').join('')).toBe('Check \nbefore placing.');
        expect(dedentedParts[1].target?.$refText).toBe('Order');
        expect(dedentedParts[1].targets.map(target => target.$refText)).toEqual(['ensureOwner']);
    });

    test('dedents CRLF specification text while retaining intentional blank lines', async () => {
        const document = await parse([
            'bounded context CrLf in bounded context CrLf {',
            '    aggregate Sample {',
            '        invariant "',
            '            first line',
            '',
            '            second line',
            '            "',
            '        root entity Item { identifier id: ItemId }',
            '        value object ItemId { raw: string }',
            '    }',
            '}'
        ].join('\r\n'));
        const context = document.parseResult.value?.declarations[1] as Model['declarations'][number] & {
            members: Array<{ $type: string; invariants?: Array<{ description: { parts: Array<{ text?: string }> } }> }>;
        };
        const aggregate = context.members.find(member => member.$type === 'Aggregate');
        expect(aggregate?.invariants?.[0].description.parts.map(part => part.text ?? '').join(''))
            .toBe('first line\n\nsecond line');
    });

    test('parses triple-quoted multiline specifications with quotes and linked references', async () => {
        const document = await parse(`bounded context Triple in bounded context Triple {
            aggregate Sample {
                invariant """
                    Use "double" and 'single' quotes.
                    Keep [[Item.status]] linked.
                    """
                root entity Item { status: string }
            }
        }`);
        expect(document.parseResult.lexerErrors).toEqual([]);
        expect(document.parseResult.parserErrors).toEqual([]);
        const context = document.parseResult.value?.declarations[1] as Model['declarations'][number] & {
            members: Array<{ $type: string; invariants?: Array<{ description: { parts: Array<{
                text?: string;
                target?: { $refText: string };
                targets?: Array<{ $refText: string }>;
            }> } }> }>;
        };
        const aggregate = context.members.find(member => member.$type === 'Aggregate');
        const parts = aggregate?.invariants?.[0].description.parts ?? [];
        expect(parts.map(part => part.text ?? (part.target
            ? `[[${part.target.$refText}${(part.targets ?? []).map(target => `.${target.$refText}`).join('')}]]`
            : '')).join(''))
            .toBe('Use "double" and \'single\' quotes.\nKeep [[Item.status]] linked.');
        expect(parts.find(part => part.target)?.target?.$refText).toBe('Item');
    });

    test('dedents CRLF triple-quoted specification text', async () => {
        const document = await parse([
            'bounded context TripleCrLf in bounded context TripleCrLf {',
            '    aggregate Sample {',
            '        invariant """',
            '            first line',
            '',
            '            second line',
            '            """',
            '        root entity Item {}',
            '    }',
            '}'
        ].join('\r\n'));
        const context = document.parseResult.value?.declarations[1] as Model['declarations'][number] & {
            members: Array<{ $type: string; invariants?: Array<{ description: { parts: Array<{ text?: string }> } }> }>;
        };
        const aggregate = context.members.find(member => member.$type === 'Aggregate');
        expect(aggregate?.invariants?.[0].description.parts.map(part => part.text ?? '').join(''))
            .toBe('first line\n\nsecond line');
    });

    test('converts escaped characters in both specification string styles', async () => {
        const document = await parse(String.raw`bounded context Escapes in bounded context Escapes {
            aggregate Sample {
                invariant "\b\f\n\r\t\v\0\q"
                root entity Item { identifier id: ItemId }
                value object ItemId { raw: string }
            }
        }`);
        const context = document.parseResult.value?.declarations[1] as Model['declarations'][number] & {
            members: Array<{ $type: string; invariants?: Array<{ description: { parts: Array<{ text?: string }> } }> }>;
        };
        const aggregate = context.members.find(member => member.$type === 'Aggregate');
        expect(aggregate?.invariants?.[0].description.parts.map(part => part.text ?? '').join(''))
            .toBe('\b\f\n\r\t\v\0q');

        const singleQuoted = await parse(String.raw`bounded context Escapes in bounded context Escapes {
            aggregate Sample { invariant '\n\t' root entity Item { identifier id: ItemId } value object ItemId { raw: string } }
        }`);
        const singleContext = singleQuoted.parseResult.value?.declarations[1] as Model['declarations'][number] & {
            members: Array<{ $type: string; invariants?: Array<{ description: { parts: Array<{ text?: string }> } }> }>;
        };
        const singleAggregate = singleContext.members.find(member => member.$type === 'Aggregate');
        expect(singleAggregate?.invariants?.[0].description.parts.map(part => part.text ?? '').join('')).toBe('\n\t');
    });

    test('parses a single-quoted behavior with an escaped apostrophe and literal reference marker', async () => {
        const document = await parse(String.raw`bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method addLine(line: OrderLine) {
                        behavior 'Add the line quantity to the order\'s lines. The initial state is [[Ordering.Order.OrderStatus.Draft]], and \[[ is literal text.'
                    }
                    identifier id: OrderId
                }
                value object OrderLine { quantity: number }
                value object OrderId { raw: string }
                enum OrderStatus { Draft }
            }
        }`);
        expect(document.parseResult.lexerErrors).toEqual([]);
        expect(document.parseResult.parserErrors).toEqual([]);
    });

    test('allows escaping a literal reference marker in a behavior specification', async () => {
        const document = await parse(
            'bounded context Escape in bounded context Escape { application service Runner { method execute() { behavior "Literal \\[[NotAReference.method]] stays text" } } aggregate Run { root entity Run { identifier id: RunId } value object RunId { raw: string } } }'
        );

        expect(checkDocumentValid(document)).toBeUndefined();
        const model = document.parseResult.value;
        if (!model || !isModel(model)) {
            return;
        }
        type Part = { text?: string; target?: unknown };
        type BehaviorShape = { description: { parts: Part[] } };
        const context = model.declarations[1] as Model['declarations'][number] & {
            members: Array<{ $type: string; methods?: Array<{ behaviors?: BehaviorShape[] }> }>;
        };
        const service = context.members.find(member => member.$type === 'ApplicationService');
        const parts = service?.methods?.[0].behaviors?.[0].description.parts ?? [];
        expect(parts).toHaveLength(1);
        expect(parts[0].text).toBe('Literal [[NotAReference.method]] stays text');
        expect(parts[0].target).toBeUndefined();
    });

    test('rejects variable-style labels on journey steps', async () => {
        const document = await parse(`bounded context Alpha
in bounded context Alpha {
    application service App {
        method run()
    }
}
actor Customer
journey Run {
    by Customer {
        invoke Alpha.App.run as step
    }
}`);
        expect(document.parseResult.lexerErrors.length + document.parseResult.parserErrors.length).toBeGreaterThan(0);
    });

    test('rejects dollar-prefixed reference syntax', async () => {
        const document = await parse('bounded context Sample in bounded context Sample { aggregate Order { invariant $"Old ${Order.method}" } }');
        expect(document.parseResult.lexerErrors.length + document.parseResult.parserErrors.length).toBeGreaterThan(0);
    });
});

function checkDocumentValid(document: LangiumDocument): string | undefined {
    return document.parseResult.parserErrors.length && s`
        Parser errors:
          ${document.parseResult.parserErrors.map(error => error.message).join('\n  ')}
    `
        || document.parseResult.value === undefined && `ParseResult is 'undefined'.`
        || !isModel(document.parseResult.value) && `Root AST object is a ${document.parseResult.value.$type}, expected a 'Model'.`
        || undefined;
}
