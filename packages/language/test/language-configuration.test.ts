import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

interface RegexConfiguration {
    pattern: string;
    flags: string;
}

interface AutoClosingPair {
    open: string;
    close: string;
    notIn?: string[];
    beforeText?: RegexConfiguration;
}

interface LanguageConfiguration {
    wordPattern: RegexConfiguration;
    onEnterRules: Array<{ beforeText: RegexConfiguration }>;
    autoClosingPairs: AutoClosingPair[];
}

async function readLanguageConfiguration(): Promise<LanguageConfiguration> {
    const path = fileURLToPath(new URL('../../extension/language-configuration.json', import.meta.url));
    const source = await readFile(path, 'utf8');
    return JSON.parse(source.replace(/^\s*\/\/.*$/gmu, '')) as LanguageConfiguration;
}

describe('VS Code language configuration', () => {
    test('treats ASCII, Unicode, and backtick-delimited identifiers as words', async () => {
        const configuration = await readLanguageConfiguration();
        const wordPattern = new RegExp(
            configuration.wordPattern.pattern,
            configuration.wordPattern.flags
        );

        for (const name of ['order', 'Élève', 'ஆர்டர்', '订单', '`ஆர்டர் சூழல்`']) {
            wordPattern.lastIndex = 0;
            expect(wordPattern.exec(name)?.[0], name).toBe(name);
        }
    });

    test('recognizes Unicode field lines in the on-enter rule', async () => {
        const configuration = await readLanguageConfiguration();
        const beforeText = new RegExp(
            configuration.onEnterRules[0]!.beforeText.pattern,
            configuration.onEnterRules[0]!.beforeText.flags
        );

        for (const line of ['short: string', 'identifier id: OrderId', 'எண்ணிக்கை: integer', '订单: string']) {
            expect(beforeText.test(line), line).toBe(true);
        }
        expect(beforeText.test('method place() {')).toBe(false);
    });

    test('auto-closes Thinai reference brackets only outside comments', async () => {
        const configuration = await readLanguageConfiguration();
        const pair = configuration.autoClosingPairs.find(candidate =>
            candidate.open === '[[' && candidate.close === ']]'
        );
        expect(pair).toBeDefined();
        expect(pair?.notIn).toEqual(['comment']);

        const beforeText = pair?.beforeText;
        expect(beforeText).toBeDefined();
        const beforeTextPattern = new RegExp(beforeText!.pattern, beforeText!.flags);

        for (const text of ['[[', 'a[[', 'A [[', String.raw`\\[[`]) {
            expect(beforeTextPattern.test(text), text).toBe(true);
        }
        for (const text of [String.raw`\[[`, String.raw`\\\[[`]) {
            expect(beforeTextPattern.test(text), text).toBe(false);
        }

        const singleBracket = configuration.autoClosingPairs.find(candidate =>
            candidate.open === '[' && candidate.close === ']'
        );
        expect(singleBracket?.notIn).toEqual(['string', 'comment']);
    });

    test('sets Thinai editor defaults for suggestions and whitespace', async () => {
        const path = fileURLToPath(new URL('../../extension/package.json', import.meta.url));
        const pkg = JSON.parse(await readFile(path, 'utf8')) as {
            contributes: {
                configurationDefaults: Record<string, Record<string, unknown>>;
            };
        };
        const defaults = pkg.contributes.configurationDefaults['[thinai]'];
        expect(defaults?.['editor.wordBasedSuggestions']).toBe('off');
        expect(defaults?.['files.trimTrailingWhitespace']).toBe(false);
        expect(defaults?.['editor.quickSuggestions']).toEqual({
            other: 'on',
            comments: 'off',
            strings: 'on'
        });
    });
});
