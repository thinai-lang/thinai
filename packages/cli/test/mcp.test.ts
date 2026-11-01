import { describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('MCP server', () => {
    test('serves model queries over stdio', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'thinai-mcp-'));
        const fileName = path.join(directory, 'order.tni');
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

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../bin/cli.js', import.meta.url)), 'mcp', fileName],
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            stderr: 'pipe'
        });
        const client = new Client({ name: 'thinai-mcp-test', version: '1.0.0' });

        try {
            await client.connect(transport);
            const packageVersion = JSON.parse(await readFile(
                fileURLToPath(new URL('../package.json', import.meta.url)),
                'utf8'
            )).version as string;
            expect(client.getServerVersion()?.version).toBe(packageVersion);

            const tools = await client.listTools();
            expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
                'list_elements',
                'search_elements',
                'get_element',
                'get_context',
                'get_dependencies',
                'get_visibility',
                'validate_model',
                'impact_of_change',
                'get_source',
                'resolve_element'
            ]));

            const elements = await client.callTool({
                name: 'list_elements',
                arguments: { kind: 'Aggregate' }
            });
            expect(elements.content).toEqual([
                expect.objectContaining({
                    type: 'text',
                    text: expect.stringContaining('Aggregate:Ordering.Order')
                })
            ]);

            const page = await client.callTool({
                name: 'list_elements',
                arguments: { limit: 1 }
            });
            const pageResult = JSON.parse((page.content as Array<{ text: string }>)[0]!.text);
            expect(pageResult.total).toBeGreaterThan(1);
            expect(pageResult.returned).toBe(1);
            expect(pageResult.truncated).toBe(true);

            const context = await client.callTool({
                name: 'get_context',
                arguments: { id: 'Aggregate:Ordering.Order', format: 'md' }
            });
            expect(context.content).toEqual([
                expect.objectContaining({
                    type: 'text',
                    text: expect.stringContaining('# Ordering.Order')
                })
            ]);
        } finally {
            await client.close().catch(() => {});
            await rm(directory, { recursive: true, force: true });
        }
    }, 20_000);

    test('serves dependency filters, impact depth, source text, and exact resolution', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'thinai-mcp-agent-'));
        const fileName = path.join(directory, 'order.tni');
        const sharedFile = path.join(directory, 'shared.tni');
        await writeFile(sharedFile, `bounded context Common
in bounded context Common {
    value object Currency {
        code: string
    }
}
`);
        await writeFile(fileName, `import "./shared.tni"

bounded context Ordering
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

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../bin/cli.js', import.meta.url)), 'mcp', fileName],
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            stderr: 'pipe'
        });
        const client = new Client({ name: 'thinai-mcp-agent-test', version: '1.0.0' });

        const call = async (name: string, args: Record<string, unknown>) => {
            const result = await client.callTool({ name, arguments: args });
            const content = result.content as Array<{ type: string; text: string }>;
            return JSON.parse(content[0]!.text);
        };

        try {
            await client.connect(transport);

            const references = await call('get_dependencies', {
                id: 'Field:Ordering.Api.Input.id'
            });
            expect(references.kind).toBe('reference');
            expect(references.total).toBe(1);
            expect(references.edges).toEqual([
                expect.objectContaining({
                    fromId: 'Field:Ordering.Api.Input.id',
                    toId: 'ValueObject:Ordering.Types.OrderId',
                    role: 'type',
                    kind: 'reference'
                })
            ]);
            expect(references.edges.every((edge: { kind: string }) => edge.kind === 'reference')).toBe(true);

            const allEdges = await call('get_dependencies', {
                id: 'Field:Ordering.Api.Input.id',
                kind: 'all'
            });
            expect(allEdges.total).toBe(2);
            expect(allEdges.edges).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    toId: 'Module:Ordering.Types',
                    role: 'qualifier',
                    kind: 'qualifier'
                })
            ]));

            const typed = await call('get_dependencies', {
                id: 'Field:Ordering.Api.Input.id',
                kind: 'all',
                role: 'type'
            });
            expect(typed.total).toBe(1);
            expect(typed.edges[0].role).toBe('type');

            const dependencyPage = await call('get_dependencies', {
                id: 'Field:Ordering.Api.Input.id',
                kind: 'all',
                limit: 1
            });
            expect(dependencyPage.total).toBe(2);
            expect(dependencyPage.returned).toBe(1);
            expect(dependencyPage.truncated).toBe(true);

            const directImpact = await call('impact_of_change', {
                id: 'ValueObject:Ordering.Order.OrderId'
            });
            expect(directImpact.depth).toBe(1);
            expect(directImpact.affectedIds).toContain('ValueObject:Shipping.ShippingOrderId');
            expect(directImpact.affectedIds).not.toContain('Field:Shipping.Shipment.orderId');

            const transitiveImpact = await call('impact_of_change', {
                id: 'ValueObject:Ordering.Order.OrderId',
                depth: 2
            });
            expect(transitiveImpact.affectedIds).toEqual(expect.arrayContaining([
                'ValueObject:Shipping.ShippingOrderId',
                'Field:Shipping.Shipment.orderId'
            ]));

            const limitedImpact = await call('impact_of_change', {
                id: 'ValueObject:Ordering.Order.OrderId',
                depth: 2,
                limit: 1
            });
            expect(limitedImpact.returned).toBe(1);
            expect(limitedImpact.totalAffected).toBeGreaterThan(1);
            expect(limitedImpact.truncated).toBe(true);

            const source = await call('get_source', {
                id: 'Aggregate:Ordering.Order'
            });
            expect(source.text).toContain('aggregate Order {');
            expect(source.text).toContain('value object OrderId');
            expect(source.truncated).toBe(false);

            const truncatedSource = await call('get_source', {
                id: 'Aggregate:Ordering.Order',
                maxCharacters: 12
            });
            expect(truncatedSource.characters).toBe(12);
            expect(truncatedSource.totalCharacters).toBeGreaterThan(12);
            expect(truncatedSource.truncated).toBe(true);

            const importedSource = await call('get_source', {
                id: 'ValueObject:Common.Currency'
            });
            expect(importedSource.uri).toContain('shared.tni');
            expect(importedSource.uri).not.toBe(source.uri);
            expect(importedSource.text).toContain('value object Currency {');

            const resolved = await call('resolve_element', {
                qualifiedName: 'Ordering.Order'
            });
            expect(resolved.count).toBe(1);
            expect(resolved.resolved.id).toBe('Aggregate:Ordering.Order');

            const resolvedByKind = await call('resolve_element', {
                qualifiedName: 'Ordering.Order.OrderId',
                kind: 'ValueObject'
            });
            expect(resolvedByKind.count).toBe(1);
            expect(resolvedByKind.resolved.id).toBe('ValueObject:Ordering.Order.OrderId');

            const unknown = await call('resolve_element', {
                qualifiedName: 'Missing.Element'
            });
            expect(unknown.count).toBe(0);
            expect(unknown.resolved).toBeUndefined();
            expect(unknown.truncated).toBe(false);
        } finally {
            await client.close().catch(() => {});
            await rm(directory, { recursive: true, force: true });
        }
    }, 20_000);
});
