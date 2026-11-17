import { readFile } from 'node:fs/promises';
import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import { describe, expect, test } from 'vitest';
import { createThinaiServices } from '../src/index.js';

const examples = new URL('../../../.agents/skills/thinai-model/references/examples/', import.meta.url);

const groups = [
    ['strategic.tni'],
    ['tactical.tni'],
    ['integration/producer.tni', 'integration/consumer.tni']
];

describe('Thinai skill examples', () => {
    for (const group of groups) {
        test(`validates ${group.join(', ')}`, async () => {
            const services = createThinaiServices(EmptyFileSystem);
            const documents: LangiumDocument[] = [];
            for (const file of group) {
                const text = await readFile(new URL(file, examples), 'utf8');
                documents.push(services.shared.workspace.LangiumDocuments.createDocument(
                    URI.file(`/workspace/skill-examples/${file}`),
                    text
                ));
            }

            await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
            for (const document of documents) {
                expect(document.parseResult.parserErrors, document.uri.toString()).toEqual([]);
                const errors = (document.diagnostics ?? []).filter(diagnostic => diagnostic.severity === 1);
                expect(errors, document.uri.toString()).toEqual([]);
            }
        });
    }
});
