import { describe, expect, test } from 'vitest';
import { scanThinaiSource } from '../src/thinai-source-scanner.js';

describe('Thinai source scanner', () => {
    test('ignores braces and delimiters inside multiline strings and comments', () => {
        const source = '""" text with " quotes and { braces } """ { /* } */ // {\n}';
        const structure = scanThinaiSource(source);

        expect(structure.braces.map((brace: { character: '{' | '}'; offset: number }) => brace.character))
            .toEqual(['{', '}']);
        expect(structure.openBraces).toBe(0);
        expect(structure.unterminatedString).toBe(false);
    });

    test('reports an unterminated triple-quoted string without counting its braces', () => {
        const structure = scanThinaiSource('""" text " {');

        expect(structure.braces).toEqual([]);
        expect(structure.openBraces).toBe(0);
        expect(structure.unterminatedString).toBe(true);
    });

    test('reports comment state at the cursor without mistaking quoted comment markers', () => {
        expect(scanThinaiSource('// comment').inComment).toBe(true);
        expect(scanThinaiSource('/* comment').inComment).toBe(true);
        expect(scanThinaiSource('/* comment */ code').inComment).toBe(false);
        expect(scanThinaiSource('"// not a comment"').inComment).toBe(false);
        expect(scanThinaiSource('"/* not a comment */"').inComment).toBe(false);
    });
});
