import { describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { LangiumCoreServices } from 'langium';
import { loadDocuments } from '../src/util.js';
import { extractCodeBlock } from '../../../evals/utils.js';

describe('workspace utilities', () => {
    test('extracts LF and CRLF fenced code blocks and escapes the requested language', () => {
        expect(extractCodeBlock('```thinai\nmodel\n```', 'thinai')).toBe('model');
        expect(extractCodeBlock('```thinai\r\nmodel\r\n```', 'thinai')).toBe('model');
        expect(extractCodeBlock('```c++\r\nint main() {}\r\n```', 'c++')).toBe('int main() {}');
    });

    test('reports a root document load failure', async () => {
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
            const escapedPath = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            await expect(loadDocuments(fileName, services))
                .rejects.toThrow(new RegExp(`Could not load Thinai source file '${escapedPath}'\\.`, 'i'));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('rejects unsupported source extensions without terminating the process', async () => {
        const services = {
            LanguageMetaData: { fileExtensions: ['.tni'] }
        } as unknown as LangiumCoreServices;

        await expect(loadDocuments('/models/readme.md', services))
            .rejects.toThrow('Please choose a file with one of these extensions: .tni.');
    });
});
