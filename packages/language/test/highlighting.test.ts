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
});
