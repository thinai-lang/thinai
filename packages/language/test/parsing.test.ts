import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { expandToString as s } from 'langium/generate';
import { parseHelper } from 'langium/test';
import type { Model } from 'thinai-language';
import {
    createThinaiServices,
    isBoundedContext,
    isModel
} from 'thinai-language';

let parse: ReturnType<typeof parseHelper<Model>>;
let services: ReturnType<typeof createThinaiServices>;

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.Thinai);
});

describe('Parsing tests', () => {
    test('parses strategic, tactical, and behavior elements', async () => {
        const document = await parse(s`
            subdomain OrderManagement kind core;

            bounded context Ordering realizes OrderManagement {
                capability OrderFulfillment;
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId;
                    }
                    value object OrderId {
                        raw: string;
                    }
                }

                application service OrderApplication for Order {
                    method placeOrder(items: string) invokes Order.Order.place {}
                    method publishOrderPlaced(source: event OrderPlaced) emits OrderPlacedV1, OrderPlacedAuditV1 after commit {}
                }
                event OrderPlaced data {
                    orderId: OrderId;
                }
                integration event OrderPlacedV1;
                integration event OrderPlacedAuditV1;
                flow PlaceOrder {
                    actor Customer;
                    invoke OrderApplication.placeOrder with "items from the selected order";
                }
            }
        `);

        expect(checkDocumentValid(document)).toBeUndefined();
        expect(document.parseResult.value?.declarations.map(declaration => declaration.$type)).toEqual([
            'Subdomain',
            'BoundedContext'
        ]);
        expect((document.parseResult.value?.declarations[1] as Model['declarations'][number] & { members?: unknown[] }).members).toHaveLength(7);

        const context = document.parseResult.value?.declarations[1] as Model['declarations'][number] & {
            members?: Array<{ $type: string; elements?: Array<{ actor?: string }> }>;
        };
        const flow = context.members?.find(member => member.$type === 'Flow');
        expect(flow?.elements?.[0]).toMatchObject({ actor: 'Customer' });

        expect(document.parseResult.value && isModel(document.parseResult.value)).toBe(true);
        expect(document.parseResult.value && isBoundedContext(document.parseResult.value.declarations[1])).toBe(true);
    });

    test('parses canonical context parts and imports', async () => {
        const document = await parse(s`
            import "./ordering.tni";

            part of bounded context Ordering {
                integration event OrderPlacedV1;
            }
        `);

        expect(checkDocumentValid(document) || document.parseResult.value?.imports[0].path).toBe('./ordering.tni');
        expect(document.parseResult.value?.declarations[0].$type).toBe('BoundedContextPart');
    });

    test('parses behavior specifications, method signatures, constructors, and collections', async () => {
        const document = await parse(s`
            bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        constructor(id: OrderId) {
                            invariant "An order must have an identifier";
                            precondition "The id must be non-empty";
                            behavior "Normalize an order's id with [[OrderId.normalize]] before creating";
                            postcondition "The identifier is set";
                        }
                        method ensureOwner() {
                            invariant "An order has a valid owner.";
                        }
                        identifier id: OrderId;
                    }
                    value object OrderId {
                        method normalize() returns string;
                        raw: string;
                    }
                    invariant "Placed orders retain [[Order.ensureOwner]]";
                    method addLines(lines: List<OrderLine>) returns Order;
                }
                domain service Pricing {
                    method calculate(lines: List<OrderLine>, currency?: Currency) returns Money {
                        behavior "Calculate a total for [[Order.Order.ensureOwner]]";
                    }
                }
                application service OrderApplication for Order {
                    method placeOrder(description?: string) {
                        precondition "The order can be placed";
                        behavior "Validate with [[Order.Order.ensureOwner]] then place";
                        postcondition "OrderPlaced is emitted";
                    }
                }
            }
        `);

        expect(checkDocumentValid(document)).toBeUndefined();
        const model = document.parseResult.value;
        expect(model && isModel(model)).toBe(true);
        type TextPart = { $type: string; text?: string; target?: { $refText: string } };
        type BehaviorShape = { description: { parts: TextPart[] } };
        type MemberShape = {
            $type: string;
            name: string;
            members?: MemberShape[];
            constructors?: Array<{ behaviors: BehaviorShape[]; invariants: unknown[] }>;
            methods?: Array<{ parameters: Array<{ optional: boolean }>; invariants: unknown[] }>;
        };
        const context = model?.declarations[0] as Model['declarations'][number] & { members: MemberShape[] };
        const aggregate = context.members.find(member => member.$type === 'Aggregate');
        const root = aggregate?.members?.find(member => member.name === 'Order');
        const behaviorParts = root?.constructors?.[0].behaviors[0].description.parts ?? [];
        expect(behaviorParts).toHaveLength(3);
        expect(behaviorParts[0].text).toBe('Normalize an order\'s id with ');
        expect(behaviorParts[1].target?.$refText).toBe('OrderId.normalize');
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
            'bounded context Ordering {',
            '    aggregate Order { method ensureOwner(); }',
            '    application service OrderApplication for Order {',
            '    method placeOrder() {',
            '        behavior "Place the order',
            'after validation";',
            '        behavior "Check [[Order.ensureOwner]]',
            'before placing";',
            '        behavior "',
            '            Check [[Order.ensureOwner]]',
            '            before placing.',
            '            ";',
            '    } }',
            '}'
        ].join('\n'));

        expect(checkDocumentValid(document)).toBeUndefined();
        type Part = { text?: string; target?: { $refText: string } };
        type BehaviorShape = { description: { parts: Part[] } };
        type MethodShape = { behaviors: BehaviorShape[] };
        const context = document.parseResult.value?.declarations[0] as {
            members: Array<{ $type: string; methods?: MethodShape[] }>;
        };
        const service = context.members.find(member => member.$type === 'ApplicationService');
        const behaviors = service?.methods?.[0].behaviors ?? [];
        const linkedParts = behaviors[1].description.parts ?? [];
        const dedentedParts = behaviors[2].description.parts ?? [];

        expect(behaviors[0].description.parts.map(part => part.text).join('')).toBe('Place the order\nafter validation');
        expect(linkedParts).toHaveLength(3);
        expect(linkedParts[0].text).toBe('Check ');
        expect(linkedParts[1].target?.$refText).toBe('Order.ensureOwner');
        expect(linkedParts[2].text).toBe('\nbefore placing');
        expect(dedentedParts.map(part => part.text ?? '').join('')).toBe('Check \nbefore placing.');
        expect(dedentedParts[1].target?.$refText).toBe('Order.ensureOwner');
    });

    test('allows escaping a literal reference marker in a behavior specification', async () => {
        const document = await parse(
            'bounded context Escape { application service Runner for Run { method execute() { behavior "Literal \\[[NotAReference.method]] stays text"; } } aggregate Run { root entity Run { identifier id: RunId; } value object RunId { raw: string; } } }'
        );

        expect(checkDocumentValid(document)).toBeUndefined();
        const model = document.parseResult.value;
        if (!model || !isModel(model)) {
            return;
        }
        type Part = { text?: string; target?: unknown };
        type BehaviorShape = { description: { parts: Part[] } };
        const context = model.declarations[0] as Model['declarations'][number] & {
            members: Array<{ $type: string; methods?: Array<{ behaviors?: BehaviorShape[] }> }>;
        };
        const service = context.members.find(member => member.$type === 'ApplicationService');
        const parts = service?.methods?.[0].behaviors?.[0].description.parts ?? [];
        expect(parts).toHaveLength(1);
        expect(parts[0].text).toBe('Literal [[NotAReference.method]] stays text');
        expect(parts[0].target).toBeUndefined();
    });

    test('rejects the former dollar-prefixed reference syntax', async () => {
        const document = await parse('bounded context Legacy { aggregate Order { invariant $"Old ${Order.method}"; } }');
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
