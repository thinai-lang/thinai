import { describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
            const tools = await client.listTools();
            expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
                'list_elements',
                'get_element',
                'get_context',
                'get_dependencies',
                'get_visibility',
                'validate_model',
                'impact_of_change'
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
});
