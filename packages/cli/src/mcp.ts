import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
        description: 'Return incoming, outgoing, or bidirectional relationships for an element, with semantic filters and pagination.',
        inputSchema: {
            id: z.string().min(1).describe('Stable element ID'),
            direction: z.enum(['incoming', 'outgoing', 'both']).optional().describe('Relationship direction, default both'),
            kind: z.enum(['reference', 'qualifier', 'all']).optional().describe('Edge kind, default reference; qualifier edges are opt-in'),
            role: z.string().min(1).optional().describe('Exact edge role, such as invokes, emits, or type'),
            offset: z.number().int().min(0).optional().describe('Zero-based edge offset, default 0'),
            limit: z.number().int().positive().max(1000).optional().describe('Maximum number of edges, default 100')
        }
    }, async ({ id, direction, kind, role, offset, limit }) => guarded(async () => {
        const { model, byId } = await getAll();
        if (!byId.has(id)) {
            return error(`Unknown model element '${id}'.`);
        }
        const selectedDirection = direction ?? 'both';
        const selectedKind = kind ?? 'reference';
        const filtered = model.edges.filter(edge => {
            const inDirection =
                (selectedDirection === 'outgoing' || selectedDirection === 'both') && edge.fromId === id ||
                (selectedDirection === 'incoming' || selectedDirection === 'both') && edge.toId === id;
            const inKind = selectedKind === 'all' || edge.kind === selectedKind;
            const inRole = !role || edge.role === role;
            return inDirection && inKind && inRole;
        });
        const start = offset ?? 0;
        const page = filtered.slice(start, start + (limit ?? 100));
        return text({
            schemaVersion: model.schemaVersion,
            id,
            direction: selectedDirection,
            kind: selectedKind,
            role: role ?? null,
            total: filtered.length,
            offset: start,
            returned: page.length,
            truncated: start + page.length < filtered.length,
            edges: page,
            related: [...new Set(page.map(edge => edge.fromId === id ? edge.toId : edge.fromId))]
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
        description: 'Return elements affected by changing a model element and its descendants, with configurable depth and limits.',
        inputSchema: {
            id: z.string().min(1).describe('Stable element ID'),
            depth: z.number().int().min(1).max(10).optional().describe('Reverse reference traversal depth, default 1'),
            limit: z.number().int().positive().max(1000).optional().describe('Maximum number of affected elements, default 200')
        }
    }, async ({ id, depth, limit }) => guarded(async () => {
        const { model } = await getAll();
        return text(computeImpact(model, id, { depth, limit }));
    }));

    server.registerTool('resolve_element', {
        title: 'Resolve element',
        description: 'Resolve an element by exact qualified name, such as Ordering.Order or CommonTypes.Currency.',
        inputSchema: {
            qualifiedName: z.string().min(1).describe('Exact, case-sensitive qualified name'),
            kind: z.string().optional().describe('Optional element kind filter, such as Aggregate or ValueObject'),
            context: z.string().optional().describe('Optional context element ID or qualified-name prefix')
        }
    }, async ({ qualifiedName, kind, context }) => guarded(async () => {
        const { model } = await getAll();
        const normalizedKind = kind?.toLowerCase();
        const matches = model.elements.filter(element =>
            element.qualifiedName === qualifiedName &&
            (!normalizedKind || element.kind.toLowerCase() === normalizedKind) &&
            (!context || element.contextId === context || element.qualifiedName.startsWith(`${context}.`))
        );
        const capped = matches.slice(0, 50);
        return text({
            schemaVersion: model.schemaVersion,
            query: qualifiedName,
            count: matches.length,
            resolved: matches.length === 1 ? matches[0] : undefined,
            matches: capped.map(summarizeElement),
            returned: capped.length,
            truncated: capped.length < matches.length
        });
    }));

    server.registerTool('get_source', {
        title: 'Get element source',
        description: 'Return the exact source declaration for a model element from a document in the loaded model.',
        inputSchema: {
            id: z.string().min(1).describe('Stable element ID'),
            maxCharacters: z.number().int().positive().max(50000).optional().describe('Maximum characters to return, default 8000')
        }
    }, async ({ id, maxCharacters }) => guarded(async () => {
        const { model, byId } = await getAll();
        const element = byId.get(id);
        if (!element) {
            return error(`Unknown model element '${id}'.`);
        }
        if (!model.documents.some(document => document.uri === element.source.uri)) {
            return error(`Element '${id}' does not belong to a loaded model document.`);
        }
        if (!element.source.uri.startsWith('file:')) {
            return error(`Element '${id}' does not have a local file source.`);
        }
        const fileText = await readFile(fileURLToPath(element.source.uri), 'utf8');
        const declaration = sliceSource(fileText, element.source.range);
        const totalCharacters = declaration.length;
        const limit = Math.min(50000, maxCharacters ?? 8000);
        const sourceText = declaration.slice(0, limit);
        return text({
            schemaVersion: model.schemaVersion,
            id,
            uri: element.source.uri,
            range: element.source.range,
            characters: sourceText.length,
            totalCharacters,
            truncated: sourceText.length < totalCharacters,
            text: sourceText
        });
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

function sliceSource(text: string, range: ThinaiModelElement['source']['range']): string {
    const lineStarts = [0];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === '\n') {
            lineStarts.push(index + 1);
        }
    }
    const start = (lineStarts[range.start.line] ?? 0) + range.start.character;
    const end = (lineStarts[range.end.line] ?? text.length) + range.end.character;
    return text.slice(start, Math.max(start, end));
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
