import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import { describe, expect, test } from 'vitest';
import { createThinaiServices } from '../src/index.js';

interface Snippet {
    page: string;
    index: number;
    text: string;
    fragment: boolean;
    invalid: boolean;
}

const docsRepo = process.env.THINAI_DOCS_REPO ??
    fileURLToPath(new URL('../../../../thinai-lang.github.io', import.meta.url));
const docsDirectory = join(docsRepo, 'src/content/docs');
const examplesDirectory = join(docsRepo, 'examples/order-fulfillment');
const describeSnippets = existsSync(docsDirectory) ? describe : describe.skip;

function readSnippets(markdown: string, page: string): Snippet[] {
    const snippets: Snippet[] = [];
    const lines = markdown.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index++) {
        if (lines[index]?.trim() !== '```thinai') {
            continue;
        }
        const marker = lines[index - 1]?.trim();
        const body: string[] = [];
        let cursor = index + 1;
        while (cursor < lines.length && lines[cursor]?.trim() !== '```') {
            body.push(lines[cursor]!);
            cursor++;
        }
        snippets.push({
            page,
            index: snippets.length + 1,
            text: body.join('\n'),
            fragment: marker === '<!-- thinai-fragment -->',
            invalid: marker === '<!-- thinai-invalid -->'
        });
        index = cursor;
    }
    return snippets;
}

const importPattern = /^\s*import\s+(?:[^"']*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/gmu;

async function loadImportGraph(
    text: string,
    baseDirectory: string,
    loaded: Map<string, string>,
    seen: Set<string>
): Promise<void> {
    for (const match of text.matchAll(importPattern)) {
        const path = resolve(baseDirectory, match[1]!);
        if (seen.has(path)) {
            continue;
        }
        seen.add(path);
        if (!existsSync(path)) {
            throw new Error(`missing import '${match[1]}' from ${baseDirectory}`);
        }
        const source = await readFile(path, 'utf8');
        loaded.set(path, source);
        await loadImportGraph(source, dirname(path), loaded, seen);
    }
}

describeSnippets('public documentation snippets', () => {
    test('every complete snippet parses, links, and validates in the example workspace', async () => {
        const pages = (await readdir(docsDirectory)).filter((file) => file.endsWith('.md')).sort();
        const failures: string[] = [];
        let completeSnippets = 0;

        for (const page of pages) {
            const markdown = await readFile(join(docsDirectory, page), 'utf8');
            for (const snippet of readSnippets(markdown, page)) {
                if (snippet.fragment || snippet.invalid) {
                    continue;
                }
                completeSnippets++;
                const services = createThinaiServices(EmptyFileSystem);
                const loaded = new Map<string, string>();
                try {
                    await loadImportGraph(snippet.text, examplesDirectory, loaded, new Set());
                } catch (error) {
                    failures.push(`${page} block ${snippet.index}: ${String(error)}`);
                    continue;
                }

                const documents: LangiumDocument[] = [];
                for (const [path, text] of loaded) {
                    documents.push(services.shared.workspace.LangiumDocuments.createDocument(URI.file(path), text));
                }
                const snippetPath = join(
                    examplesDirectory,
                    `__docs-${page.replace(/\.md$/u, '')}-${snippet.index}.tni`
                );
                const snippetDocument = services.shared.workspace.LangiumDocuments.createDocument(
                    URI.file(snippetPath),
                    snippet.text
                );
                documents.push(snippetDocument);

                await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
                const errors = [
                    ...snippetDocument.parseResult.parserErrors.map((error) => error.message),
                    ...(snippetDocument.diagnostics ?? [])
                        .filter((diagnostic) => diagnostic.severity === 1)
                        .map((diagnostic) => diagnostic.message)
                ];
                if (errors.length > 0) {
                    failures.push(`${page} block ${snippet.index}: ${errors.join(' | ')}`);
                }
            }
        }

        expect(completeSnippets).toBeGreaterThan(0);
        expect(failures).toEqual([]);
    });
});
