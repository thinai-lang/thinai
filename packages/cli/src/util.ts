import type { AstNode, LangiumCoreServices, LangiumDocument } from 'langium';
import chalk from 'chalk';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { URI } from 'langium';
import { isModel, resolveImportUri, type Model } from 'thinai-language';

export async function extractDocuments(fileName: string, services: LangiumCoreServices): Promise<LangiumDocument<Model>[]> {
    validateFileName(fileName, services);

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
        } catch {
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
        console.error(chalk.red('There are validation errors:'));
        for (const { document, diagnostic } of validationErrors) {
            console.error(chalk.red(
                `${document.uri.fsPath}:${diagnostic.range.start.line + 1}: ${diagnostic.message} [${document.textDocument.getText(diagnostic.range)}]`
            ));
        }
        process.exit(1);
    }

    return loadedDocuments;
}

export async function extractDocument(fileName: string, services: LangiumCoreServices): Promise<LangiumDocument> {
    return (await extractDocuments(fileName, services))[0];
}

export async function extractAstNode<T extends AstNode>(fileName: string, services: LangiumCoreServices): Promise<T> {
    return (await extractDocument(fileName, services)).parseResult?.value as T;
}

function validateFileName(fileName: string, services: LangiumCoreServices): void {
    const extensions = services.LanguageMetaData.fileExtensions;
    if (!extensions.includes(path.extname(fileName))) {
        console.error(chalk.yellow(`Please choose a file with one of these extensions: ${extensions}.`));
        process.exit(1);
    }

    if (!fs.existsSync(fileName)) {
        console.error(chalk.red(`File ${fileName} does not exist.`));
        process.exit(1);
    }
}

interface FilePathData {
    destination: string,
    name: string
}

export function extractDestinationAndName(filePath: string, destination: string | undefined): FilePathData {
    filePath = path.basename(filePath, path.extname(filePath)).replace(/[.-]/g, '');
    return {
        destination: destination ?? path.join(path.dirname(filePath), 'generated'),
        name: path.basename(filePath)
    };
}
