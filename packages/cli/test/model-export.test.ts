import { describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeImpact, createContextSlice, renderContextMarkdown } from 'thinai-language';
import { loadModel } from '../src/model.js';

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(path.join(tmpdir(), 'thinai-model-export-'));
    try {
        return await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

describe('model export', () => {
    test('exports stable IDs, typed fields, and reference edges', async () => {
        await withTempDirectory(async directory => {
            const fileName = path.join(directory, 'ordering.tni');
            await writeFile(fileName, `bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
            name: string
            constructor(id: OrderId)
            method place() {
                emits OrderPlaced
            }
        }
        value object OrderId {
            raw: string
        }
    }
    event OrderPlaced
}
`);

            const model = await loadModel(fileName);
            const ids = model.elements.map(element => element.id);
            expect(model.schemaVersion).toBe('thinai-model-v1');
            expect(ids).toEqual(expect.arrayContaining([
                'BoundedContext:Ordering',
                'Aggregate:Ordering.Order',
                'Entity:Ordering.Order.Order',
                'Field:Ordering.Order.Order.id',
                'Method:Ordering.Order.Order.place',
                'ValueObject:Ordering.Order.OrderId',
                'DomainEvent:Ordering.OrderPlaced'
            ]));

            expect(model.elements.find(element => element.id === 'Aggregate:Ordering.Order')?.parentId)
                .toBe('BoundedContext:Ordering');
            expect(model.elements.find(element => element.id === 'DomainEvent:Ordering.OrderPlaced')?.parentId)
                .toBe('BoundedContext:Ordering');

            const identifier = model.elements.find(element => element.id === 'Field:Ordering.Order.Order.id');
            expect(identifier?.parentId).toBe('Entity:Ordering.Order.Order');

            const constructor = model.elements.find(element => element.id === 'Constructor:Ordering.Order.Order.constructor#0');
            expect(constructor?.parentId).toBe('Entity:Ordering.Order.Order');
            const parameter = model.elements.find(element => element.id === 'Parameter:Ordering.Order.Order.constructor#0.id');
            expect(parameter?.parentId).toBe('Constructor:Ordering.Order.Order.constructor#0');
            expect(identifier?.properties.type).toMatchObject({
                kind: 'reference',
                name: 'OrderId',
                targetId: 'ValueObject:Ordering.Order.OrderId'
            });

            expect(model.edges).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    fromId: 'Method:Ordering.Order.Order.place',
                    toId: 'DomainEvent:Ordering.OrderPlaced'
                }),
                expect.objectContaining({
                    fromId: 'Field:Ordering.Order.Order.id',
                    toId: 'ValueObject:Ordering.Order.OrderId',
                    role: 'type'
                })
            ]));
            expect(model.diagnostics).toEqual([]);
        });
    });

    test('exports module dependencies, exposure, and resolved type targets', async () => {
        await withTempDirectory(async directory => {
            const fileName = path.join(directory, 'modules.tni');
            await writeFile(fileName, `bounded context Ordering
in bounded context Ordering {
    module Types {
        exposes OrderId
        value object OrderId {
            raw: string
        }
    }

    module Api {
    depends on Types

        data object Input {
            id: Types.OrderId
        }
    }
}
`);

            const model = await loadModel(fileName);
            const orderId = model.elements.find(element => element.id === 'ValueObject:Ordering.Types.OrderId');
            expect(orderId?.visibility).toBe('module-exposed');
            expect(orderId?.exposedBy).toEqual(['Module:Ordering.Types']);

            const api = model.elements.find(element => element.id === 'Module:Ordering.Api');
            expect(api?.properties.dependsOn).toEqual(['Module:Ordering.Types']);

            const field = model.elements.find(element => element.id === 'Field:Ordering.Api.Input.id');
            expect(field?.properties.type).toMatchObject({
                kind: 'reference',
                name: 'OrderId',
                targetId: 'ValueObject:Ordering.Types.OrderId'
            });
        });
    });

    test('creates deterministic context slices and Markdown', async () => {
        await withTempDirectory(async directory => {
            const fileName = path.join(directory, 'context.tni');
            await writeFile(fileName, `bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
            method place() {
                emits OrderPlaced
            }
        }
        value object OrderId {
            raw: string
        }
    }
    event OrderPlaced
}
`);

            const model = await loadModel(fileName);
            const slice = createContextSlice(model, 'Aggregate:Ordering.Order', { depth: 1 });
            const ids = slice.elements.map(element => element.id);
            expect(ids).toEqual(expect.arrayContaining([
                'Aggregate:Ordering.Order',
                'Entity:Ordering.Order.Order',
                'Field:Ordering.Order.Order.id',
                'Method:Ordering.Order.Order.place',
                'ValueObject:Ordering.Order.OrderId',
                'DomainEvent:Ordering.OrderPlaced'
            ]));
            expect(slice.contextId).toBe('BoundedContext:Ordering');
            expect(slice.edges.every(edge =>
                ids.includes(edge.fromId) && ids.includes(edge.toId)
            )).toBe(true);

            const markdown = renderContextMarkdown(slice);
            expect(markdown).toContain('# Ordering.Order');
            expect(markdown).toContain('Aggregate:Ordering.Order');
        });
    });

    test('context slices exclude cross-context module-private declarations', async () => {
        await withTempDirectory(async directory => {
            const fileName = path.join(directory, 'privacy.tni');
            await writeFile(fileName, `bounded context A
in bounded context A {
    module Secret {
        value object Hidden {
            raw: string
        }
    }
    value object Public {
        raw: string
    }
}

bounded context B
in bounded context B {
    data object Input {
        hidden: A.Secret.Hidden
        public: A.Public
    }
}
`);

            const model = await loadModel(fileName);
            const slice = createContextSlice(model, 'BoundedContext:B', { depth: 1 });
            const ids = slice.elements.map(element => element.id);
            expect(ids).toContain('Field:B.Input.hidden');
            expect(ids).not.toContain('ValueObject:A.Secret.Hidden');
            expect(slice.elements.find(element => element.id === 'ValueObject:A.Secret.Hidden')).toBeUndefined();
        });
    });

    test('computes model-side impact for referenced elements', async () => {
        await withTempDirectory(async directory => {
            const fileName = path.join(directory, 'impact.tni');
            await writeFile(fileName, `bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
        }
        value object OrderId {
            raw: string
        }
    }
}
`);

            const model = await loadModel(fileName);
            const impact = computeImpact(model, 'ValueObject:Ordering.Order.OrderId');
            expect(impact.changedIds).toContain('ValueObject:Ordering.Order.OrderId');
            expect(impact.affectedIds).toContain('Field:Ordering.Order.Order.id');
            expect(impact.incoming).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    fromId: 'Field:Ordering.Order.Order.id',
                    toId: 'ValueObject:Ordering.Order.OrderId'
                })
            ]));
        });
    });

    test('traverses identifier mirrors in impact and context slices', async () => {
        await withTempDirectory(async directory => {
            const fileName = path.join(directory, 'mirror.tni');
            await writeFile(fileName, `bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
        }
        value object OrderId {
            raw: string
        }
    }
}

bounded context Shipping
in bounded context Shipping {
    value object OrderId mirrors Ordering.Order.OrderId {
        raw: string
    }
}

context map ShippingOrdering {
    customer Shipping -> supplier Ordering
}
`);

            const model = await loadModel(fileName);
            expect(model.diagnostics).toEqual([]);

            const impact = computeImpact(model, 'ValueObject:Ordering.Order.OrderId');
            expect(impact.affectedIds).toContain('ValueObject:Shipping.OrderId');
            expect(impact.incoming).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    fromId: 'ValueObject:Shipping.OrderId',
                    toId: 'ValueObject:Ordering.Order.OrderId',
                    role: 'mirrors'
                })
            ]));

            const slice = createContextSlice(model, 'ValueObject:Shipping.OrderId');
            expect(slice.elements.map(element => element.id)).toContain('ValueObject:Ordering.Order.OrderId');
            expect(slice.edges).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    fromId: 'ValueObject:Shipping.OrderId',
                    toId: 'ValueObject:Ordering.Order.OrderId',
                    role: 'mirrors'
                })
            ]));
        });
    });

    test('computes transitive impact with configurable depth and limit', async () => {
        await withTempDirectory(async directory => {
            const fileName = path.join(directory, 'transitive-impact.tni');
            await writeFile(fileName, `bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
        }
        value object OrderId {
            raw: string
        }
    }
}

bounded context Shipping
in bounded context Shipping {
    value object ShippingOrderId mirrors Ordering.Order.OrderId {
        raw: string
    }
    data object Shipment {
        orderId: ShippingOrderId
    }
}

context map ShippingOrdering {
    customer Shipping -> supplier Ordering
}
`);

            const model = await loadModel(fileName);
            expect(model.diagnostics).toEqual([]);

            const shallow = computeImpact(model, 'ValueObject:Ordering.Order.OrderId');
            expect(shallow.depth).toBe(1);
            expect(shallow.affectedIds).toContain('ValueObject:Shipping.ShippingOrderId');
            expect(shallow.affectedIds).not.toContain('Field:Shipping.Shipment.orderId');
            expect(shallow.returned).toBe(shallow.affectedIds.length);
            expect(shallow.totalAffected).toBe(shallow.affectedIds.length);
            expect(shallow.truncated).toBe(false);

            const deep = computeImpact(model, 'ValueObject:Ordering.Order.OrderId', { depth: 2 });
            expect(deep.affectedIds).toEqual(expect.arrayContaining([
                'ValueObject:Shipping.ShippingOrderId',
                'Field:Shipping.Shipment.orderId'
            ]));

            const limited = computeImpact(model, 'ValueObject:Ordering.Order.OrderId', { depth: 2, limit: 1 });
            expect(limited.affectedIds).toHaveLength(1);
            expect(limited.returned).toBe(1);
            expect(limited.totalAffected).toBeGreaterThan(1);
            expect(limited.truncated).toBe(true);
            expect(limited.incoming.every(edge => limited.affectedIds.includes(edge.fromId))).toBe(true);
        });
    });

    test('includes qualifier edges in impact traversal', async () => {
        await withTempDirectory(async directory => {
            const fileName = path.join(directory, 'qualifier-impact.tni');
            await writeFile(fileName, `bounded context Ordering
in bounded context Ordering {
    module Types {
        exposes OrderId
        value object OrderId {
            raw: string
        }
    }
    data object Input {
        id: Types.OrderId
    }
}
`);

            const model = await loadModel(fileName);
            const impact = computeImpact(model, 'Module:Ordering.Types');
            expect(impact.incoming).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    fromId: 'Field:Ordering.Input.id',
                    toId: 'Module:Ordering.Types',
                    kind: 'qualifier'
                })
            ]));
            expect(impact.affectedIds).toContain('Field:Ordering.Input.id');
        });
    });

    test('includes validation diagnostics without rejecting the model export', async () => {
        await withTempDirectory(async directory => {
            const fileName = path.join(directory, 'invalid.tni');
            await writeFile(fileName, `bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            name: string
        }
    }
}
`);

            const model = await loadModel(fileName);
            expect(model.elements.map(element => element.id)).toContain('Entity:Ordering.Order.Order');
            expect(model.diagnostics.some(diagnostic => diagnostic.severity === 1)).toBe(true);
        });
    });

    test('aligns exposedBy, visibility, and publicApi with validator visibility', async () => {
        await withTempDirectory(async directory => {
            const fileName = path.join(directory, 'visibility.tni');
            await writeFile(fileName, `bounded context C
in bounded context C {
    module ExposedAggregate {
        exposes Agg
        aggregate Agg {
            root entity E {
                identifier id: I
                method place() {}
            }
            value object I {
                raw: string
            }
        }
    }

    module ExposedMembers {
        exposes Agg2, Agg2.E2, Agg2.I2
        aggregate Agg2 {
            root entity E2 {
                identifier id: I2
            }
            value object I2 {
                raw: string
            }
        }
    }

    module ExposedService {
        exposes Api, Api.run
        application service Api {
            method run() {}
        }
    }

    module HiddenNested {
        module Outer {
            module Inner {
                exposes V
                value object V {
                    raw: string
                }
            }
        }
    }
}
`);

            const model = await loadModel(fileName);
            const element = (id: string) => model.elements.find(candidate => candidate.id === id);

            expect(element('Module:C.ExposedAggregate')).toMatchObject({
                visibility: 'context',
                publicApi: true
            });
            expect(element('Entity:C.ExposedAggregate.Agg.E')).toMatchObject({
                visibility: 'module-exposed',
                publicApi: true,
                exposedBy: ['Module:C.ExposedAggregate']
            });
            expect(element('Field:C.ExposedAggregate.Agg.E.id')).toMatchObject({
                visibility: 'module-exposed',
                publicApi: true,
                exposedBy: ['Module:C.ExposedAggregate']
            });
            expect(element('Method:C.ExposedAggregate.Agg.E.place')).toMatchObject({
                visibility: 'module-exposed',
                publicApi: true,
                exposedBy: ['Module:C.ExposedAggregate']
            });
            expect(element('ValueObject:C.ExposedAggregate.Agg.I')).toMatchObject({
                visibility: 'module-private',
                publicApi: false,
                exposedBy: []
            });

            expect(element('Entity:C.ExposedMembers.Agg2.E2')).toMatchObject({
                visibility: 'module-exposed',
                publicApi: true,
                exposedBy: ['Module:C.ExposedMembers']
            });
            expect(element('Field:C.ExposedMembers.Agg2.E2.id')).toMatchObject({
                visibility: 'module-exposed',
                publicApi: true
            });

            expect(element('Method:C.ExposedService.Api.run')).toMatchObject({
                visibility: 'module-exposed',
                publicApi: true,
                exposedBy: ['Module:C.ExposedService']
            });

            expect(element('Module:C.HiddenNested.Outer.Inner')).toMatchObject({
                visibility: 'module-private',
                publicApi: false
            });
            expect(element('ValueObject:C.HiddenNested.Outer.Inner.V')).toMatchObject({
                visibility: 'module-exposed',
                publicApi: false,
                exposedBy: ['Module:C.HiddenNested.Outer.Inner']
            });
        });
    });

    test('exports semantic edge roles and separates qualifier edges', async () => {
        const fileName = fileURLToPath(new URL('../../../examples/order-fulfillment/ordering-events.tni', import.meta.url));
        const model = await loadModel(fileName);
        const edge = (fromId: string, toId: string, role: string) =>
            model.edges.find(candidate =>
                candidate.fromId === fromId &&
                candidate.toId === toId &&
                candidate.role === role
            );

        expect(edge(
            'Method:Ordering.OrderApplication.placeOrder',
            'Method:Ordering.Order.Order.place',
            'invokes'
        )).toMatchObject({ kind: 'reference' });
        expect(edge(
            'Method:Ordering.OrderApplication.publishOrderPlaced',
            'IntegrationEvent:Ordering.Contracts.OrderPlacedV1',
            'emits'
        )).toMatchObject({ kind: 'reference' });
        expect(edge(
            'Method:Ordering.OrderQueries.canPlaceOrder',
            'QueryRepository:Ordering.OrderSummaryRepository',
            'readsFrom'
        )).toMatchObject({ kind: 'reference' });
        expect(edge(
            'Method:Ordering.OrderSummaryProjector.onOrderPlaced',
            'ReadModel:Ordering.OrderSummary',
            'projects'
        )).toMatchObject({ kind: 'reference' });
        expect(edge(
            'Field:Ordering.Order.Order.currency',
            'SharedKernel:CommonTypes',
            'qualifier'
        )).toMatchObject({ kind: 'qualifier' });

        const placeOrder = model.elements.find(element => element.id === 'Method:Ordering.OrderApplication.placeOrder');
        expect(placeOrder?.properties.invokes).toContainEqual({
            targetId: 'Method:Ordering.Order.Order.place',
            when: '"The order is ready to be placed."'
        });

        const place = model.elements.find(element => element.id === 'Method:Ordering.Order.Order.place');
        expect(place?.properties.emits).toContainEqual({
            eventIds: ['DomainEvent:Ordering.OrderPlaced'],
            when: '"The order is ready to be placed."'
        });
        expect(place?.properties.transitions).toContainEqual({
            when: '"The order is ready to be placed."',
            changes: [{
                fieldId: 'Field:Ordering.Order.Order.status',
                fromId: 'EnumValue:Ordering.Order.OrderStatus.Draft',
                toId: 'EnumValue:Ordering.Order.OrderStatus.Placed'
            }]
        });

        const canPlaceOrder = model.elements.find(element => element.id === 'Method:Ordering.OrderQueries.canPlaceOrder');
        expect(canPlaceOrder?.properties.readsFrom).toContainEqual({
            sourceIds: ['QueryRepository:Ordering.OrderSummaryRepository'],
            when: '"The order summary is available for eligibility checks."'
        });
    });
});
