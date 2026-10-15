import { describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { LangiumCoreServices } from 'langium';
import { extractDestinationAndName } from '../src/util.js';
import { extractDocuments } from '../src/util.js';
import { extractCodeBlock } from '../../../evals/utils.js';

describe('workspace utilities', () => {
    test('keeps punctuation in generated file names and defaults beside the source', () => {
        expect(extractDestinationAndName('/models/order-fulfillment.v2.tni', undefined)).toEqual({
            destination: '/models/generated',
            name: 'order-fulfillment.v2'
        });
        expect(extractDestinationAndName('/models/orderfulfillmentv2.tni', undefined).name)
            .not.toBe(extractDestinationAndName('/models/order-fulfillment.v2.tni', undefined).name);
    });

    test('uses stable source-based suffixes for explicit shared destinations', () => {
        const first = extractDestinationAndName('/models/a/order.tni', '/out');
        const sameSource = extractDestinationAndName('/models/a/order.tni', '/out');
        const second = extractDestinationAndName('/models/b/order.tni', '/out');

        expect(first).toEqual(sameSource);
        expect(first.name).not.toBe(second.name);
        expect(first.name).toMatch(/^order-[0-9a-f]{12}$/);
    });

    test('extracts LF and CRLF fenced code blocks and escapes the requested language', () => {
        expect(extractCodeBlock('```thinai\nmodel\n```', 'thinai')).toBe('model');
        expect(extractCodeBlock('```thinai\r\nmodel\r\n```', 'thinai')).toBe('model');
        expect(extractCodeBlock('```c++\r\nint main() {}\r\n```', 'c++')).toBe('int main() {}');
    });

    test('reports a root document load failure instead of generating an empty model', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'thinai-cli-'));
        const fileName = path.join(directory, 'model.tni');
        await writeFile(fileName, 'bounded context Ordering');
        const services = {
            LanguageMetaData: { fileExtensions: ['.tni'] },
            shared: {
                workspace: {
                    LangiumDocuments: {
                        getOrCreateDocument: async () => { throw new Error('read failed'); }
                    }
                }
            }
        } as unknown as LangiumCoreServices;

        try {
            await expect(extractDocuments(fileName, services))
                .rejects.toThrow(`Could not load Thinai source file '${fileName}'.`);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('rejects unsupported source extensions without terminating the process', async () => {
        const services = {
            LanguageMetaData: { fileExtensions: ['.tni'] }
        } as unknown as LangiumCoreServices;

        await expect(extractDocuments('/models/readme.md', services))
            .rejects.toThrow('Please choose a file with one of these extensions: .tni.');
    });
});
