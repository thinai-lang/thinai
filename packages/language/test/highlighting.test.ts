import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { INITIAL, Registry } from 'vscode-textmate';

const grammarPath = new URL('../syntaxes/thinai.tmLanguage.json', import.meta.url);
const require = createRequire(import.meta.url);
let registry: Registry;
let grammar: Awaited<ReturnType<Registry['loadGrammar']>>;

beforeAll(async () => {
    const wasm = await readFile(require.resolve('vscode-oniguruma/release/onig.wasm'));
    const wasmBuffer = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
    const onigLib = loadWASM(wasmBuffer).then(() => ({
        createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
        createOnigString: (value: string) => new OnigString(value)
    }));
    registry = new Registry({
        onigLib,
        loadGrammar: async scopeName => scopeName === 'source.thinai'
            ? JSON.parse(await readFile(grammarPath, 'utf8'))
            : null
    });
    grammar = await registry.loadGrammar('source.thinai');
});

afterAll(() => registry.dispose());

describe('TextMate highlighting', () => {
    test('recognizes linked references in both quoted string styles', async () => {
        const rawGrammar = JSON.parse(await readFile(grammarPath, 'utf8'));
        const reference = rawGrammar.repository['linked-reference'];
        const referenceStart = new RegExp(reference.begin);

        expect(rawGrammar.repository['template-interpolation']).toBeUndefined();
        expect(rawGrammar.patterns.filter((pattern: { name?: string }) => pattern.name === 'string.quoted.double.thinai' || pattern.name === 'string.quoted.single.thinai')).toHaveLength(2);
        expect(reference.patterns[0].name).toBe('variable.other.reference.thinai');
        expect(referenceStart.test('[[Order.Order.place]]')).toBe(true);
        expect(referenceStart.test('\\[[NotAReference.method]]')).toBe(false);
        expect(referenceStart.test('\\\\[[Order.Order.place]]')).toBe(true);
    });

    test('scopes Thinai declaration names by their domain role', () => {
        const examples = [
            ['bounded context Ordering', 'Ordering', 'entity.name.namespace.thinai'],
            ['aggregate Order', 'Order', 'entity.name.class.thinai'],
            ['root entity OrderLine', 'OrderLine', 'entity.name.class.thinai'],
            ['value object OrderId', 'OrderId', 'entity.name.type.thinai'],
            ['event OrderPlaced', 'OrderPlaced', 'entity.name.type.thinai'],
            ['repository OrderRepository', 'OrderRepository', 'entity.name.interface.thinai'],
            ['method placeOrder', 'placeOrder', 'entity.name.function.thinai'],
            ['actor Customer', 'Customer', 'entity.name.variable.thinai']
        ] as const;

        for (const [line, identifier, expectedScope] of examples) {
            const tokens = grammar!.tokenizeLine(line, INITIAL).tokens;
            const index = line.indexOf(identifier);
            const scopes = tokens.find(token => token.startIndex <= index && index < token.endIndex)?.scopes ?? [];
            expect(scopes, `${line} should scope ${identifier} as ${expectedScope}`).toContain(expectedScope);
        }
    });

    test('scopes built-in types, fields, enum values, and relationship operators', () => {
        const scopesOn = (line: string, identifier: string) => {
            const tokens = grammar!.tokenizeLine(line, INITIAL).tokens;
            const index = line.indexOf(identifier);
            return tokens.find(token => token.startIndex <= index && index < token.endIndex)?.scopes ?? [];
        };

        expect(scopesOn('method placeOrder(id: OrderId)', 'id')).toContain('variable.other.property.thinai');
        expect(scopesOn('adjustments?: List<number>', 'adjustments')).toContain('variable.other.property.thinai');
        expect(scopesOn('adjustments?: List<number>', '?')).toContain('keyword.operator.optional.thinai');
        expect(scopesOn('enum OrderStatus { Draft, Placed }', 'OrderStatus')).toContain('entity.name.type.thinai');
        expect(scopesOn('raw: string', 'string')).toContain('storage.type.thinai');
        expect(scopesOn('items: List<OrderLine>', 'List')).toContain('storage.type.thinai');
        expect(scopesOn('enum OrderStatus { Draft, Placed }', 'Draft')).toContain('constant.other.enum-member.thinai');
        expect(scopesOn('customer Shipping -> supplier Ordering', '->')).toContain('keyword.operator.relationship.thinai');
    });

    test('tokenizes linked references in both quote styles and ignores escaped markers', () => {
        expect(grammar).toBeDefined();
        const lines = [
            'behavior "Call [[Order.Order.place]]"',
            "behavior 'Call [[Order.Order.place]]'",
            String.raw`behavior "Literal \[[NotAReference.method]]"`
        ];
        const results = lines.map(line => grammar!.tokenizeLine(line, INITIAL).tokens);
        const scopes = (tokens: typeof results[number]) => tokens.flatMap(token => token.scopes);

        expect(scopes(results[0])).toContain('variable.other.reference.thinai');
        expect(scopes(results[1])).toContain('variable.other.reference.thinai');
        expect(scopes(results[2])).not.toContain('variable.other.reference.thinai');
        expect(scopes(results[2])).toContain('string.quoted.double.thinai');
    });

    test('keeps a single-quoted behavior open across escaped quotes and markers', () => {
        const line = String.raw`behavior 'Add the line quantity to the order\'s lines. The initial state is [[Ordering.Order.OrderStatus.Draft]], and \[[ is literal text.'`;
        const tokens = grammar!.tokenizeLine(line, INITIAL).tokens;
        const scopesAt = (needle: string) => {
            const index = line.indexOf(needle);
            return tokens.find(token => token.startIndex <= index && index < token.endIndex)?.scopes ?? [];
        };
        const escapedQuoteIndex = line.indexOf("\\'", line.indexOf('order'));
        const escapedQuoteScopes = tokens.find(token =>
            token.startIndex <= escapedQuoteIndex && escapedQuoteIndex < token.endIndex
        )?.scopes ?? [];

        expect(scopesAt('s lines')).toContain('string.quoted.single.thinai');
        expect(escapedQuoteScopes).toContain('constant.character.escape.thinai');
        expect(scopesAt('OrderStatus')).toContain('variable.other.reference.thinai');
        expect(scopesAt('is literal')).toContain('string.quoted.single.thinai');
        expect(scopesAt('is literal')).not.toContain('variable.other.reference.thinai');
    });
});
