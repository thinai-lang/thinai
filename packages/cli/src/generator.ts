import type { LangiumDocument } from 'langium';
import type { Model } from 'thinai-language';
import { expandToNode, toString } from 'langium/generate';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { extractDestinationAndName } from './util.js';

export async function generateJavaScript(documents: LangiumDocument<Model>[], filePath: string, destination: string | undefined): Promise<string> {
    const data = extractDestinationAndName(filePath, destination);
    const generatedFilePath = `${path.join(data.destination, data.name)}.js`;

    const summary = documents.flatMap(document => {
        const model = document.parseResult.value;
        return model.declarations.map(declaration => ({
            file: document.uri.fsPath,
            type: declaration.$type,
            name: 'name' in declaration
                ? declaration.name
                : declaration.context?.ref?.name ?? declaration.context?.$refText ?? 'unknown'
        }));
    });

    const fileNode = expandToNode`
        "use strict";

        const thinaiModel = ${JSON.stringify(summary, undefined, 4)};
        console.log(JSON.stringify(thinaiModel, undefined, 2));
    `.appendNewLineIfNotEmpty();

    await fs.mkdir(data.destination, { recursive: true });
    await fs.writeFile(generatedFilePath, toString(fileNode));
    return generatedFilePath;
}
