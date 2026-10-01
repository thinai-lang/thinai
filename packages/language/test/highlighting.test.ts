import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const grammarPath = new URL('../syntaxes/thinai.tmLanguage.json', import.meta.url);

describe('TextMate highlighting', () => {
    test('recognizes interpolation references in both template string styles', async () => {
        const grammar = JSON.parse(await readFile(grammarPath, 'utf8'));
        const interpolation = grammar.repository['template-interpolation'];
        const interpolationStart = new RegExp(interpolation.begin);

        expect(grammar.patterns.filter((pattern: { begin?: string }) => pattern.begin === '\\$"' || pattern.begin === "\\$'")).toHaveLength(2);
        expect(interpolation.patterns[0].name).toBe('variable.other.reference.thinai');
        expect(interpolationStart.test('${Order.OrderRoot.place}')).toBe(true);
        expect(interpolationStart.test('\\${NotAReference.method}')).toBe(false);
        expect(interpolationStart.test('\\\\${Order.OrderRoot.place}')).toBe(true);
    });
});
