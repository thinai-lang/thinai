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

beforeAll(() => {
    const services = createThinaiServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.Thinai);
});

describe('Parsing tests', () => {
    test('parses strategic, tactical, and EventStorming elements', async () => {
        const document = await parse(s`
            subdomain OrderManagement kind core;

            bounded context Ordering realizes OrderManagement {
                capability OrderFulfillment;
                actor Customer;
                external system PaymentProvider;

                aggregate Order root OrderRoot {
                    entity OrderRoot {
                        id: OrderId;
                        invariant "An order must have an owner";
                    }
                    value object OrderId {
                        identifier: string;
                    }
                }

                command PlaceOrder handled by Customer targets Order with items: string emits OrderPlaced;
                event OrderPlaced for Order publishes integration OrderPlacedV1 data {
                    orderId: OrderId;
                }
                integration event OrderPlacedV1 from OrderPlaced;
                policy ReserveInventory when OrderPlaced then PlaceOrder;
                read model OrderSummary from OrderPlaced;
                hotspot PaymentProvider note "Payment API contract is unclear";

                event storming PlaceOrderWorkshop {
                    actor Customer;
                    command PlaceOrder;
                    event OrderPlaced;
                    policy ReserveInventory;
                    aggregate Order;
                    read model OrderSummary;
                    hotspot PaymentProvider;
                }
            }
        `);

        expect(checkDocumentValid(document)).toBeUndefined();
        expect(document.parseResult.value?.declarations.map(declaration => declaration.$type)).toEqual([
            'Subdomain',
            'BoundedContext'
        ]);
        expect((document.parseResult.value?.declarations[1] as Model['declarations'][number] & { members?: unknown[] }).members).toHaveLength(11);

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
