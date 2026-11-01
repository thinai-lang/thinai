import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { THINAI_KEYWORDS } from '../src/thinai-constants.js';

describe('keyword inventory', () => {
    test('THINAI_KEYWORDS includes every grammar keyword', async () => {
        const grammar = await readFile(
            fileURLToPath(new URL('../src/thinai.langium', import.meta.url)),
            'utf8'
        );
        const grammarKeywords = [...new Set(
            [...grammar.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/gu)].map(match => match[1]!)
        )].sort();

        expect([...THINAI_KEYWORDS].sort()).toEqual(expect.arrayContaining(grammarKeywords));
    });
});
