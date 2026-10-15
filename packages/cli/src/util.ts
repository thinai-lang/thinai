import type { LangiumCoreServices, LangiumDocument } from 'langium';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { URI } from 'langium';
import { isModel, resolveImportUri, type Model } from 'thinai-language';

export async function extractDocuments(fileName: string, services: LangiumCoreServices): Promise<LangiumDocument<Model>[]> {
    await validateFileName(fileName, services);

    const rootUri = URI.file(path.resolve(fileName));
    const documents = new Map<string, LangiumDocument<Model>>();
    const pending: URI[] = [rootUri];

    while (pending.length > 0) {
        const uri = pending.pop()!;
        const key = uri.toString();
        if (documents.has(key)) {
            continue;
        }

        let document: LangiumDocument<Model>;
        try {
            document = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(uri) as LangiumDocument<Model>;
        } catch (error) {
            if (uri.toString() === rootUri.toString()) {
                const failure = new Error(`Could not load Thinai source file '${uri.fsPath}'.`);
                (failure as Error & { cause?: unknown }).cause = error;
                throw failure;
            }
            continue;
        }
        documents.set(key, document);

        const model = document.parseResult.value;
        if (isModel(model)) {
            for (const importDeclaration of model.imports) {
                const importUri = resolveImportUri(document, importDeclaration);
                if (importUri) {
                    pending.push(importUri);
                }
            }
        }
    }

    const loadedDocuments = [...documents.values()];
    await services.shared.workspace.DocumentBuilder.build(loadedDocuments, { validation: true });

    const validationErrors = loadedDocuments.flatMap(document =>
        (document.diagnostics ?? [])
            .filter(diagnostic => diagnostic.severity === 1)
            .map(diagnostic => ({ document, diagnostic }))
    );
    if (validationErrors.length > 0) {
        const details = validationErrors.map(({ document, diagnostic }) =>
            `${document.uri.fsPath}:${diagnostic.range.start.line + 1}: ${diagnostic.message} [${document.textDocument.getText(diagnostic.range)}]`
        );
        throw new Error(['There are validation errors:', ...details].join('\n'));
    }

    return loadedDocuments;
}

async function validateFileName(fileName: string, services: LangiumCoreServices): Promise<void> {
    const extensions = services.LanguageMetaData.fileExtensions;
    if (!extensions.includes(path.extname(fileName))) {
        throw new Error(`Please choose a file with one of these extensions: ${extensions.join(', ')}.`);
    }

    try {
        const file = await fs.stat(fileName);
        if (!file.isFile()) {
            throw new Error(`File ${fileName} is not a regular file.`);
        }
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            throw new Error(`File ${fileName} does not exist.`);
        }
        throw error;
    }
}

interface FilePathData {
    destination: string,
    name: string
}

export function extractDestinationAndName(filePath: string, destination: string | undefined): FilePathData {
    const absoluteFilePath = path.resolve(filePath);
    const baseName = path.basename(absoluteFilePath, path.extname(absoluteFilePath));
    return {
        destination: destination ?? path.join(path.dirname(absoluteFilePath), 'generated'),
        name: destination === undefined
            ? baseName
            : `${baseName}-${createHash('sha256').update(absoluteFilePath).digest('hex').slice(0, 12)}`
    };
}
