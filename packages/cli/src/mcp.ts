import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { z } from 'zod';
import {
    computeImpact,
    createContextSlice,
    renderContextMarkdown,
    type ThinaiModelElement,
    type ThinaiModelExport
} from 'thinai-language';
import { loadModel } from './model.js';

const MODEL_TOOL_SCHEMA = z.string().min(1).describe('Thinai source file path');
const require = createRequire(import.meta.url);
const packageVersion = (require('../package.json') as { version: string }).version;

export async function startMcpServer(fileName: string): Promise<void> {
    // Reload on every tool call so changes in imported files are visible.
    const currentModel = async (): Promise<ThinaiModelExport> => loadModel(fileName);

    const getAll = async () => {
        const model = await currentModel();
        return { model, byId: new Map(model.elements.map(element => [element.id, element])) };
    };

    const server = new McpServer({
        name: 'thinai',
        version: packageVersion
    });

    server.registerTool('list_elements', {
        title: 'List model elements',
        description: 'List Thinai model elements, optionally filtered by kind, context, or text.',
        inputSchema: {
            kind: z.string().optional().describe('Element kind, such as Aggregate, Entity, or IntegrationEvent'),
            context: z.string().optional().describe('Context element ID or qualified-name prefix'),
            query: z.string().optional().describe('Case-insensitive text match against ID, name, and qualified name'),
            offset: z.number().int().min(0).optional().describe('Zero-based result offset, default 0'),
            limit: z.number().int().positive().max(1000).optional().describe('Maximum number of elements, default 200')
        }
    }, async ({ kind, context, query, offset, limit }) => guarded(async () => {
        const { model } = await getAll();
        const normalizedKind = kind?.toLowerCase();
        const normalizedQuery = query?.toLowerCase();
        const filtered = model.elements
            .filter(element => !normalizedKind || element.kind.toLowerCase() === normalizedKind)
            .filter(element => !context || element.contextId === context || element.qualifiedName.startsWith(`${context}.`))
            .filter(element => !normalizedQuery ||
                element.id.toLowerCase().includes(normalizedQuery) ||
                element.name.toLowerCase().includes(normalizedQuery) ||
                element.qualifiedName.toLowerCase().includes(normalizedQuery));
        const start = offset ?? 0;
        const page = filtered.slice(start, start + (limit ?? 200));
        const elements = page.map(summarizeElement);
        return text({
            schemaVersion: model.schemaVersion,
            total: filtered.length,
            offset: start,
            returned: elements.length,
            truncated: start + elements.length < filtered.length,
            elements
        });
    }));

    server.registerTool('search_elements', {
        title: 'Search model elements',
        description: 'Search Thinai elements by ID, name, or qualified name.',
        inputSchema: {
            query: z.string().min(1).describe('Case-insensitive search text'),
            offset: z.number().int().min(0).optional().describe('Zero-based result offset, default 0'),
            limit: z.number().int().positive().max(1000).optional().describe('Maximum number of elements, default 100')
        }
    }, async ({ query, offset, limit }) => guarded(async () => {
        const { model } = await getAll();
        const normalized = query.toLowerCase();
        const filtered = model.elements
            .filter(element =>
                element.id.toLowerCase().includes(normalized) ||
                element.name.toLowerCase().includes(normalized) ||
                element.qualifiedName.toLowerCase().includes(normalized)
            );
        const start = offset ?? 0;
        const page = filtered.slice(start, start + (limit ?? 100));
        const elements = page.map(summarizeElement);
        return text({
            schemaVersion: model.schemaVersion,
            total: filtered.length,
            offset: start,
            returned: elements.length,
            truncated: start + elements.length < filtered.length,
            elements
        });
    }));

    server.registerTool('get_element', {
        title: 'Get model element',
        description: 'Return one element with its source, properties, and direct relationships.',
        inputSchema: {
            id: z.string().min(1).describe('Stable element ID, for example Aggregate:Ordering.Order')
        }
    }, async ({ id }) => guarded(async () => {
        const { model, byId } = await getAll();
        const element = byId.get(id);
        if (!element) {
            return error(`Unknown model element '${id}'.`);
        }
        return text({
            schemaVersion: model.schemaVersion,
            element,
            incoming: model.edges.filter(edge => edge.toId === id),
            outgoing: model.edges.filter(edge => edge.fromId === id)
        });
    }));

    server.registerTool('get_context', {
        title: 'Get task context',
        description: 'Return the relevant model slice for an aggregate, context, module, or contract.',
        inputSchema: {
            id: z.string().min(1).describe('Root element ID'),
            depth: z.number().int().min(0).max(5).optional().describe('Reference expansion depth, default 1'),
            format: z.enum(['json', 'md']).optional().describe('Output format, default json')
        }
    }, async ({ id, depth, format }) => guarded(async () => {
        const { model } = await getAll();
        const slice = createContextSlice(model, id, { depth });
        return text(format === 'md' ? renderContextMarkdown(slice) : slice);
    }));

    server.registerTool('get_dependencies', {
        title: 'Get dependencies',
        description: 'Return incoming, outgoing, or bidirectional relationships for an element.',
        inputSchema: {
            id: z.string().min(1).describe('Stable element ID'),
            direction: z.enum(['incoming', 'outgoing', 'both']).optional().describe('Relationship direction, default both')
        }
    }, async ({ id, direction }) => guarded(async () => {
        const { model, byId } = await getAll();
        if (!byId.has(id)) {
            return error(`Unknown model element '${id}'.`);
        }
        const selected = direction ?? 'both';
        const edges = model.edges.filter(edge =>
            (selected === 'outgoing' || selected === 'both') && edge.fromId === id ||
            (selected === 'incoming' || selected === 'both') && edge.toId === id
        );
        return text({
            schemaVersion: model.schemaVersion,
            id,
            edges,
            related: [...new Set(edges.map(edge => edge.fromId === id ? edge.toId : edge.fromId))]
                .map(relatedId => byId.get(relatedId))
                .filter((element): element is ThinaiModelElement => element !== undefined)
                .map(summarizeElement)
        });
    }));

    server.registerTool('get_visibility', {
        title: 'Get visibility',
        description: 'Return the context, module path, exposure, and visibility metadata for an element.',
        inputSchema: {
            id: z.string().min(1).describe('Stable element ID')
        }
    }, async ({ id }) => guarded(async () => {
        const { model, byId } = await getAll();
        const element = byId.get(id);
        if (!element) {
            return error(`Unknown model element '${id}'.`);
        }
        return text({
            schemaVersion: model.schemaVersion,
            id: element.id,
            kind: element.kind,
            contextId: element.contextId,
            moduleId: element.moduleId,
            modulePath: element.modulePath,
            visibility: element.visibility,
            publicApi: element.publicApi,
            exposedBy: element.exposedBy
        });
    }));

    server.registerTool('validate_model', {
        title: 'Validate model',
        description: 'Reload and validate the model, returning all diagnostics.',
        inputSchema: {
            model: MODEL_TOOL_SCHEMA.optional().describe('Optional source file; defaults to the file used to start the server')
        }
    }, async ({ model: requestedModel }) => guarded(async () => {
        const model = requestedModel
            ? await loadModel(requestedModel)
            : await currentModel();
        return text({
            schemaVersion: model.schemaVersion,
            documents: model.documents,
            diagnostics: model.diagnostics
        });
    }));

    server.registerTool('impact_of_change', {
        title: 'Impact of change',
        description: 'Return elements affected by changing a model element and its descendants.',
        inputSchema: {
            id: z.string().min(1).describe('Stable element ID')
        }
    }, async ({ id }) => guarded(async () => {
        const { model } = await getAll();
        return text(computeImpact(model, id));
    }));

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

interface ToolTextResult {
    [key: string]: unknown;
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

async function guarded(run: () => Promise<ToolTextResult>): Promise<ToolTextResult> {
    try {
        return await run();
    } catch (cause) {
        return error(cause instanceof Error ? cause.message : String(cause));
    }
}

function text(value: unknown): ToolTextResult {
    return {
        content: [{
            type: 'text' as const,
            text: typeof value === 'string' ? value : JSON.stringify(value, undefined, 2)
        }]
    };
}

function error(message: string): ToolTextResult {
    return {
        isError: true,
        content: [{
            type: 'text' as const,
            text: message
        }]
    };
}

function summarizeElement(element: ThinaiModelElement) {
    return {
        id: element.id,
        kind: element.kind,
        name: element.name,
        qualifiedName: element.qualifiedName,
        parentId: element.parentId,
        contextId: element.contextId,
        moduleId: element.moduleId,
        visibility: element.visibility,
        publicApi: element.publicApi,
        source: element.source
    };
}
