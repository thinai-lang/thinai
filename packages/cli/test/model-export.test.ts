import { describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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

    module Api depends on Types {
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
});
