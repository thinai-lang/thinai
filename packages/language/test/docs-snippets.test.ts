import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments } from 'langium/test';
import { createThinaiServices } from '../src/index.js';

interface Snippet {
    fileName: string;
    text: string;
    fragment: boolean;
}

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));

function readThinaiSnippets(markdown: string): Snippet[] {
    const snippets: Snippet[] = [];
    const lines = markdown.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index++) {
        if (lines[index]?.trim() !== '```thinai') {
            continue;
        }
        const fragment = lines[index - 1]?.trim() === '<!-- thinai-fragment -->';
        const body: string[] = [];
        let cursor = index + 1;
        while (cursor < lines.length && lines[cursor]?.trim() !== '```') {
            body.push(lines[cursor]!);
            cursor++;
        }
        const fileComment = body[0]?.match(/^\/\/ ([\w.-]+\.tni)$/u);
        snippets.push({
            fileName: fileComment?.[1] ?? `snippet-${snippets.length + 1}.tni`,
            text: body.join('\n'),
            fragment
        });
        index = cursor;
    }
    return snippets;
}

describe('README snippets', () => {
    let services: ReturnType<typeof createThinaiServices>;
    let documents: LangiumDocument[] = [];

    beforeAll(() => {
        services = createThinaiServices(EmptyFileSystem);
    });

    afterAll(async () => {
        await clearDocuments(services.shared, documents);
    });

    test('complete README snippets parse and link', async () => {
        const snippets = readThinaiSnippets(await readFile(readmePath, 'utf8'))
            .filter(snippet => !snippet.fragment);
        expect(snippets.length).toBeGreaterThan(0);
        documents = snippets.map(snippet =>
            services.shared.workspace.LangiumDocuments.createDocument(
                URI.file(`/workspace/${snippet.fileName}`),
                snippet.text
            )
        );
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: false });

        for (const document of documents) {
            const parserErrors = document.parseResult.parserErrors;
            expect(parserErrors, document.uri.toString()).toEqual([]);
            const linkingErrors = (document.diagnostics ?? []).filter(diagnostic => diagnostic.severity === 1);
            expect(linkingErrors, document.uri.toString()).toEqual([]);
        }
    });
});
