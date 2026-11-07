import { describe, expect, test } from 'vitest';
import { findPreviousImportStart, scanThinaiSource } from '../src/thinai-source-scanner.js';

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

    test('finds only real import keywords outside comments and strings', () => {
        const source = `// A second kernel, imported later
// import these later
/* import these too */
shared kernel Example { value object V { raw: "import" } }
import { Common } from "./common.tni"
shared kernel Extra {`;
        const offset = source.indexOf('shared kernel Extra');
        const realImport = source.indexOf('import { Common }');

        expect(findPreviousImportStart(source, offset)).toBe(realImport);
        expect(findPreviousImportStart('// imported\nshared kernel Extra {\n', '// imported\nshared kernel Extra {\n'.length)).toBeUndefined();
        expect(findPreviousImportStart('shared kernel Imported {\n', 'shared kernel Imported {\n'.length)).toBeUndefined();
        expect(findPreviousImportStart('shared kernel Example {\n  value: "import"\n}\n', 'shared kernel Example {\n  value: "import"\n}\n'.length)).toBeUndefined();
    });
});
