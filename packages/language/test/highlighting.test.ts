import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const grammarPath = new URL('../syntaxes/thinai.tmLanguage.json', import.meta.url);

describe('TextMate highlighting', () => {
    test('recognizes linked references in both quoted string styles', async () => {
        const grammar = JSON.parse(await readFile(grammarPath, 'utf8'));
        const reference = grammar.repository['linked-reference'];
        const referenceStart = new RegExp(reference.begin);

        expect(grammar.repository['template-interpolation']).toBeUndefined();
        expect(grammar.patterns.filter((pattern: { name?: string }) => pattern.name === 'string.quoted.double.thinai' || pattern.name === 'string.quoted.single.thinai')).toHaveLength(2);
        expect(reference.patterns[0].name).toBe('variable.other.reference.thinai');
        expect(referenceStart.test('[[Order.Order.place]]')).toBe(true);
        expect(referenceStart.test('\\[[NotAReference.method]]')).toBe(false);
        expect(referenceStart.test('\\\\[[Order.Order.place]]')).toBe(true);
    });
});
